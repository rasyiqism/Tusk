import postgres from "postgres";
import { sqlite, type InstanceRow, logAudit } from "../db/schema";
import { encryptSecret } from "../lib/crypto";
import { emitJobLog, finishJobLog, initJobLog } from "../lib/jobStream";
import { isSafeOutboundHost } from "../lib/safeOutboundUrl";
import { getDatabaseTables } from "./pg-inspector";
import {
  getInstanceAdminUrl,
  isExternalPrimary,
  PG_ADMIN_URL,
  pauseSharedDatabase,
  resumeSharedDatabase,
} from "./postgres";

export interface MigrationPreflightResult {
  targetHost: string;
  targetDatabase: string;
  targetVersion: string;
  sourceTables: number;
  targetExistingTables: number;
}

export async function validateMigrationTargetUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error("URL PostgreSQL target tidak valid");
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("Target URL harus memakai protokol postgres:// atau postgresql://");
  }
  const dbPath = parsed.pathname.replace(/^\//, "");
  if (!parsed.hostname || !dbPath) {
    throw new Error("Target URL harus menyertakan host dan nama database (mis. postgres://user:pass@host:5432/dbname)");
  }

  const allowInternal = process.env.ALLOW_INTERNAL_URLS === "true";
  if (!allowInternal && !(await isSafeOutboundHost(parsed.hostname))) {
    throw new Error("Host target diblokir oleh kebijakan anti-SSRF (aktifkan ALLOW_INTERNAL_URLS=true untuk host internal)");
  }

  return parsed;
}

/**
 * Verifies connectivity, non-replica write readiness, and table counts for any target PG URL.
 */
