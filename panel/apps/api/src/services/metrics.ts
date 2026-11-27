import { sqlite, type MetricsSampleRow } from "../db/schema";
import { getVpsHealth } from "./alert";
import { getDatabaseSizesAndCacheHit } from "./pg-inspector";
import { getAllPoolStats } from "./pgbouncer";

export interface ScaleAdvisory {
  level: "info" | "warn";
  code: string;
  message: string;
}

/**
 * Captures a lightweight point-in-time snapshot into SQLite and prunes samples > 14 days.
 */
export async function sampleAndStoreMetrics(): Promise<void> {
  const [vps, databases, pools] = await Promise.all([
    getVpsHealth(),
    getDatabaseSizesAndCacheHit().catch(() => []),
    getAllPoolStats(),
  ]);

  const totalDbBytes = databases.reduce((sum, d) => sum + d.size_bytes, 0);
  const activeBackends = databases.reduce((sum, d) => sum + d.active_backends, 0);
  const waitingClients = pools.reduce((sum, p) => sum + p.cl_waiting, 0);
  const avgCacheHit =
    databases.length > 0
      ? Number(
          (databases.reduce((sum, d) => sum + d.cache_hit_ratio, 0) / databases.length).toFixed(2)
        )
      : 100;

  sqlite
    .prepare(
      `INSERT INTO metrics_samples (
        ram_pct, disk_pct, load_1m, total_db_bytes, active_backends, waiting_clients, avg_cache_hit
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      vps.ramPct,
      vps.diskPct,
      vps.loadAvg1m,
      totalDbBytes,
      activeBackends,
      waitingClients,
      avgCacheHit
    );

  sqlite
    .prepare("DELETE FROM metrics_samples WHERE datetime(sampled_at) < datetime('now', '-14 days')")
    .run();
}

export function getMetricsHistory(range: "24h" | "7d" = "24h"): MetricsSampleRow[] {
  const lookback = range === "7d" ? "-7 days" : "-24 hours";
  const rows = sqlite
    .prepare(
      `SELECT * FROM metrics_samples
       WHERE datetime(sampled_at) >= datetime('now', ?)
       ORDER BY id ASC`
    )
    .all(lookback) as MetricsSampleRow[];

  if (rows.length <= 120) return rows;
  const step = Math.ceil(rows.length / 120);
  return rows.filter((_, idx) => idx % step === 0 || idx === rows.length - 1);
}

export function computeScaleAdvisories(input: {
  ramPct: number;
  diskPct: number;
  activeBackends: number;
  waitingClients: number;
  avgCacheHit: number;
  totalDbBytes: number;
  maxConnections?: number;
}): ScaleAdvisory[] {
  const maxConn = input.maxConnections ?? Number(process.env.PG_MAX_CONNECTIONS || 200);
  const advisories: ScaleAdvisory[] = [];

  if (input.waitingClients > 0 || (maxConn > 0 && input.activeBackends / maxConn >= 0.75)) {
    advisories.push({
      level: "warn",
      code: "pool_saturation",
      message: `Koneksi aktif mendekati batas (${input.activeBackends}/${maxConn}, antre: ${input.waitingClients}). Pertimbangkan menaikkan PG_MAX_CONNECTIONS atau scale-out DB terpadat.`,
    });
  }

  if (input.avgCacheHit < 95 && input.totalDbBytes > 50 * 1024 * 1024) {
    advisories.push({
      level: "warn",
      code: "low_cache_hit",
      message: `Rata-rata cache hit ${input.avgCacheHit}% (<95%). Naikkan PG_SHARED_BUFFERS / RAM VPS untuk mengurangi disk I/O.`,
    });
  }

  if (input.diskPct >= 75) {
    advisories.push({
      level: "warn",
      code: "disk_pressure",
      message: `Pemakaian disk ${input.diskPct}%. Pastikan S3/R2 offload aktif atau tingkatkan kapasitas disk VPS.`,
    });
  }

  if (input.ramPct >= 85) {
    advisories.push({
      level: "warn",
      code: "ram_pressure",
      message: `Pemakaian RAM ${input.ramPct}%. Upgrade RAM VPS atau pindahkan DB berat ke node terpisah.`,
    });
  }

  return advisories;
}
