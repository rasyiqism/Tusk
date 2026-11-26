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
  getInstanceAdminUrl,
  pauseSharedDatabase,
  resetRolePassword,
  resumeSharedDatabase,
} from "../services/postgres";
import { getDatabaseTables, getTableColumns, getTablePreview } from "../services/pg-inspector";
import { runBackupForInstance } from "../services/backup";
import {
  controlDedicatedContainer,
  recreateDedicatedPgbouncer,
  spawnDedicatedContainer,
} from "../services/docker";
import { authPlugin } from "./auth";

export const instanceRoutes = new Elysia({ prefix: "/instances" })
  .use(authPlugin)
  .onBeforeHandle(({ isAuthenticated, set }) => {
    if (!isAuthenticated) {
      set.status = 401;
      return { error: "Unauthorized" };
    }
  })
  .get("/", () => {
    const rows = sqlite
      .prepare("SELECT * FROM instances WHERE status != 'deleted' ORDER BY created_at DESC")
      .all() as InstanceRow[];

    return rows.map((row) => ({
      ...row,
      encrypted_password: undefined,
      has_saved_password: Boolean(row.encrypted_password),
    }));
  })
  .post(
    "/",
    async ({ body, set }) => {
      try {
        const name = assertPgIdentifier(body.name, "name");
        const dbName = assertPgIdentifier(body.db_name || name, "db_name");
        const username = assertPgIdentifier(body.db_username || `${name}_user`, "db_username");
        const password = generateStrongPassword(20);
        const id = crypto.randomUUID();

        const mode = body.mode || "shared";
        const pgVersion = (body.pg_version === "18" ? "18" : "17") as "17" | "18";

        let containerId: string | null = null;
        let directPort = 5432;
        let txPoolPort = 6432;
        let cpuLimit: number | null = null;
        let ramLimitMb: number | null = null;
        let backupStrategy: "pg_dump" | "pitr_walg" = "pg_dump";

        if (mode === "dedicated") {
          cpuLimit = body.cpu_limit ?? 1;
          ramLimitMb = body.ram_limit_mb ?? 512;
          directPort = body.direct_port ?? 5440 + Math.floor(Math.random() * 400);
          txPoolPort = directPort + 1000;
          backupStrategy = body.enable_walg ? "pitr_walg" : "pg_dump";
          containerId = await spawnDedicatedContainer({
            instanceId: id,
            name,
            dbName,
            dbUsername: username,
            password,
            pgVersion,
            cpuLimit,
            ramLimitMb,
            hostPort: directPort,
            enableWalg: body.enable_walg,
          });
        } else {
          await createSharedDatabase(dbName, username, password);
        }

        const encryptedPassword = encryptSecret(password);
        sqlite
          .prepare(
            `INSERT INTO instances (
              id, name, mode, env, pg_version, db_name, db_username, encrypted_password,
              container_id, direct_port, tx_pool_port, cpu_limit, ram_limit_mb,
              backup_strategy, retention_days, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`
          )
          .run(
            id,
            name,
            mode,
            body.env,
            pgVersion,
            dbName,
            username,
            encryptedPassword,
            containerId,
            directPort,
            txPoolPort,
            cpuLimit,
            ramLimitMb,
            backupStrategy,
            body.retention_days ?? 14
          );

        logAudit("create", { name, mode, dbName, username, env: body.env, containerId }, id);

        const instance = sqlite
          .prepare("SELECT * FROM instances WHERE id = ?")
          .get(id) as InstanceRow;

        return {
          instance: {
            ...instance,
            encrypted_password: undefined,
          },
          password,
          connectionStrings: buildConnectionStrings(
            dbName,
            username,
            password,
            instance.tx_pool_port,
            instance.session_pool_port,
            directPort,
            mode === "dedicated" ? `pgb-ded-${name}` : "pgbouncer-tx"
          ),
        };
      } catch (err) {
        set.status = 400;
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
    {
      body: t.Object({
        name: t.String(),
        mode: t.Optional(t.Union([t.Literal("shared"), t.Literal("dedicated")])),
        env: t.Union([t.Literal("prod"), t.Literal("staging"), t.Literal("dev")]),
        db_name: t.Optional(t.String()),
        db_username: t.Optional(t.String()),
        pg_version: t.Optional(t.String()),
        cpu_limit: t.Optional(t.Number()),
        ram_limit_mb: t.Optional(t.Number()),
        direct_port: t.Optional(t.Number()),
        enable_walg: t.Optional(t.Boolean()),
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
      connectionStrings: buildConnectionStrings(
        row.db_name,
        row.db_username,
        password,
        row.tx_pool_port,
        row.session_pool_port,
        row.direct_port,
        row.mode === "dedicated" ? `pgb-ded-${row.name}` : "pgbouncer-tx"
      ),
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
    await resetRolePassword(
      row.db_username,
      newPassword,
      row.mode === "dedicated" ? getInstanceAdminUrl(row) : undefined
    );

    if (row.mode === "dedicated") {
      await recreateDedicatedPgbouncer({
        instanceId: row.id,
        name: row.name,
        dbName: row.db_name,
        dbUsername: row.db_username,
        password: newPassword,
        pgVersion: row.pg_version === "18" ? "18" : "17",
        cpuLimit: row.cpu_limit ?? 1,
        ramLimitMb: row.ram_limit_mb ?? 512,
        hostPort: row.direct_port,
        enableWalg: row.backup_strategy === "pitr_walg",
      });
    }

    sqlite
      .prepare("UPDATE instances SET encrypted_password = ? WHERE id = ?")
      .run(encryptSecret(newPassword), row.id);

    logAudit("reset_pw", { db_username: row.db_username }, row.id);

    return {
      password: newPassword,
      connectionStrings: buildConnectionStrings(
        row.db_name,
        row.db_username,
        newPassword,
        row.tx_pool_port,
        row.session_pool_port,
        row.direct_port,
        row.mode === "dedicated" ? `pgb-ded-${row.name}` : "pgbouncer-tx"
      ),
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
    if (row.mode === "dedicated" && row.container_id) {
      await controlDedicatedContainer(row.container_id, "pause", row.name);
    } else {
      await pauseSharedDatabase(row.db_name, row.db_username);
    }
    sqlite.prepare("UPDATE instances SET status = 'paused' WHERE id = ?").run(row.id);
    logAudit("pause", { db_name: row.db_name, mode: row.mode }, row.id);
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
    if (row.mode === "dedicated" && row.container_id) {
      await controlDedicatedContainer(row.container_id, "unpause", row.name);
    } else {
      await resumeSharedDatabase(row.db_name, row.db_username);
    }
    sqlite.prepare("UPDATE instances SET status = 'active' WHERE id = ?").run(row.id);
    logAudit("resume", { db_name: row.db_name, mode: row.mode }, row.id);
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
        const password = generateStrongPassword(20);
        const id = crypto.randomUUID();

        await cloneSharedDatabase(
          source.db_name,
          targetDb,
          targetUser,
          password,
          source.mode === "dedicated" ? getInstanceAdminUrl(source) : undefined
        );

        sqlite
          .prepare(
            `INSERT INTO instances (
              id, name, mode, env, pg_version, db_name, db_username, encrypted_password,
              backup_strategy, retention_days, status
            ) VALUES (?, ?, 'shared', ?, ?, ?, ?, ?, 'pg_dump', ?, 'active')`
          )
          .run(
            id,
            targetName,
            body.env || "staging",
            source.pg_version,
            targetDb,
            targetUser,
            encryptSecret(password),
            source.retention_days
          );

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
  .delete("/:id", async ({ params, set }) => {
    const row = sqlite
      .prepare("SELECT * FROM instances WHERE id = ? AND status != 'deleted'")
      .get(params.id) as InstanceRow | undefined;
    if (!row) {
      set.status = 404;
      return { error: "Instance not found" };
    }

    // Trigger safety backup before disabling & soft-deleting
    if (row.mode === "dedicated" && row.container_id) {
      await controlDedicatedContainer(row.container_id, "stop", row.name);
    } else {
      await runBackupForInstance(row, "pre_delete");
      await pauseSharedDatabase(row.db_name, row.db_username);
    }

    sqlite
      .prepare("UPDATE instances SET status = 'deleted', deleted_at = datetime('now') WHERE id = ?")
      .run(row.id);

    logAudit("delete", { db_name: row.db_name }, row.id);
    return { ok: true };
  });
