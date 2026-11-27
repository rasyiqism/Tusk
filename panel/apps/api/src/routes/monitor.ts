import { Elysia, t } from "elysia";
import { logAudit } from "../db/schema";
import { getVpsHealth } from "../services/alert";
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
    return { vps, databases, pools };
  })
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
