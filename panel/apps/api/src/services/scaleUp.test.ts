import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "../index";
import { MIGRATIONS, runForwardMigrations } from "../db/schema";
import { cronMatchesNow, isValidCronExpression } from "./backup";
import { computeScaleAdvisories } from "./metrics";
import { validateMigrationTargetUrl } from "./migration";

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

describe("Scale-up capabilities & guardrails", () => {
  test("SQLite migration v2 adds scale columns & metrics_samples while preserving v1 rows", () => {
    const dir = makeTempDir("tusk-scale-v2-");
    const dbFile = join(dir, "panel.sqlite");
    const db = new Database(dbFile, { create: true });

    try {
      // Apply only v1 and seed a row
      runForwardMigrations(db, dbFile, MIGRATIONS.slice(0, 1));
      db.prepare(
        `INSERT INTO instances (id, name, mode, env, pg_version, db_name, db_username, status)
         VALUES ('inst-legacy', 'app_main', 'shared', 'prod', '17', 'app_main', 'app_main_user', 'active')`
      ).run();

      // Upgrade v1 -> v2 specifically using slice(0, 2)
      const upgrade = runForwardMigrations(db, dbFile, MIGRATIONS.slice(0, 2));
      expect(upgrade.appliedVersions).toEqual([2]);
      expect(upgrade.backupPath).toBe(`${dbFile}.pre-v2.bak`);
      expect(existsSync(upgrade.backupPath!)).toBe(true);

      const row = db
        .prepare(
          "SELECT id, connection_limit, statement_timeout_sec, remote_admin_url_enc FROM instances WHERE id = 'inst-legacy'"
        )
        .get() as {
        id: string;
        connection_limit: number;
        statement_timeout_sec: number;
        remote_admin_url_enc: string | null;
      };
      expect(row.connection_limit).toBe(25);
      expect(row.statement_timeout_sec).toBe(30);
      expect(row.remote_admin_url_enc).toBeNull();

      const metricsTable = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'metrics_samples'")
        .get() as { name: string } | undefined;
      expect(metricsTable?.name).toBe("metrics_samples");
    } finally {
      db.close();
    }
  }, 15_000);

  test("cronMatchesNow and isValidCronExpression handle standard 5-field expressions", () => {
    expect(isValidCronExpression("0 2 * * *")).toBe(true);
    expect(isValidCronExpression("0 */6 * * *")).toBe(true);
    expect(isValidCronExpression("30 3 * * 0")).toBe(true);
    expect(isValidCronExpression("invalid cron")).toBe(false);
    expect(isValidCronExpression("60 2 * * *")).toBe(false);

    const twoAm = new Date(2026, 10, 27, 2, 0, 0);
    expect(cronMatchesNow("0 2 * * *", twoAm)).toBe(true);
    expect(cronMatchesNow("0 */6 * * *", twoAm)).toBe(false);

    const noon = new Date(2026, 10, 27, 12, 0, 0);
    expect(cronMatchesNow("0 */6 * * *", noon)).toBe(true);

    const sunday330 = new Date(2026, 10, 29, 3, 30, 0);
    expect(cronMatchesNow("30 3 * * 0", sunday330)).toBe(true);
    expect(cronMatchesNow("30 3 * * 7", sunday330)).toBe(true);
  });

  test("computeScaleAdvisories flags bottlenecks and stays quiet when healthy", () => {
    expect(
      computeScaleAdvisories({
        ramPct: 45,
        diskPct: 30,
        activeBackends: 20,
        waitingClients: 0,
        avgCacheHit: 99.4,
        totalDbBytes: 500 * 1024 * 1024,
        maxConnections: 200,
      })
    ).toEqual([]);

    const warnings = computeScaleAdvisories({
      ramPct: 88,
      diskPct: 80,
      activeBackends: 160,
      waitingClients: 3,
      avgCacheHit: 91.2,
      totalDbBytes: 200 * 1024 * 1024,
      maxConnections: 200,
    });
    expect(warnings.map((w) => w.code)).toEqual([
      "pool_saturation",
      "low_cache_hit",
      "disk_pressure",
      "ram_pressure",
    ]);
  });

  test("validateMigrationTargetUrl enforces scheme, db path, and SSRF policy", async () => {
    const prevAllow = process.env.ALLOW_INTERNAL_URLS;
    try {
      process.env.ALLOW_INTERNAL_URLS = "false";
      await expect(validateMigrationTargetUrl("http://example.com/db")).rejects.toThrow();
      await expect(validateMigrationTargetUrl("postgres://user:pass@host:5432/")).rejects.toThrow();
      await expect(
        validateMigrationTargetUrl("postgres://user:pass@169.254.169.254:5432/db")
      ).rejects.toThrow();

      process.env.ALLOW_INTERNAL_URLS = "true";
      const parsed = await validateMigrationTargetUrl("postgres://postgres:pass@10.0.0.5:5432/prod_db");
      expect(parsed.hostname).toBe("10.0.0.5");
    } finally {
      if (prevAllow === undefined) delete process.env.ALLOW_INTERNAL_URLS;
      else process.env.ALLOW_INTERNAL_URLS = prevAllow;
    }
  });

  test("Monitor overview returns advisories and history endpoint returns samples", async () => {
    const [ovRes, histRes] = await Promise.all([
      app.handle(new Request("http://localhost/api/monitor/overview")),
      app.handle(new Request("http://localhost/api/monitor/history?range=7d")),
    ]);
    expect(ovRes.status).toBe(200);
    expect(histRes.status).toBe(200);
    const ov = (await ovRes.json()) as { advisories: unknown[] };
    const hist = (await histRes.json()) as { range: string; samples: unknown[] };
    expect(Array.isArray(ov.advisories)).toBe(true);
    expect(hist.range).toBe("7d");
    expect(Array.isArray(hist.samples)).toBe(true);
  });
});
