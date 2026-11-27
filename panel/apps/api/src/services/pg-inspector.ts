import postgres from "postgres";
import { assertPgIdentifier, assertPgObjectName } from "../lib/crypto";
import { PG_ADMIN_URL, pgAdmin } from "./postgres";

export interface TableInfo {
  schema_name: string;
  table_name: string;
  estimated_rows: number;
  total_bytes: number;
}

export interface ColumnInfo {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}

function resolveDbUrl(dbNameRaw: string, customAdminUrl?: string): string {
  const dbName = assertPgIdentifier(dbNameRaw, "db_name");
  if (customAdminUrl) return customAdminUrl;
  const url = new URL(PG_ADMIN_URL);
  url.pathname = `/${dbName}`;
  return url.toString();
}

export async function getDatabaseSizesAndCacheHit() {
  const rows = await pgAdmin`
    SELECT
      d.datname AS db_name,
      pg_database_size(d.datname)::bigint AS size_bytes,
      s.numbackends AS active_backends,
      CASE
        WHEN (s.blks_hit + s.blks_read) = 0 THEN 100.0
        ELSE ROUND((s.blks_hit::numeric / (s.blks_hit + s.blks_read)) * 100, 2)
      END AS cache_hit_ratio
    FROM pg_database d
    LEFT JOIN pg_stat_database s ON d.oid = s.datid
    WHERE d.datistemplate = false
      AND d.datname NOT IN ('postgres')
    ORDER BY size_bytes DESC
  `;
  return rows.map((r) => ({
    db_name: String(r.db_name),
    size_bytes: Number(r.size_bytes),
    active_backends: Number(r.active_backends ?? 0),
    cache_hit_ratio: Number(r.cache_hit_ratio ?? 100),
  }));
}

export async function getLiveConnections(dbName?: string, customAdminUrl?: string) {
  const client = customAdminUrl
    ? postgres(customAdminUrl, { max: 1, connect_timeout: 3, idle_timeout: 5 })
    : pgAdmin;

  try {
    const rows = dbName
      ? await client`
          SELECT pid, datname, usename, client_addr::text AS client_addr, state,
                 EXTRACT(EPOCH FROM (now() - query_start))::int AS duration_sec,
                 LEFT(query, 240) AS query
          FROM pg_stat_activity
          WHERE datname = ${dbName}
            AND pid <> pg_backend_pid()
            AND backend_type = 'client backend'
          ORDER BY query_start ASC NULLS LAST
        `
      : await client`
          SELECT pid, datname, usename, client_addr::text AS client_addr, state,
                 EXTRACT(EPOCH FROM (now() - query_start))::int AS duration_sec,
                 LEFT(query, 240) AS query
          FROM pg_stat_activity
          WHERE pid <> pg_backend_pid()
            AND datname IS NOT NULL
            AND backend_type = 'client backend'
          ORDER BY query_start ASC NULLS LAST
        `;

    return rows.map((r) => ({
      pid: Number(r.pid),
      datname: String(r.datname),
      usename: String(r.usename ?? ""),
      client_addr: r.client_addr ? String(r.client_addr) : "local",
      state: String(r.state ?? "unknown"),
      duration_sec: Number(r.duration_sec ?? 0),
      query: String(r.query ?? ""),
    }));
  } finally {
    if (customAdminUrl) await client.end({ timeout: 1 }).catch(() => {});
  }
}

export async function terminatePid(pid: number, customAdminUrl?: string): Promise<boolean> {
  const client = customAdminUrl
    ? postgres(customAdminUrl, { max: 1, connect_timeout: 3, idle_timeout: 5 })
    : pgAdmin;
  try {
    const [res] = await client`
      SELECT pg_terminate_backend(pid) AS terminated
      FROM pg_stat_activity
      WHERE pid = ${pid}
        AND pid <> pg_backend_pid()
        AND backend_type = 'client backend'
        AND usename <> 'postgres'
    `;
    return Boolean(res?.terminated);
  } finally {
    if (customAdminUrl) await client.end({ timeout: 1 }).catch(() => {});
  }
}

