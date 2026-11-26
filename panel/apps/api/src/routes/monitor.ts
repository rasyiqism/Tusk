import { Elysia, t } from "elysia";
import { sqlite, type InstanceRow, logAudit } from "../db/schema";
import { getVpsHealth } from "../services/alert";
import { getAllPoolStats } from "../services/pgbouncer";
import { getInstanceAdminUrl } from "../services/postgres";
import {
  getDatabaseSizesAndCacheHit,
  getLiveConnections,
  getSlowQueries,
  terminatePid,
} from "../services/pg-inspector";
import { authPlugin } from "./auth";

function resolveMonitorUrl(instanceId?: string): string | undefined {
  if (!instanceId) return undefined;
  const row = sqlite
    .prepare("SELECT * FROM instances WHERE id = ? AND status != 'deleted'")
    .get(instanceId) as InstanceRow | undefined;
  if (!row || row.mode !== "dedicated") return undefined;
  return getInstanceAdminUrl(row);
}

export const monitorRoutes = new Elysia({ prefix: "/monitor" })
  .use(authPlugin)
  .onBeforeHandle(({ isAuthenticated, set }) => {
    if (!isAuthenticated) {
      set.status = 401;
      return { error: "Unauthorized" };
    }
  })
  .get("/overview", async () => {
    const [vps, databases, pools] = await Promise.all([
      getVpsHealth(),
      getDatabaseSizesAndCacheHit().catch(() => []),
      getAllPoolStats(),
    ]);
    return { vps, databases, pools };
  })
  .get(
    "/connections",
    async ({ query }) => {
      const customUrl = resolveMonitorUrl(query.instanceId);
      const connections = await getLiveConnections(query.db, customUrl).catch(() => []);
      return { connections };
    },
    {
      query: t.Object({
        db: t.Optional(t.String()),
        instanceId: t.Optional(t.String()),
      }),
    }
  )
  .post(
    "/kill-pid",
    async ({ body }) => {
      const customUrl = resolveMonitorUrl(body.instanceId);
      const terminated = await terminatePid(body.pid, customUrl);
      logAudit("kill_pid", { pid: body.pid, terminated, instanceId: body.instanceId });
      return { ok: terminated };
    },
    {
      body: t.Object({
        pid: t.Number(),
        instanceId: t.Optional(t.String()),
      }),
    }
  )
  .get(
    "/slow-queries",
    async ({ query }) => {
      const customUrl = resolveMonitorUrl(query.instanceId);
      const queries = await getSlowQueries(query.sort, customUrl);
      return { queries };
    },
    {
      query: t.Object({
        instanceId: t.Optional(t.String()),
        sort: t.Optional(
          t.Union([t.Literal("mean_exec_time"), t.Literal("total_exec_time"), t.Literal("calls")])
        ),
      }),
    }
  );
