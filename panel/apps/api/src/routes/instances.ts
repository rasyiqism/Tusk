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
  cloneSharedDatabase,
  createSharedDatabase,
  dropSharedDatabaseAndRole,
  getInstanceAdminUrl,
  pauseSharedDatabase,
  resetRolePassword,
  resumeSharedDatabase,
} from "../services/postgres";
import { getDatabaseTables, getTableColumns, getTablePreview } from "../services/pg-inspector";
import { deleteBackupFilesByInstance, runBackupForInstance } from "../services/backup";
import { authPlugin } from "./auth";

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

      return rows.map((row) => ({
        ...row,
        encrypted_password: undefined,
        has_saved_password: Boolean(row.encrypted_password),
      }));
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
        assertInstanceUniqueInSqlite(name, dbName, username);

        const password = generateStrongPassword(20);
        const id = crypto.randomUUID();

        await createSharedDatabase(dbName, username, password);

        const encryptedPassword = encryptSecret(password);
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
              name,
              body.env,
              dbName,
              username,
              encryptedPassword,
              body.retention_days ?? 14
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
          instance: {
            ...instance,
            encrypted_password: undefined,
          },
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
        retention_days: t.Optional(t.Number()),
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
    const password = row.encrypted_password
      ? decryptSecret(row.encrypted_password)
      : "<RESET_PASSWORD_REQUIRED>";
    return {
      password,
      connectionStrings: buildConnectionStrings(row.db_name, row.db_username, password),
    };
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
        await dropSharedDatabaseAndRole(row.db_name, row.db_username);

        const purgeTx = sqlite.transaction((instanceId: string) => {
          sqlite.prepare("DELETE FROM backups WHERE instance_id = ?").run(instanceId);
          sqlite
            .prepare("UPDATE audit_events SET instance_id = NULL WHERE instance_id = ?")
            .run(instanceId);
          sqlite.prepare("DELETE FROM instances WHERE id = ?").run(instanceId);
        });
        purgeTx(row.id);

        logAudit("purge", { db_name: row.db_name }, null);
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

      await pauseSharedDatabase(row.db_name, row.db_username);

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