export async function getSlowQueries(
  sortBy: "mean_exec_time" | "total_exec_time" | "calls" = "mean_exec_time",
  customAdminUrl?: string
) {
  const orderCol =
    sortBy === "total_exec_time"
      ? "total_exec_time"
      : sortBy === "calls"
        ? "calls"
        : "mean_exec_time";

  const client = customAdminUrl
    ? postgres(customAdminUrl, { max: 1, connect_timeout: 3, idle_timeout: 5 })
    : pgAdmin;

  try {
    const rows = await client.unsafe(`
      SELECT
        d.datname AS db_name,
        LEFT(s.query, 300) AS query,
        s.calls::bigint AS calls,
        ROUND(s.mean_exec_time::numeric, 2) AS mean_ms,
        ROUND(s.total_exec_time::numeric, 2) AS total_ms,
        s.rows::bigint AS rows
      FROM pg_stat_statements s
      JOIN pg_database d ON d.oid = s.dbid
      WHERE d.datname NOT IN ('postgres', 'template0', 'template1')
      ORDER BY ${orderCol} DESC
      LIMIT 10
    `);

    return rows.map((r) => ({
      db_name: String(r.db_name),
      query: String(r.query),
      calls: Number(r.calls),
      mean_ms: Number(r.mean_ms),
      total_ms: Number(r.total_ms),
      rows: Number(r.rows),
    }));
  } catch {
    return [];
  } finally {
    if (customAdminUrl) await client.end({ timeout: 1 }).catch(() => {});
  }
}

export async function getDatabaseTables(
  dbNameRaw: string,
  customAdminUrl?: string
): Promise<TableInfo[]> {
  const client = postgres(resolveDbUrl(dbNameRaw, customAdminUrl), {
    max: 1,
    connect_timeout: 3,
    idle_timeout: 5,
  });

  try {
    const rows = await client`
      SELECT
        n.nspname AS schema_name,
        c.relname AS table_name,
        COALESCE(s.n_live_tup, 0)::bigint AS estimated_rows,
        pg_total_relation_size(c.oid)::bigint AS total_bytes
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
      WHERE c.relkind IN ('r', 'p')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY total_bytes DESC, c.relname ASC
    `;
    return rows.map((r) => ({
      schema_name: String(r.schema_name),
      table_name: String(r.table_name),
      estimated_rows: Number(r.estimated_rows ?? 0),
      total_bytes: Number(r.total_bytes ?? 0),
    }));
  } finally {
    await client.end({ timeout: 1 }).catch(() => {});
  }
}

export async function getTableColumns(
  dbNameRaw: string,
  schemaRaw: string,
  tableRaw: string,
  customAdminUrl?: string
): Promise<ColumnInfo[]> {
  const schemaName = assertPgObjectName(schemaRaw, "schema_name");
  const tableName = assertPgObjectName(tableRaw, "table_name");
  const client = postgres(resolveDbUrl(dbNameRaw, customAdminUrl), {
    max: 1,
    connect_timeout: 3,
    idle_timeout: 5,
  });

  try {
    const rows = await client`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = ${schemaName}
        AND table_name = ${tableName}
      ORDER BY ordinal_position ASC
    `;
    return rows.map((r) => ({
      column_name: String(r.column_name),
      data_type: String(r.data_type),
      is_nullable: String(r.is_nullable),
      column_default: r.column_default ? String(r.column_default) : null,
    }));
  } finally {
    await client.end({ timeout: 1 }).catch(() => {});
  }
}

export async function getTablePreview(
  dbNameRaw: string,
  schemaRaw: string,
  tableRaw: string,
  customAdminUrl?: string
): Promise<Record<string, unknown>[]> {
  const schemaName = assertPgObjectName(schemaRaw, "schema_name");
  const tableName = assertPgObjectName(tableRaw, "table_name");
  const client = postgres(resolveDbUrl(dbNameRaw, customAdminUrl), {
    max: 1,
    connect_timeout: 3,
    idle_timeout: 5,
  });

  try {
    const rows = await client.unsafe(`SELECT * FROM "${schemaName}"."${tableName}" LIMIT 25`);
    return rows.map((r) => ({ ...r }));
  } finally {
    await client.end({ timeout: 1 }).catch(() => {});
  }
}
