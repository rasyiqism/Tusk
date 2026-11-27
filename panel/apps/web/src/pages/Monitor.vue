<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { api } from "../lib/api";
import { useToast } from "../components/useToast";
import AppIcon from "../components/AppIcon.vue";
import ConfirmModal from "../components/ConfirmModal.vue";

interface ConnRow {
  pid: number;
  datname: string;
  usename: string;
  client_addr: string;
  state: string;
  duration_sec: number;
  query: string;
}

interface SlowQueryRow {
  db_name: string;
  query: string;
  calls: number;
  mean_ms: number;
  total_ms: number;
}

const toast = useToast();
const connections = ref<ConnRow[]>([]);
const slowQueries = ref<SlowQueryRow[]>([]);
const dbFilter = ref("");
const sortBy = ref<"mean_exec_time" | "total_exec_time" | "calls">("mean_exec_time");
const autoRefresh = ref(false);
const killPidTarget = ref<number | null>(null);
let timer: ReturnType<typeof setInterval> | null = null;

async function load() {
  const [cRes, qRes] = await Promise.all([
    api.api.monitor.connections.get({
      query: {
        ...(dbFilter.value.trim() ? { db: dbFilter.value.trim() } : {}),
      },
    }),
    api.api.monitor["slow-queries"].get({
      query: {
        sort: sortBy.value,
      },
    }),
  ]);
  if (cRes.data && "connections" in cRes.data) {
    connections.value = cRes.data.connections as ConnRow[];
  }
  if (qRes.data && "queries" in qRes.data) {
    slowQueries.value = qRes.data.queries as SlowQueryRow[];
  }
}

