import { Elysia, t } from "elysia";
import { logAudit } from "../db/schema";
import { getVpsHealth } from "../services/alert";
import { computeScaleAdvisories, getMetricsHistory } from "../services/metrics";
import { getAllPoolStats } from "../services/pgbouncer";
import {
  getDatabaseSizesAndCacheHit,
  getLiveConnections,
  getSlowQueries,
  terminatePid,
} from "../services/pg-inspector";
import { authPlugin } from "./auth";

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
    const totalDbBytes = databases.reduce((s, d) => s + d.size_bytes, 0);
    const activeBackends = databases.reduce((s, d) => s + d.active_backends, 0);
    const waitingClients = pools.reduce((s, p) => s + p.cl_waiting, 0);
    const avgCacheHit =
      databases.length > 0
        ? Number((databases.reduce((s, d) => s + d.cache_hit_ratio, 0) / databases.length).toFixed(2))
        : 100;
    const advisories = computeScaleAdvisories({
      ramPct: vps.ramPct,
      diskPct: vps.diskPct,
      activeBackends,
      waitingClients,
      avgCacheHit,
      totalDbBytes,
    });
    return { vps, databases, pools, advisories };
  })
  .get(
    "/history",
    ({ query }) => {
      const range = query.range === "7d" ? "7d" : "24h";
      return { range, samples: getMetricsHistory(range) };
    },
    {
      query: t.Object({
        range: t.Optional(t.Union([t.Literal("24h"), t.Literal("7d")])),
      }),
    }
  )
  .get(
    "/connections",
    async ({ query }) => {
      const connections = await getLiveConnections(query.db).catch(() => []);
      return { connections };
    },
    {
      query: t.Object({
        db: t.Optional(t.String()),
      }),
    }
  )
  .post(
    "/kill-pid",
    async ({ body }) => {
      const terminated = await terminatePid(body.pid);
      logAudit("kill_pid", { pid: body.pid, terminated });
      return { ok: terminated };
    },
    {
      body: t.Object({
        pid: t.Number(),
      }),
    }
  )
  .get(
    "/slow-queries",
    async ({ query }) => {
      const queries = await getSlowQueries(query.sort);
      return { queries };
    },
    {
      query: t.Object({
        sort: t.Optional(
          t.Union([t.Literal("mean_exec_time"), t.Literal("total_exec_time"), t.Literal("calls")])
        ),
      }),
    }
  );
