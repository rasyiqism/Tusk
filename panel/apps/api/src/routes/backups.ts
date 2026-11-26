import { Elysia, t } from "elysia";
import { sqlite, type BackupRow, type InstanceRow, logAudit } from "../db/schema";
import {
  getBackupDownloadResponse,
  restoreBackupById,
  runBackupForInstance,
  startBackupJobAsync,
  subscribeBackupJob,
} from "../services/backup";
import { execInContainer, runDedicatedPitrRecovery } from "../services/docker";
import { runAutomatedRestoreTest } from "../services/restore-test";
import { authPlugin } from "./auth";

export const backupRoutes = new Elysia({ prefix: "/backups" })
  .use(authPlugin)
  .onBeforeHandle(({ isAuthenticated, set }) => {
    if (!isAuthenticated) {
      set.status = 401;
      return { error: "Unauthorized" };
    }
  })
  .get("/", () => {
    const rows = sqlite
      .prepare(
        `SELECT b.*, i.name AS instance_name, i.db_name
         FROM backups b
         JOIN instances i ON i.id = b.instance_id
         ORDER BY b.created_at DESC
         LIMIT 100`
      )
      .all() as (BackupRow & { instance_name: string; db_name: string })[];
    return { backups: rows };
  })
  .post(
    "/:id/run",
    async ({ params, query, set }) => {
      const instance = sqlite
        .prepare("SELECT * FROM instances WHERE id = ? AND status != 'deleted'")
        .get(params.id) as InstanceRow | undefined;
      if (!instance) {
        set.status = 404;
        return { error: "Instance not found" };
      }

      if (query.async === "1") {
        const jobId = startBackupJobAsync(instance, "manual");
        return { jobId };
      }

      const backup = await runBackupForInstance(instance, "manual");
      return { backup };
    },
    {
      query: t.Object({
        async: t.Optional(t.String()),
      }),
    }
  )
  .post("/:id/walg-base", async ({ params, set }) => {
    const instance = sqlite
      .prepare("SELECT * FROM instances WHERE id = ? AND mode = 'dedicated' AND status != 'deleted'")
      .get(params.id) as InstanceRow | undefined;
    if (!instance || !instance.container_id) {
      set.status = 404;
      return { error: "Dedicated instance not found" };
    }

    const output = await execInContainer(instance.container_id, [
      "wal-g",
      "backup-push",
      "/var/lib/postgresql/data",
    ]);
    logAudit("walg_base_backup", { instance: instance.name }, instance.id);
    return { ok: true, output };
  })
  .post(
    "/:id/pitr-restore",
    async ({ params, body, set }) => {
      const instance = sqlite
        .prepare("SELECT * FROM instances WHERE id = ? AND mode = 'dedicated' AND status != 'deleted'")
        .get(params.id) as InstanceRow | undefined;
      if (!instance || !instance.container_id) {
        set.status = 404;
        return { error: "Dedicated instance not found" };
      }

      try {
        await runBackupForInstance(instance, "pre_restore");
        await runDedicatedPitrRecovery(instance, body.targetTime);
        logAudit("pitr_restore", { targetTime: body.targetTime }, instance.id);
        return {
          ok: true,
          message: `PITR recovery to ${body.targetTime} completed on ${instance.name}.`,
        };
      } catch (err) {
        set.status = 400;
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
    {
      body: t.Object({
        targetTime: t.String(),
      }),
    }
  )
  .post("/verify-latest", async () => {
    return runAutomatedRestoreTest();
  })
  .get("/jobs/:jobId/stream", ({ params }) => {
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const unsubscribe = subscribeBackupJob(params.jobId, (line) => {
          controller.enqueue(encoder.encode(`data: ${line}\n\n`));
        });
        return () => unsubscribe();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  })
  .get("/:id/download", async ({ params }) => {
    return getBackupDownloadResponse(params.id);
  })
  .post(
    "/:id/restore",
    async ({ params, set }) => {
      try {
        await restoreBackupById(params.id);
        return { ok: true };
      } catch (err) {
        set.status = 400;
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
    {
      params: t.Object({
        id: t.String(),
      }),
    }
  );
