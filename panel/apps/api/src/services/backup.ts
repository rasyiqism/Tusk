import { S3Client } from "bun";
import type { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { sqlite, type BackupRow, type InstanceRow, logAudit } from "../db/schema";
import { sendAlert } from "./alert";
import { assertPgIdentifier } from "../lib/crypto";
import { emitJobLog, finishJobLog, initJobLog, subscribeJobLog } from "../lib/jobStream";
import { syncInstanceLayer2 } from "./layer2";
import { getInstanceAdminUrl, pauseSharedDatabase, resumeSharedDatabase } from "./postgres";

const BACKUP_ENCRYPTION_KEY = process.env.BACKUP_ENCRYPTION_KEY || "";
const LOCAL_BACKUP_DIR = join(process.env.DATA_DIR || "./data", "backups");
mkdirSync(LOCAL_BACKUP_DIR, { recursive: true });

let shuttingDown = false;
const activeJobs = new Set<Promise<unknown>>();

function trackActiveJob<T>(promise: Promise<T>): Promise<T> {
  activeJobs.add(promise);
  void promise.finally(() => {
    activeJobs.delete(promise);
  });
  return promise;
}

function assertNotShuttingDown() {
  if (shuttingDown) {
    throw new Error("Panel is shutting down for restart/redeploy; retry shortly.");
  }
}

/**
 * Prevents new backup/restore jobs from starting and waits up to timeoutMs
 * for active pg_dump/pg_restore child processes to finish before exit.
 */
export async function beginShutdownAndDrain(timeoutMs = 20_000): Promise<{ drained: boolean }> {
  shuttingDown = true;
  if (activeJobs.size === 0) return { drained: true };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  const result = await Promise.race([
    Promise.allSettled(Array.from(activeJobs)).then(() => "drained" as const),
    timeoutPromise,
  ]);
  if (timer) clearTimeout(timer);
  return { drained: result === "drained" };
}

/**
 * Reconciles interrupted backup/restore state left by a forced kill or crash
 * during redeploy: marks dangling 'running' backups as failed, cleans .tmp files
 * without touching valid backup archives, and unlocks any DB stuck mid-restore.
 */
export async function reconcileInterruptedJobsOnStartup(options?: {
  db?: Database;
  backupDir?: string;
  resumeFn?: (dbName: string, username: string) => Promise<void>;
}): Promise<{
  failedBackups: number;
  removedTempFiles: number;
  resumedRestores: number;
}> {
  const db = options?.db ?? sqlite;
  const backupDir = options?.backupDir ?? LOCAL_BACKUP_DIR;
  const resumeFn = options?.resumeFn ?? resumeSharedDatabase;

  const danglingBackups = db
    .prepare("SELECT id, encryption_algo FROM backups WHERE status = 'running'")
    .all() as Array<{ id: string; encryption_algo: string }>;

  let failedBackups = 0;
  let removedTempFiles = 0;

  if (danglingBackups.length > 0) {
    const failStmt = db.prepare(
      `UPDATE backups
       SET status = 'failed', error_message = COALESCE(error_message, 'Interrupted by container restart or redeploy')
       WHERE id = ? AND status = 'running'`
    );
    for (const row of danglingBackups) {
      const res = failStmt.run(row.id);
      if (res.changes > 0) failedBackups++;
      const ext = row.encryption_algo !== "none" ? "dump.enc" : "dump";
      const partialPath = join(backupDir, `${row.id}.${ext}`);
      try {
        rmSync(partialPath, { force: true });
      } catch {
        // ignore cleanup failure
      }
    }
  }

  try {
    for (const entry of readdirSync(backupDir)) {
      if (/^(restore|dl|verify)-.+\.tmp$/.test(entry)) {
        rmSync(join(backupDir, entry), { force: true });
        removedTempFiles++;
      }
    }
  } catch {
    // ignore if directory missing
  }

  const restoreLocks = db
    .prepare("SELECT key, value_json FROM settings WHERE key LIKE 'active_restore:%'")
    .all() as Array<{ key: string; value_json: string }>;

  let resumedRestores = 0;
  for (const lock of restoreLocks) {
    const instanceId = lock.key.slice("active_restore:".length);
    const inst = db
      .prepare("SELECT * FROM instances WHERE id = ?")
      .get(instanceId) as InstanceRow | undefined;

    if (inst && inst.status === "active") {
      try {
        await resumeFn(inst.db_name, inst.db_username);
        resumedRestores++;
        db.prepare(
          `INSERT INTO audit_events (instance_id, actor, ip_address, action, detail_json)
           VALUES (?, 'system', NULL, 'restore_interrupted_recovery', ?)`
        ).run(inst.id, JSON.stringify({ db_name: inst.db_name, reason: "startup_reconcile" }));
      } catch (err) {
        console.error(`Failed to auto-resume instance ${inst.id} after interrupted restore:`, err);
        continue;
      }
    }
    db.prepare("DELETE FROM settings WHERE key = ?").run(lock.key);
  }

  return { failedBackups, removedTempFiles, resumedRestores };
}

export function getS3Client(): S3Client | null {
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

export async function streamToFile(
  stream: ReadableStream<Uint8Array>,
  destPath: string
): Promise<void> {
  const writer = Bun.file(destPath).writer();
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) writer.write(value);
    }
    await writer.end();
  } catch (err) {
    try {
      await writer.end();
    } catch {
      // ignore close error
    }
    throw err;
  } finally {
    reader.releaseLock();
  }
}

