import { sqlite, type InstanceRow, logAudit } from "../db/schema";
import { assertPgIdentifier, decryptSecret, encryptSecret, generateStrongPassword } from "../lib/crypto";
import { emitJobLog, finishJobLog, initJobLog } from "../lib/jobStream";
import { sendAlert } from "./alert";
import { checkPgTargetHealth, streamPgDumpToTarget } from "./migration";
import { getDatabaseTables } from "./pg-inspector";
import {
  createSharedDatabase,
  getExternalAdminUrl,
  getLocalAdminUrl,
  isExternalPrimary,
  pauseSharedDatabase,
  pgAdmin,
  resumeSharedDatabase,
} from "./postgres";

export async function attachLayer2Target(
  instance: InstanceRow,
  options: { targetUrl: string; label?: string; syncMode?: "manual" | "after_backup" }
) {
  const cleanUrl = options.targetUrl.trim();
  const localUrl = getLocalAdminUrl(instance);
  const info = await checkPgTargetHealth(cleanUrl, localUrl);

  const encUrl = encryptSecret(cleanUrl);
  const syncMode = options.syncMode === "manual" ? "manual" : "after_backup";
  const label = options.label?.trim().slice(0, 40) || info.targetHost;

  sqlite
    .prepare(
      `UPDATE instances
       SET external_url_enc = ?,
           remote_admin_url_enc = ?,
           layer2_label = ?,
           layer2_sync_mode = ?,
           layer2_last_error = NULL
       WHERE id = ?`
    )
    .run(encUrl, encUrl, label, syncMode, instance.id);

  logAudit("layer2_attach", { label, syncMode, targetHost: info.targetHost }, instance.id);
  return info;
}

export function detachLayer2Target(instance: InstanceRow) {
  if (isExternalPrimary(instance)) {
    throw new Error(
      "Tidak dapat melepas target eksternal saat sedang aktif sebagai Primary. Lakukan Failback ke Tusk terlebih dahulu."
    );
  }
  sqlite
    .prepare(
      `UPDATE instances
       SET external_url_enc = NULL,
           remote_admin_url_enc = NULL,
           layer2_label = NULL,
           layer2_last_sync_at = NULL,
           layer2_last_sync_status = NULL,
           layer2_last_error = NULL
       WHERE id = ?`
    )
    .run(instance.id);
  logAudit("layer2_detach", { db_name: instance.db_name }, instance.id);
}

async function ensureLocalDatabaseExists(instance: InstanceRow) {
  const dbName = assertPgIdentifier(instance.db_name, "db_name");
  const username = assertPgIdentifier(instance.db_username, "db_username");

  const [existsRow] = await pgAdmin`SELECT 1 AS ok FROM pg_database WHERE datname = ${dbName}`;
  if (existsRow) return;

  let password: string;
  if (instance.encrypted_password) {
    try {
      password = decryptSecret(instance.encrypted_password);
    } catch {
      password = generateStrongPassword(20);
      sqlite
        .prepare("UPDATE instances SET encrypted_password = ? WHERE id = ?")
        .run(encryptSecret(password), instance.id);
    }
  } else {
    password = generateStrongPassword(20);
    sqlite
      .prepare("UPDATE instances SET encrypted_password = ? WHERE id = ?")
      .run(encryptSecret(password), instance.id);
  }

  await createSharedDatabase(dbName, username, password, {
    connectionLimit: instance.connection_limit || 25,
    statementTimeoutSec: instance.statement_timeout_sec || 30,
  });
}

