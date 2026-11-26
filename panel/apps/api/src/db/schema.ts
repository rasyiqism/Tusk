import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const dataDir = process.env.DATA_DIR || "./data";
mkdirSync(dataDir, { recursive: true });

const dbPath = join(dataDir, "pg-panel.sqlite");
export const sqlite = new Database(dbPath, { create: true });

sqlite.exec("PRAGMA journal_mode = WAL;");

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS instances (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    mode TEXT NOT NULL CHECK(mode IN ('shared', 'dedicated')),
    env TEXT NOT NULL CHECK(env IN ('prod', 'staging', 'dev')),
    pg_version TEXT NOT NULL DEFAULT '17',
    db_name TEXT NOT NULL UNIQUE,
    db_username TEXT NOT NULL UNIQUE,
    encrypted_password TEXT,
    container_id TEXT,
    direct_port INTEGER NOT NULL DEFAULT 5432,
    tx_pool_port INTEGER NOT NULL DEFAULT 6432,
    session_pool_port INTEGER NOT NULL DEFAULT 6433,
    cpu_limit REAL,
    ram_limit_mb INTEGER,
    backup_strategy TEXT NOT NULL DEFAULT 'pg_dump' CHECK(backup_strategy IN ('pg_dump', 'pitr_walg')),
    backup_cron TEXT NOT NULL DEFAULT '0 2 * * *',
    retention_days INTEGER NOT NULL DEFAULT 14,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'deleted')),
    deleted_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS backups (
    id TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('scheduled', 'manual', 'pre_restore', 'pre_delete', 'wal_base')),
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
`);

export interface InstanceRow {
  id: string;
  name: string;
  mode: "shared" | "dedicated";
  env: "prod" | "staging" | "dev";
  pg_version: string;
  db_name: string;
  db_username: string;
  encrypted_password: string | null;
  container_id: string | null;
  direct_port: number;
  tx_pool_port: number;
  session_pool_port: number;
  cpu_limit: number | null;
  ram_limit_mb: number | null;
  backup_strategy: "pg_dump" | "pitr_walg";
  backup_cron: string;
  retention_days: number;
  status: "active" | "paused" | "deleted";
  deleted_at: string | null;
  created_at: string;
}

export interface BackupRow {
  id: string;
  instance_id: string;
  type: "scheduled" | "manual" | "pre_restore" | "pre_delete" | "wal_base";
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
