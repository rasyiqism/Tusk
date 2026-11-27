<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../lib/api";
import { useToast } from "../components/useToast";
import AppIcon from "../components/AppIcon.vue";
import BottomSheet from "../components/BottomSheet.vue";
import ConfirmModal from "../components/ConfirmModal.vue";
import CreateDbSheet from "../components/CreateDbSheet.vue";
import ConnectionSheet from "../components/ConnectionSheet.vue";
import TuningSheet from "../components/TuningSheet.vue";
import MigrateSheet from "../components/MigrateSheet.vue";
import Layer2Sheet from "../components/Layer2Sheet.vue";
import TableSkeleton from "../components/TableSkeleton.vue";

interface InstanceItem {
  id: string;
  name: string;
  mode: string;
  env: string;
  db_name: string;
  db_username: string;
  backup_cron: string;
  retention_days: number;
  connection_limit: number;
  statement_timeout_sec: number;
  primary_tier?: "local" | "external";
  is_remote?: boolean;
  has_layer2?: boolean;
  layer2_target?: string | null;
  layer2_label?: string | null;
  layer2_sync_mode?: "manual" | "after_backup";
  layer2_last_sync_at?: string | null;
  layer2_last_sync_status?: string | null;
  layer2_last_error?: string | null;
  status: string;
  created_at: string;
}

const route = useRoute();
const router = useRouter();
const toast = useToast();

const instances = ref<InstanceItem[]>([]);
const loading = ref(true);
const loadError = ref("");
const searchQuery = ref("");
const envFilter = ref<"all" | "prod" | "staging" | "dev" | "trash">("all");
const busyId = ref<string | null>(null);

const createSheetOpen = ref(false);
const initialCreateName = ref("");

const credsSheetOpen = ref(false);
const createdCreds = ref<{
  dbName: string;
  password: string;
  primaryTier?: "local" | "external";
  standby?: {
    configured: boolean;
    tier: "local" | "external";
    target: string | null;
    label: string | null;
    lastSyncAt: string | null;
    lastSyncStatus: string | null;
  } | null;
  connectionStrings: { internal: string; transaction: string; session: string; direct: string };
} | null>(null);

const cloneSheetOpen = ref(false);
const cloneTargetInst = ref<InstanceItem | null>(null);
const cloneTargetName = ref("");
const cloning = ref(false);

const tuningSheetOpen = ref(false);
const tuningInst = ref<InstanceItem | null>(null);

const migrateSheetOpen = ref(false);
const migrateInst = ref<InstanceItem | null>(null);

const layer2SheetOpen = ref(false);
const layer2Inst = ref<InstanceItem | null>(null);

const confirmAction = ref<{
  title: string;
  message: string;
  confirmLabel: string;
  danger: boolean;
  onConfirm: () => Promise<void>;
} | null>(null);

const filteredInstances = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  return instances.value.filter((i) => {
    const matchEnv =
      envFilter.value === "trash"
        ? i.status === "deleted"
        : i.status !== "deleted" && (envFilter.value === "all" || i.env === envFilter.value);
    const matchSearch =
      !q ||
      i.name.toLowerCase().includes(q) ||
      i.db_name.toLowerCase().includes(q) ||
      i.db_username.toLowerCase().includes(q);
    return matchEnv && matchSearch;
  });
});

async function load() {
  loading.value = true;
  loadError.value = "";
  try {
    const res = await api.api.instances.get({ query: { include_deleted: "1" } });
    if (res.error || !Array.isArray(res.data)) {
      loadError.value = "Failed to load databases.";
    } else {
      instances.value = res.data as InstanceItem[];
      if (layer2Inst.value) {
        const fresh = instances.value.find((i) => i.id === layer2Inst.value?.id);
        if (fresh) layer2Inst.value = fresh;
      }
    }
  } catch {
    loadError.value = "Connection to panel API lost.";
  } finally {
    loading.value = false;
  }
}

function openCreateWithSearch() {
  initialCreateName.value = searchQuery.value.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
  createSheetOpen.value = true;
}

function onDbCreated(creds: NonNullable<typeof createdCreds.value>) {
  createdCreds.value = creds;
  credsSheetOpen.value = true;
  void load();
}

async function showConnections(inst: InstanceItem) {
  const res = await api.api.instances({ id: inst.id }).connections.get();
  if (res.data && "connectionStrings" in res.data && res.data.connectionStrings) {
    createdCreds.value = {
      dbName: inst.db_name,
      password: "password" in res.data && typeof res.data.password === "string" ? res.data.password : "",
      primaryTier: "primaryTier" in res.data ? res.data.primaryTier : inst.primary_tier,
      standby: "standby" in res.data ? res.data.standby : null,
      connectionStrings: res.data.connectionStrings,
    };
    credsSheetOpen.value = true;
  } else {
    toast.error("Failed to fetch credentials");
  }
}

