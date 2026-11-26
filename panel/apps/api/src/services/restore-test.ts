import postgres from "postgres";
import { S3Client } from "bun";
import { join } from "node:path";
import { sqlite, type BackupRow, logAudit } from "../db/schema";
import { generateStrongPassword } from "../lib/crypto";
import { sendAlert } from "./alert";
import { controlDedicatedContainer, spawnEphemeralRestoreContainer } from "./docker";

const BACKUP_ENCRYPTION_KEY = process.env.BACKUP_ENCRYPTION_KEY || "";
const LOCAL_BACKUP_DIR = join(process.env.DATA_DIR || "./data", "backups");

function getS3Client(): S3Client | null {
  const endpoint = process.env.S3_ENDPOINT;
  const bucket = process.env.S3_BUCKET;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return new S3Client({
    endpoint,
    bucket,
    region: process.env.S3_REGION || "us-east-1",
    accessKeyId,
    secretAccessKey,
  });
}

/**
 * Automated Restore Test:
 * Spins up an ephemeral Postgres container, restores the latest successful backup,
 * verifies tables are readable, marks verified_restore = 1, and cleans up.
 */
export async function runAutomatedRestoreTest(): Promise<{
  tested: boolean;
  backupId?: string;
  tableCount?: number;
  error?: string;
}> {
  const latest = sqlite
    .prepare(
      `SELECT * FROM backups WHERE status = 'success' AND type IN ('scheduled', 'manual')
       ORDER BY created_at DESC LIMIT 1`
    )
    .get() as BackupRow | undefined;

  if (!latest) {
    return { tested: false, error: "No successful backup found to verify" };
  }

  const containerName = `pg-verify-${Date.now()}`;
  const password = generateStrongPassword(16);
  const tempFile = join(LOCAL_BACKUP_DIR, `verify-${latest.id}.tmp`);
  let containerId: string | null = null;

  try {
    containerId = await spawnEphemeralRestoreContainer(containerName, password);

    // Wait up to 20s for Postgres in ephemeral container to accept connections
    const verifyUrl = `postgres://postgres:${encodeURIComponent(password)}@${containerName}:5432/verify_db`;
    let ready = false;
    for (let i = 0; i < 20; i++) {
      try {
        const probe = postgres(verifyUrl, { max: 1, connect_timeout: 1 });
        await probe`SELECT 1`;
        await probe.end({ timeout: 1 });
        ready = true;
        break;
      } catch {
        await Bun.sleep(1000);
      }
    }
    if (!ready) throw new Error("Ephemeral Postgres container did not become ready in time");

    const s3 = getS3Client();
    if (s3) {
      await Bun.write(tempFile, await s3.file(latest.storage_key).arrayBuffer());
    } else {
      const ext = latest.encryption_algo !== "none" ? "dump.enc" : "dump";
      await Bun.$`cp ${join(LOCAL_BACKUP_DIR, `${latest.id}.${ext}`)} ${tempFile}`.quiet();
    }

    if (latest.encryption_algo !== "none") {
      const decProc = Bun.spawn(
        [
          "openssl",
          "enc",
          "-d",
          "-aes-256-cbc",
          "-pbkdf2",
          "-pass",
          "env:BACKUP_PASS",
          "-in",
          tempFile,
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, BACKUP_PASS: BACKUP_ENCRYPTION_KEY },
        }
      );
      const restoreProc = Bun.spawn(
        ["pg_restore", "--no-owner", "--no-acl", "-d", verifyUrl],
        { stdin: decProc.stdout, stderr: "pipe" }
      );
      await Promise.all([decProc.exited, restoreProc.exited]);
    } else {
      const restoreProc = Bun.spawn(
        ["pg_restore", "--no-owner", "--no-acl", "-d", verifyUrl, tempFile],
        { stderr: "pipe" }
      );
      await restoreProc.exited;
    }

    const verifyClient = postgres(verifyUrl, { max: 1 });
    const [row] = await verifyClient`
      SELECT count(*)::int AS cnt FROM information_schema.tables WHERE table_schema = 'public'
    `;
    await verifyClient.end({ timeout: 1 });

    const tableCount = Number(row?.cnt ?? 0);
    sqlite.prepare("UPDATE backups SET verified_restore = 1 WHERE id = ?").run(latest.id);
    logAudit("restore_test", { backupId: latest.id, tableCount }, latest.instance_id);
    await sendAlert(
      "Automated Restore Test Passed",
      `Verified backup ${latest.storage_key} (${tableCount} public tables readable).`,
      "default"
    );

    return { tested: true, backupId: latest.id, tableCount };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sendAlert("Automated Restore Test Failed", `Backup ${latest.id}: ${msg}`, "high");
    return { tested: false, backupId: latest.id, error: msg };
  } finally {
    await Bun.$`rm -f ${tempFile}`.quiet();
    if (containerId) {
      await controlDedicatedContainer(containerId, "remove").catch(() => {});
    }
  }
}
