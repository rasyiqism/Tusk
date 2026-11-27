<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { api } from "../lib/api";
import AppIcon from "../components/AppIcon.vue";
import TableSkeleton from "../components/TableSkeleton.vue";

interface TableItem {
  schema_name: string;
  table_name: string;
  estimated_rows: number;
  total_bytes: number;
}

interface ColumnItem {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}

const route = useRoute();
const instanceId = computed(() => String(route.params.id));

const dbName = ref("");
const tables = ref<TableItem[]>([]);
const loadingTables = ref(true);
const loadError = ref(false);
const search = ref("");

const selectedTable = ref<TableItem | null>(null);
const columns = ref<ColumnItem[]>([]);
const previewRows = ref<Record<string, unknown>[]>([]);
const activeView = ref<"columns" | "data">("columns");
const loadingDetail = ref(false);

const filteredTables = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return tables.value;
  return tables.value.filter(
    (t) => t.table_name.toLowerCase().includes(q) || t.schema_name.toLowerCase().includes(q)
  );
});

const previewHeaders = computed(() => {
  if (previewRows.value.length > 0) return Object.keys(previewRows.value[0]);
  return columns.value.map((c) => c.column_name);
});

async function loadTables() {
  loadingTables.value = true;
  loadError.value = false;
  try {
    const [listRes, tablesRes] = await Promise.all([
      api.api.instances.get(),
      api.api.instances({ id: instanceId.value }).tables.get(),
    ]);

    if (Array.isArray(listRes.data)) {
      const found = listRes.data.find((i: { id: string; db_name: string }) => i.id === instanceId.value);
      if (found) dbName.value = found.db_name;
    }

    if (tablesRes.error) {
      loadError.value = true;
      tables.value = [];
    } else if (tablesRes.data && "tables" in tablesRes.data && tablesRes.data.tables) {
      tables.value = tablesRes.data.tables as TableItem[];
      if (tables.value.length > 0 && !selectedTable.value) {
        await selectTable(tables.value[0]);
      }
    } else {
      tables.value = [];
    }
  } catch {
    loadError.value = true;
    tables.value = [];
  } finally {
    loadingTables.value = false;
  }
}

async function selectTable(t: TableItem) {
  selectedTable.value = t;
  loadingDetail.value = true;
  try {
    const [colRes, rowRes] = await Promise.all([
      api.api.instances({ id: instanceId.value }).tables({ schema: t.schema_name })({ table: t.table_name }).columns.get(),
      api.api.instances({ id: instanceId.value }).tables({ schema: t.schema_name })({ table: t.table_name }).preview.get(),
    ]);
    columns.value =
      colRes.data && "columns" in colRes.data && colRes.data.columns
        ? (colRes.data.columns as ColumnItem[])
        : [];
    previewRows.value =
      rowRes.data && "rows" in rowRes.data && rowRes.data.rows
        ? (rowRes.data.rows as Record<string, unknown>[])
        : [];
  } finally {
    loadingDetail.value = false;
  }
}

function formatCell(val: unknown): string {
  if (val === null || val === undefined) return "NULL";
  if (typeof val === "object") return JSON.stringify(val);
  return String(val);
}

onMounted(loadTables);
</script>

