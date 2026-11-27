import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export interface SqliteMigration {
  version: number;
  name: string;
  up: (db: Database) => void;
}

const BASELINE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS instances (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    mode TEXT NOT NULL DEFAULT 'shared' CHECK(mode IN ('shared')),
    env TEXT NOT NULL CHECK(env IN ('prod', 'staging', 'dev')),
    pg_version TEXT NOT NULL DEFAULT '17',
    db_name TEXT NOT NULL UNIQUE,
    db_username TEXT NOT NULL UNIQUE,
    encrypted_password TEXT,
    direct_port INTEGER NOT NULL DEFAULT 5432,
    tx_pool_port INTEGER NOT NULL DEFAULT 6432,
    session_pool_port INTEGER NOT NULL DEFAULT 5432,
    backup_strategy TEXT NOT NULL DEFAULT 'pg_dump' CHECK(backup_strategy IN ('pg_dump')),
    backup_cron TEXT NOT NULL DEFAULT '0 2 * * *',
    retention_days INTEGER NOT NULL DEFAULT 14,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'deleted')),
    deleted_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS backups (
    id TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('scheduled', 'manual', 'pre_restore', 'pre_delete')),
    size_bytes INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    storage_key TEXT NOT NULL,
    encryption_algo TEXT NOT NULL DEFAULT 'aes-256-cbc',
    status TEXT NOT NULL CHECK(status IN ('running', 'success', 'failed')),
    error_message TEXT,
    verified_restore INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_backups_instance_id ON backups(instance_id, created_at);

  CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_id TEXT,
    actor TEXT NOT NULL DEFAULT 'admin',
    ip_address TEXT,
    action TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_audit_events_instance_id ON audit_events(instance_id, created_at);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS revoked_tokens (
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
`;

function addColumnIfMissing(db: Database, table: string, column: string, definition: string) {
  const cols = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE "${table}" ADD COLUMN ${column} ${definition}`);
  }
}

export const MIGRATIONS: SqliteMigration[] = [
  {
    version: 1,
    name: "baseline_schema_v2_2",
    up: (db) => {
      db.exec(BASELINE_SCHEMA_SQL);
    },
  },
  {
    version: 2,
    name: "scale_up_v2_3",
    up: (db) => {
      addColumnIfMissing(db, "instances", "connection_limit", "INTEGER NOT NULL DEFAULT 25");
      addColumnIfMissing(db, "instances", "statement_timeout_sec", "INTEGER NOT NULL DEFAULT 30");
      addColumnIfMissing(db, "instances", "remote_admin_url_enc", "TEXT");

      db.exec(`
        CREATE TABLE IF NOT EXISTS metrics_samples (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sampled_at TEXT NOT NULL DEFAULT (datetime('now')),
          ram_pct INTEGER NOT NULL,
          disk_pct INTEGER NOT NULL,
          load_1m REAL NOT NULL,
          total_db_bytes INTEGER NOT NULL,
          active_backends INTEGER NOT NULL,
          waiting_clients INTEGER NOT NULL,
          avg_cache_hit REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_metrics_samples_at ON metrics_samples(sampled_at);
      `);
    },
  },
  {
    version: 3,
    name: "bidirectional_layer2_v2_4",
    up: (db) => {
      addColumnIfMissing(db, "instances", "primary_tier", "TEXT NOT NULL DEFAULT 'local'");
      addColumnIfMissing(db, "instances", "external_url_enc", "TEXT");
      addColumnIfMissing(db, "instances", "layer2_label", "TEXT");
      addColumnIfMissing(db, "instances", "layer2_sync_mode", "TEXT NOT NULL DEFAULT 'after_backup'");
      addColumnIfMissing(db, "instances", "layer2_last_sync_at", "TEXT");
      addColumnIfMissing(db, "instances", "layer2_last_sync_status", "TEXT");
      addColumnIfMissing(db, "instances", "layer2_last_error", "TEXT");

      // Preserve any existing v2 remote instances as external primaries automatically
      db.exec(`
        UPDATE instances
        SET primary_tier = 'external',
            external_url_enc = COALESCE(external_url_enc, remote_admin_url_enc)
        WHERE remote_admin_url_enc IS NOT NULL
      `);
    },
  },
];

/**
 * Runs forward-only additive SQLite migrations inside transactions and creates
 * a transactional VACUUM INTO backup before modifying any existing populated DB.
 */