function toggleAutoRefresh() {
  autoRefresh.value = !autoRefresh.value;
  if (autoRefresh.value) {
    timer = setInterval(() => void load(), 5000);
  } else if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function confirmKillPid() {
  if (killPidTarget.value === null) return;
  const pid = killPidTarget.value;
  killPidTarget.value = null;
  await api.api.monitor["kill-pid"].post({
    pid,
  });
  toast.success(`PID ${pid} dihentikan`);
  await load();
}

onMounted(load);
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div class="w-full divide-y divide-neutral-800">
    <!-- Toolbar -->
    <div class="flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6">
      <div class="flex flex-1 flex-wrap items-center gap-2">
        <div class="relative w-full max-w-xs">
          <AppIcon name="search" size="xs" class="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
          <input
            v-model="dbFilter"
            @keyup.enter="load"
            placeholder="Filter nama database..."
            class="w-full rounded-lg border border-neutral-800 bg-neutral-900 py-1.5 pl-8 pr-3 text-xs text-neutral-100 placeholder:text-neutral-500 focus:border-indigo-500 focus:outline-none"
          />
        </div>
      </div>

      <div class="flex items-center gap-2">
        <button
          @click="toggleAutoRefresh"
          :class="
            autoRefresh
              ? 'border-emerald-700 bg-emerald-950/40 text-emerald-300'
              : 'border-neutral-800 bg-neutral-900 text-neutral-400'
          "
          class="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition hover:bg-neutral-800"
        >
          <AppIcon name="radio" size="xs" />
          <span>{{ autoRefresh ? "5s" : "Manual" }}</span>
        </button>
        <button
          @click="load"
          class="inline-flex items-center gap-1.5 rounded-lg border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-xs font-medium text-neutral-200 transition hover:bg-neutral-800"
        >
          <AppIcon name="refresh" size="xs" />
          <span>Refresh</span>
        </button>
      </div>
    </div>

    <!-- Active Connections Table -->
    <div>
      <div class="border-b border-neutral-800 bg-neutral-950 px-4 py-2 text-xs font-semibold uppercase tracking-wider text-neutral-400 sm:px-6">
        Koneksi Aktif ({{ connections.length }})
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="border-b border-neutral-800 text-xs text-neutral-400">
            <tr>
              <th class="px-4 py-2.5 sm:px-6">PID</th>
              <th class="px-4 py-2.5">Database</th>
              <th class="px-4 py-2.5">User</th>
              <th class="px-4 py-2.5">IP Klien</th>
              <th class="px-4 py-2.5">Status</th>
              <th class="px-4 py-2.5">Durasi</th>
              <th class="px-4 py-2.5">Query</th>
              <th class="px-4 py-2.5 text-right sm:px-6">Aksi</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-neutral-800/80">
            <tr v-for="c in connections" :key="c.pid" class="align-middle hover:bg-neutral-900/60">
              <td class="px-4 py-2.5 font-mono text-xs text-neutral-300 sm:px-6">{{ c.pid }}</td>
              <td class="px-4 py-2.5 font-mono text-xs text-neutral-100">{{ c.datname }}</td>
              <td class="px-4 py-2.5 text-xs text-neutral-300">{{ c.usename }}</td>
              <td class="px-4 py-2.5 font-mono text-xs text-neutral-400">{{ c.client_addr || "internal" }}</td>
              <td class="px-4 py-2.5">
                <span
                  :class="c.state === 'active' ? 'text-emerald-400' : 'text-neutral-500'"
                  class="font-mono text-xs capitalize"
                >
                  {{ c.state }}
                </span>
              </td>
              <td class="px-4 py-2.5 font-mono text-xs text-neutral-300">{{ c.duration_sec }}s</td>
              <td class="max-w-xs truncate px-4 py-2.5 font-mono text-xs text-neutral-400" :title="c.query">
                {{ c.query }}
              </td>
              <td class="px-4 py-2.5 text-right sm:px-6">
                <button
                  @click="killPidTarget = c.pid"
                  class="rounded-lg p-1 text-rose-400 transition hover:bg-rose-950/60"
                  title="Hentikan Proses (Kill PID)"
                  aria-label="Kill PID"
                >
                  <AppIcon name="stop" size="xs" />
                </button>
              </td>
            </tr>
            <tr v-if="connections.length === 0">
              <td colspan="8" class="px-4 py-8 text-center text-xs text-neutral-500">
                Tidak ada koneksi aktif selain panel.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Slow Queries / pg_stat_statements -->
    <div>
      <div class="flex items-center justify-between border-b border-neutral-800 bg-neutral-950 px-4 py-2 text-xs font-semibold uppercase tracking-wider text-neutral-400 sm:px-6">
        <span>Slow Queries (pg_stat_statements)</span>
        <div class="flex items-center gap-1.5 text-xs lowercase">
          <span class="text-neutral-500 uppercase tracking-wider text-[10px]">Urutkan:</span>
          <button
            v-for="s in (['mean_exec_time', 'total_exec_time', 'calls'] as const)"
            :key="s"
            @click="sortBy = s; load()"
            :class="sortBy === s ? 'text-indigo-400 font-semibold' : 'text-neutral-400 hover:text-neutral-200'"
            class="px-1 py-0.5"
          >
            {{ s.replace('_exec_time', '') }}
          </button>
        </div>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="border-b border-neutral-800 text-xs text-neutral-400">
            <tr>
              <th class="px-4 py-2.5 sm:px-6">Database</th>
              <th class="px-4 py-2.5">Panggilan</th>
              <th class="px-4 py-2.5">Rata-rata</th>
              <th class="px-4 py-2.5">Total</th>
              <th class="px-4 py-2.5">Query</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-neutral-800/80">
            <tr v-for="(q, idx) in slowQueries" :key="idx" class="align-middle hover:bg-neutral-900/60">
              <td class="px-4 py-2.5 font-mono text-xs text-neutral-200 sm:px-6">{{ q.db_name }}</td>
              <td class="px-4 py-2.5 font-mono text-xs text-neutral-300">{{ q.calls.toLocaleString() }}</td>
              <td class="px-4 py-2.5 font-mono text-xs text-amber-400">{{ q.mean_ms.toFixed(1) }}ms</td>
              <td class="px-4 py-2.5 font-mono text-xs text-neutral-300">{{ (q.total_ms / 1000).toFixed(2) }}s</td>
              <td class="max-w-md truncate px-4 py-2.5 font-mono text-xs text-neutral-400" :title="q.query">
                {{ q.query }}
              </td>
            </tr>
            <tr v-if="slowQueries.length === 0">
              <td colspan="5" class="px-4 py-8 text-center text-xs text-neutral-500">
                Belum ada query yang tercatat di pg_stat_statements.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Confirm Kill Modal -->
    <ConfirmModal
      :open="killPidTarget !== null"
      title="Hentikan Query (Kill PID)"
      :message="`Yakin ingin menghentikan backend PostgreSQL dengan PID ${killPidTarget}? Transaksi yang sedang berjalan akan di-rollback.`"
      confirm-label="Hentikan Proses"
      :danger="true"
      @confirm="confirmKillPid"
      @cancel="killPidTarget = null"
    />
  </div>
</template>