export async function checkPgTargetHealth(
  rawTargetUrl: string,
  disallowSameAsUrl?: string
): Promise<{
  targetHost: string;
  targetDatabase: string;
  targetVersion: string;
  existingTables: number;
}> {
  const targetParsed = await validateMigrationTargetUrl(rawTargetUrl);
  const targetDb = targetParsed.pathname.replace(/^\//, "");

  if (disallowSameAsUrl) {
    const srcParsed = new URL(disallowSameAsUrl);
    const sameHost =
      targetParsed.hostname === srcParsed.hostname &&
      (targetParsed.port || "5432") === (srcParsed.port || "5432");
    const srcDb = srcParsed.pathname.replace(/^\//, "");
    if (sameHost && targetDb === srcDb) {
      throw new Error("Target tidak boleh sama persis dengan database sumber");
    }
  }

  const client = postgres(targetParsed.toString(), {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 5,
  });

  try {
    const [info] = await client`
      SELECT version() AS ver, current_database() AS db, pg_is_in_recovery() AS in_recovery
    `;
    if (info?.in_recovery) {
      throw new Error("Target PostgreSQL sedang dalam mode read-only replica");
    }
    const tgtTables = await getDatabaseTables(targetDb, targetParsed.toString());
    return {
      targetHost: `${targetParsed.hostname}:${targetParsed.port || "5432"}`,
      targetDatabase: String(info?.db || targetDb),
      targetVersion: String(info?.ver || "").split(" ").slice(0, 2).join(" "),
      existingTables: tgtTables.length,
    };
  } finally {
    await client.end({ timeout: 2 }).catch(() => {});
  }
}

/**
 * Streams logical pg_dump directly into pg_restore on the target URL without staging to disk.
 */
export async function streamPgDumpToTarget(
  sourceUrl: string,
  targetUrl: string,
  restoreRole?: string
): Promise<void> {
  const dumpProc = Bun.spawn(
    ["pg_dump", "--format=custom", "--no-owner", "--no-acl", sourceUrl],
    { stdout: "pipe", stderr: "pipe" }
  );
  const restoreArgs = [
    "pg_restore",
    "--clean",
    "--if-exists",
    "--no-owner",
    "--no-acl",
    ...(restoreRole ? [`--role=${restoreRole}`] : []),
    "-d",
    targetUrl,
  ];
  const restoreProc = Bun.spawn(restoreArgs, {
    stdin: dumpProc.stdout,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [dumpExit, restoreExit] = await Promise.all([dumpProc.exited, restoreProc.exited]);
  if (dumpExit !== 0) {
    throw new Error(`pg_dump error: ${await new Response(dumpProc.stderr).text()}`);
  }
  if (restoreExit !== 0) {
    throw new Error(`pg_restore error: ${await new Response(restoreProc.stderr).text()}`);
  }
}

export async function preflightMigration(
  instance: InstanceRow,
  rawTargetUrl: string
): Promise<MigrationPreflightResult> {
  const sourceUrl = getInstanceAdminUrl(instance);
  const [targetInfo, srcTables] = await Promise.all([
    checkPgTargetHealth(rawTargetUrl, sourceUrl),
    getDatabaseTables(instance.db_name, sourceUrl),
  ]);

  return {
    targetHost: targetInfo.targetHost,
    targetDatabase: targetInfo.targetDatabase,
    targetVersion: targetInfo.targetVersion,
    sourceTables: srcTables.length,
    targetExistingTables: targetInfo.existingTables,
  };
}

export function startMigrationJobAsync(
  instance: InstanceRow,
  options: { targetUrl: string; pauseSource?: boolean; promoteRemote?: boolean }
): string {
  const jobId = crypto.randomUUID();
  initJobLog(jobId);
  void executeMigrationJob(jobId, instance, options);
  return jobId;
}

async function executeMigrationJob(
  jobId: string,
  instance: InstanceRow,
  options: { targetUrl: string; pauseSource?: boolean; promoteRemote?: boolean }
) {
  const sourceUrl = getInstanceAdminUrl(instance);
  const lockKey = `active_restore:${instance.id}`;
  const shouldPauseSource =
    (options.pauseSource || options.promoteRemote) &&
    instance.status === "active" &&
    !isExternalPrimary(instance);
  let promoted = false;

  try {
    emitJobLog(jobId, `Validating target PostgreSQL connectivity for ${instance.db_name}...`);
    const preflight = await preflightMigration(instance, options.targetUrl);
    emitJobLog(
      jobId,
      `Target ready (${preflight.targetHost}/${preflight.targetDatabase}, ${preflight.targetVersion}). Source tables: ${preflight.sourceTables}`
    );

    if (shouldPauseSource) {
      emitJobLog(jobId, `Pausing writes on source role ${instance.db_username} for clean cutover...`);
      sqlite
        .prepare(
          `INSERT OR REPLACE INTO settings (key, value_json, updated_at)
           VALUES (?, ?, datetime('now'))`
        )
        .run(lockKey, JSON.stringify({ jobId, mode: "migrate", startedAt: new Date().toISOString() }));
      await pauseSharedDatabase(instance.db_name, instance.db_username);
    }

    emitJobLog(jobId, "Streaming pg_dump directly to target pg_restore (zero temp disk copy)...");
    await streamPgDumpToTarget(sourceUrl, options.targetUrl);

    const targetTables = await getDatabaseTables(
      preflight.targetDatabase,
      options.targetUrl
    );
    emitJobLog(
      jobId,
      `Post-flight verified: ${targetTables.length} table(s) present on target (source had ${preflight.sourceTables}).`
    );

    if (options.promoteRemote) {
      const encUrl = encryptSecret(options.targetUrl);
      sqlite
        .prepare(
          `UPDATE instances
           SET primary_tier = 'external',
               external_url_enc = ?,
               remote_admin_url_enc = ?,
               layer2_last_sync_at = datetime('now'),
               layer2_last_sync_status = 'success',
               layer2_last_error = NULL
           WHERE id = ?`
        )
        .run(encUrl, encUrl, instance.id);
      promoted = true;
      emitJobLog(
        jobId,
        "Promoted external target as Primary while keeping Tusk local database as Layer 2 standby."
      );
      logAudit(
        "scale_out_promote",
        { targetHost: preflight.targetHost, targetDatabase: preflight.targetDatabase },
        instance.id
      );
    } else {
      logAudit(
        "scale_out_copy",
        { targetHost: preflight.targetHost, targetDatabase: preflight.targetDatabase },
        instance.id
      );
    }

    emitJobLog(jobId, "Migration completed successfully.");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emitJobLog(jobId, `ERROR: ${msg}`);
  } finally {
    if (shouldPauseSource) {
      if (!promoted) {
        await resumeSharedDatabase(instance.db_name, instance.db_username).catch(() => {});
      }
      sqlite.prepare("DELETE FROM settings WHERE key = ?").run(lockKey);
    }
    finishJobLog(jobId);
  }
}

export function getLocalPgAdminHost(): string {
  return new URL(PG_ADMIN_URL).hostname;
}
