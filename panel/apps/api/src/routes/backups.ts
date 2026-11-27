import { Elysia, t } from "elysia";
import { sqlite, type BackupRow, type InstanceRow } from "../db/schema";
import {
  getBackupDownloadResponse,
  restoreBackupById,
  runBackupForInstance,
  startBackupJobAsync,
  subscribeBackupJob,
} from "../services/backup";
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
  .post("/verify-latest", async () => {
    return runAutomatedRestoreTest();
  })
  .get("/jobs/:jobId/stream", ({ params }) => {
    let unsubscribe: (() => void) | null = null;

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        let closed = false;

        unsubscribe = subscribeBackupJob(params.jobId, (ev) => {
          if (closed) return;
          if (ev.line) {
            controller.enqueue(encoder.encode(`data: ${ev.line}\n\n`));
          }
          if (ev.done) {
            closed = true;
            unsubscribe?.();
            unsubscribe = null;
            try {
              controller.close();
            } catch {
              // already closed
            }
          }
        });
      },
      cancel() {
        unsubscribe?.();
        unsubscribe = null;
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