export function runForwardMigrations(
  db: Database,
  targetDbPath: string,
  migrations: SqliteMigration[] = MIGRATIONS
): { appliedVersions: number[]; backupPath: string | null } {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const existingTables = db
    .prepare(
      "SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type = 'table' AND name != 'schema_migrations'"
    )
    .get() as { cnt: number };

  const appliedRows = db
    .prepare("SELECT version FROM schema_migrations")
    .all() as Array<{ version: number }>;
  const applied = new Set(appliedRows.map((r) => r.version));
  const pending = migrations
    .filter((m) => !applied.has(m.version))
    .sort((a, b) => a.version - b.version);

  if (pending.length === 0) {
    return { appliedVersions: [], backupPath: null };
  }

  let backupPath: string | null = null;
  const hasExistingData =
    existingTables.cnt > 0 &&
    targetDbPath !== ":memory:" &&
    existsSync(targetDbPath) &&
    statSync(targetDbPath).size > 0;

  if (hasExistingData) {
    const targetVersion = pending[pending.length - 1]!.version;
    backupPath = `${targetDbPath}.pre-v${targetVersion}.bak`;
    rmSync(backupPath, { force: true });
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  }

  const recordStmt = db.prepare(
    "INSERT INTO schema_migrations (version, name) VALUES (?, ?)"
  );

  const applyTx = db.transaction((items: SqliteMigration[]) => {
    for (const m of items) {
      m.up(db);
      recordStmt.run(m.version, m.name);
    }
  });
  applyTx(pending);

  return {
    appliedVersions: pending.map((m) => m.version),
    backupPath,
  };
}

const dataDir = process.env.DATA_DIR || "./data";
mkdirSync(dataDir, { recursive: true });

export const dbPath = join(dataDir, "pg-panel.sqlite");
export const sqlite = new Database(dbPath, { create: true });

sqlite.exec("PRAGMA journal_mode = WAL;");
sqlite.exec("PRAGMA synchronous = FULL;");
sqlite.exec("PRAGMA busy_timeout = 5000;");

runForwardMigrations(sqlite, dbPath, MIGRATIONS);

let sqliteClosed = false;

export function checkpointAndCloseSqlite() {
  if (sqliteClosed) return;
  sqliteClosed = true;
  try {
    sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } catch (err) {
    console.error("Failed to checkpoint SQLite WAL on shutdown:", err);
  }
  try {
    sqlite.close();
  } catch {
    // ignore close error on exit
  }
}

export interface InstanceRow {
  id: string;
  name: string;
  mode: "shared";
  env: "prod" | "staging" | "dev";
  pg_version: string;
  db_name: string;
  db_username: string;
  encrypted_password: string | null;
  direct_port: number;
  tx_pool_port: number;
  session_pool_port: number;
  backup_strategy: "pg_dump";
  backup_cron: string;
  retention_days: number;
  connection_limit: number;
  statement_timeout_sec: number;
  remote_admin_url_enc: string | null;
  primary_tier: "local" | "external";
  external_url_enc: string | null;
  layer2_label: string | null;
  layer2_sync_mode: "manual" | "after_backup";
  layer2_last_sync_at: string | null;
  layer2_last_sync_status: string | null;
  layer2_last_error: string | null;
  status: "active" | "paused" | "deleted";
  deleted_at: string | null;
  created_at: string;
}

export interface MetricsSampleRow {
  id: number;
  sampled_at: string;
  ram_pct: number;
  disk_pct: number;
  load_1m: number;
  total_db_bytes: number;
  active_backends: number;
  waiting_clients: number;
  avg_cache_hit: number;
}

export interface BackupRow {
  id: string;
  instance_id: string;
  type: "scheduled" | "manual" | "pre_restore" | "pre_delete";
  size_bytes: number;
  duration_ms: number;
  storage_key: string;
  encryption_algo: string;
  status: "running" | "success" | "failed";
  error_message: string | null;
  verified_restore: number;
  created_at: string;
}

export interface AuditEventRow {
  id: number;
  instance_id: string | null;
  actor: string;
  ip_address: string | null;
  action: string;
  detail_json: string;
  created_at: string;
}

export function logAudit(
  action: string,
  detail: Record<string, unknown>,
  instanceId?: string | null,
  ipAddress?: string | null
) {
  sqlite
    .prepare(
      `INSERT INTO audit_events (instance_id, actor, ip_address, action, detail_json)
       VALUES (?, 'admin', ?, ?, ?)`
    )
    .run(instanceId ?? null, ipAddress ?? null, action, JSON.stringify(detail));
}