async function togglePause(inst: InstanceItem) {
  if (busyId.value) return;
  busyId.value = inst.id;
  const wasActive = inst.status === "active";
  const res = wasActive
    ? await api.api.instances({ id: inst.id }).pause.post()
    : await api.api.instances({ id: inst.id }).resume.post();
  busyId.value = null;

  if (res.error || (res.data && "error" in res.data)) {
    toast.error(`Failed to ${wasActive ? "pause" : "resume"} ${inst.db_name}`);
    return;
  }
  await load();
  toast.info(wasActive ? `${inst.db_name} paused` : `${inst.db_name} active`, {
    undo: {
      label: "Undo",
      action: async () => {
        const undoRes = wasActive
          ? await api.api.instances({ id: inst.id }).resume.post()
          : await api.api.instances({ id: inst.id }).pause.post();
        if (undoRes.error) {
          toast.error("Failed to undo action");
          return;
        }
        await load();
      },
    },
  });
}

async function submitClone() {
  if (!cloneTargetInst.value || !cloneTargetName.value.trim() || cloning.value) return;
  cloning.value = true;
  const res = await api.api.instances({ id: cloneTargetInst.value.id }).clone.post({
    target_name: cloneTargetName.value.trim(),
    env: "staging",
  });
  cloning.value = false;
  if (res.error || (res.data && "error" in res.data)) {
    toast.error("Clone failed. Check target name.");
    return;
  }
  toast.success(`Cloned to ${cloneTargetName.value.trim()}`);
  cloneSheetOpen.value = false;
  cloneTargetInst.value = null;
  await load();
}

async function undeleteDb(inst: InstanceItem) {
  if (busyId.value) return;
  busyId.value = inst.id;
  const res = await api.api.instances({ id: inst.id }).undelete.post();
  busyId.value = null;
  if (res.error || (res.data && "error" in res.data)) {
    toast.error(`Failed to restore ${inst.db_name}`);
    return;
  }
  toast.success(`${inst.db_name} restored`);
  await load();
}

function purgeDb(inst: InstanceItem) {
  confirmAction.value = {
    title: `Purge ${inst.name}`,
    message: `Database ${inst.db_name}, its role, and all associated backups will be permanently deleted.`,
    confirmLabel: "Purge",
    danger: true,
    onConfirm: async () => {
      const res = await api.api.instances({ id: inst.id }).delete(undefined, { query: { purge: "1" } });
      if (res.error || (res.data && "error" in res.data)) {
        toast.error("Failed to purge database");
        return;
      }
      toast.success(`${inst.name} permanently deleted`);
      await load();
    },
  };
}

function deleteDb(inst: InstanceItem) {
  confirmAction.value = {
    title: `Delete ${inst.name}`,
    message: `A pre_delete snapshot will be created automatically and access disabled. Permanent purge occurs after 14 days.`,
    confirmLabel: "Delete",
    danger: true,
    onConfirm: async () => {
      const res = await api.api.instances({ id: inst.id }).delete();
      if (res.error || (res.data && "error" in res.data)) {
        const msg =
          (res.data && "error" in res.data && String(res.data.error)) ||
          "pre_delete backup failed; deletion aborted.";
        toast.error(msg);
        return;
      }
      toast.info(`${inst.name} moved to Trash`);
      await load();
    },
  };
}

function resetPassword(inst: InstanceItem) {
  confirmAction.value = {
    title: `Reset Password · ${inst.db_username}`,
    message: `Apps using the old password will fail to connect until connection strings are updated.`,
    confirmLabel: "Reset",
    danger: true,
    onConfirm: async () => {
      const res = await api.api.instances({ id: inst.id })["reset-password"].post();
      if (res.data && "connectionStrings" in res.data && res.data.connectionStrings) {
        createdCreds.value = {
          dbName: inst.db_name,
          password: res.data.password,
          primaryTier: inst.primary_tier,
          connectionStrings: res.data.connectionStrings,
        };
        credsSheetOpen.value = true;
        toast.success(`Password updated for ${inst.db_username}`);
      }
    },
  };
}

async function runConfirmedAction() {
  if (!confirmAction.value) return;
  const fn = confirmAction.value.onConfirm;
  confirmAction.value = null;
  await fn();
}