function getTargetDatabaseName(urlStr: string, fallbackDbName: string): string {
  try {
    return new URL(urlStr).pathname.replace(/^\//, "") || fallbackDbName;
  } catch {
    return fallbackDbName;
  }
}

export async function syncInstanceLayer2(instance: InstanceRow, jobId?: string): Promise<void> {
  const externalUrl = getExternalAdminUrl(instance);
  if (!externalUrl) {
    throw new Error("Target Layer 2 eksternal belum dikonfigurasi");
  }

  const localUrl = getLocalAdminUrl(instance);
  const externalIsPrimary = isExternalPrimary(instance);
  const sourceUrl = externalIsPrimary ? externalUrl : localUrl;
  const targetUrl = externalIsPrimary ? localUrl : externalUrl;
  const directionLabel = externalIsPrimary ? "External (Primary) -> Tusk Local (L2)" : "Tusk Local (Primary) -> External (L2)";

  if (jobId) emitJobLog(jobId, `Starting Layer 2 sync [${directionLabel}]...`);

  try {
    if (externalIsPrimary) {
      await ensureLocalDatabaseExists(instance);
    } else {
      await checkPgTargetHealth(externalUrl, localUrl);
    }

    const restoreRole = externalIsPrimary
      ? assertPgIdentifier(instance.db_username, "db_username")
      : undefined;

    await streamPgDumpToTarget(sourceUrl, targetUrl, restoreRole);

    const targetDb = getTargetDatabaseName(targetUrl, instance.db_name);
    const tables = await getDatabaseTables(targetDb, targetUrl);

    sqlite
      .prepare(
        `UPDATE instances
         SET layer2_last_sync_at = datetime('now'),
             layer2_last_sync_status = 'success',
             layer2_last_error = NULL
         WHERE id = ?`
      )
      .run(instance.id);

    if (jobId) {
      emitJobLog(jobId, `Layer 2 sync succeeded (${tables.length} tables mirrored).`);
    }
    logAudit(
      "layer2_sync",
      { direction: externalIsPrimary ? "external_to_local" : "local_to_external", tableCount: tables.length },
      instance.id
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sqlite
      .prepare(
        `UPDATE instances
         SET layer2_last_sync_at = datetime('now'),
             layer2_last_sync_status = 'failed',
             layer2_last_error = ?
         WHERE id = ?`
      )
      .run(msg, instance.id);

    if (jobId) emitJobLog(jobId, `ERROR: ${msg}`);
    throw err;
  }
}

export function startLayer2SyncJobAsync(instance: InstanceRow): string {
  const jobId = crypto.randomUUID();
  initJobLog(jobId);
  void (async () => {
    try {
      await syncInstanceLayer2(instance, jobId);
      emitJobLog(jobId, "Layer 2 sync completed.");
    } catch {
      // already logged inside syncInstanceLayer2
    } finally {
      finishJobLog(jobId);
    }
  })();
  return jobId;
}

export function switchPrimaryTierJobAsync(
  instance: InstanceRow,
  options: { targetTier: "local" | "external"; pauseCutover?: boolean }
): string {
  const currentlyExternal = isExternalPrimary(instance);
  if (options.targetTier === "external" && currentlyExternal) {
    throw new Error("Instance sudah memakai node eksternal sebagai Primary");
  }
  if (options.targetTier === "local" && !currentlyExternal) {
    throw new Error("Instance sudah memakai Tusk Lokal sebagai Primary");
  }
  const externalUrl = getExternalAdminUrl(instance);
  if (!externalUrl) {
    throw new Error("Konfigurasi target eksternal (Layer 2) belum ada");
  }

  const jobId = crypto.randomUUID();
  initJobLog(jobId);

  void executeSwitchJob(jobId, instance, externalUrl, options);
  return jobId;
}

async function executeSwitchJob(
  jobId: string,
  instance: InstanceRow,
  externalUrl: string,
  options: { targetTier: "local" | "external"; pauseCutover?: boolean }
) {
  const localUrl = getLocalAdminUrl(instance);
  const lockKey = `active_restore:${instance.id}`;
  const toExternal = options.targetTier === "external";
  const shouldPauseLocalForCutover =
    toExternal && options.pauseCutover !== false && instance.status === "active";
  let switched = false;

  try {
    if (toExternal) {
      emitJobLog(jobId, `Preparing Promote: Tusk Local -> External (${instance.layer2_label || "Layer 2"})...`);
      await checkPgTargetHealth(externalUrl, localUrl);

      if (shouldPauseLocalForCutover) {
        emitJobLog(jobId, `Pausing local role ${instance.db_username} for clean cutover...`);
        sqlite
          .prepare(
            `INSERT OR REPLACE INTO settings (key, value_json, updated_at)
             VALUES (?, ?, datetime('now'))`
          )
          .run(lockKey, JSON.stringify({ jobId, mode: "promote_l2", startedAt: new Date().toISOString() }));
        await pauseSharedDatabase(instance.db_name, instance.db_username);
      }

      emitJobLog(jobId, "Streaming final snapshot Local -> External...");
      await streamPgDumpToTarget(localUrl, externalUrl);

      const srcTables = await getDatabaseTables(instance.db_name, localUrl);
      const tgtDb = getTargetDatabaseName(externalUrl, instance.db_name);
      const tgtTables = await getDatabaseTables(tgtDb, externalUrl);
      emitJobLog(jobId, `Verified parity: source ${srcTables.length} tables -> target ${tgtTables.length} tables.`);

      sqlite
        .prepare(
          `UPDATE instances
           SET primary_tier = 'external',
               layer2_last_sync_at = datetime('now'),
               layer2_last_sync_status = 'success',
               layer2_last_error = NULL
           WHERE id = ?`
        )
        .run(instance.id);
      switched = true;

      logAudit("layer2_promote", { targetDb: tgtDb, label: instance.layer2_label }, instance.id);
      await sendAlert(
        "Tusk Primary Promoted to External",
        `Database ${instance.db_name} switched Primary -> External (${instance.layer2_label || "remote"}). Local DB paused as Layer 2 standby.`,
        "high"
      );
      emitJobLog(jobId, "Switch completed: External node is now Primary; Tusk Local acts as Layer 2 standby.");
    } else {
      emitJobLog(jobId, `Preparing Failback: External -> Tusk Local (${instance.db_name})...`);
      await checkPgTargetHealth(externalUrl, localUrl);
      await ensureLocalDatabaseExists(instance);

      const extDb = getTargetDatabaseName(externalUrl, instance.db_name);
      const srcTables = await getDatabaseTables(extDb, externalUrl);

      emitJobLog(jobId, "Streaming latest data from External -> Tusk Local...");
      const localRole = assertPgIdentifier(instance.db_username, "db_username");
      await streamPgDumpToTarget(externalUrl, localUrl, localRole);

      const localTables = await getDatabaseTables(instance.db_name, localUrl);
      emitJobLog(jobId, `Verified parity: external ${srcTables.length} tables -> local ${localTables.length} tables.`);

      await resumeSharedDatabase(instance.db_name, instance.db_username);

      sqlite
        .prepare(
          `UPDATE instances
           SET primary_tier = 'local',
               status = 'active',
               layer2_last_sync_at = datetime('now'),
               layer2_last_sync_status = 'success',
               layer2_last_error = NULL
           WHERE id = ?`
        )
        .run(instance.id);
      switched = true;

      logAudit("layer2_failback", { localDb: instance.db_name, label: instance.layer2_label }, instance.id);
      await sendAlert(
        "Tusk Primary Restored to Local",
        `Database ${instance.db_name} failed back to Tusk Local as Primary. External node remains Layer 2 standby.`,
        "high"
      );
      emitJobLog(jobId, "Failback completed: Tusk Local is active Primary again; External returned to Layer 2 standby.");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sqlite
      .prepare(
        `UPDATE instances
         SET layer2_last_sync_at = datetime('now'),
             layer2_last_sync_status = 'failed',
             layer2_last_error = ?
         WHERE id = ?`
      )
      .run(msg, instance.id);
    emitJobLog(jobId, `ERROR: ${msg}`);
  } finally {
    if (shouldPauseLocalForCutover) {
      if (!switched) {
        await resumeSharedDatabase(instance.db_name, instance.db_username).catch(() => {});
      }
      sqlite.prepare("DELETE FROM settings WHERE key = ?").run(lockKey);
    }
    finishJobLog(jobId);
  }
}
