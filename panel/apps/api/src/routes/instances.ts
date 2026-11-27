import { Elysia, t } from "elysia";
import { sqlite, type InstanceRow, logAudit } from "../db/schema";
import {
  assertPgIdentifier,
  decryptSecret,
  encryptSecret,
  generateStrongPassword,
} from "../lib/crypto";
import {
  buildConnectionStrings,
  buildInstanceConnectionStrings,
  cloneSharedDatabase,
  createSharedDatabase,
  dropSharedDatabaseAndRole,
  getInstanceAdminUrl,
  getMaskedExternalTarget,
  isExternalPrimary,
  pauseSharedDatabase,
  resetRolePassword,
  resumeSharedDatabase,
  updateRoleLimits,
} from "../services/postgres";
import { getDatabaseTables, getTableColumns, getTablePreview } from "../services/pg-inspector";
import {
  deleteBackupFilesByInstance,
  isValidCronExpression,
  runBackupForInstance,
} from "../services/backup";
import {
  attachLayer2Target,
  detachLayer2Target,
  startLayer2SyncJobAsync,
  switchPrimaryTierJobAsync,
} from "../services/layer2";
import {
  checkPgTargetHealth,
  preflightMigration,
  startMigrationJobAsync,
} from "../services/migration";
import { authPlugin } from "./auth";

function serializeInstance(row: InstanceRow) {
  const extPrimary = isExternalPrimary(row);
  const extTarget = getMaskedExternalTarget(row);
  return {
    ...row,
    encrypted_password: undefined,
    remote_admin_url_enc: undefined,
    external_url_enc: undefined,
    has_saved_password: Boolean(row.encrypted_password),
    primary_tier: (extPrimary ? "external" : "local") as "local" | "external",
    is_remote: extPrimary,
    has_layer2: Boolean(row.external_url_enc || row.remote_admin_url_enc),
    layer2_target: extTarget,
  };
}

function assertInstanceUniqueInSqlite(name: string, dbName: string, username: string) {
  const conflict = sqlite
    .prepare(
      `SELECT name, db_name, db_username, status
       FROM instances
       WHERE name = ? OR db_name = ? OR db_username = ?
       LIMIT 1`
    )
    .get(name, dbName, username) as
    | { name: string; db_name: string; db_username: string; status: string }
    | undefined;
  if (conflict) {
    const suffix = conflict.status === "deleted" ? " (saat ini berada di Sampah; pulihkan atau hapus permanen dulu)" : "";
    throw new Error(`Nama instance/database/username sudah terdaftar${suffix}`);
  }
}