async function triggerBackup(inst: InstanceItem) {
  if (busyId.value) return;
  busyId.value = inst.id;
  toast.info(`Backing up ${inst.db_name}...`);
  const res = await api.api.backups({ id: inst.id }).run.post();
  busyId.value = null;
  if (res.error || (res.data && "error" in res.data)) {
    toast.error(`Backup failed for ${inst.db_name}`);
    return;
  }
  if (res.data && "backup" in res.data && res.data.backup?.status === "failed") {
    toast.error(`Backup failed: ${res.data.backup.error_message || "unknown error"}`);
    return;
  }
  toast.success(`Backup completed for ${inst.db_name}`);
}

watch(
  () => route.query.create,
  (val) => {
    if (val) createSheetOpen.value = true;
  },
  { immediate: true }
);

onMounted(load);
</script>

<template>
  <div class="w-full divide-y divide-neutral-200">
    <!-- Search-First Toolbar + Horizontal Snap Filter Chips -->
    <div class="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
      <div class="flex flex-1 flex-wrap items-center gap-3">
        <div class="relative w-full sm:w-64">
          <AppIcon name="search" size="xs" class="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
          <input
            v-model="searchQuery"
            placeholder="Search databases..."
            class="w-full rounded-lg border border-neutral-300 bg-white py-1.5 pl-8 pr-3 text-xs text-neutral-900 placeholder:text-neutral-500 focus:border-emerald-600 focus:outline-none"
          />
        </div>

        <div class="flex gap-1.5 overflow-x-auto snap-x snap-mandatory text-xs">
          <button
            v-for="env in (['all', 'prod', 'staging', 'dev', 'trash'] as const)"
            :key="env"
            @click="envFilter = env"
            :class="
              envFilter === env
                ? 'bg-neutral-900 text-white font-semibold'
                : 'bg-white text-neutral-600 border border-neutral-200 hover:bg-neutral-100 hover:text-neutral-900'
            "
            class="shrink-0 snap-start rounded-lg px-2.5 py-1.5 uppercase transition active:scale-[0.98]"
          >
            {{ env }}
          </button>
        </div>
      </div>
    </div>

    <!-- Error Recovery Banner -->
    <div v-if="loadError" class="flex items-center justify-between gap-3 bg-rose-50 px-4 py-3 sm:px-6 text-xs text-rose-700">
      <span>{{ loadError }}</span>
      <button
        @click="load"
        class="rounded-lg border border-rose-200 bg-white px-3 py-1 font-semibold text-rose-700 hover:bg-rose-100"
      >
        Retry
      </button>
    </div>

    <!-- High-Density Hairline Table -->
    <div class="overflow-x-auto">
      <table class="w-full text-left text-sm">
        <thead class="border-b border-neutral-200 text-xs text-neutral-600">
          <tr>
            <th class="px-4 py-2.5 sm:px-6">Database</th>
            <th class="px-4 py-2.5">Status</th>
            <th class="px-4 py-2.5 text-right sm:px-6">Actions</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-neutral-200/80">
          <TableSkeleton v-if="loading" :rows="4" :cols="3" />

          <tr
            v-for="inst in filteredInstances"
            v-else
            :key="inst.id"
            class="align-middle transition hover:bg-neutral-50"
          >
            <td class="px-4 py-3 sm:px-6 max-w-[260px] sm:max-w-none">
              <div class="flex flex-wrap items-center gap-1.5">
                <span class="truncate font-mono text-xs font-semibold text-neutral-900">
                  {{ inst.db_name }}
                </span>
                <span class="rounded-sm bg-neutral-100 border border-neutral-200 px-1.5 py-0.5 font-mono text-[10px] uppercase text-neutral-700">
                  {{ inst.env }}
                </span>
                <span
                  v-if="inst.primary_tier === 'external'"
                  class="rounded-sm border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 font-mono text-[10px] uppercase text-indigo-700"
                >
                  primary: ext
                </span>
                <span
                  v-else-if="inst.has_layer2"
                  :class="
                    inst.layer2_last_sync_status === 'failed'
                      ? 'border-rose-200 bg-rose-50 text-rose-700'
                      : 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  "
                  class="rounded-sm border px-1.5 py-0.5 font-mono text-[10px]"
                  :title="inst.layer2_target || ''"
                >
                  L2: {{ inst.layer2_label || "ext" }}
                </span>
              </div>
              <div class="truncate text-[11px] text-neutral-600 font-mono">
                {{ inst.primary_tier === "external" ? `L2: Local (${inst.db_name})` : inst.db_username }} &middot; lim {{ inst.connection_limit ?? 25 }} &middot; {{ inst.backup_cron || "0 2 * * *" }}
              </div>
            </td>

            <td class="px-4 py-3 whitespace-nowrap">
              <span
                :class="
                  inst.status === 'active'
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                    : inst.status === 'deleted'
                      ? 'border-rose-200 bg-rose-50 text-rose-700'
                      : 'border-amber-200 bg-amber-50 text-amber-800'
                "
                class="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium"
              >
                <span
                  :class="
                    inst.status === 'active'
                      ? 'bg-emerald-500'
                      : inst.status === 'deleted'
                        ? 'bg-rose-500'
                        : 'bg-amber-500'
                  "
                  class="h-1.5 w-1.5 rounded-full"
                />
                <span>{{ inst.status === "active" ? "Active" : inst.status === "deleted" ? "Trash" : "Paused" }}</span>
              </span>
            </td>

            <td class="px-4 py-3 text-right sm:px-6 whitespace-nowrap">
              <div v-if="inst.status === 'deleted'" class="inline-flex items-center justify-end gap-1.5">
                <button
                  @click="undeleteDb(inst)"
                  :disabled="busyId === inst.id"
                  class="min-h-[36px] rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs font-medium text-emerald-700 transition active:scale-95 hover:bg-emerald-50 disabled:opacity-50"
                >
                  Restore
                </button>
                <button
                  @click="purgeDb(inst)"
                  aria-label="Purge permanently"
                  title="Purge"
                  class="min-h-[36px] rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-medium text-rose-700 transition active:scale-95 hover:bg-rose-100"
                >
                  Purge
                </button>
              </div>

              <div v-else class="inline-flex items-center justify-end gap-0.5">
                <button
                  @click="router.push(`/instances/${inst.id}/tables`)"
                  aria-label="Tables"
                  title="Tables"
                  class="inline-flex min-h-[38px] min-w-[38px] sm:min-h-0 sm:min-w-0 items-center justify-center rounded-lg p-2 sm:p-1.5 text-indigo-600 transition active:scale-95 hover:bg-neutral-100"
                >
                  <AppIcon name="table" size="sm" />
                </button>
                <button
                  @click="showConnections(inst)"
                  aria-label="Connections"
                  title="Connections"
                  class="inline-flex min-h-[38px] min-w-[38px] sm:min-h-0 sm:min-w-0 items-center justify-center rounded-lg p-2 sm:p-1.5 text-neutral-600 transition active:scale-95 hover:bg-neutral-100 hover:text-neutral-900"
                >
                  <AppIcon name="link" size="sm" />
                </button>
                <button
                  @click="triggerBackup(inst)"
                  :disabled="busyId === inst.id"
                  aria-label="Backup"
                  title="Backup"
                  class="inline-flex min-h-[38px] min-w-[38px] sm:min-h-0 sm:min-w-0 items-center justify-center rounded-lg p-2 sm:p-1.5 text-emerald-600 transition active:scale-95 hover:bg-neutral-100 disabled:opacity-50"
                >
                  <AppIcon name="upload" size="sm" />
                </button>
                <button
                  @click="cloneTargetInst = inst; cloneTargetName = `${inst.name}_staging`; cloneSheetOpen = true"
                  aria-label="Clone"
                  title="Clone"
                  class="inline-flex min-h-[38px] min-w-[38px] sm:min-h-0 sm:min-w-0 items-center justify-center rounded-lg p-2 sm:p-1.5 text-neutral-600 transition active:scale-95 hover:bg-neutral-100 hover:text-neutral-900"
                >
                  <AppIcon name="copy" size="sm" />
                </button>
                <button
                  @click="tuningInst = inst; tuningSheetOpen = true"
                  aria-label="Scale & Schedule"
                  title="Scale & Schedule"
                  class="inline-flex min-h-[38px] min-w-[38px] sm:min-h-0 sm:min-w-0 items-center justify-center rounded-lg p-2 sm:p-1.5 text-neutral-600 transition active:scale-95 hover:bg-neutral-100 hover:text-neutral-900"
                >
                  <AppIcon name="sliders" size="sm" />
                </button>
                <button
                  @click="layer2Inst = inst; layer2SheetOpen = true"
                  aria-label="Layer 2 & Failover"
                  title="Layer 2 & Failover"
                  class="inline-flex min-h-[38px] min-w-[38px] sm:min-h-0 sm:min-w-0 items-center justify-center rounded-lg p-2 sm:p-1.5 text-emerald-600 transition active:scale-95 hover:bg-neutral-100"
                >
                  <AppIcon name="layers" size="sm" />
                </button>
                <button
                  @click="migrateInst = inst; migrateSheetOpen = true"
                  aria-label="Migrate"
                  title="Migrate"
                  class="inline-flex min-h-[38px] min-w-[38px] sm:min-h-0 sm:min-w-0 items-center justify-center rounded-lg p-2 sm:p-1.5 text-indigo-600 transition active:scale-95 hover:bg-neutral-100"
                >
                  <AppIcon name="rocket" size="sm" />
                </button>
                <button
                  @click="resetPassword(inst)"
                  aria-label="Reset Password"
                  title="Reset Password"
                  class="inline-flex min-h-[38px] min-w-[38px] sm:min-h-0 sm:min-w-0 items-center justify-center rounded-lg p-2 sm:p-1.5 text-neutral-600 transition active:scale-95 hover:bg-neutral-100 hover:text-neutral-900"
                >
                  <AppIcon name="unlock" size="sm" />
                </button>
                <button
                  @click="togglePause(inst)"
                  :disabled="busyId === inst.id"
                  :aria-label="inst.status === 'active' ? 'Pause' : 'Resume'"
                  :title="inst.status === 'active' ? 'Pause' : 'Resume'"
                  class="inline-flex min-h-[38px] min-w-[38px] sm:min-h-0 sm:min-w-0 items-center justify-center rounded-lg p-2 sm:p-1.5 text-amber-600 transition active:scale-95 hover:bg-neutral-100 disabled:opacity-50"
                >
                  <AppIcon :name="inst.status === 'active' ? 'pause' : 'play'" size="sm" />
                </button>
                <button
                  @click="deleteDb(inst)"
                  aria-label="Delete"
                  title="Delete"
                  class="inline-flex min-h-[38px] min-w-[38px] sm:min-h-0 sm:min-w-0 items-center justify-center rounded-lg p-2 sm:p-1.5 text-rose-600 transition active:scale-95 hover:bg-rose-50"
                >
                  <AppIcon name="trash" size="sm" />
                </button>
              </div>
            </td>
          </tr>

          <tr v-if="!loading && !loadError && filteredInstances.length === 0">
            <td colspan="3" class="px-4 py-12 text-center space-y-3">
              <div class="text-xs text-neutral-600">
                {{ searchQuery ? `Database "${searchQuery}" not found.` : "No databases yet." }}
              </div>
              <button
                @click="openCreateWithSearch"
                class="inline-flex items-center gap-1.5 rounded-lg bg-neutral-900 px-3.5 py-2 text-xs font-semibold text-white transition active:scale-95 hover:bg-neutral-800"
              >
                <AppIcon name="plus" size="xs" />
                <span>{{ searchQuery ? `Create "${searchQuery}"` : "Add" }}</span>
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <CreateDbSheet v-model="createSheetOpen" :initial-name="initialCreateName" @created="onDbCreated" />
    <ConnectionSheet v-model="credsSheetOpen" :creds="createdCreds" />
    <TuningSheet v-model="tuningSheetOpen" :instance="tuningInst" @saved="load" />
    <MigrateSheet v-model="migrateSheetOpen" :instance="migrateInst" @completed="load" />
    <Layer2Sheet v-model="layer2SheetOpen" :instance="layer2Inst" @updated="load" />

    <BottomSheet v-model="cloneSheetOpen" :title="`Clone · ${cloneTargetInst?.db_name || ''}`">
      <div class="space-y-3">
        <label class="block text-xs font-semibold text-neutral-700">Target Name</label>
        <input
          v-model="cloneTargetName"
          class="w-full rounded-lg border border-neutral-300 bg-white px-3.5 py-2.5 font-mono text-sm text-neutral-900 focus:border-emerald-600 focus:outline-none"
        />
      </div>
      <template #footer>
        <div class="flex justify-end gap-2">
          <button
            @click="cloneSheetOpen = false"
            class="rounded-lg border border-neutral-200 bg-white px-4 py-2 text-xs font-medium text-neutral-700 transition active:scale-[0.98] hover:bg-neutral-100"
          >
            Cancel
          </button>
          <button
            @click="submitClone"
            :disabled="cloning"
            class="rounded-lg bg-neutral-900 px-4 py-2 text-xs font-semibold text-white transition active:scale-[0.98] hover:bg-neutral-800 disabled:opacity-50"
          >
            {{ cloning ? "Cloning..." : "Clone" }}
          </button>
        </div>
      </template>
    </BottomSheet>

    <ConfirmModal
      :open="confirmAction !== null"
      :title="confirmAction?.title || ''"
      :message="confirmAction?.message || ''"
      :confirm-label="confirmAction?.confirmLabel"
      :danger="confirmAction?.danger"
      @confirm="runConfirmedAction"
      @cancel="confirmAction = null"
    />
  </div>
</template>
