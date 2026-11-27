import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, runForwardMigrations, type SqliteMigration } from "../db/schema";
import { reconcileInterruptedJobsOnStartup } from "./backup";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Redeploy & crash data safety", () => {
  test("runForwardMigrations preserves existing data, creates pre-migration snapshot, and runs additively", () => {
    const dir = makeTempDir("tusk-mig-");
    const dbFile = join(dir, "panel.sqlite");
    const db = new Database(dbFile, { create: true });

    try {
      const baseMigrations: SqliteMigration[] = [MIGRATIONS[0]!];
      // Simulate a legacy v2.2.0 SQLite DB created before schema_migrations existed
      baseMigrations[0]!.up(db);
      db.prepare(
        `INSERT INTO instances (id, name, mode, env, pg_version, db_name, db_username, status)
         VALUES ('inst-1', 'kbm_prod', 'shared', 'prod', '17', 'kbm_prod', 'kbm_prod_user', 'active')`
      ).run();

      const first = runForwardMigrations(db, dbFile, baseMigrations);
      expect(first.appliedVersions).toEqual([1]);
      expect(first.backupPath).toBe(`${dbFile}.pre-v1.bak`);
      expect(existsSync(first.backupPath!)).toBe(true);

      // Repeat boot is an exact no-op
      const second = runForwardMigrations(db, dbFile, baseMigrations);
      expect(second.appliedVersions).toEqual([]);
      expect(second.backupPath).toBeNull();

      // Future v2 additive migration adds column without losing existing row
      const extendedMigrations: SqliteMigration[] = [
        ...baseMigrations,
        {
          version: 2,
          name: "add_notes_to_instances",
          up: (conn) => {
            conn.exec("ALTER TABLE instances ADD COLUMN notes TEXT DEFAULT '';");
          },
        },
      ];
      const third = runForwardMigrations(db, dbFile, extendedMigrations);
      expect(third.appliedVersions).toEqual([2]);
      expect(third.backupPath).toBe(`${dbFile}.pre-v2.bak`);
      expect(existsSync(third.backupPath!)).toBe(true);

      const row = db
        .prepare("SELECT id, name, notes FROM instances WHERE id = 'inst-1'")
        .get() as { id: string; name: string; notes: string };
      expect(row.name).toBe("kbm_prod");
      expect(row.notes).toBe("");
    } finally {
      db.close();
    }
  }, 15_000);

  test("reconcileInterruptedJobsOnStartup fails dangling backups, preserves valid archives, and resumes crash-locked DB", async () => {
    const dir = makeTempDir("tusk-reconcile-");
    const backupDir = join(dir, "backups");
    const dbFile = join(dir, "panel.sqlite");
    const db = new Database(dbFile, { create: true });
    runForwardMigrations(db, dbFile, MIGRATIONS);

    db.prepare(
      `INSERT INTO instances (id, name, mode, env, pg_version, db_name, db_username, status)
       VALUES
         ('inst-active', 'app_prod', 'shared', 'prod', '17', 'app_prod', 'app_prod_user', 'active'),
         ('inst-paused', 'app_paused', 'shared', 'prod', '17', 'app_paused', 'app_paused_user', 'paused')`
    ).run();

    // One completed valid backup and one interrupted running backup
    db.prepare(
      `INSERT INTO backups (id, instance_id, type, storage_key, encryption_algo, status)
       VALUES
         ('bak-ok', 'inst-active', 'manual', 'app_prod/ok.dump.enc', 'aes-256-cbc', 'success'),
         ('bak-crash', 'inst-active', 'manual', 'app_prod/crash.dump', 'none', 'running')`
    ).run();

    // Locks for both instances; only active instance should be auto-resumed
    db.prepare(
      `INSERT INTO settings (key, value_json)
       VALUES
         ('active_restore:inst-active', '{"backupId":"bak-ok"}'),
         ('active_restore:inst-paused', '{"backupId":"bak-ok"}')`
    ).run();

    // Create local files: valid backup + partial crashed backup + orphan temp files
    const { mkdirSync } = await import("node:fs");
    mkdirSync(backupDir, { recursive: true });
    const validFile = join(backupDir, "bak-ok.dump.enc");
    const crashedPartial = join(backupDir, "bak-crash.dump");
    const tempRestore = join(backupDir, "restore-bak-ok.tmp");
    const tempDownload = join(backupDir, "dl-bak-ok-123.tmp");
    writeFileSync(validFile, "encrypted-valid-data");
    writeFileSync(crashedPartial, "partial-corrupt-data");
    writeFileSync(tempRestore, "temp-restore-data");
    writeFileSync(tempDownload, "temp-download-data");

    const resumedCalls: Array<{ dbName: string; username: string }> = [];
    const summary = await reconcileInterruptedJobsOnStartup({
      db,
      backupDir,
      resumeFn: async (dbName, username) => {
        resumedCalls.push({ dbName, username });
      },
    });

    expect(summary.failedBackups).toBe(1);
    expect(summary.removedTempFiles).toBe(2);
    expect(summary.resumedRestores).toBe(1);

    // Valid backup archive MUST remain untouched
    expect(existsSync(validFile)).toBe(true);
    // Partial crashed backup and temp files removed
    expect(existsSync(crashedPartial)).toBe(false);
    expect(existsSync(tempRestore)).toBe(false);
    expect(existsSync(tempDownload)).toBe(false);

    // Dangling backup marked failed
    const crashedRow = db
      .prepare("SELECT status, error_message FROM backups WHERE id = 'bak-crash'")
      .get() as { status: string; error_message: string };
    expect(crashedRow.status).toBe("failed");
    expect(crashedRow.error_message).toContain("Interrupted");

    // Only active instance resumed; intentionally paused stays paused
    expect(resumedCalls).toEqual([{ dbName: "app_prod", username: "app_prod_user" }]);

    // Locks cleaned up and recovery audited
    const remainingLocks = db
      .prepare("SELECT key FROM settings WHERE key LIKE 'active_restore:%'")
      .all();
    expect(remainingLocks.length).toBe(0);

    const audit = db
      .prepare("SELECT action, instance_id FROM audit_events WHERE action = 'restore_interrupted_recovery'")
      .all() as Array<{ action: string; instance_id: string }>;
    expect(audit).toEqual([{ action: "restore_interrupted_recovery", instance_id: "inst-active" }]);

    db.close();
  }, 15_000);
});
