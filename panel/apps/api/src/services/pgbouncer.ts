import postgres from "postgres";

const PGB_TX_ADMIN_URL = process.env.PGB_TX_ADMIN_URL;
const PGB_SESS_ADMIN_URL = process.env.PGB_SESS_ADMIN_URL;

export interface PoolStatus {
  pooler: "tx" | "session";
  database: string;
  user: string;
  cl_active: number;
  cl_waiting: number;
  sv_active: number;
  sv_idle: number;
  maxwait: number;
}

async function queryPools(url: string | undefined, pooler: "tx" | "session"): Promise<PoolStatus[]> {
  if (!url) return [];
  const client = postgres(url, {
    max: 1,
    connect_timeout: 2,
    idle_timeout: 5,
    fetch_types: false,
  });
  try {
    const rows = await client.unsafe("SHOW POOLS").simple();
    return rows.map((r) => ({
      pooler,
      database: String(r.database ?? ""),
      user: String(r.user ?? ""),
      cl_active: Number(r.cl_active ?? 0),
      cl_waiting: Number(r.cl_waiting ?? 0),
      sv_active: Number(r.sv_active ?? 0),
      sv_idle: Number(r.sv_idle ?? 0),
      maxwait: Number(r.maxwait ?? 0),
    }));
  } catch {
    return [];
  } finally {
    await client.end({ timeout: 1 }).catch(() => {});
  }
}

export async function getAllPoolStats(): Promise<PoolStatus[]> {
  const [tx, sess] = await Promise.all([
    queryPools(PGB_TX_ADMIN_URL, "tx"),
    queryPools(PGB_SESS_ADMIN_URL, "session"),
  ]);
  return [...tx, ...sess];
}