<template>
  <div class="w-full divide-y divide-neutral-200">
    <!-- Top Hairline Sub-Bar -->
    <div class="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
      <div class="flex items-center gap-3">
        <RouterLink
          to="/instances"
          class="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-xs text-neutral-700 transition hover:bg-neutral-100 hover:text-neutral-900"
        >
          <AppIcon name="arrow-left" size="xs" />
          <span>Back</span>
        </RouterLink>
        <span class="font-mono text-sm font-semibold text-emerald-700">
          {{ dbName || instanceId }}
        </span>
      </div>

      <button
        @click="loadTables"
        class="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-xs text-neutral-700 transition hover:bg-neutral-100 active:scale-[0.98]"
      >
        <AppIcon name="refresh" size="xs" />
        <span>Refresh</span>
      </button>
    </div>

    <!-- Error Retry Banner -->
    <div v-if="loadError" class="flex items-center justify-between gap-3 bg-rose-50 px-4 py-3 text-xs text-rose-700 sm:px-6">
      <span>Failed to load tables from database.</span>
      <button
        @click="loadTables"
        class="rounded-lg border border-rose-200 bg-white px-2.5 py-1 font-medium text-rose-700 transition hover:bg-rose-100 active:scale-[0.98]"
      >
        Retry
      </button>
    </div>

    <!-- Split 2-Column Hairline Workspace -->
    <div class="grid grid-cols-1 lg:grid-cols-12 divide-y lg:divide-y-0 lg:divide-x divide-neutral-200 min-h-[calc(100vh-7.5rem)]">
      <!-- Left Column: Table List -->
      <section class="lg:col-span-4 flex flex-col">
        <div class="border-b border-neutral-200 p-3">
          <div class="relative">
            <AppIcon name="search" size="xs" class="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
            <input
              v-model="search"
              placeholder="Search tables..."
              class="w-full rounded-lg border border-neutral-300 bg-white py-1.5 pl-8 pr-3 text-xs text-neutral-900 placeholder:text-neutral-500 focus:border-emerald-600 focus:outline-none"
            />
          </div>
        </div>

        <div class="divide-y divide-neutral-200/80 overflow-y-auto">
          <template v-if="loadingTables">
            <div v-for="i in 5" :key="`ts-${i}`" class="flex items-center justify-between px-4 py-3 animate-pulse">
              <div class="space-y-1.5">
                <div class="h-3.5 w-32 rounded bg-neutral-200" />
                <div class="h-3 w-24 rounded bg-neutral-100" />
              </div>
              <div class="h-3 w-12 rounded bg-neutral-200" />
            </div>
          </template>
          <button
            v-else
            v-for="t in filteredTables"
            :key="`${t.schema_name}.${t.table_name}`"
            @click="selectTable(t)"
            :class="
              selectedTable?.table_name === t.table_name && selectedTable?.schema_name === t.schema_name
                ? 'bg-neutral-100 border-l-2 border-l-emerald-600'
                : 'hover:bg-neutral-50'
            "
            class="flex w-full items-center justify-between px-4 py-3 text-left transition active:scale-[0.99]"
          >
            <div class="min-w-0">
              <div class="truncate font-mono text-xs font-semibold text-neutral-900">
                {{ t.table_name }}
              </div>
              <div class="font-mono text-[11px] text-neutral-600">
                {{ t.schema_name }} &middot; {{ t.estimated_rows }} rows
              </div>
            </div>
            <span class="shrink-0 font-mono text-[11px] text-neutral-600">
              {{ (t.total_bytes / 1024).toFixed(1) }} KB
            </span>
          </button>

          <div v-if="!loadingTables && filteredTables.length === 0" class="p-8 text-center text-xs text-neutral-600">
            No tables found in this database.
          </div>
        </div>
      </section>

      <!-- Right Column: Columns & Data Preview -->
      <section class="lg:col-span-8 flex flex-col">
        <div v-if="!selectedTable" class="flex flex-1 items-center justify-center p-8 text-xs text-neutral-600">
          Select a table on the left to inspect columns and rows.
        </div>

        <template v-else>
          <div class="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-200 px-4 py-2.5 sm:px-6">
            <div class="font-mono text-xs font-semibold text-emerald-700">
              {{ selectedTable.schema_name }}.{{ selectedTable.table_name }}
            </div>
            <div class="flex gap-1.5 text-xs">
              <button
                @click="activeView = 'columns'"
                :class="
                  activeView === 'columns'
                    ? 'bg-neutral-900 text-white font-semibold'
                    : 'bg-white text-neutral-600 border border-neutral-200 hover:bg-neutral-100'
                "
                class="rounded-lg px-2.5 py-1 transition active:scale-[0.98]"
              >
                Columns ({{ columns.length }})
              </button>
              <button
                @click="activeView = 'data'"
                :class="
                  activeView === 'data'
                    ? 'bg-neutral-900 text-white font-semibold'
                    : 'bg-white text-neutral-600 border border-neutral-200 hover:bg-neutral-100'
                "
                class="rounded-lg px-2.5 py-1 transition active:scale-[0.98]"
              >
                Data ({{ previewRows.length }})
              </button>
            </div>
          </div>

          <div v-if="loadingDetail" class="overflow-x-auto">
            <table class="w-full text-left text-xs">
              <tbody class="divide-y divide-neutral-200/80">
                <TableSkeleton :rows="6" :cols="4" />
              </tbody>
            </table>
          </div>

          <!-- Columns View -->
          <div v-else-if="activeView === 'columns'" class="overflow-x-auto">
            <table class="w-full text-left text-xs">
              <thead class="border-b border-neutral-200 text-neutral-600">
                <tr>
                  <th class="px-4 py-2.5 sm:px-6">Column</th>
                  <th class="px-4 py-2.5">Type</th>
                  <th class="px-4 py-2.5">Nullable</th>
                  <th class="px-4 py-2.5 sm:px-6">Default</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-neutral-200/80">
                <tr v-for="c in columns" :key="c.column_name" class="align-middle hover:bg-neutral-50">
                  <td class="px-4 py-2.5 font-mono font-semibold text-emerald-700 sm:px-6">
                    {{ c.column_name }}
                  </td>
                  <td class="px-4 py-2.5 font-mono text-neutral-800">{{ c.data_type }}</td>
                  <td class="px-4 py-2.5 font-mono text-neutral-600">{{ c.is_nullable }}</td>
                  <td class="max-w-xs truncate px-4 py-2.5 font-mono text-neutral-600 sm:px-6">
                    {{ c.column_default || "-" }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- Data Preview View (Read-Only, LIMIT 25) -->
          <div v-else class="overflow-x-auto">
            <table class="w-full text-left text-xs">
              <thead class="border-b border-neutral-200 text-neutral-600">
                <tr>
                  <th v-for="h in previewHeaders" :key="h" class="px-4 py-2.5 font-mono">
                    {{ h }}
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-neutral-200/80">
                <tr v-for="(r, idx) in previewRows" :key="idx" class="align-middle hover:bg-neutral-50">
                  <td
                    v-for="h in previewHeaders"
                    :key="h"
                    class="max-w-xs truncate px-4 py-2.5 font-mono text-neutral-800"
                    :title="formatCell(r[h])"
                  >
                    <span :class="r[h] === null ? 'text-neutral-500 italic' : ''">
                      {{ formatCell(r[h]) }}
                    </span>
                  </td>
                </tr>
                <tr v-if="previewRows.length === 0">
                  <td :colspan="Math.max(1, previewHeaders.length)" class="px-4 py-8 text-center text-neutral-600">
                    Table is empty.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </section>
    </div>
  </div>
</template>
