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

interface DedicatedOpt {
  id: string;
  name: string;
  mode: string;
}

const toast = useToast();
const connections = ref<ConnRow[]>([]);
const slowQueries = ref<SlowQueryRow[]>([]);
const dedicatedList = ref<DedicatedOpt[]>([]);
const selectedInstanceId = ref("");
const dbFilter = ref("");
const sortBy = ref<"mean_exec_time" | "total_exec_time" | "calls">("mean_exec_time");
const autoRefresh = ref(false);
const killPidTarget = ref<number | null>(null);
let timer: ReturnType<typeof setInterval> | null = null;

async function load() {
  const [cRes, qRes, iRes] = await Promise.all([
    api.api.monitor.connections.get({
      query: {
        ...(dbFilter.value.trim() ? { db: dbFilter.value.trim() } : {}),
        ...(selectedInstanceId.value ? { instanceId: selectedInstanceId.value } : {}),
      },
    }),
    api.api.monitor["slow-queries"].get({
      query: {
        sort: sortBy.value,
        ...(selectedInstanceId.value ? { instanceId: selectedInstanceId.value } : {}),
      },
    }),
    api.api.instances.get(),
  ]);
  if (cRes.data && "connections" in cRes.data) {
    connections.value = cRes.data.connections as ConnRow[];
  }
  if (qRes.data && "queries" in qRes.data) {
    slowQueries.value = qRes.data.queries as SlowQueryRow[];
  }
  if (Array.isArray(iRes.data)) {
    dedicatedList.value = (iRes.data as DedicatedOpt[]).filter((i) => i.mode === "dedicated");
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
    instanceId: selectedInstanceId.value || undefined,
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
        <select
          v-if="dedicatedList.length > 0"
          v-model="selectedInstanceId"
          @change="load"
          class="rounded-lg border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-xs text-neutral-200"
        >
          <option value="">Shared Cluster</option>
          <option v-for="d in dedicatedList" :key="d.id" :value="d.id">
            Dedicated: {{ d.name }}
          </option>
        </select>
        <div class="relative w-full max-w-xs">
          <AppIcon name="search" size="xs" class="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
          <input
            v-model="dbFilter"
            @keyup.enter="load"
            placeholder="Filter DB..."
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
          <span>Segarkan</span>
        </button>
      </div>
    </div>

    <!-- Active Backends -->
    <section>
      <div class="border-b border-neutral-800 px-4 py-2.5 sm:px-6">
        <h2 class="text-xs font-semibold uppercase tracking-wider text-neutral-400">
          Koneksi Aktif ({{ connections.length }})
        </h2>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-xs">
          <thead class="border-b border-neutral-800 text-neutral-400">
            <tr>
              <th class="px-4 py-2.5 sm:px-6">PID</th>
              <th class="px-4 py-2.5">Database</th>
              <th class="px-4 py-2.5">Durasi</th>
              <th class="px-4 py-2.5">Query</th>
              <th class="px-4 py-2.5 text-right sm:px-6">Aksi</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-neutral-800/80">
            <tr v-for="c in connections" :key="c.pid" class="align-middle hover:bg-neutral-900/60">
              <td class="px-4 py-2.5 font-mono font-semibold text-neutral-200 sm:px-6">{{ c.pid }}</td>
              <td class="px-4 py-2.5">
                <div class="font-mono text-neutral-100">{{ c.datname }}</div>
                <div class="text-[11px] text-neutral-400">{{ c.usename }} &middot; {{ c.state }}</div>
              </td>
              <td class="px-4 py-2.5 font-mono">{{ c.duration_sec }}s</td>
              <td class="max-w-md truncate px-4 py-2.5 font-mono text-neutral-400" :title="c.query">
                {{ c.query }}
              </td>
              <td class="px-4 py-2.5 text-right sm:px-6">
                <button
                  @click="killPidTarget = c.pid"
                  aria-label="Putus PID"
                  title="Putus PID"
                  class="rounded-lg p-1.5 text-rose-400 transition hover:bg-rose-950/60"
                >
                  <AppIcon name="ban" size="sm" />
                </button>
              </td>
            </tr>
            <tr v-if="connections.length === 0">
              <td colspan="5" class="px-4 py-6 text-center text-neutral-500">Tidak ada koneksi aktif.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- Top 10 Slow Queries -->
    <section>
      <div class="flex items-center justify-between border-b border-neutral-800 px-4 py-2.5 sm:px-6">
        <h2 class="text-xs font-semibold uppercase tracking-wider text-neutral-400">
          Top 10 Query (pg_stat_statements)
        </h2>
        <select
          v-model="sortBy"
          @change="load"
          class="rounded-lg border border-neutral-800 bg-neutral-900 px-2.5 py-1 text-xs text-neutral-200"
        >
          <option value="mean_exec_time">Terlambat (Mean)</option>
          <option value="total_exec_time">Total Waktu</option>
          <option value="calls">Terbanyak</option>
        </select>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-xs">
          <thead class="border-b border-neutral-800 text-neutral-400">
            <tr>
              <th class="px-4 py-2.5 sm:px-6">Database</th>
              <th class="px-4 py-2.5">Calls</th>
              <th class="px-4 py-2.5">Mean</th>
              <th class="px-4 py-2.5">Total</th>
              <th class="px-4 py-2.5 sm:px-6">Query</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-neutral-800/80">
            <tr v-for="(q, idx) in slowQueries" :key="idx" class="align-middle hover:bg-neutral-900/60">
              <td class="px-4 py-2.5 font-mono text-neutral-200 sm:px-6">{{ q.db_name }}</td>
              <td class="px-4 py-2.5 font-mono">{{ q.calls }}</td>
              <td class="px-4 py-2.5 font-mono font-semibold text-amber-400">{{ q.mean_ms }}ms</td>
              <td class="px-4 py-2.5 font-mono text-neutral-300">{{ q.total_ms }}ms</td>
              <td class="max-w-lg truncate px-4 py-2.5 font-mono text-neutral-400 sm:px-6" :title="q.query">
                {{ q.query }}
              </td>
            </tr>
            <tr v-if="slowQueries.length === 0">
              <td colspan="5" class="px-4 py-6 text-center text-neutral-500">Belum ada statistik query.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <ConfirmModal
      :open="killPidTarget !== null"
      title="Putus Koneksi"
      :message="`Hentikan proses backend PID ${killPidTarget}? Transaksi aktif akan di-rollback.`"
      confirm-label="Putus"
      :danger="true"
      @confirm="confirmKillPid"
      @cancel="killPidTarget = null"
    />
  </div>
</template>
