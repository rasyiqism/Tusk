<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { api } from "../lib/api";
import { useToast } from "../components/useToast";
import AppIcon from "../components/AppIcon.vue";
import ConfirmModal from "../components/ConfirmModal.vue";
import TableSkeleton from "../components/TableSkeleton.vue";

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
const loading = ref(true);
const loadError = ref(false);
const killing = ref(false);
const autoRefresh = ref(false);
const killPidTarget = ref<number | null>(null);
let timer: ReturnType<typeof setInterval> | null = null;

async function load() {
  if (connections.value.length === 0 && slowQueries.value.length === 0) {
    loading.value = true;
  }
  loadError.value = false;
  try {
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
    if (cRes.error && qRes.error) {
      loadError.value = true;
      return;
    }
    if (cRes.data && "connections" in cRes.data) {
      connections.value = cRes.data.connections as ConnRow[];
    }
    if (qRes.data && "queries" in qRes.data) {
      slowQueries.value = qRes.data.queries as SlowQueryRow[];
    }
  } catch {
    loadError.value = true;
  } finally {
    loading.value = false;
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
  if (killPidTarget.value === null || killing.value) return;
  const pid = killPidTarget.value;
  killing.value = true;
  killPidTarget.value = null;
  try {
    await api.api.monitor["kill-pid"].post({
      pid,
    });
    toast.success(`PID ${pid} terminated`);
    await load();
  } finally {
    killing.value = false;
  }
}

onMounted(load);
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div class="w-full divide-y divide-neutral-200">
    <!-- Toolbar -->
    <div class="flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6">
      <div class="flex flex-1 flex-wrap items-center gap-2">
        <div class="relative w-full max-w-xs">
          <AppIcon name="search" size="xs" class="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
          <input
            v-model="dbFilter"
            @keyup.enter="load"
            placeholder="Filter by database name..."
            class="w-full rounded-lg border border-neutral-300 bg-white py-1.5 pl-8 pr-3 text-xs text-neutral-900 placeholder:text-neutral-500 focus:border-emerald-600 focus:outline-none"
          />
        </div>
      </div>

      <div class="flex items-center gap-2">
        <button
          @click="toggleAutoRefresh"
          :class="
            autoRefresh
              ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
              : 'border-neutral-200 bg-white text-neutral-600'
          "
          class="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition hover:bg-neutral-100 active:scale-[0.98]"
        >
          <AppIcon name="radio" size="xs" />
          <span>{{ autoRefresh ? "5s" : "Manual" }}</span>
        </button>
        <button
          @click="load"
          class="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-xs font-medium text-neutral-700 transition hover:bg-neutral-100 active:scale-[0.98]"
        >
          <AppIcon name="refresh" size="xs" />
          <span>Refresh</span>
        </button>
      </div>
    </div>

    <!-- Error Retry Banner -->
    <div v-if="loadError" class="flex items-center justify-between gap-3 bg-rose-50 px-4 py-3 text-xs text-rose-700 sm:px-6">
      <span>Failed to load connection metrics from server.</span>
      <button
        @click="load"
        class="rounded-lg border border-rose-200 bg-white px-2.5 py-1 font-medium text-rose-700 transition hover:bg-rose-100 active:scale-[0.98]"
      >
        Retry
      </button>
    </div>

    <!-- Active Connections Table -->
    <div>
      <div class="border-b border-neutral-200 bg-neutral-50 px-4 py-2 text-xs font-semibold uppercase tracking-wider text-neutral-600 sm:px-6">
        Active Connections ({{ connections.length }})
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="border-b border-neutral-200 text-xs text-neutral-600">
            <tr>
              <th class="px-4 py-2.5 sm:px-6">PID</th>
              <th class="px-4 py-2.5">Database</th>
              <th class="px-4 py-2.5">User</th>
              <th class="px-4 py-2.5">Client IP</th>
              <th class="px-4 py-2.5">State</th>
              <th class="px-4 py-2.5">Duration</th>
              <th class="px-4 py-2.5">Query</th>
              <th class="px-4 py-2.5 text-right sm:px-6">Action</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-neutral-200/80">
            <TableSkeleton v-if="loading" :rows="3" :cols="8" />
            <tr v-for="c in connections" :key="c.pid" class="align-middle hover:bg-neutral-50">
              <td class="px-4 py-2.5 font-mono text-xs text-neutral-700 sm:px-6">{{ c.pid }}</td>
              <td class="px-4 py-2.5 font-mono text-xs text-neutral-900 font-semibold">{{ c.datname }}</td>
              <td class="px-4 py-2.5 text-xs text-neutral-700">{{ c.usename }}</td>
              <td class="px-4 py-2.5 font-mono text-xs text-neutral-600">{{ c.client_addr || "internal" }}</td>
              <td class="px-4 py-2.5">
                <span
                  :class="c.state === 'active' ? 'text-emerald-700 font-semibold' : 'text-neutral-600'"
                  class="font-mono text-xs capitalize"
                >
                  {{ c.state }}
                </span>
              </td>
              <td class="px-4 py-2.5 font-mono text-xs text-neutral-700">{{ c.duration_sec }}s</td>
              <td class="max-w-xs truncate px-4 py-2.5 font-mono text-xs text-neutral-600" :title="c.query">
                {{ c.query }}
              </td>
              <td class="px-4 py-2.5 text-right sm:px-6">
                <button
                  @click="killPidTarget = c.pid"
                  :disabled="killing"
                  class="inline-flex min-h-[36px] min-w-[36px] items-center justify-center rounded-lg p-1 text-rose-600 transition hover:bg-rose-50 active:scale-[0.98] disabled:opacity-50 sm:min-h-0 sm:min-w-0"
                  title="Terminate Backend (Kill PID)"
                  aria-label="Kill PID"
                >
                  <AppIcon name="stop" size="xs" />
                </button>
              </td>
            </tr>
            <tr v-if="!loading && connections.length === 0">
              <td colspan="8" class="px-4 py-8 text-center text-xs text-neutral-600">
                No active connections outside panel.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Slow Queries / pg_stat_statements -->
    <div>
      <div class="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-200 bg-neutral-50 px-4 py-2 text-xs font-semibold uppercase tracking-wider text-neutral-600 sm:px-6">
        <span>Slow Queries (pg_stat_statements)</span>
        <div class="flex items-center gap-1.5 text-xs normal-case">
          <span class="text-neutral-600 uppercase tracking-wider text-[10px]">Sort:</span>
          <button
            v-for="s in [
              { id: 'mean_exec_time' as const, label: 'Mean' },
              { id: 'total_exec_time' as const, label: 'Total' },
              { id: 'calls' as const, label: 'Calls' },
            ]"
            :key="s.id"
            @click="sortBy = s.id; load()"
            :class="sortBy === s.id ? 'text-emerald-700 font-semibold' : 'text-neutral-600 hover:text-neutral-900'"
            class="rounded px-1.5 py-0.5 transition active:scale-[0.98]"
          >
            {{ s.label }}
          </button>
        </div>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="border-b border-neutral-200 text-xs text-neutral-600">
            <tr>
              <th class="px-4 py-2.5 sm:px-6">Database</th>
              <th class="px-4 py-2.5">Calls</th>
              <th class="px-4 py-2.5">Mean</th>
              <th class="px-4 py-2.5">Total</th>
              <th class="px-4 py-2.5">Query</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-neutral-200/80">
            <TableSkeleton v-if="loading" :rows="3" :cols="5" />
            <tr v-for="(q, idx) in slowQueries" :key="idx" class="align-middle hover:bg-neutral-50">
              <td class="px-4 py-2.5 font-mono text-xs text-neutral-900 sm:px-6">{{ q.db_name }}</td>
              <td class="px-4 py-2.5 font-mono text-xs text-neutral-700">{{ q.calls.toLocaleString() }}</td>
              <td class="px-4 py-2.5 font-mono text-xs font-semibold text-amber-700">{{ q.mean_ms.toFixed(1) }}ms</td>
              <td class="px-4 py-2.5 font-mono text-xs text-neutral-700">{{ (q.total_ms / 1000).toFixed(2) }}s</td>
              <td class="max-w-md truncate px-4 py-2.5 font-mono text-xs text-neutral-600" :title="q.query">
                {{ q.query }}
              </td>
            </tr>
            <tr v-if="!loading && slowQueries.length === 0">
              <td colspan="5" class="px-4 py-8 text-center text-xs text-neutral-600">
                No queries recorded in pg_stat_statements yet.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Confirm Kill Modal -->
    <ConfirmModal
      :open="killPidTarget !== null"
      title="Terminate Query (Kill PID)"
      :message="`Terminate PostgreSQL backend PID ${killPidTarget}? Any active transaction will be rolled back.`"
      confirm-label="Terminate"
      :danger="true"
      @confirm="confirmKillPid"
      @cancel="killPidTarget = null"
    />
  </div>
</template>