export { subscribeJobLog as subscribeBackupJob, type JobLogEvent } from "../lib/jobStream";

function parseCronField(field: string, value: number, min: number, max: number): boolean {
  for (const rawPart of field.split(",")) {
    const part = rawPart.trim();
    if (!part) return false;
    const [rangePart, stepStr] = part.split("/");
    const step = stepStr ? Number(stepStr) : 1;
    if (!Number.isInteger(step) || step <= 0) return false;

    if (rangePart === "*") {
      if ((value - min) % step === 0) return true;
      continue;
    }

    if (rangePart.includes("-")) {
      const [startStr, endStr] = rangePart.split("-");
      const start = Number(startStr);
      const end = Number(endStr);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) return false;
      if (start < min || end > max) return false;
      if (value >= start && value <= end && (value - start) % step === 0) return true;
      continue;
    }

    const num = Number(rangePart);
    if (!Number.isInteger(num) || num < min || num > max) return false;
    if (value === num) return true;
  }
  return false;
}

export function isValidCronExpression(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const bounds: Array<[number, number]> = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ];
  return parts.every((field, idx) => {
    const [min, max] = bounds[idx]!;
    for (let v = min; v <= max; v++) {
      if (parseCronField(field, v, min, max)) return true;
    }
    return false;
  });
}

export function cronMatchesNow(expr: string, now = new Date()): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const dow = now.getDay();
  const [minF, hourF, domF, monF, dowF] = parts as [string, string, string, string, string];
  const dowMatch =
    parseCronField(dowF, dow, 0, 7) || (dow === 0 && parseCronField(dowF, 7, 0, 7));
  return (
    parseCronField(minF, now.getMinutes(), 0, 59) &&
    parseCronField(hourF, now.getHours(), 0, 23) &&
    parseCronField(domF, now.getDate(), 1, 31) &&
    parseCronField(monF, now.getMonth() + 1, 1, 12) &&
    dowMatch
  );
}

let cachedCompressFlag: string | null = null;

async function getPgDumpCompressionFlag(): Promise<string> {
  if (cachedCompressFlag) return cachedCompressFlag;
  try {
    const out = await Bun.$`pg_dump --help`.text();
    cachedCompressFlag = out.includes("zstd") ? "--compress=zstd:3" : "--compress=6";
  } catch {
    cachedCompressFlag = "--compress=6";
  }
  return cachedCompressFlag;
}

export function startBackupJobAsync(
  instance: InstanceRow,
  type: BackupRow["type"] = "manual"
): string {
  assertNotShuttingDown();
  const dbName = assertPgIdentifier(instance.db_name, "db_name");
  const backupId = crypto.randomUUID();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const encrypted = Boolean(BACKUP_ENCRYPTION_KEY);
  const ext = encrypted ? "dump.enc" : "dump";
  const storageKey = `${instance.name}/${timestamp}_${type}.${ext}`;

  initJobLog(backupId);

  sqlite
    .prepare(
      `INSERT INTO backups (id, instance_id, type, storage_key, encryption_algo, status)
       VALUES (?, ?, ?, ?, ?, 'running')`
    )
    .run(backupId, instance.id, type, storageKey, encrypted ? "aes-256-cbc" : "none");

  void trackActiveJob(executeBackupJob(backupId, instance, dbName, type, storageKey, encrypted));
  return backupId;
}