export const instanceRoutes = new Elysia({ prefix: "/instances" })
  .use(authPlugin)
  .onBeforeHandle(({ isAuthenticated, set }) => {
    if (!isAuthenticated) {
      set.status = 401;
      return { error: "Unauthorized" };
    }
  })
  .get(
    "/",
    ({ query }) => {
      const sql =
        query.include_deleted === "1"
          ? "SELECT * FROM instances ORDER BY created_at DESC"
          : "SELECT * FROM instances WHERE status != 'deleted' ORDER BY created_at DESC";
      const rows = sqlite.prepare(sql).all() as InstanceRow[];

      return rows.map(serializeInstance);
    },
    {
      query: t.Object({
        include_deleted: t.Optional(t.String()),
      }),
    }
  )
  .post(
    "/",
    async ({ body, set }) => {
      try {
        const name = assertPgIdentifier(body.name, "name");
        const dbName = assertPgIdentifier(body.db_name || name, "db_name");
        const username = assertPgIdentifier(body.db_username || `${name}_user`, "db_username");
        const backupCron = (body.backup_cron || "0 2 * * *").trim();
        if (!isValidCronExpression(backupCron)) {
          throw new Error("Format cron backup tidak valid (gunakan 5 field standar, mis. 0 2 * * *)");
        }
        const connectionLimit = body.connection_limit ?? 25;
        const statementTimeoutSec = body.statement_timeout_sec ?? 30;
        assertInstanceUniqueInSqlite(name, dbName, username);

        const password = generateStrongPassword(20);
        const id = crypto.randomUUID();

        await createSharedDatabase(dbName, username, password, {
          connectionLimit,
          statementTimeoutSec,
        });

        const encryptedPassword = encryptSecret(password);
        try {
          sqlite
            .prepare(
              `INSERT INTO instances (
                id, name, mode, env, pg_version, db_name, db_username, encrypted_password,
                direct_port, tx_pool_port, session_pool_port,
                backup_strategy, backup_cron, retention_days, connection_limit, statement_timeout_sec, status
              ) VALUES (?, ?, 'shared', ?, '17', ?, ?, ?, 5432, 6432, 5432, 'pg_dump', ?, ?, ?, ?, 'active')`
            )
            .run(
              id,
              name,
              body.env,
              dbName,
              username,
              encryptedPassword,
              backupCron,
              body.retention_days ?? 14,
              connectionLimit,
              statementTimeoutSec
            );
        } catch (dbErr) {
          await dropSharedDatabaseAndRole(dbName, username).catch(() => {});
          throw dbErr;
        }

        logAudit("create", { name, mode: "shared", dbName, username, env: body.env }, id);

        const instance = sqlite
          .prepare("SELECT * FROM instances WHERE id = ?")
          .get(id) as InstanceRow;

        return {
          instance: serializeInstance(instance),
          password,
          connectionStrings: buildConnectionStrings(dbName, username, password),
        };
      } catch (err) {
        set.status = 400;
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
    {
      body: t.Object({
        name: t.String(),
        env: t.Union([t.Literal("prod"), t.Literal("staging"), t.Literal("dev")]),
        db_name: t.Optional(t.String()),
        db_username: t.Optional(t.String()),
        retention_days: t.Optional(t.Number({ minimum: 1, maximum: 3650 })),
        backup_cron: t.Optional(t.String()),
        connection_limit: t.Optional(t.Number({ minimum: 1, maximum: 500 })),
        statement_timeout_sec: t.Optional(t.Number({ minimum: 1, maximum: 3600 })),
      }),
    }
  )
  .post(
    "/external",
    async ({ body, set }) => {
      try {
        const name = assertPgIdentifier(body.name, "name");
        const dbName = assertPgIdentifier(body.db_name || name, "db_name");
        const username = assertPgIdentifier(`${name}_user`, "db_username");
        const backupCron = (body.backup_cron || "0 2 * * *").trim();
        if (!isValidCronExpression(backupCron)) {
          throw new Error("Format cron backup tidak valid (gunakan 5 field standar)");
        }
        assertInstanceUniqueInSqlite(name, dbName, username);

        const targetUrl = body.target_url.trim();
        const info = await checkPgTargetHealth(targetUrl);

        // Pre-provision companion paused local Layer 2 slot so 1-click Sync & Failback work immediately
        const standbyPassword = generateStrongPassword(20);
        const id = crypto.randomUUID();

        await createSharedDatabase(dbName, username, standbyPassword, {
          connectionLimit: 25,
          statementTimeoutSec: 30,
        });
        await pauseSharedDatabase(dbName, username);

        const encStandbyPass = encryptSecret(standbyPassword);
        const encExtUrl = encryptSecret(targetUrl);
        const label = body.layer2_label?.trim().slice(0, 40) || info.targetHost;
        const syncMode = body.layer2_sync_mode === "manual" ? "manual" : "after_backup";

        try {
          sqlite
            .prepare(
              `INSERT INTO instances (
                id, name, mode, env, pg_version, db_name, db_username, encrypted_password,
                direct_port, tx_pool_port, session_pool_port,
                backup_strategy, backup_cron, retention_days,
                primary_tier, external_url_enc, remote_admin_url_enc, layer2_label, layer2_sync_mode,
                status
              ) VALUES (?, ?, 'shared', ?, '17', ?, ?, ?, 5432, 6432, 5432, 'pg_dump', ?, ?, 'external', ?, ?, ?, ?, 'active')`
            )
            .run(
              id,
              name,
              body.env,
              dbName,
              username,
              encStandbyPass,
              backupCron,
              body.retention_days ?? 14,
              encExtUrl,
              encExtUrl,
              label,
              syncMode
            );
        } catch (dbErr) {
          await dropSharedDatabaseAndRole(dbName, username).catch(() => {});
          throw dbErr;
        }

        logAudit(
          "create_external",
          { name, targetHost: info.targetHost, targetDatabase: info.targetDatabase, label },
          id
        );

        const instance = sqlite
          .prepare("SELECT * FROM instances WHERE id = ?")
          .get(id) as InstanceRow;

        return {
          instance: serializeInstance(instance),
          password: "",
          connectionStrings: buildInstanceConnectionStrings(instance, standbyPassword),
        };
      } catch (err) {
        set.status = 400;
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
    {
      body: t.Object({
        name: t.String(),
        env: t.Union([t.Literal("prod"), t.Literal("staging"), t.Literal("dev")]),
        target_url: t.String(),
        db_name: t.Optional(t.String()),
        layer2_label: t.Optional(t.String()),
        layer2_sync_mode: t.Optional(t.Union([t.Literal("manual"), t.Literal("after_backup")])),
        retention_days: t.Optional(t.Number({ minimum: 1, maximum: 3650 })),
        backup_cron: t.Optional(t.String()),
      }),
    }
  )
  .get("/:id/connections", ({ params, set }) => {
    const row = sqlite
      .prepare("SELECT * FROM instances WHERE id = ? AND status != 'deleted'")
      .get(params.id) as InstanceRow | undefined;
    if (!row) {
      set.status = 404;
      return { error: "Instance not found" };
    }
    let password = "<RESET_PASSWORD_REQUIRED>";
    let decryptError = false;
    if (row.encrypted_password) {
      try {
        password = decryptSecret(row.encrypted_password);
      } catch {
        password = "<KEY_MISMATCH_RESET_REQUIRED>";
        decryptError = true;
      }
    }
    try {
      return {
        password,
        decryptError,
        primaryTier: isExternalPrimary(row) ? ("external" as const) : ("local" as const),
        isRemote: isExternalPrimary(row),
        standby: {
          configured: Boolean(row.external_url_enc || row.remote_admin_url_enc),
          tier: isExternalPrimary(row) ? ("local" as const) : ("external" as const),
          target: isExternalPrimary(row)
            ? `pgbouncer / ${row.db_name}`
            : getMaskedExternalTarget(row),
          label: row.layer2_label,
          lastSyncAt: row.layer2_last_sync_at,
          lastSyncStatus: row.layer2_last_sync_status,
        },
        connectionStrings: buildInstanceConnectionStrings(row, password),
      };
    } catch {
      return {
        password,
        decryptError: true,
        primaryTier: "local" as const,
        isRemote: false,
        standby: null,
        connectionStrings: buildConnectionStrings(row.db_name, row.db_username, password),
      };
    }
  })
  .get("/:id/tables", async ({ params, set }) => {
    const row = sqlite
      .prepare("SELECT * FROM instances WHERE id = ? AND status != 'deleted'")
      .get(params.id) as InstanceRow | undefined;
    if (!row) {
      set.status = 404;
      return { error: "Instance not found" };
    }
    try {
      const tables = await getDatabaseTables(row.db_name, getInstanceAdminUrl(row));
      return { tables };
    } catch (err) {
      set.status = 400;
      return { error: err instanceof Error ? err.message : String(err) };
    }
  })
  .get("/:id/tables/:schema/:table/columns", async ({ params, set }) => {
    const row = sqlite
      .prepare("SELECT * FROM instances WHERE id = ? AND status != 'deleted'")
      .get(params.id) as InstanceRow | undefined;
    if (!row) {
      set.status = 404;
      return { error: "Instance not found" };
    }
    try {
      const columns = await getTableColumns(
        row.db_name,
        params.schema,
        params.table,
        getInstanceAdminUrl(row)
      );
      return { columns };
    } catch (err) {
      set.status = 400;
      return { error: err instanceof Error ? err.message : String(err) };
    }
  })
  .get("/:id/tables/:schema/:table/preview", async ({ params, set }) => {
    const row = sqlite
      .prepare("SELECT * FROM instances WHERE id = ? AND status != 'deleted'")
      .get(params.id) as InstanceRow | undefined;
    if (!row) {
      set.status = 404;
      return { error: "Instance not found" };
    }
    try {
      const rows = await getTablePreview(
        row.db_name,
        params.schema,
        params.table,
        getInstanceAdminUrl(row)
      );
      return { rows };
    } catch (err) {
      set.status = 400;
      return { error: err instanceof Error ? err.message : String(err) };
    }
  })
  .post("/:id/reset-password", async ({ params, set }) => {
    const row = sqlite
      .prepare("SELECT * FROM instances WHERE id = ? AND status != 'deleted'")
      .get(params.id) as InstanceRow | undefined;
    if (!row) {
      set.status = 404;
      return { error: "Instance not found" };
    }

    const newPassword = generateStrongPassword(20);
    await resetRolePassword(row.db_username, newPassword);

    sqlite
      .prepare("UPDATE instances SET encrypted_password = ? WHERE id = ?")
      .run(encryptSecret(newPassword), row.id);

    logAudit("reset_pw", { db_username: row.db_username }, row.id);

    return {
      password: newPassword,
      connectionStrings: buildConnectionStrings(row.db_name, row.db_username, newPassword),
    };
  })
  .post("/:id/pause", async ({ params, set }) => {
    const row = sqlite
      .prepare("SELECT * FROM instances WHERE id = ? AND status = 'active'")
      .get(params.id) as InstanceRow | undefined;
    if (!row) {
      set.status = 404;
      return { error: "Active instance not found" };
    }
    await pauseSharedDatabase(row.db_name, row.db_username);
    sqlite.prepare("UPDATE instances SET status = 'paused' WHERE id = ?").run(row.id);
    logAudit("pause", { db_name: row.db_name }, row.id);
    return { ok: true, status: "paused" };
  })
  .post("/:id/resume", async ({ params, set }) => {
    const row = sqlite
      .prepare("SELECT * FROM instances WHERE id = ? AND status = 'paused'")
      .get(params.id) as InstanceRow | undefined;
    if (!row) {
      set.status = 404;
      return { error: "Paused instance not found" };
    }
    await resumeSharedDatabase(row.db_name, row.db_username);
    sqlite.prepare("UPDATE instances SET status = 'active' WHERE id = ?").run(row.id);
    logAudit("resume", { db_name: row.db_name }, row.id);
    return { ok: true, status: "active" };
  })
  .post("/:id/undelete", async ({ params, set }) => {
    const row = sqlite
      .prepare("SELECT * FROM instances WHERE id = ? AND status = 'deleted'")
      .get(params.id) as InstanceRow | undefined;
    if (!row) {
      set.status = 404;
      return { error: "Deleted instance not found" };
    }
    await resumeSharedDatabase(row.db_name, row.db_username);
    sqlite
      .prepare("UPDATE instances SET status = 'active', deleted_at = NULL WHERE id = ?")
      .run(row.id);
    logAudit("undelete", { db_name: row.db_name }, row.id);
    return { ok: true, status: "active" };
  })
  .post(
    "/:id/clone",
    async ({ params, body, set }) => {
      const source = sqlite
        .prepare("SELECT * FROM instances WHERE id = ? AND status != 'deleted'")
        .get(params.id) as InstanceRow | undefined;
      if (!source) {
        set.status = 404;
        return { error: "Source instance not found" };
      }

      try {
        const targetName = assertPgIdentifier(body.target_name, "target_name");
        const targetDb = assertPgIdentifier(body.target_db_name || targetName, "target_db_name");
        const targetUser = assertPgIdentifier(`${targetName}_user`, "target_user");
        assertInstanceUniqueInSqlite(targetName, targetDb, targetUser);

        const password = generateStrongPassword(20);
        const id = crypto.randomUUID();

        await cloneSharedDatabase(source.db_name, targetDb, targetUser, password);

        try {
          sqlite
            .prepare(
              `INSERT INTO instances (
                id, name, mode, env, pg_version, db_name, db_username, encrypted_password,
                direct_port, tx_pool_port, session_pool_port,
                backup_strategy, retention_days, status
              ) VALUES (?, ?, 'shared', ?, '17', ?, ?, ?, 5432, 6432, 5432, 'pg_dump', ?, 'active')`
            )
            .run(
              id,
              targetName,
              body.env || "staging",
              targetDb,
              targetUser,
              encryptSecret(password),
              source.retention_days
            );
        } catch (dbErr) {
          await dropSharedDatabaseAndRole(targetDb, targetUser).catch(() => {});
          throw dbErr;
        }

        logAudit("clone", { sourceDb: source.db_name, targetDb }, id);

        return {
          id,
          name: targetName,
          db_name: targetDb,
          db_username: targetUser,
          password,
          connectionStrings: buildConnectionStrings(targetDb, targetUser, password),
        };
      } catch (err) {
        set.status = 400;
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
    {
      body: t.Object({
        target_name: t.String(),
        target_db_name: t.Optional(t.String()),
        env: t.Optional(t.Union([t.Literal("prod"), t.Literal("staging"), t.Literal("dev")])),
      }),
    }
  )
  .patch(
    "/:id/limits",
    async ({ params, body, set }) => {
      const row = sqlite
        .prepare("SELECT * FROM instances WHERE id = ? AND status != 'deleted'")
        .get(params.id) as InstanceRow | undefined;
      if (!row) {
        set.status = 404;
        return { error: "Instance not found" };
      }
      if (isExternalPrimary(row)) {
        set.status = 400;
        return { error: "Role limit lokal tidak berlaku saat node eksternal menjadi Primary" };
      }
      await updateRoleLimits(row.db_username, {
        connectionLimit: body.connection_limit,
        statementTimeoutSec: body.statement_timeout_sec,
      });
      sqlite
        .prepare("UPDATE instances SET connection_limit = ?, statement_timeout_sec = ? WHERE id = ?")
        .run(body.connection_limit, body.statement_timeout_sec, row.id);
      logAudit(
        "update_limits",
        { connection_limit: body.connection_limit, statement_timeout_sec: body.statement_timeout_sec },
        row.id
      );
      return { ok: true };
    },
    {
      body: t.Object({
        connection_limit: t.Number({ minimum: 1, maximum: 500 }),
        statement_timeout_sec: t.Number({ minimum: 1, maximum: 3600 }),
      }),
    }
  )
  .patch(
    "/:id/schedule",
    ({ params, body, set }) => {
      const row = sqlite
        .prepare("SELECT * FROM instances WHERE id = ? AND status != 'deleted'")
        .get(params.id) as InstanceRow | undefined;
      if (!row) {
        set.status = 404;
        return { error: "Instance not found" };
      }
      const cronExpr = body.backup_cron.trim();
      if (!isValidCronExpression(cronExpr)) {
        set.status = 400;
        return { error: "Format cron tidak valid (harus 5 field, mis. 0 */6 * * *)" };
      }
      sqlite
        .prepare("UPDATE instances SET backup_cron = ?, retention_days = ? WHERE id = ?")
        .run(cronExpr, body.retention_days, row.id);
      logAudit("update_schedule", { backup_cron: cronExpr, retention_days: body.retention_days }, row.id);
      return { ok: true };
    },
    {
      body: t.Object({
        backup_cron: t.String(),
        retention_days: t.Number({ minimum: 1, maximum: 3650 }),
      }),
    }
  )
  .post(
    "/:id/migrate/preflight",
    async ({ params, body, set }) => {
      const row = sqlite
        .prepare("SELECT * FROM instances WHERE id = ? AND status != 'deleted'")
        .get(params.id) as InstanceRow | undefined;
      if (!row) {
        set.status = 404;
        return { error: "Instance not found" };
      }
      try {
        const result = await preflightMigration(row, body.target_url);
        return { ok: true, preflight: result };
      } catch (err) {
        set.status = 400;
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
    {
      body: t.Object({
        target_url: t.String(),
      }),
    }
  )
  .post(
    "/:id/migrate",
    async ({ params, body, set }) => {
      const row = sqlite
        .prepare("SELECT * FROM instances WHERE id = ? AND status != 'deleted'")
        .get(params.id) as InstanceRow | undefined;
      if (!row) {
        set.status = 404;
        return { error: "Instance not found" };
      }
      try {
        await preflightMigration(row, body.target_url);
        const jobId = startMigrationJobAsync(row, {
          targetUrl: body.target_url.trim(),
          pauseSource: body.pause_source,
          promoteRemote: body.promote_remote,
        });
        return { ok: true, jobId };
      } catch (err) {
        set.status = 400;
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
    {
      body: t.Object({
        target_url: t.String(),
        pause_source: t.Optional(t.Boolean()),
        promote_remote: t.Optional(t.Boolean()),
      }),
    }
  )
  .put(
    "/:id/layer2",
    async ({ params, body, set }) => {
      const row = sqlite
        .prepare("SELECT * FROM instances WHERE id = ? AND status != 'deleted'")
        .get(params.id) as InstanceRow | undefined;
      if (!row) {
        set.status = 404;
        return { error: "Instance not found" };
      }
      try {
        const info = await attachLayer2Target(row, {
          targetUrl: body.target_url,
          label: body.label,
          syncMode: body.sync_mode,
        });
        return { ok: true, target: info };
      } catch (err) {
        set.status = 400;
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
    {
      body: t.Object({
        target_url: t.String(),
        label: t.Optional(t.String()),
        sync_mode: t.Optional(t.Union([t.Literal("manual"), t.Literal("after_backup")])),
      }),
    }
  )
  .delete("/:id/layer2", ({ params, set }) => {
    const row = sqlite
      .prepare("SELECT * FROM instances WHERE id = ? AND status != 'deleted'")
      .get(params.id) as InstanceRow | undefined;
    if (!row) {
      set.status = 404;
      return { error: "Instance not found" };
    }
    try {
      detachLayer2Target(row);
      return { ok: true };
    } catch (err) {
      set.status = 400;
      return { error: err instanceof Error ? err.message : String(err) };
    }
  })
  .post("/:id/layer2/sync", ({ params, set }) => {
    const row = sqlite
      .prepare("SELECT * FROM instances WHERE id = ? AND status != 'deleted'")
      .get(params.id) as InstanceRow | undefined;
    if (!row) {
      set.status = 404;
      return { error: "Instance not found" };
    }
    try {
      const jobId = startLayer2SyncJobAsync(row);
      return { ok: true, jobId };
    } catch (err) {
      set.status = 400;
      return { error: err instanceof Error ? err.message : String(err) };
    }
  })
  .post(
    "/:id/layer2/switch",
    ({ params, body, set }) => {
      const row = sqlite
        .prepare("SELECT * FROM instances WHERE id = ? AND status != 'deleted'")
        .get(params.id) as InstanceRow | undefined;
      if (!row) {
        set.status = 404;
        return { error: "Instance not found" };
      }
      try {
        const jobId = switchPrimaryTierJobAsync(row, {
          targetTier: body.target_tier,
          pauseCutover: body.pause_cutover,
        });
        return { ok: true, jobId };
      } catch (err) {
        set.status = 400;
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
    {
      body: t.Object({
        target_tier: t.Union([t.Literal("local"), t.Literal("external")]),
        pause_cutover: t.Optional(t.Boolean()),
      }),
    }
  )
  .delete(
    "/:id",
    async ({ params, query, set }) => {
      const row = sqlite
        .prepare("SELECT * FROM instances WHERE id = ?")
        .get(params.id) as InstanceRow | undefined;
      if (!row) {
        set.status = 404;
        return { error: "Instance not found" };
      }

      if (query.purge === "1") {
        await deleteBackupFilesByInstance(row.id);
        await dropSharedDatabaseAndRole(row.db_name, row.db_username).catch((err) => {
          if (!isExternalPrimary(row)) throw err;
        });

        const purgeTx = sqlite.transaction((instanceId: string) => {
          sqlite.prepare("DELETE FROM backups WHERE instance_id = ?").run(instanceId);
          sqlite
            .prepare("UPDATE audit_events SET instance_id = NULL WHERE instance_id = ?")
            .run(instanceId);
          sqlite.prepare("DELETE FROM instances WHERE id = ?").run(instanceId);
        });
        purgeTx(row.id);

        logAudit("purge", { db_name: row.db_name, wasExternalPrimary: isExternalPrimary(row) }, null);
        return { ok: true, purged: true };
      }

      if (row.status === "deleted") {
        set.status = 400;
        return { error: "Instance is already in trash (pass ?purge=1 to permanently delete)" };
      }

      // Trigger safety backup before disabling & soft-deleting
      const safetyBackup = await runBackupForInstance(row, "pre_delete");
      if (safetyBackup.status !== "success" && query.force !== "1") {
        set.status = 500;
        return {
          error: `Safety pre_delete backup failed (${safetyBackup.error_message || "unknown error"}). Delete aborted.`,
        };
      }

      if (!isExternalPrimary(row)) {
        await pauseSharedDatabase(row.db_name, row.db_username);
      }

      sqlite
        .prepare("UPDATE instances SET status = 'deleted', deleted_at = datetime('now') WHERE id = ?")
        .run(row.id);

      logAudit("delete", { db_name: row.db_name, forced: query.force === "1" }, row.id);
      return { ok: true };
    },
    {
      query: t.Object({
        force: t.Optional(t.String()),
        purge: t.Optional(t.String()),
      }),
    }
  );
