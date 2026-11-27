import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, runForwardMigrations, type InstanceRow } from "../db/schema";
import { encryptSecret } from "../lib/crypto";
import { detachLayer2Target, switchPrimaryTierJobAsync } from "./layer2";
import {
  buildInstanceConnectionStrings,
  getInstanceAdminUrl,
  getMaskedExternalTarget,
  isExternalPrimary,
} from "./postgres";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeMockInstance(overrides: Partial<InstanceRow> = {}): InstanceRow {
  return {
    id: "inst-l2-test",
    name: "shop_prod",
    mode: "shared",
    env: "prod",
    pg_version: "17",
    db_name: "shop_prod",
    db_username: "shop_prod_user",
    encrypted_password: encryptSecret("localPass123"),
    direct_port: 5432,
    tx_pool_port: 6432,
    session_pool_port: 5432,
    backup_strategy: "pg_dump",
    backup_cron: "0 2 * * *",
    retention_days: 14,
    connection_limit: 25,
    statement_timeout_sec: 30,
    remote_admin_url_enc: null,
    primary_tier: "local",
    external_url_enc: null,
    layer2_label: "neon",
    layer2_sync_mode: "after_backup",
    layer2_last_sync_at: null,
    layer2_last_sync_status: null,
    layer2_last_error: null,
    status: "active",
    deleted_at: null,
    created_at: "2026-11-27T00:00:00.000Z",
    ...overrides,
  };
}

describe("Bidirectional Primary / Layer 2 architecture", () => {
  test("SQLite migration v3 preserves v2 rows and promotes legacy remote_admin_url_enc cleanly", () => {
    const dir = makeTempDir("tusk-l2-v3-");
    const dbFile = join(dir, "panel.sqlite");
    const db = new Database(dbFile, { create: true });

    try {
      runForwardMigrations(db, dbFile, MIGRATIONS.slice(0, 2));
      const encRemote = encryptSecret("postgres://neon:secret@ep-demo.aws.neon.tech:5432/neondb?sslmode=require");

      db.prepare(
        `INSERT INTO instances (id, name, mode, env, pg_version, db_name, db_username, remote_admin_url_enc, status)
         VALUES
           ('i-local', 'local_db', 'shared', 'prod', '17', 'local_db', 'local_db_user', NULL, 'active'),
           ('i-remote', 'remote_db', 'shared', 'prod', '17', 'remote_db', 'remote_db_user', ?, 'active')`
      ).run(encRemote);

      const res = runForwardMigrations(db, dbFile, MIGRATIONS);
      expect(res.appliedVersions).toEqual([3]);
      expect(res.backupPath).toBe(`${dbFile}.pre-v3.bak`);
      expect(existsSync(res.backupPath!)).toBe(true);

      const localRow = db
        .prepare("SELECT primary_tier, external_url_enc, layer2_sync_mode FROM instances WHERE id = 'i-local'")
        .get() as { primary_tier: string; external_url_enc: string | null; layer2_sync_mode: string };
      expect(localRow.primary_tier).toBe("local");
      expect(localRow.external_url_enc).toBeNull();
      expect(localRow.layer2_sync_mode).toBe("after_backup");

      const remoteRow = db
        .prepare("SELECT primary_tier, external_url_enc FROM instances WHERE id = 'i-remote'")
        .get() as { primary_tier: string; external_url_enc: string | null };
      expect(remoteRow.primary_tier).toBe("external");
      expect(remoteRow.external_url_enc).toBe(encRemote);
    } finally {
      db.close();
    }
  });

  test("Admin URLs, connection strings, and credential masking follow primary_tier symmetrically", () => {
    const extUrl = "postgres://neon_owner:supersecret@ep-main.aws.neon.tech:5432/appdb?sslmode=require";
    const encExt = encryptSecret(extUrl);

    const localPrimary = makeMockInstance({
      primary_tier: "local",
      external_url_enc: encExt,
      remote_admin_url_enc: encExt,
    });
    expect(isExternalPrimary(localPrimary)).toBe(false);
    expect(getInstanceAdminUrl(localPrimary)).toContain("/shop_prod");
    expect(getInstanceAdminUrl(localPrimary)).not.toContain("ep-main.aws.neon.tech");
    expect(getMaskedExternalTarget(localPrimary)).toBe("ep-main.aws.neon.tech:5432/appdb");
    expect(getMaskedExternalTarget(localPrimary)).not.toContain("supersecret");

    const localConns = buildInstanceConnectionStrings(localPrimary, "localPass123");
    expect(localConns.internal).toContain("@pgbouncer:6432/shop_prod");

    const extPrimary = makeMockInstance({
      primary_tier: "external",
      external_url_enc: encExt,
      remote_admin_url_enc: encExt,
    });
    expect(isExternalPrimary(extPrimary)).toBe(true);
    expect(getInstanceAdminUrl(extPrimary)).toBe(extUrl);

    const extConns = buildInstanceConnectionStrings(extPrimary, "localPass123");
    expect(extConns.transaction).toBe(extUrl);
    expect(extConns.direct).toBe(extUrl);
  });

  test("detachLayer2Target & switchPrimaryTierJobAsync enforce tier preconditions", () => {
    const extOnly = makeMockInstance({
      primary_tier: "external",
      external_url_enc: encryptSecret("postgres://u:p@host:5432/db"),
    });
    expect(() => detachLayer2Target(extOnly)).toThrow("Failback ke Tusk terlebih dahulu");
    expect(() => switchPrimaryTierJobAsync(extOnly, { targetTier: "external" })).toThrow();

    const localNoL2 = makeMockInstance({ primary_tier: "local", external_url_enc: null });
    expect(() => switchPrimaryTierJobAsync(localNoL2, { targetTier: "local" })).toThrow();
    expect(() => switchPrimaryTierJobAsync(localNoL2, { targetTier: "external" })).toThrow();
  });
});
