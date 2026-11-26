import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { cron } from "@elysiajs/cron";
import { staticPlugin } from "@elysiajs/static";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { sqlite, type InstanceRow } from "./db/schema";
import { authRoutes } from "./routes/auth";
import { instanceRoutes } from "./routes/instances";
import { monitorRoutes } from "./routes/monitor";
import { backupRoutes } from "./routes/backups";
import { settingsRoutes } from "./routes/settings";
import { cleanupExpiredBackups, runBackupForInstance } from "./services/backup";
import { getPanelSettings, getVpsHealth, sendAlert } from "./services/alert";
import { runAutomatedRestoreTest } from "./services/restore-test";
import { controlDedicatedContainer } from "./services/docker";
import { pgAdmin } from "./services/postgres";
import { assertPgIdentifier } from "./lib/crypto";

const publicDir = join(import.meta.dir, "..", "public");

const api = new Elysia({ prefix: "/api" })
  .get("/health", () => ({ ok: true, time: new Date().toISOString() }))
  .use(authRoutes)
  .use(instanceRoutes)
  .use(monitorRoutes)
  .use(backupRoutes)
  .use(settingsRoutes);

export const app = new Elysia()
  .use(cors({ origin: true, credentials: true }))
  .use(
    cron({
      name: "daily-shared-backup",
      pattern: "0 2 * * *",
      async run() {
        const instances = sqlite
          .prepare("SELECT * FROM instances WHERE status = 'active' AND mode = 'shared'")
          .all() as InstanceRow[];
        for (const inst of instances) {
          await runBackupForInstance(inst, "scheduled");
        }
      },
    })
  )
  .use(
    cron({
      name: "vps-health-watch",
      pattern: "*/15 * * * *",
      async run() {
        const [health, settings] = await Promise.all([getVpsHealth(), getPanelSettings()]);
        if (health.diskPct >= settings.disk_alert_pct) {
          await sendAlert(
            "VPS Disk Warning",
            `Disk usage at ${health.diskPct}% (${health.diskUsedGb}/${health.diskTotalGb} GB)`,
            "high"
          );
        }
        if (health.ramPct >= settings.ram_alert_pct) {
          await sendAlert(
            "VPS RAM Critical",
            `RAM usage at ${health.ramPct}% (${health.ramUsedMb}/${health.ramTotalMb} MB)`,
            "high"
          );
        }
      },
    })
  )
  .use(
    cron({
      name: "weekly-restore-test",
      pattern: "0 3 * * 0",
      async run() {
        await runAutomatedRestoreTest();
      },
    })
  )
  .use(
    cron({
      name: "backup-retention-and-purge",
      pattern: "0 4 * * *",
      async run() {
        await cleanupExpiredBackups();
        const expiredInstances = sqlite
          .prepare(
            `SELECT * FROM instances
             WHERE status = 'deleted'
               AND deleted_at IS NOT NULL
               AND datetime(deleted_at) < datetime('now', '-14 days')`
          )
          .all() as InstanceRow[];

        for (const inst of expiredInstances) {
          try {
            if (inst.mode === "dedicated" && inst.container_id) {
              await controlDedicatedContainer(inst.container_id, "remove", inst.name);
            } else {
              const db = assertPgIdentifier(inst.db_name, "db_name");
              const user = assertPgIdentifier(inst.db_username, "db_username");
              await pgAdmin.unsafe(`DROP DATABASE IF EXISTS "${db}"`);
              await pgAdmin.unsafe(`DROP ROLE IF EXISTS "${user}"`);
            }
            const purgeTx = sqlite.transaction((instanceId: string) => {
              sqlite.prepare("DELETE FROM backups WHERE instance_id = ?").run(instanceId);
              sqlite
                .prepare("UPDATE audit_events SET instance_id = NULL WHERE instance_id = ?")
                .run(instanceId);
              sqlite.prepare("DELETE FROM instances WHERE id = ?").run(instanceId);
            });
            purgeTx(inst.id);
          } catch (err) {
            console.error(`Failed to purge soft-deleted instance ${inst.id}:`, err);
          }
        }
      },
    })
  )
  .use(api);

if (existsSync(publicDir)) {
  app.use(
    staticPlugin({
      assets: publicDir,
      prefix: "/",
    })
  );
  // SPA fallback for Vue Router history mode
  app.get("*", ({ path }) => {
    if (path.startsWith("/api")) return new Response("Not Found", { status: 404 });
    return Bun.file(join(publicDir, "index.html"));
  });
}

export type App = typeof app;

if (import.meta.main) {
  const port = Number(process.env.PORT || 3000);
  app.listen(port);
  console.log(`PG Control Panel API listening on http://localhost:${port}`);
}
