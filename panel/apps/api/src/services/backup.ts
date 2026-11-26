import { S3Client } from "bun";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { sqlite, type BackupRow, type InstanceRow, logAudit } from "../db/schema";
import { sendAlert } from "./alert";
import { assertPgIdentifier } from "../lib/crypto";
import { getInstanceAdminUrl } from "./postgres";

const BACKUP_ENCRYPTION_KEY = process.env.BACKUP_ENCRYPTION_KEY || "";
const LOCAL_BACKUP_DIR = join(process.env.DATA_DIR || "./data", "backups");
mkdirSync(LOCAL_BACKUP_DIR, { recursive: true });

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

// In-memory SSE log subscribers per backup job
const jobSubscribers = new Map<string, Set<(line: string) => void>>();

export function subscribeBackupJob(jobId: string, cb: (line: string) => void) {
  let set = jobSubscribers.get(jobId);
  if (!set) {
    set = new Set();
    jobSubscribers.set(jobId, set);
  }
  set.add(cb);
  return () => {
    set?.delete(cb);
    if (set?.size === 0) jobSubscribers.delete(jobId);
  };
}

function emitJobLog(jobId: string, message: string) {
  const line = `[${new Date().toISOString()}] ${message}`;
  jobSubscribers.get(jobId)?.forEach((cb) => cb(line));
}

export function startBackupJobAsync(
  instance: InstanceRow,
  type: BackupRow["type"] = "manual"
): string {
  const dbName = assertPgIdentifier(instance.db_name, "db_name");
  const backupId = crypto.randomUUID();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const encrypted = Boolean(BACKUP_ENCRYPTION_KEY);
  const ext = encrypted ? "dump.enc" : "dump";
  const storageKey = `${instance.name}/${timestamp}_${type}.${ext}`;

  sqlite
    .prepare(
      `INSERT INTO backups (id, instance_id, type, storage_key, encryption_algo, status)
       VALUES (?, ?, ?, ?, ?, 'running')`
    )
    .run(backupId, instance.id, type, storageKey, encrypted ? "aes-256-cbc" : "none");

  void executeBackupJob(backupId, instance, dbName, type, storageKey, encrypted);
  return backupId;
}

export async function runBackupForInstance(
  instance: InstanceRow,
  type: BackupRow["type"] = "manual"
): Promise<BackupRow> {
  const dbName = assertPgIdentifier(instance.db_name, "db_name");
  const backupId = crypto.randomUUID();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const encrypted = Boolean(BACKUP_ENCRYPTION_KEY);
  const ext = encrypted ? "dump.enc" : "dump";
  const storageKey = `${instance.name}/${timestamp}_${type}.${ext}`;

  sqlite
    .prepare(
      `INSERT INTO backups (id, instance_id, type, storage_key, encryption_algo, status)
       VALUES (?, ?, ?, ?, ?, 'running')`
    )
    .run(backupId, instance.id, type, storageKey, encrypted ? "aes-256-cbc" : "none");

  await executeBackupJob(backupId, instance, dbName, type, storageKey, encrypted);
  return sqlite.prepare("SELECT * FROM backups WHERE id = ?").get(backupId) as BackupRow;
}

async function executeBackupJob(
  backupId: string,
  instance: InstanceRow,
  dbName: string,
  type: BackupRow["type"],
  storageKey: string,
  encrypted: boolean
) {
  const ext = encrypted ? "dump.enc" : "dump";
  const localFile = join(LOCAL_BACKUP_DIR, `${backupId}.${ext}`);
  const startMs = Date.now();
  emitJobLog(backupId, `Starting ${type} backup for ${dbName}...`);

  try {
    const dbUrl = getInstanceAdminUrl(instance);

    const dumpProc = Bun.spawn(
      ["pg_dump", "--format=custom", "--compress=6", dbUrl],
      { stdout: "pipe", stderr: "pipe" }
    );

    if (encrypted) {
      emitJobLog(backupId, "Encrypting stream with OpenSSL AES-256-CBC (PBKDF2)...");
      const encProc = Bun.spawn(
        [
          "openssl",
          "enc",
          "-aes-256-cbc",
          "-salt",
          "-pbkdf2",
          "-pass",
          "env:BACKUP_PASS",
          "-out",
          localFile,
        ],
        {
          stdin: dumpProc.stdout,
          stderr: "pipe",
          env: { ...process.env, BACKUP_PASS: BACKUP_ENCRYPTION_KEY },
        }
      );

      const [dumpExit, encExit] = await Promise.all([dumpProc.exited, encProc.exited]);
      if (dumpExit !== 0) {
        throw new Error(await new Response(dumpProc.stderr).text());
      }
      if (encExit !== 0) {
        throw new Error(await new Response(encProc.stderr).text());
      }
    } else {
      const data = await new Response(dumpProc.stdout).arrayBuffer();
      const dumpExit = await dumpProc.exited;
      if (dumpExit !== 0) {
        throw new Error(await new Response(dumpProc.stderr).text());
      }
      await Bun.write(localFile, data);
    }

    const sizeBytes = statSync(localFile).size;
    const s3 = getS3Client();

    if (s3) {
      emitJobLog(backupId, `Uploading ${sizeBytes} bytes to S3 (${storageKey})...`);
      await s3.write(storageKey, Bun.file(localFile));
      // Remove local temp file after successful S3 upload to save VPS disk
      await Bun.$`rm -f ${localFile}`.quiet();
    } else {
      emitJobLog(backupId, `S3 not configured; stored locally at ${localFile}`);
    }

    const durationMs = Date.now() - startMs;
    sqlite
      .prepare(
        `UPDATE backups SET status = 'success', size_bytes = ?, duration_ms = ? WHERE id = ?`
      )
      .run(sizeBytes, durationMs, backupId);

    emitJobLog(backupId, `Backup completed in ${durationMs}ms.`);
    logAudit("backup", { backupId, type, sizeBytes, durationMs }, instance.id);
  } catch (err) {
    const durationMs = Date.now() - startMs;
    const msg = err instanceof Error ? err.message : String(err);
    sqlite
      .prepare(
        `UPDATE backups SET status = 'failed', duration_ms = ?, error_message = ? WHERE id = ?`
      )
      .run(durationMs, msg, backupId);

    emitJobLog(backupId, `ERROR: ${msg}`);
    await sendAlert("Backup Failed", `Instance ${instance.name} (${type}): ${msg}`, "high");
  }
}

