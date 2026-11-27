<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api } from "../lib/api";
import AppIcon from "../components/AppIcon.vue";

interface OverviewData {
  vps: {
    ramTotalMb: number;
    ramUsedMb: number;
    ramPct: number;
    diskTotalGb: number;
    diskUsedGb: number;
    diskPct: number;
    loadAvg1m: number;
  };
  databases: Array<{
    db_name: string;
    size_bytes: number;
    active_backends: number;
    cache_hit_ratio: number;
  }>;
  pools: Array<{
    pooler: string;
    database: string;
    user: string;
    cl_active: number;
    cl_waiting: number;
    sv_active: number;
    sv_idle: number;
  }>;
  advisories?: Array<{
    level: "info" | "warn";
    code: string;
    message: string;
  }>;
}

interface MetricSample {
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

const data = ref<OverviewData | null>(null);
const history = ref<MetricSample[]>([]);
const historyRange = ref<"24h" | "7d">("24h");
const loading = ref(true);

function sparklinePoints(values: number[], maxVal = 100): string {
  if (values.length === 0) return "";
  if (values.length === 1) {
    const y = 26 - Math.min(1, Math.max(0, values[0] / Math.max(1, maxVal))) * 22;
    return `0,${y.toFixed(1)} 120,${y.toFixed(1)}`;
  }
  const ceil = Math.max(1, maxVal, ...values);
  return values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * 120;
      const y = 26 - (Math.max(0, v) / ceil) * 22;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function metricColor(pct: number) {
  if (pct >= 85) return "text-rose-400";
  if (pct >= 70) return "text-amber-400";
  return "text-emerald-400";
}

function barColor(pct: number) {
  if (pct >= 85) return "bg-rose-500";
  if (pct >= 70) return "bg-amber-500";
  return "bg-emerald-500";
}

async function load() {
  loading.value = true;
  const [ovRes, hRes] = await Promise.all([
    api.api.monitor.overview.get(),
    api.api.monitor.history.get({ query: { range: historyRange.value } }),
  ]);
  if (ovRes.data) {
    data.value = ovRes.data as OverviewData;
  }
  if (hRes.data && "samples" in hRes.data && Array.isArray(hRes.data.samples)) {
    history.value = hRes.data.samples as MetricSample[];
  }
  loading.value = false;
}

async function setRange(r: "24h" | "7d") {
  historyRange.value = r;
  const hRes = await api.api.monitor.history.get({ query: { range: r } });
  if (hRes.data && "samples" in hRes.data && Array.isArray(hRes.data.samples)) {
    history.value = hRes.data.samples as MetricSample[];
  }
}

onMounted(load);
</script>

<template>
  <div class="w-full divide-y divide-neutral-800">
    <!-- Loading Skeleton (Anti-CLS) -->
    <div v-if="loading" class="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-neutral-800">
      <div v-for="i in 3" :key="i" class="p-5 space-y-3 animate-pulse">
        <div class="h-3 w-20 rounded bg-neutral-800" />
        <div class="h-7 w-16 rounded bg-neutral-800" />
        <div class="h-2 w-full rounded bg-neutral-800" />
      </div>
    </div>

    <template v-else-if="data">
      <!-- Horizontal Scroll KPI Rail on Mobile / 3-Column Swiss Hairline Grid on Desktop -->
      <div class="flex overflow-x-auto snap-x snap-mandatory divide-x divide-neutral-800 md:grid md:grid-cols-3 md:overflow-visible">
        <div class="shrink-0 min-w-[65%] snap-start md:min-w-0 p-5 space-y-2">
          <div class="flex items-center justify-between text-xs text-neutral-400">
            <span class="flex items-center gap-1.5">
              <AppIcon name="cpu" size="xs" />
              <span>RAM VPS</span>
            </span>
            <span :class="metricColor(data.vps.ramPct)" class="font-mono font-semibold tracking-wider">
              {{ data.vps.ramPct }}%
            </span>
          </div>
          <div class="font-mono text-lg font-bold tracking-wider text-neutral-100">
            {{ data.vps.ramUsedMb }} <span class="text-xs font-normal text-neutral-500">/ {{ data.vps.ramTotalMb }} MB</span>
          </div>
          <div class="h-1.5 w-full overflow-hidden rounded-full bg-neutral-800">
            <div :class="barColor(data.vps.ramPct)" :style="{ width: `${data.vps.ramPct}%` }" class="h-full" />
          </div>
        </div>

        <div class="shrink-0 min-w-[65%] snap-start md:min-w-0 p-5 space-y-2">
          <div class="flex items-center justify-between text-xs text-neutral-400">
            <span class="flex items-center gap-1.5">
              <AppIcon name="storage" size="xs" />
              <span>Disk VPS</span>
            </span>
            <span :class="metricColor(data.vps.diskPct)" class="font-mono font-semibold tracking-wider">
              {{ data.vps.diskPct }}%
            </span>
          </div>
          <div class="font-mono text-lg font-bold tracking-wider text-neutral-100">
            {{ data.vps.diskUsedGb }} <span class="text-xs font-normal text-neutral-500">/ {{ data.vps.diskTotalGb }} GB</span>
          </div>
          <div class="h-1.5 w-full overflow-hidden rounded-full bg-neutral-800">
            <div :class="barColor(data.vps.diskPct)" :style="{ width: `${data.vps.diskPct}%` }" class="h-full" />
          </div>
        </div>

        <div class="shrink-0 min-w-[65%] snap-start md:min-w-0 p-5 space-y-2">
          <div class="flex items-center justify-between text-xs text-neutral-400">
            <span class="flex items-center gap-1.5">
              <AppIcon name="analytics" size="xs" />
              <span>Load 1m</span>
            </span>
            <button
              @click="load"
              class="rounded-md p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
              aria-label="Segarkan"
              title="Segarkan"
            >
              <AppIcon name="refresh" size="xs" />
            </button>
          </div>
          <div class="font-mono text-lg font-bold tracking-wider text-neutral-100">
            {{ data.vps.loadAvg1m }}
          </div>
          <div class="text-xs text-neutral-400 font-mono">
            {{ data.databases.length }} DB &middot; {{ data.pools.length }} Pool
          </div>
        </div>
      </div>

      <!-- Capacity Advisories -->
      <div v-if="data.advisories && data.advisories.length > 0" class="bg-amber-950/20 px-4 py-3 sm:px-6 space-y-1.5">
        <div
          v-for="adv in data.advisories"
          :key="adv.code"
          class="flex items-start gap-2 text-xs text-amber-300"
        >
          <AppIcon name="warning" size="xs" class="mt-0.5 text-amber-400" />
          <span>{{ adv.message }}</span>
        </div>
      </div>

      <!-- Lightweight Time-Series Sparklines -->
      <div v-if="history.length > 0" class="px-4 py-3 sm:px-6">
        <div class="mb-2.5 flex items-center justify-between">
          <span class="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
            Tren Resource ({{ history.length }} sampel)
          </span>
          <div class="inline-flex rounded-lg border border-neutral-800 bg-neutral-900 p-0.5 text-[11px]">
            <button
              @click="setRange('24h')"
              :class="historyRange === '24h' ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-400'"
              class="rounded-md px-2 py-0.5 font-mono transition"
            >
              24h
            </button>
            <button
              @click="setRange('7d')"
              :class="historyRange === '7d' ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-400'"
              class="rounded-md px-2 py-0.5 font-mono transition"
            >
              7d
            </button>
          </div>
        </div>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div class="rounded-lg border border-neutral-800/80 bg-neutral-950/60 p-3">
            <div class="mb-1 flex items-center justify-between text-[11px] text-neutral-400">
              <span>Tren RAM</span>
              <span class="font-mono text-emerald-400">{{ history[history.length - 1]?.ram_pct }}%</span>
            </div>
            <svg viewBox="0 0 120 28" class="h-7 w-full text-emerald-400" fill="none">
              <polyline :points="sparklinePoints(history.map((s) => s.ram_pct), 100)" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </div>
          <div class="rounded-lg border border-neutral-800/80 bg-neutral-950/60 p-3">
            <div class="mb-1 flex items-center justify-between text-[11px] text-neutral-400">
              <span>Tren Disk</span>
              <span class="font-mono text-indigo-400">{{ history[history.length - 1]?.disk_pct }}%</span>
            </div>
            <svg viewBox="0 0 120 28" class="h-7 w-full text-indigo-400" fill="none">
              <polyline :points="sparklinePoints(history.map((s) => s.disk_pct), 100)" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </div>
          <div class="rounded-lg border border-neutral-800/80 bg-neutral-950/60 p-3">
            <div class="mb-1 flex items-center justify-between text-[11px] text-neutral-400">
              <span>Koneksi Aktif PG</span>
              <span class="font-mono text-amber-400">{{ history[history.length - 1]?.active_backends }}</span>
            </div>
            <svg viewBox="0 0 120 28" class="h-7 w-full text-amber-400" fill="none">
              <polyline :points="sparklinePoints(history.map((s) => s.active_backends), 20)" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </div>
        </div>
      </div>

      <!-- Hairline 2-Column Split on Desktop -->
      <div class="grid grid-cols-1 lg:grid-cols-12 divide-y lg:divide-y-0 lg:divide-x divide-neutral-800">
        <!-- Database Sizes -->
        <section class="lg:col-span-7">
          <div class="flex items-center justify-between border-b border-neutral-800 px-4 py-3 sm:px-6">
            <h2 class="text-xs font-semibold uppercase tracking-wider text-neutral-400">Databases</h2>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full text-left text-sm">
              <thead class="border-b border-neutral-800 text-xs text-neutral-400">
                <tr>
                  <th class="px-4 py-2.5 sm:px-6">Nama</th>
                  <th class="px-4 py-2.5">Ukuran</th>
                  <th class="px-4 py-2.5">Koneksi</th>
                  <th class="px-4 py-2.5 text-right sm:px-6">Cache Hit</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-neutral-800/80">
                <tr v-for="db in data.databases" :key="db.db_name" class="align-middle hover:bg-neutral-900/60">
                  <td class="px-4 py-3 font-mono text-xs font-semibold text-emerald-400 sm:px-6">
                    {{ db.db_name }}
                  </td>
                  <td class="px-4 py-3 font-mono text-xs tracking-wider text-neutral-200">
                    {{ formatBytes(db.size_bytes) }}
                  </td>
                  <td class="px-4 py-3 font-mono text-xs text-neutral-300">{{ db.active_backends }}</td>
                  <td class="px-4 py-3 text-right font-mono text-xs font-semibold sm:px-6">
                    <span :class="db.cache_hit_ratio >= 95 ? 'text-emerald-400' : 'text-amber-400'">
                      {{ db.cache_hit_ratio }}%
                    </span>
                  </td>
                </tr>
                <tr v-if="data.databases.length === 0">
                  <td colspan="4" class="px-4 py-8 text-center text-xs text-neutral-500">
                    Belum ada database aktif.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <!-- PgBouncer Pools -->
        <section class="lg:col-span-5">
          <div class="flex items-center justify-between border-b border-neutral-800 px-4 py-3 sm:px-6">
            <h2 class="text-xs font-semibold uppercase tracking-wider text-neutral-400">PgBouncer Pools</h2>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full text-left text-sm">
              <thead class="border-b border-neutral-800 text-xs text-neutral-400">
                <tr>
                  <th class="px-4 py-2.5 sm:px-6">Mode</th>
                  <th class="px-4 py-2.5">Client</th>
                  <th class="px-4 py-2.5 text-right sm:px-6">Server</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-neutral-800/80">
                <tr v-for="(p, idx) in data.pools" :key="idx" class="align-middle hover:bg-neutral-900/60">
                  <td class="px-4 py-3 sm:px-6">
                    <div class="font-mono text-xs font-semibold uppercase text-indigo-400">{{ p.pooler }}</div>
                    <div class="text-[11px] text-neutral-400 truncate">{{ p.database }}</div>
                  </td>
                  <td class="px-4 py-3 font-mono text-xs text-neutral-200">
                    {{ p.cl_active }} akt &middot; {{ p.cl_waiting }} antre
                  </td>
                  <td class="px-4 py-3 text-right font-mono text-xs text-neutral-300 sm:px-6">
                    {{ p.sv_active }} akt &middot; {{ p.sv_idle }} idle
                  </td>
                </tr>
                <tr v-if="data.pools.length === 0">
                  <td colspan="3" class="px-4 py-8 text-center text-xs text-neutral-500">
                    Pooler belum terhubung.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </template>
  </div>
</template>