export async function runBackupForInstance(
  instance: InstanceRow,
  type: BackupRow["type"] = "manual"
): Promise<BackupRow> {
  assertNotShuttingDown();
  const dbName = assertPgIdentifier(instance.db_name, "db_name");
  const backupId = crypto.randomUUID();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const encrypted = Boolean(BACKUP_ENCRYPTION_KEY);
  const ext = encrypted ? "dump.enc" : "dump";
  const storageKey = `${instance.name}/${timestamp}_${type}.${ext}`;

  initJobLog(backupId);

  sqlite
    .prepare(
      `INSERT INTO backups (id, instance_id, type, storage_key, encryption_algo, status)
       VALUES (?, ?, ?, ?, ?, 'running')`
    )
    .run(backupId, instance.id, type, storageKey, encrypted ? "aes-256-cbc" : "none");

  await trackActiveJob(executeBackupJob(backupId, instance, dbName, type, storageKey, encrypted));
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
  const compressFlag = await getPgDumpCompressionFlag();
  emitJobLog(backupId, `Starting ${type} backup for ${dbName} (${compressFlag})...`);

  try {
    const dbUrl = getInstanceAdminUrl(instance);

    const dumpProc = Bun.spawn(
      ["pg_dump", "--format=custom", compressFlag, dbUrl],
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
      await streamToFile(dumpProc.stdout, localFile);
      const dumpExit = await dumpProc.exited;
      if (dumpExit !== 0) {
        throw new Error(await new Response(dumpProc.stderr).text());
      }
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

    if (type === "scheduled" || type === "manual") {
      const fresh = sqlite
        .prepare("SELECT * FROM instances WHERE id = ?")
        .get(instance.id) as InstanceRow | undefined;
      if (
        fresh &&
        (fresh.external_url_enc || fresh.remote_admin_url_enc) &&
        fresh.layer2_sync_mode === "after_backup"
      ) {
        emitJobLog(backupId, "Triggering background Layer 2 warm-standby mirror...");
        void trackActiveJob(
          syncInstanceLayer2(fresh).catch((err) => {
            console.error(`Auto Layer 2 mirror warning for ${fresh.db_name}:`, err);
          })
        );
      }
    }
  } catch (err) {
    const durationMs = Date.now() - startMs;
    const msg = err instanceof Error ? err.message : String(err);
    await Bun.$`rm -f ${localFile}`.quiet().catch(() => {});
    sqlite
      .prepare(
        `UPDATE backups SET status = 'failed', duration_ms = ?, error_message = ? WHERE id = ?`
      )
      .run(durationMs, msg, backupId);

    emitJobLog(backupId, `ERROR: ${msg}`);
    await sendAlert("Backup Failed", `Instance ${instance.name} (${type}): ${msg}`, "high");
  } finally {
    finishJobLog(backupId);
  }
}

async function deleteSingleBackupArtifact(b: BackupRow, s3: S3Client | null) {
  if (s3) {
    await s3.delete(b.storage_key);
  } else {
    const ext = b.encryption_algo !== "none" ? "dump.enc" : "dump";
    await Bun.$`rm -f ${join(LOCAL_BACKUP_DIR, `${b.id}.${ext}`)}`.quiet();
  }
}

export async function deleteBackupFilesByInstance(instanceId: string): Promise<number> {
  const rows = sqlite
    .prepare("SELECT * FROM backups WHERE instance_id = ? AND status = 'success'")
    .all(instanceId) as BackupRow[];
  const s3 = getS3Client();
  let removed = 0;

  for (const b of rows) {
    try {
      await deleteSingleBackupArtifact(b, s3);
      removed++;
    } catch (err) {
      console.error(`Failed to delete backup artifact ${b.id} during purge:`, err);
    }
  }
  return removed;
}

export async function cleanupExpiredBackups(): Promise<number> {
  const expired = sqlite
    .prepare(
      `SELECT b.*
       FROM backups b
       JOIN instances i ON i.id = b.instance_id
       WHERE b.status = 'success'
         AND b.type IN ('scheduled', 'manual')
         AND datetime(b.created_at) < datetime('now', '-' || MAX(1, i.retention_days) || ' days')`
    )
    .all() as BackupRow[];

  const s3 = getS3Client();
  let removed = 0;

  for (const b of expired) {
    try {
      await deleteSingleBackupArtifact(b, s3);
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
  assertNotShuttingDown();
  return trackActiveJob((async () => {
    const backup = sqlite.prepare("SELECT * FROM backups WHERE id = ?").get(backupId) as
      | BackupRow
      | undefined;
    if (!backup || backup.status !== "success") {
      throw new Error("Backup not found or not in success state");
    }
    if (backup.encryption_algo !== "none" && !BACKUP_ENCRYPTION_KEY) {
      throw new Error("BACKUP_ENCRYPTION_KEY is required to decrypt this backup");
    }

    const instance = sqlite
      .prepare("SELECT * FROM instances WHERE id = ?")
      .get(backup.instance_id) as InstanceRow | undefined;
    if (!instance) {
      throw new Error("Target instance not found");
    }

    // Safety net: take pre_restore snapshot first and verify it succeeded
    const preRestore = await runBackupForInstance(instance, "pre_restore");
    if (preRestore.status !== "success") {
      throw new Error(
        `Safety pre_restore snapshot failed (${preRestore.error_message || "unknown error"}); restore aborted`
      );
    }

    const tempFile = join(LOCAL_BACKUP_DIR, `restore-${backup.id}.tmp`);
    const s3 = getS3Client();

    if (s3) {
      await streamToFile(s3.file(backup.storage_key).stream(), tempFile);
    } else {
      const localEncrypted = join(
        LOCAL_BACKUP_DIR,
        `${backup.id}.${backup.encryption_algo !== "none" ? "dump.enc" : "dump"}`
      );
      await Bun.$`cp ${localEncrypted} ${tempFile}`.quiet();
    }

    const dbUrl = getInstanceAdminUrl(instance);
    const targetRole = assertPgIdentifier(instance.db_username, "db_username");
    const wasActive = instance.status === "active";
    const lockKey = `active_restore:${instance.id}`;

    try {
      // Mark restore lock before disconnecting clients so startup reconcile can
      // auto-resume the role if container crashes or redeploys mid-restore.
      if (wasActive) {
        sqlite
          .prepare(
            `INSERT OR REPLACE INTO settings (key, value_json, updated_at)
             VALUES (?, ?, datetime('now'))`
          )
          .run(lockKey, JSON.stringify({ backupId, startedAt: new Date().toISOString() }));
        await pauseSharedDatabase(instance.db_name, instance.db_username);
      }

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
          ["pg_restore", "--clean", "--if-exists", "--no-owner", `--role=${targetRole}`, "-d", dbUrl],
          { stdin: decProc.stdout, stderr: "pipe" }
        );

        const [decExit, resExit] = await Promise.all([decProc.exited, restoreProc.exited]);
        if (decExit !== 0) throw new Error(await new Response(decProc.stderr).text());
        if (resExit !== 0) throw new Error(await new Response(restoreProc.stderr).text());
      } else {
        const restoreProc = Bun.spawn(
          ["pg_restore", "--clean", "--if-exists", "--no-owner", `--role=${targetRole}`, "-d", dbUrl, tempFile],
          { stderr: "pipe" }
        );
        if ((await restoreProc.exited) !== 0) {
          throw new Error(await new Response(restoreProc.stderr).text());
        }
      }

      logAudit("restore", { backupId, storageKey: backup.storage_key }, instance.id);
    } finally {
      if (wasActive) {
        await resumeSharedDatabase(instance.db_name, instance.db_username).catch(() => {});
        sqlite.prepare("DELETE FROM settings WHERE key = ?").run(lockKey);
      }
      await Bun.$`rm -f ${tempFile}`.quiet().catch(() => {});
    }
  })());
}

export async function getBackupDownloadResponse(backupId: string): Promise<Response> {
  const backup = sqlite.prepare("SELECT * FROM backups WHERE id = ?").get(backupId) as
    | BackupRow
    | undefined;
  if (!backup || backup.status !== "success") {
    return new Response("Backup not found", { status: 404 });
  }

  const s3 = getS3Client();

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

  if (!BACKUP_ENCRYPTION_KEY) {
    return new Response("BACKUP_ENCRYPTION_KEY is not configured", { status: 500 });
  }

  const tempFile = join(LOCAL_BACKUP_DIR, `dl-${backup.id}-${Date.now()}.tmp`);
  try {
    if (s3) {
      await streamToFile(s3.file(backup.storage_key).stream(), tempFile);
    } else {
      await Bun.$`cp ${join(LOCAL_BACKUP_DIR, `${backup.id}.dump.enc`)} ${tempFile}`.quiet();
    }
  } catch {
    await Bun.$`rm -f ${tempFile}`.quiet().catch(() => {});
    return new Response("Failed to fetch backup artifact", { status: 500 });
  }

  // Stream decrypted output directly without buffering the entire archive in RAM
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

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = decProc.stdout.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) controller.enqueue(value);
        }
        const exitCode = await decProc.exited;
        if (exitCode !== 0) {
          const errText = await new Response(decProc.stderr).text();
          controller.error(new Error(errText || "OpenSSL decryption failed"));
          return;
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      } finally {
        reader.releaseLock();
        await Bun.$`rm -f ${tempFile}`.quiet().catch(() => {});
      }
    },
    async cancel() {
      decProc.kill();
      await Bun.$`rm -f ${tempFile}`.quiet().catch(() => {});
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${backup.id}.dump"`,
    },
  });
}