export async function cleanupExpiredBackups(): Promise<number> {
  const expired = sqlite
    .prepare(
      `SELECT b.*
       FROM backups b
       JOIN instances i ON i.id = b.instance_id
       WHERE b.status = 'success'
         AND b.type IN ('scheduled', 'manual')
         AND datetime(b.created_at) < datetime('now', '-' || i.retention_days || ' days')`
    )
    .all() as BackupRow[];

  const s3 = getS3Client();
  let removed = 0;

  for (const b of expired) {
    try {
      if (s3) {
        await s3.delete(b.storage_key);
      } else {
        const ext = b.encryption_algo !== "none" ? "dump.enc" : "dump";
        await Bun.$`rm -f ${join(LOCAL_BACKUP_DIR, `${b.id}.${ext}`)}`.quiet();
      }
      sqlite.prepare("DELETE FROM backups WHERE id = ?").run(b.id);
      removed++;
    } catch (err) {
      console.error(`Failed to cleanup backup ${b.id}:`, err);
    }
  }

  if (removed > 0) {
    logAudit("retention_cleanup", { removedCount: removed });
  }
  return removed;
}

export async function restoreBackupById(backupId: string): Promise<void> {
  const backup = sqlite.prepare("SELECT * FROM backups WHERE id = ?").get(backupId) as
    | BackupRow
    | undefined;
  if (!backup || backup.status !== "success") {
    throw new Error("Backup not found or not in success state");
  }

  const instance = sqlite
    .prepare("SELECT * FROM instances WHERE id = ?")
    .get(backup.instance_id) as InstanceRow | undefined;
  if (!instance) {
    throw new Error("Target instance not found");
  }

  // Safety net: take pre_restore snapshot first
  await runBackupForInstance(instance, "pre_restore");

  const tempFile = join(LOCAL_BACKUP_DIR, `restore-${backup.id}.tmp`);
  const s3 = getS3Client();

  if (s3) {
    const s3Data = await s3.file(backup.storage_key).arrayBuffer();
    await Bun.write(tempFile, s3Data);
  } else {
    const localEncrypted = join(
      LOCAL_BACKUP_DIR,
      `${backup.id}.${backup.encryption_algo !== "none" ? "dump.enc" : "dump"}`
    );
    await Bun.$`cp ${localEncrypted} ${tempFile}`.quiet();
  }

  const dbUrl = getInstanceAdminUrl(instance);

  try {
    if (backup.encryption_algo !== "none") {
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
        ["pg_restore", "--clean", "--if-exists", "--no-owner", "-d", dbUrl],
        { stdin: decProc.stdout, stderr: "pipe" }
      );

      const [decExit, resExit] = await Promise.all([decProc.exited, restoreProc.exited]);
      if (decExit !== 0) throw new Error(await new Response(decProc.stderr).text());
      if (resExit !== 0) throw new Error(await new Response(restoreProc.stderr).text());
    } else {
      const restoreProc = Bun.spawn(
        ["pg_restore", "--clean", "--if-exists", "--no-owner", "-d", dbUrl, tempFile],
        { stderr: "pipe" }
      );
      if ((await restoreProc.exited) !== 0) {
        throw new Error(await new Response(restoreProc.stderr).text());
      }
    }

    logAudit("restore", { backupId, storageKey: backup.storage_key }, instance.id);
  } finally {
    await Bun.$`rm -f ${tempFile}`.quiet();
  }
}

export async function getBackupDownloadResponse(backupId: string): Promise<Response> {
  const backup = sqlite.prepare("SELECT * FROM backups WHERE id = ?").get(backupId) as
    | BackupRow
    | undefined;
  if (!backup || backup.status !== "success") {
    return new Response("Backup not found", { status: 404 });
  }

  const s3 = getS3Client();
  const tempFile = join(LOCAL_BACKUP_DIR, `dl-${backup.id}.tmp`);

  if (backup.encryption_algo === "none") {
    if (s3) {
      return Response.redirect(s3.presign(backup.storage_key, { expiresIn: 300 }), 302);
    }
    const localFile = join(LOCAL_BACKUP_DIR, `${backup.id}.dump`);
    return new Response(Bun.file(localFile), {
      headers: {
        "Content-Disposition": `attachment; filename="${backup.id}.dump"`,
      },
    });
  }

  if (s3) {
    await Bun.write(tempFile, await s3.file(backup.storage_key).arrayBuffer());
  } else {
    await Bun.$`cp ${join(LOCAL_BACKUP_DIR, `${backup.id}.dump.enc`)} ${tempFile}`.quiet();
  }

  // Decrypt on the fly to standard PostgreSQL .dump format
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

  const decryptedBuf = await new Response(decProc.stdout).arrayBuffer();
  const exitCode = await decProc.exited;
  await Bun.$`rm -f ${tempFile}`.quiet();

  if (exitCode !== 0) {
    return new Response("Failed to decrypt backup", { status: 500 });
  }

  return new Response(decryptedBuf, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${backup.id}.dump"`,
    },
  });
}
