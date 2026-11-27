<script setup lang="ts">
import { onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
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
const loadError = ref("");

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
  if (pct >= 85) return "text-rose-600";
  if (pct >= 70) return "text-amber-600";
  return "text-emerald-700";
}

function barColor(pct: number) {
  if (pct >= 85) return "bg-rose-600";
  if (pct >= 70) return "bg-amber-500";
  return "bg-emerald-600";
}

async function load() {
  loading.value = true;
  loadError.value = "";
  try {
    const [ovRes, hRes] = await Promise.all([
      api.api.monitor.overview.get(),
      api.api.monitor.history.get({ query: { range: historyRange.value } }),
    ]);
    if (ovRes.error || !ovRes.data) {
      loadError.value = "Failed to load server overview.";
    } else {
      data.value = ovRes.data as OverviewData;
    }
    if (hRes.data && "samples" in hRes.data && Array.isArray(hRes.data.samples)) {
      history.value = hRes.data.samples as MetricSample[];
    }
  } catch {
    loadError.value = "Connection to panel API lost.";
  } finally {
    loading.value = false;
  }
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
  <div class="w-full divide-y divide-neutral-200">
    <!-- Loading Skeleton (Anti-CLS) -->
    <div v-if="loading" class="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-neutral-200">
      <div v-for="i in 3" :key="i" class="p-5 space-y-3 animate-pulse">
        <div class="h-3 w-20 rounded bg-neutral-200" />
        <div class="h-7 w-24 rounded bg-neutral-200" />
        <div class="h-1.5 w-full rounded bg-neutral-100" />
      </div>
    </div>

    <!-- Error Recovery Banner -->
    <div v-else-if="loadError" class="flex items-center justify-between gap-3 bg-rose-50 px-4 py-4 sm:px-6 text-xs text-rose-700">
      <span>{{ loadError }}</span>
      <button
        @click="load"
        class="rounded-lg border border-rose-200 bg-white px-3 py-1.5 font-semibold text-rose-700 transition active:scale-95 hover:bg-rose-100"
      >
        Retry
      </button>
    </div>

    <template v-else-if="data">
      <!-- Horizontal Scroll KPI Rail on Mobile / Swiss Hairline Bento on Desktop -->
      <div class="flex overflow-x-auto snap-x snap-mandatory divide-x divide-neutral-200 md:grid md:grid-cols-12 md:overflow-visible">
        <div class="shrink-0 min-w-[68%] snap-start md:col-span-5 md:min-w-0 p-5 space-y-2">
          <div class="flex items-center justify-between text-xs text-neutral-600">
            <span class="flex items-center gap-1.5">
              <AppIcon name="cpu" size="xs" />
              <span>VPS RAM</span>
            </span>
            <span :class="metricColor(data.vps.ramPct)" class="font-mono font-semibold tracking-wider">
              {{ data.vps.ramPct }}%
            </span>
          </div>
          <div class="font-mono text-lg font-bold tracking-wider text-neutral-900">
            {{ data.vps.ramUsedMb }} <span class="text-xs font-normal text-neutral-600">/ {{ data.vps.ramTotalMb }} MB</span>
          </div>
          <div class="h-1.5 w-full overflow-hidden rounded-full bg-neutral-100">
            <div :class="barColor(data.vps.ramPct)" :style="{ width: `${data.vps.ramPct}%` }" class="h-full" />
          </div>
        </div>

        <div class="shrink-0 min-w-[68%] snap-start md:col-span-4 md:min-w-0 p-5 space-y-2">
          <div class="flex items-center justify-between text-xs text-neutral-600">
            <span class="flex items-center gap-1.5">
              <AppIcon name="storage" size="xs" />
              <span>VPS Disk</span>
            </span>
            <span :class="metricColor(data.vps.diskPct)" class="font-mono font-semibold tracking-wider">
              {{ data.vps.diskPct }}%
            </span>
          </div>
          <div class="font-mono text-lg font-bold tracking-wider text-neutral-900">
            {{ data.vps.diskUsedGb }} <span class="text-xs font-normal text-neutral-600">/ {{ data.vps.diskTotalGb }} GB</span>
          </div>
          <div class="h-1.5 w-full overflow-hidden rounded-full bg-neutral-100">
            <div :class="barColor(data.vps.diskPct)" :style="{ width: `${data.vps.diskPct}%` }" class="h-full" />
          </div>
        </div>

        <div class="shrink-0 min-w-[65%] snap-start md:col-span-3 md:min-w-0 p-5 space-y-2">
          <div class="flex items-center justify-between text-xs text-neutral-600">
            <span class="flex items-center gap-1.5">
              <AppIcon name="analytics" size="xs" />
              <span>Load 1m</span>
            </span>
            <button
              @click="load"
              class="rounded-md p-1 text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900 active:scale-95"
              aria-label="Refresh"
              title="Refresh"
            >
              <AppIcon name="refresh" size="xs" />
            </button>
          </div>
          <div class="font-mono text-lg font-bold tracking-wider text-neutral-900">
            {{ data.vps.loadAvg1m }}
          </div>
          <div class="text-xs text-neutral-600 font-mono">
            {{ data.databases.length }} DBs &middot; {{ data.pools.length }} Pools
          </div>
        </div>
      </div>

      <!-- Capacity Advisories -->
      <div v-if="data.advisories && data.advisories.length > 0" class="bg-amber-50 px-4 py-3 sm:px-6 space-y-1.5">
        <div
          v-for="adv in data.advisories"
          :key="adv.code"
          class="flex items-start gap-2 text-xs text-amber-800"
        >
          <AppIcon name="warning" size="xs" class="mt-0.5 text-amber-600" />
          <span>{{ adv.message }}</span>
        </div>
      </div>

      <!-- Docked Hairline Time-Series Trends (Anti Card-in-Card) -->
      <div v-if="history.length > 0" class="divide-y divide-neutral-200">
        <div class="flex items-center justify-between px-4 py-2.5 sm:px-6">
          <span class="text-[11px] font-semibold uppercase tracking-wider text-neutral-600">
            Resource Trends ({{ history.length }} samples)
          </span>
          <div class="inline-flex rounded-lg border border-neutral-200 bg-neutral-100 p-0.5 text-[11px]">
            <button
              @click="setRange('24h')"
              :class="historyRange === '24h' ? 'bg-white text-neutral-900 font-semibold shadow-2xs' : 'text-neutral-600 hover:text-neutral-900'"
              class="rounded-md px-2 py-0.5 font-mono transition"
            >
              24h
            </button>
            <button
              @click="setRange('7d')"
              :class="historyRange === '7d' ? 'bg-white text-neutral-900 font-semibold shadow-2xs' : 'text-neutral-600 hover:text-neutral-900'"
              class="rounded-md px-2 py-0.5 font-mono transition"
            >
              7d
            </button>
          </div>
        </div>
        <div class="flex overflow-x-auto snap-x snap-mandatory divide-x divide-neutral-200 md:grid md:grid-cols-12 md:overflow-visible">
          <div class="shrink-0 min-w-[68%] snap-start md:col-span-5 md:min-w-0 px-4 py-3 sm:px-6">
            <div class="mb-1 flex items-center justify-between text-[11px] text-neutral-600">
              <span>RAM</span>
              <span class="font-mono font-semibold tracking-wider text-emerald-700">{{ history[history.length - 1]?.ram_pct }}%</span>
            </div>
            <svg viewBox="0 0 120 28" class="h-7 w-full text-emerald-600" fill="none">
              <polyline :points="sparklinePoints(history.map((s) => s.ram_pct), 100)" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </div>
          <div class="shrink-0 min-w-[68%] snap-start md:col-span-4 md:min-w-0 px-4 py-3 sm:px-6">
            <div class="mb-1 flex items-center justify-between text-[11px] text-neutral-600">
              <span>Disk</span>
              <span class="font-mono font-semibold tracking-wider text-indigo-700">{{ history[history.length - 1]?.disk_pct }}%</span>
            </div>
            <svg viewBox="0 0 120 28" class="h-7 w-full text-indigo-600" fill="none">
              <polyline :points="sparklinePoints(history.map((s) => s.disk_pct), 100)" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </div>
          <div class="shrink-0 min-w-[65%] snap-start md:col-span-3 md:min-w-0 px-4 py-3 sm:px-6">
            <div class="mb-1 flex items-center justify-between text-[11px] text-neutral-600">
              <span>PG Connections</span>
              <span class="font-mono font-semibold tracking-wider text-amber-700">{{ history[history.length - 1]?.active_backends }}</span>
            </div>
            <svg viewBox="0 0 120 28" class="h-7 w-full text-amber-600" fill="none">
              <polyline :points="sparklinePoints(history.map((s) => s.active_backends), 20)" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </div>
        </div>
      </div>

      <!-- Hairline 2-Column Split on Desktop -->
      <div class="grid grid-cols-1 lg:grid-cols-12 divide-y lg:divide-y-0 lg:divide-x divide-neutral-200">
        <section class="lg:col-span-7">
          <div class="flex items-center justify-between border-b border-neutral-200 px-4 py-3 sm:px-6">
            <h2 class="text-xs font-semibold uppercase tracking-wider text-neutral-600">Databases</h2>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full text-left text-sm">
              <thead class="border-b border-neutral-200 text-xs text-neutral-600">
                <tr>
                  <th class="px-4 py-2.5 sm:px-6">Name</th>
                  <th class="px-4 py-2.5">Size</th>
                  <th class="px-4 py-2.5">Connections</th>
                  <th class="px-4 py-2.5 text-right sm:px-6">Cache Hit</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-neutral-200/80">
                <tr v-for="db in data.databases" :key="db.db_name" class="align-middle hover:bg-neutral-50">
                  <td class="px-4 py-3 font-mono text-xs font-semibold text-emerald-700 sm:px-6">
                    {{ db.db_name }}
                  </td>
                  <td class="px-4 py-3 font-mono text-xs tracking-wider text-neutral-800">
                    {{ formatBytes(db.size_bytes) }}
                  </td>
                  <td class="px-4 py-3 font-mono text-xs text-neutral-700">{{ db.active_backends }}</td>
                  <td class="px-4 py-3 text-right font-mono text-xs font-semibold sm:px-6">
                    <span :class="db.cache_hit_ratio >= 95 ? 'text-emerald-700' : 'text-amber-700'">
                      {{ db.cache_hit_ratio }}%
                    </span>
                  </td>
                </tr>
                <tr v-if="data.databases.length === 0">
                  <td colspan="4" class="px-4 py-8 text-center text-xs text-neutral-600">
                    <span>No active databases yet.</span>
                    <RouterLink
                      to="/instances?create=1"
                      class="ml-2 font-semibold text-emerald-700 hover:underline"
                    >
                      Create
                    </RouterLink>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section class="lg:col-span-5">
          <div class="flex items-center justify-between border-b border-neutral-200 px-4 py-3 sm:px-6">
            <h2 class="text-xs font-semibold uppercase tracking-wider text-neutral-600">PgBouncer Pools</h2>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full text-left text-sm">
              <thead class="border-b border-neutral-200 text-xs text-neutral-600">
                <tr>
                  <th class="px-4 py-2.5 sm:px-6">Mode</th>
                  <th class="px-4 py-2.5">Client</th>
                  <th class="px-4 py-2.5 text-right sm:px-6">Server</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-neutral-200/80">
                <tr v-for="(p, idx) in data.pools" :key="idx" class="align-middle hover:bg-neutral-50">
                  <td class="px-4 py-3 sm:px-6">
                    <div class="font-mono text-xs font-semibold uppercase text-indigo-700">{{ p.pooler }}</div>
                    <div class="text-[11px] text-neutral-600 truncate">{{ p.database }}</div>
                  </td>
                  <td class="px-4 py-3 font-mono text-xs text-neutral-800">
                    {{ p.cl_active }} act &middot; {{ p.cl_waiting }} wait
                  </td>
                  <td class="px-4 py-3 text-right font-mono text-xs text-neutral-700 sm:px-6">
                    {{ p.sv_active }} act &middot; {{ p.sv_idle }} idle
                  </td>
                </tr>
                <tr v-if="data.pools.length === 0">
                  <td colspan="3" class="px-4 py-8 text-center text-xs text-neutral-600">
                    Pooler not connected.
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
