<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../lib/api";
import { useToast } from "../components/useToast";
import AppIcon from "../components/AppIcon.vue";
import BottomSheet from "../components/BottomSheet.vue";
import ConfirmModal from "../components/ConfirmModal.vue";
import CreateDbSheet from "../components/CreateDbSheet.vue";
import ConnectionSheet from "../components/ConnectionSheet.vue";

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
const searchQuery = ref("");
const envFilter = ref<"all" | "prod" | "staging" | "dev" | "trash">("all");

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
const tuningConnLimit = ref(25);
const tuningTimeoutSec = ref(30);
const tuningCron = ref("0 2 * * *");
const tuningRetention = ref(14);
const savingTuning = ref(false);

const migrateSheetOpen = ref(false);
const migrateInst = ref<InstanceItem | null>(null);
const migrateTargetUrl = ref("");
const migratePauseSource = ref(true);
const migratePromoteRemote = ref(false);
const migratePreflightInfo = ref<{
  targetHost: string;
  targetDatabase: string;
  targetVersion: string;
  sourceTables: number;
  targetExistingTables: number;
} | null>(null);
const migrateError = ref("");
const migrateLogs = ref<string[]>([]);
const migrating = ref(false);
let activeSseEs: EventSource | null = null;

const layer2SheetOpen = ref(false);
const layer2Inst = ref<InstanceItem | null>(null);
const layer2Url = ref("");
const layer2Label = ref("");
const layer2SyncMode = ref<"after_backup" | "manual">("after_backup");
const layer2Busy = ref(false);
const layer2Logs = ref<string[]>([]);
const layer2Error = ref("");

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
  const res = await api.api.instances.get({ query: { include_deleted: "1" } });
  if (Array.isArray(res.data)) {
    instances.value = res.data as InstanceItem[];
  }
  loading.value = false;
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
  }
}

async function togglePause(inst: InstanceItem) {
  const wasActive = inst.status === "active";
  if (wasActive) {
    const res = await api.api.instances({ id: inst.id }).pause.post();
    if (res.error || (res.data && "error" in res.data)) {
      toast.error(`Gagal menjeda ${inst.db_name}`);
      return;
    }
    await load();
    toast.info(`${inst.db_name} dijeda`, {
      undo: {
        label: "Urungkan",
        action: async () => {
          const r = await api.api.instances({ id: inst.id }).resume.post();
          if (r.error) {
            toast.error(`Gagal mengaktifkan kembali ${inst.db_name}`);
            return;
          }
          await load();
          toast.success(`${inst.db_name} aktif kembali`);
        },
      },
    });
  } else {
    const res = await api.api.instances({ id: inst.id }).resume.post();
    if (res.error || (res.data && "error" in res.data)) {
      toast.error(`Gagal mengaktifkan ${inst.db_name}`);
      return;
    }
    await load();
    toast.success(`${inst.db_name} aktif`, {
      undo: {
        label: "Urungkan",
        action: async () => {
          const r = await api.api.instances({ id: inst.id }).pause.post();
          if (r.error) {
            toast.error(`Gagal menjeda ${inst.db_name}`);
            return;
          }
          await load();
        },
      },
    });
  }
}

function openClone(inst: InstanceItem) {
  cloneTargetInst.value = inst;
  cloneTargetName.value = `${inst.name}_staging`;
  cloneSheetOpen.value = true;
}

async function submitClone() {
  if (!cloneTargetInst.value || !cloneTargetName.value.trim()) return;
  cloning.value = true;
  const res = await api.api.instances({ id: cloneTargetInst.value.id }).clone.post({
    target_name: cloneTargetName.value.trim(),
    env: "staging",
  });
  cloning.value = false;
  if (res.error || (res.data && "error" in res.data)) {
    toast.error("Clone gagal. Periksa nama target.");
    return;
  }
  toast.success(`Berhasil clone ke ${cloneTargetName.value.trim()}`);
  cloneSheetOpen.value = false;
  cloneTargetInst.value = null;
  await load();
}

async function undeleteDb(inst: InstanceItem) {
  const res = await api.api.instances({ id: inst.id }).undelete.post();
  if (res.error || (res.data && "error" in res.data)) {
    toast.error(`Gagal memulihkan ${inst.db_name}`);
    return;
  }
  toast.success(`${inst.db_name} dipulihkan dari sampah`);
  await load();
}

function purgeDb(inst: InstanceItem) {
  confirmAction.value = {
    title: `Hapus Permanen ${inst.name}`,
    message: `Database ${inst.db_name}, role, dan seluruh file backup terkait akan dihapus permanen sekarang.`,
    confirmLabel: "Hapus Permanen",
    danger: true,
    onConfirm: async () => {
      const res = await api.api.instances({ id: inst.id }).delete(undefined, { query: { purge: "1" } });
      if (res.error || (res.data && "error" in res.data)) {
        toast.error("Gagal menghapus permanen");
        return;
      }
      toast.success(`${inst.name} dihapus permanen`);
      await load();
    },
  };
}

function deleteDb(inst: InstanceItem) {
  confirmAction.value = {
    title: `Hapus ${inst.name}`,
    message: `Snapshot pre_delete akan dibuat dan koneksi dimatikan. Penghapusan permanen terjadi setelah 14 hari.`,
    confirmLabel: "Hapus",
    danger: true,
    onConfirm: async () => {
      const res = await api.api.instances({ id: inst.id }).delete();
      if (res.error || (res.data && "error" in res.data)) {
        const msg =
          (res.data && "error" in res.data && String(res.data.error)) ||
          "Backup pre_delete gagal, penghapusan dibatalkan.";
        toast.error(msg);
        return;
      }
      toast.info(`${inst.name} dipindahkan ke masa tenggang 14 hari`);
      await load();
    },
  };
}

function resetPassword(inst: InstanceItem) {
  confirmAction.value = {
    title: `Reset Sandi ${inst.db_username}`,
    message: `Aplikasi yang memakai sandi lama tidak dapat terhubung sampai diperbarui.`,
    confirmLabel: "Reset",
    danger: true,
    onConfirm: async () => {
      const res = await api.api.instances({ id: inst.id })["reset-password"].post();
      if (res.data && "connectionStrings" in res.data && res.data.connectionStrings) {
        createdCreds.value = {
          dbName: inst.db_name,
          password: res.data.password,
          connectionStrings: res.data.connectionStrings,
        };
        credsSheetOpen.value = true;
        toast.success(`Sandi ${inst.db_username} diperbarui`);
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
  toast.info(`Membackup ${inst.db_name}...`);
  const res = await api.api.backups({ id: inst.id }).run.post();
  if (res.error || (res.data && "error" in res.data)) {
    toast.error(`Backup ${inst.db_name} gagal`);
    return;
  }
  if (res.data && "backup" in res.data && res.data.backup && res.data.backup.status === "failed") {
    toast.error(`Backup gagal: ${res.data.backup.error_message || "error tidak diketahui"}`);
    return;
  }
  toast.success(`Backup ${inst.db_name} selesai`);
}

function openTuning(inst: InstanceItem) {
  tuningInst.value = inst;
  tuningConnLimit.value = inst.connection_limit || 25;
  tuningTimeoutSec.value = inst.statement_timeout_sec || 30;
  tuningCron.value = inst.backup_cron || "0 2 * * *";
  tuningRetention.value = inst.retention_days || 14;
  tuningSheetOpen.value = true;
}

async function saveTuning() {
  if (!tuningInst.value) return;
  savingTuning.value = true;
  const inst = tuningInst.value;
  if (!inst.is_remote) {
    const limRes = await api.api.instances({ id: inst.id }).limits.patch({
      connection_limit: tuningConnLimit.value,
      statement_timeout_sec: tuningTimeoutSec.value,
    });
    if (limRes.error || (limRes.data && "error" in limRes.data)) {
      savingTuning.value = false;
      toast.error("Gagal menyimpan limit role");
      return;
    }
  }
  const schRes = await api.api.instances({ id: inst.id }).schedule.patch({
    backup_cron: tuningCron.value.trim(),
    retention_days: tuningRetention.value,
  });
  savingTuning.value = false;
  if (schRes.error || (schRes.data && "error" in schRes.data)) {
    const msg = schRes.data && "error" in schRes.data ? String(schRes.data.error) : "Format cron tidak valid";
    toast.error(msg);
    return;
  }
  toast.success(`Konfigurasi scale & jadwal ${inst.db_name} disimpan`);
  tuningSheetOpen.value = false;
  await load();
}

function closeActiveSse() {
  if (activeSseEs) {
    activeSseEs.close();
    activeSseEs = null;
  }
}

function streamSseJob(
  jobId: string,
  logsTarget: { value: string[] },
  busyTarget: { value: boolean },
  successToast: string,
  failToast: string
) {
  closeActiveSse();
  const es = new EventSource(`/api/backups/jobs/${jobId}/stream`);
  activeSseEs = es;
  es.onmessage = (ev) => {
    logsTarget.value.push(ev.data);
    if (ev.data.includes("completed") || ev.data.includes("ERROR:") || ev.data.includes("Switch completed")) {
      busyTarget.value = false;
      closeActiveSse();
      if (ev.data.includes("ERROR:")) {
        toast.error(failToast);
      } else {
        toast.success(successToast);
        void load();
      }
    }
  };
  es.onerror = () => {
    busyTarget.value = false;
    closeActiveSse();
  };
}

function openMigrate(inst: InstanceItem) {
  closeActiveSse();
  migrateInst.value = inst;
  migrateTargetUrl.value = "";
  migratePauseSource.value = true;
  migratePromoteRemote.value = false;
  migratePreflightInfo.value = null;
  migrateError.value = "";
  migrateLogs.value = [];
  migrateSheetOpen.value = true;
}

async function runMigratePreflight() {
  if (!migrateInst.value || !migrateTargetUrl.value.trim()) return;
  migrateError.value = "";
  migratePreflightInfo.value = null;
  const res = await api.api.instances({ id: migrateInst.value.id }).migrate.preflight.post({
    target_url: migrateTargetUrl.value.trim(),
  });
  if (res.data && "preflight" in res.data && res.data.preflight) {
    migratePreflightInfo.value = res.data.preflight;
  } else {
    migrateError.value =
      (res.data && "error" in res.data && String(res.data.error)) ||
      (res.error?.value && typeof res.error.value === "object" && "error" in res.error.value
        ? String((res.error.value as { error: unknown }).error)
        : "Gagal terhubung ke server target");
  }
}

async function startMigration() {
  if (!migrateInst.value || !migrateTargetUrl.value.trim()) return;
  migrateError.value = "";
  migrating.value = true;
  migrateLogs.value = ["Memulai streaming scale-out migration..."];

  const res = await api.api.instances({ id: migrateInst.value.id }).migrate.post({
    target_url: migrateTargetUrl.value.trim(),
    pause_source: migratePauseSource.value,
    promote_remote: migratePromoteRemote.value,
  });

  if (res.data && "jobId" in res.data && res.data.jobId) {
    streamSseJob(
      res.data.jobId,
      migrateLogs,
      migrating,
      "Scale-out migrasi selesai",
      "Migrasi gagal; lihat log detail"
    );
  } else {
    migrating.value = false;
    migrateError.value =
      (res.data && "error" in res.data && String(res.data.error)) || "Gagal memulai migrasi";
  }
}

function openLayer2(inst: InstanceItem) {
  closeActiveSse();
  layer2Inst.value = inst;
  layer2Url.value = "";
  layer2Label.value = inst.layer2_label || "";
  layer2SyncMode.value = inst.layer2_sync_mode || "after_backup";
  layer2Logs.value = [];
  layer2Error.value = "";
  layer2SheetOpen.value = true;
}

async function saveLayer2Target() {
  if (!layer2Inst.value || !layer2Url.value.trim()) return;
  layer2Error.value = "";
  layer2Busy.value = true;
  const res = await api.api.instances({ id: layer2Inst.value.id }).layer2.put({
    target_url: layer2Url.value.trim(),
    label: layer2Label.value.trim() || undefined,
    sync_mode: layer2SyncMode.value,
  });
  layer2Busy.value = false;
  if (res.data && "ok" in res.data && res.data.ok) {
    toast.success("Target Layer 2 disimpan & terverifikasi");
    layer2Url.value = "";
    await load();
    const updated = instances.value.find((i) => i.id === layer2Inst.value?.id);
    if (updated) layer2Inst.value = updated;
  } else {
    layer2Error.value =
      (res.data && "error" in res.data && String(res.data.error)) || "Gagal menyimpan target Layer 2";
  }
}

async function detachLayer2() {
  if (!layer2Inst.value) return;
  layer2Error.value = "";
  const res = await api.api.instances({ id: layer2Inst.value.id }).layer2.delete();
  if (res.data && "ok" in res.data && res.data.ok) {
    toast.info("Target Layer 2 dilepas");
    await load();
    const updated = instances.value.find((i) => i.id === layer2Inst.value?.id);
    if (updated) layer2Inst.value = updated;
  } else {
    layer2Error.value =
      (res.data && "error" in res.data && String(res.data.error)) || "Gagal melepas Layer 2";
  }
}

async function syncLayer2Now() {
  if (!layer2Inst.value) return;
  layer2Error.value = "";
  layer2Busy.value = true;
  layer2Logs.value = ["Memulai sinkronisasi snapshot Primary -> Layer 2..."];
  const res = await api.api.instances({ id: layer2Inst.value.id }).layer2.sync.post();
  if (res.data && "jobId" in res.data && res.data.jobId) {
    streamSseJob(
      res.data.jobId,
      layer2Logs,
      layer2Busy,
      "Sinkronisasi Layer 2 selesai",
      "Sinkronisasi Layer 2 gagal"
    );
  } else {
    layer2Busy.value = false;
    layer2Error.value =
      (res.data && "error" in res.data && String(res.data.error)) || "Gagal memulai sinkronisasi";
  }
}

async function switchPrimaryTier(targetTier: "local" | "external") {
  if (!layer2Inst.value) return;
  layer2Error.value = "";
  layer2Busy.value = true;
  layer2Logs.value = [
    targetTier === "external"
      ? "Memulai Promote Layer 2 Eksternal -> Primary..."
      : "Memulai Failback Eksternal -> Tusk Lokal sebagai Primary...",
  ];
  const res = await api.api.instances({ id: layer2Inst.value.id }).layer2.switch.post({
    target_tier: targetTier,
    pause_cutover: true,
  });
  if (res.data && "jobId" in res.data && res.data.jobId) {
    streamSseJob(
      res.data.jobId,
      layer2Logs,
      layer2Busy,
      targetTier === "external" ? "Eksternal kini menjadi Primary" : "Tusk Lokal kembali menjadi Primary",
      "Perpindahan Primary gagal; rollback otomatis"
    );
  } else {
    layer2Busy.value = false;
    layer2Error.value =
      (res.data && "error" in res.data && String(res.data.error)) || "Gagal mengganti Primary tier";
  }
}

watch(
  () => route.query.create,
  (val) => {
    if (val) createSheetOpen.value = true;
  },
  { immediate: true }
);

onMounted(load);
onBeforeUnmount(() => {
  closeActiveSse();
});
</script>

<template>
  <div class="w-full divide-y divide-neutral-800">
    <!-- Search-First Toolbar + Horizontal Snap Filter Chips -->
    <div class="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
      <div class="flex flex-1 flex-wrap items-center gap-3">
        <div class="relative w-full sm:w-64">
          <AppIcon name="search" size="xs" class="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
          <input
            v-model="searchQuery"
            placeholder="Cari database..."
            class="w-full rounded-lg border border-neutral-800 bg-neutral-900 py-1.5 pl-8 pr-3 text-xs text-neutral-100 placeholder:text-neutral-500 focus:border-indigo-500 focus:outline-none"
          />
        </div>

        <div class="flex gap-1.5 overflow-x-auto snap-x snap-mandatory text-xs">
          <button
            v-for="env in (['all', 'prod', 'staging', 'dev', 'trash'] as const)"
            :key="env"
            @click="envFilter = env"
            :class="
              envFilter === env
                ? 'bg-white text-neutral-950 font-semibold'
                : 'bg-neutral-900 text-neutral-400 border border-neutral-800 hover:bg-neutral-800'
            "
            class="shrink-0 snap-start rounded-lg px-2.5 py-1 uppercase transition"
          >
            {{ env === "trash" ? "Sampah" : env }}
          </button>
        </div>
      </div>

      <button
        @click="openCreateWithSearch"
        class="inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-neutral-950 transition-all duration-150 hover:bg-neutral-200 hover:scale-[1.02] active:scale-[0.98]"
      >
        <AppIcon name="plus" size="xs" />
        <span>Tambah</span>
      </button>
    </div>

    <!-- High-Density Hairline Table -->
    <div class="overflow-x-auto">
      <table class="w-full text-left text-sm">
        <thead class="border-b border-neutral-800 text-xs text-neutral-400">
          <tr>
            <th class="px-4 py-2.5 sm:px-6">Database</th>
            <th class="px-4 py-2.5">Status</th>
            <th class="px-4 py-2.5 text-right sm:px-6">Aksi</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-neutral-800/80">
          <tr v-if="loading">
            <td colspan="3" class="px-4 py-6 text-center text-xs text-neutral-500">Memuat...</td>
          </tr>

          <tr
            v-for="inst in filteredInstances"
            :key="inst.id"
            class="align-middle transition hover:bg-neutral-900/60"
          >
            <td class="px-4 py-3 sm:px-6">
              <div class="flex flex-wrap items-center gap-1.5">
                <span class="truncate font-mono text-xs font-semibold text-neutral-100">
                  {{ inst.db_name }}
                </span>
                <span class="rounded-sm bg-neutral-800 px-1.5 py-0.5 font-mono text-[10px] uppercase text-neutral-300">
                  {{ inst.env }}
                </span>
                <span
                  v-if="inst.primary_tier === 'external'"
                  class="rounded-sm border border-indigo-800 bg-indigo-950/60 px-1.5 py-0.5 font-mono text-[10px] uppercase text-indigo-300"
                >
                  primary: ext
                </span>
                <span
                  v-else-if="inst.has_layer2"
                  :class="
                    inst.layer2_last_sync_status === 'failed'
                      ? 'border-rose-800/80 bg-rose-950/40 text-rose-300'
                      : 'border-emerald-800/70 bg-emerald-950/30 text-emerald-300'
                  "
                  class="rounded-sm border px-1.5 py-0.5 font-mono text-[10px]"
                  :title="inst.layer2_target || ''"
                >
                  L2: {{ inst.layer2_label || 'ext' }}
                </span>
              </div>
              <div class="truncate text-[11px] text-neutral-400 font-mono">
                {{ inst.primary_tier === 'external' ? `L2: Tusk Lokal (${inst.db_name})` : inst.db_username }} &middot; lim {{ inst.connection_limit ?? 25 }} &middot; {{ inst.backup_cron || "0 2 * * *" }}
              </div>
            </td>

            <td class="px-4 py-3">
              <span
                :class="
                  inst.status === 'active'
                    ? 'border-emerald-800 bg-emerald-950/40 text-emerald-400'
                    : inst.status === 'deleted'
                      ? 'border-rose-800 bg-rose-950/40 text-rose-400'
                      : 'border-amber-800 bg-amber-950/40 text-amber-400'
                "
                class="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium"
              >
                <span
                  :class="
                    inst.status === 'active'
                      ? 'bg-emerald-400'
                      : inst.status === 'deleted'
                        ? 'bg-rose-400'
                        : 'bg-amber-400'
                  "
                  class="h-1.5 w-1.5 rounded-full"
                />
                <span>{{ inst.status === "active" ? "Aktif" : inst.status === "deleted" ? "Sampah" : "Jeda" }}</span>
              </span>
            </td>

            <td class="px-4 py-3 text-right sm:px-6">
              <div v-if="inst.status === 'deleted'" class="inline-flex items-center justify-end gap-1">
                <button
                  @click="undeleteDb(inst)"
                  class="rounded-lg border border-neutral-800 bg-neutral-900 px-2.5 py-1 text-xs font-medium text-emerald-400 transition hover:bg-neutral-800"
                >
                  Pulihkan
                </button>
                <button
                  @click="purgeDb(inst)"
                  class="rounded-lg border border-rose-900/60 bg-rose-950/40 px-2.5 py-1 text-xs font-medium text-rose-400 transition hover:bg-rose-950"
                >
                  Hapus Permanen
                </button>
              </div>
              <div v-else class="inline-flex items-center justify-end gap-0.5">
                <button
                  @click="router.push(`/instances/${inst.id}/tables`)"
                  aria-label="Tabel"
                  title="Tabel"
                  class="rounded-lg p-1.5 text-indigo-400 transition hover:bg-neutral-800"
                >
                  <AppIcon name="table" size="sm" />
                </button>
                <button
                  @click="showConnections(inst)"
                  aria-label="Koneksi"
                  title="Koneksi"
                  class="rounded-lg p-1.5 text-neutral-300 transition hover:bg-neutral-800"
                >
                  <AppIcon name="link" size="sm" />
                </button>
                <button
                  @click="triggerBackup(inst)"
                  aria-label="Backup"
                  title="Backup"
                  class="rounded-lg p-1.5 text-emerald-400 transition hover:bg-neutral-800"
                >
                  <AppIcon name="upload" size="sm" />
                </button>
                <button
                  @click="openClone(inst)"
                  aria-label="Clone"
                  title="Clone"
                  class="rounded-lg p-1.5 text-neutral-300 transition hover:bg-neutral-800"
                >
                  <AppIcon name="copy" size="sm" />
                </button>
                <button
                  @click="openTuning(inst)"
                  aria-label="Scale & Jadwal"
                  title="Scale & Jadwal"
                  class="rounded-lg p-1.5 text-neutral-300 transition hover:bg-neutral-800"
                >
                  <AppIcon name="sliders" size="sm" />
                </button>
                <button
                  @click="openLayer2(inst)"
                  aria-label="Layer 2 & Failover"
                  title="Layer 2 & Failover"
                  class="rounded-lg p-1.5 text-emerald-400 transition hover:bg-neutral-800"
                >
                  <AppIcon name="layers" size="sm" />
                </button>
                <button
                  @click="openMigrate(inst)"
                  aria-label="Scale-Out / Migrasi"
                  title="Scale-Out / Migrasi"
                  class="rounded-lg p-1.5 text-indigo-400 transition hover:bg-neutral-800"
                >
                  <AppIcon name="rocket" size="sm" />
                </button>
                <button
                  @click="resetPassword(inst)"
                  aria-label="Reset Sandi"
                  title="Reset Sandi"
                  class="rounded-lg p-1.5 text-neutral-300 transition hover:bg-neutral-800"
                >
                  <AppIcon name="unlock" size="sm" />
                </button>
                <button
                  @click="togglePause(inst)"
                  :aria-label="inst.status === 'active' ? 'Jeda' : 'Aktifkan'"
                  :title="inst.status === 'active' ? 'Jeda' : 'Aktifkan'"
                  class="rounded-lg p-1.5 text-amber-400 transition hover:bg-neutral-800"
                >
                  <AppIcon :name="inst.status === 'active' ? 'pause' : 'play'" size="sm" />
                </button>
                <button
                  @click="deleteDb(inst)"
                  aria-label="Hapus"
                  title="Hapus"
                  class="rounded-lg p-1.5 text-rose-400 transition hover:bg-rose-950/60"
                >
                  <AppIcon name="trash" size="sm" />
                </button>
              </div>
            </td>
          </tr>

          <tr v-if="!loading && filteredInstances.length === 0">
            <td colspan="3" class="px-4 py-10 text-center space-y-3">
              <div class="text-xs text-neutral-400">
                {{ searchQuery ? `Database "${searchQuery}" tidak ditemukan.` : "Belum ada database." }}
              </div>
              <button
                @click="openCreateWithSearch"
                class="inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-neutral-950 hover:bg-neutral-200"
              >
                <AppIcon name="plus" size="xs" />
                <span>{{ searchQuery ? `Buat "${searchQuery}"` : "Tambah" }}</span>
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <CreateDbSheet
      v-model="createSheetOpen"
      :initial-name="initialCreateName"
      @created="onDbCreated"
    />

    <ConnectionSheet v-model="credsSheetOpen" :creds="createdCreds" />

    <BottomSheet v-model="cloneSheetOpen" :title="`Clone · ${cloneTargetInst?.db_name || ''}`">
      <div class="space-y-3">
        <label class="block text-xs font-semibold text-neutral-300">Nama Target</label>
        <input
          v-model="cloneTargetName"
          class="w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3.5 py-2.5 font-mono text-sm text-neutral-100"
        />
      </div>
      <template #footer>
        <div class="flex justify-end gap-2">
          <button
            @click="cloneSheetOpen = false"
            class="rounded-xl border border-neutral-800 bg-neutral-900 px-4 py-2 text-xs font-medium text-neutral-300"
          >
            Batal
          </button>
          <button
            @click="submitClone"
            :disabled="cloning"
            class="rounded-xl bg-white px-4 py-2 text-xs font-semibold text-neutral-950 hover:bg-neutral-200 disabled:opacity-50"
          >
            {{ cloning ? "Menyalin..." : "Clone" }}
          </button>
        </div>
      </template>
    </BottomSheet>

    <BottomSheet v-model="tuningSheetOpen" :title="`Scale & Jadwal · ${tuningInst?.db_name || ''}`">
      <div class="space-y-4">
        <div v-if="!tuningInst?.is_remote" class="grid grid-cols-2 gap-3">
          <div class="space-y-1.5">
            <label class="block text-xs font-semibold text-neutral-300">Koneksi Maks (Role)</label>
            <input
              v-model.number="tuningConnLimit"
              type="number"
              min="1"
              max="500"
              class="w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3.5 py-2 font-mono text-sm text-neutral-100"
            />
          </div>
          <div class="space-y-1.5">
            <label class="block text-xs font-semibold text-neutral-300">Timeout Query (dtk)</label>
            <input
              v-model.number="tuningTimeoutSec"
              type="number"
              min="1"
              max="3600"
              class="w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3.5 py-2 font-mono text-sm text-neutral-100"
            />
          </div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div class="space-y-1.5">
            <label class="block text-xs font-semibold text-neutral-300">Cron Backup</label>
            <input
              v-model="tuningCron"
              placeholder="0 2 * * *"
              class="w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3.5 py-2 font-mono text-sm text-neutral-100"
            />
          </div>
          <div class="space-y-1.5">
            <label class="block text-xs font-semibold text-neutral-300">Retensi (Hari)</label>
            <input
              v-model.number="tuningRetention"
              type="number"
              min="1"
              max="3650"
              class="w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3.5 py-2 font-mono text-sm text-neutral-100"
            />
          </div>
        </div>
        <p class="text-[11px] text-neutral-400">
          Contoh cron: <code class="font-mono text-neutral-200">0 */6 * * *</code> (tiap 6 jam) atau <code class="font-mono text-neutral-200">0 2 * * *</code> (harian jam 02:00).
        </p>
      </div>
      <template #footer>
        <div class="flex justify-end gap-2">
          <button
            @click="tuningSheetOpen = false"
            class="rounded-xl border border-neutral-800 bg-neutral-900 px-4 py-2 text-xs font-medium text-neutral-300"
          >
            Batal
          </button>
          <button
            @click="saveTuning"
            :disabled="savingTuning"
            class="rounded-xl bg-white px-4 py-2 text-xs font-semibold text-neutral-950 hover:bg-neutral-200 disabled:opacity-50"
          >
            {{ savingTuning ? "Menyimpan..." : "Simpan" }}
          </button>
        </div>
      </template>
    </BottomSheet>

    <BottomSheet v-model="migrateSheetOpen" :title="`Scale-Out · ${migrateInst?.db_name || ''}`">
      <div class="space-y-3.5">
        <div class="space-y-1.5">
          <label class="block text-xs font-semibold text-neutral-300">PostgreSQL Target URL (VPS Baru / Dedicated / Managed)</label>
          <input
            v-model="migrateTargetUrl"
            type="password"
            placeholder="postgres://postgres:pass@new-db.domain.com:5432/target_db?sslmode=require"
            class="w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3.5 py-2.5 font-mono text-xs text-neutral-100"
          />
        </div>

        <div class="flex flex-col gap-2 text-xs text-neutral-300">
          <label class="inline-flex items-center gap-2">
            <input v-model="migratePauseSource" type="checkbox" class="rounded border-neutral-700 bg-neutral-900" />
            <span>Jeda penulisan sumber saat cutover agar nol selisih transaksi</span>
          </label>
          <label class="inline-flex items-center gap-2">
            <input v-model="migratePromoteRemote" type="checkbox" class="rounded border-neutral-700 bg-neutral-900" />
            <span>Promosikan instance ini untuk mengarah ke node target (mode remote)</span>
          </label>
        </div>

        <div v-if="migratePreflightInfo" class="rounded-xl border border-emerald-900/60 bg-emerald-950/30 p-3 text-xs text-emerald-300 space-y-1">
          <div class="font-semibold">Koneksi Target Siap</div>
          <div class="font-mono text-[11px]">
            {{ migratePreflightInfo.targetHost }} / {{ migratePreflightInfo.targetDatabase }} ({{ migratePreflightInfo.targetVersion }})
          </div>
          <div class="text-[11px] text-emerald-200/80">
            Sumber: {{ migratePreflightInfo.sourceTables }} tabel &middot; Target saat ini: {{ migratePreflightInfo.targetExistingTables }} tabel
          </div>
        </div>

        <div v-if="migrateError" class="text-xs text-rose-400">{{ migrateError }}</div>

        <pre
          v-if="migrateLogs.length > 0"
          class="max-h-40 overflow-y-auto rounded-lg border border-neutral-800 bg-neutral-950 p-3 font-mono text-[11px] text-emerald-400"
        >{{ migrateLogs.join("\n") }}</pre>
      </div>
      <template #footer>
        <div class="flex justify-between gap-2 w-full">
          <button
            @click="runMigratePreflight"
            :disabled="migrating || !migrateTargetUrl.trim()"
            class="rounded-xl border border-neutral-800 bg-neutral-900 px-3.5 py-2 text-xs font-medium text-neutral-200 hover:bg-neutral-800 disabled:opacity-50"
          >
            Uji Koneksi
          </button>
          <div class="flex gap-2">
            <button
              @click="migrateSheetOpen = false"
              class="rounded-xl border border-neutral-800 bg-neutral-900 px-4 py-2 text-xs font-medium text-neutral-300"
            >
              Tutup
            </button>
            <button
              @click="startMigration"
              :disabled="migrating || !migrateTargetUrl.trim()"
              class="rounded-xl bg-white px-4 py-2 text-xs font-semibold text-neutral-950 hover:bg-neutral-200 disabled:opacity-50"
            >
              {{ migrating ? "Memigrasi..." : "Mulai Migrasi" }}
            </button>
          </div>
        </div>
      </template>
    </BottomSheet>

    <BottomSheet v-model="layer2SheetOpen" :title="`Layer 2 & Failover · ${layer2Inst?.db_name || ''}`">
      <div v-if="layer2Inst" class="space-y-4">
        <div class="grid grid-cols-2 gap-2.5 text-xs">
          <div class="rounded-xl border border-neutral-800 bg-neutral-950 p-3 space-y-1">
            <div class="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">Primary Aktif (L1)</div>
            <div class="font-mono font-semibold text-emerald-400">
              {{ layer2Inst.primary_tier === "external" ? `Eksternal (${layer2Inst.layer2_label || "remote"})` : "Tusk Lokal" }}
            </div>
          </div>
          <div class="rounded-xl border border-neutral-800 bg-neutral-950 p-3 space-y-1">
            <div class="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">Layer 2 Standby</div>
            <div class="font-mono text-indigo-300 truncate">
              {{
                layer2Inst.primary_tier === "external"
                  ? `Tusk Lokal (${layer2Inst.db_name})`
                  : layer2Inst.has_layer2
                    ? `${layer2Inst.layer2_label || layer2Inst.layer2_target}`
                    : "Belum terpasang"
              }}
            </div>
            <div v-if="layer2Inst.layer2_last_sync_at" class="text-[10px] text-neutral-400">
              Sync terakhir: {{ layer2Inst.layer2_last_sync_status || "-" }} ({{ layer2Inst.layer2_last_sync_at }})
            </div>
          </div>
        </div>

        <div v-if="layer2Inst.layer2_last_error" class="rounded-lg border border-rose-900/60 bg-rose-950/30 p-2.5 text-[11px] text-rose-300">
          Sync terakhir gagal: {{ layer2Inst.layer2_last_error }}
        </div>

        <div class="space-y-3 rounded-xl border border-neutral-800 bg-neutral-900/40 p-3">
          <div class="flex items-center justify-between">
            <span class="text-xs font-semibold text-neutral-200">Target Node Eksternal</span>
            <button
              v-if="layer2Inst.has_layer2 && layer2Inst.primary_tier !== 'external'"
              @click="detachLayer2"
              class="text-[11px] text-rose-400 hover:underline"
            >
              Lepas Layer 2
            </button>
          </div>
          <input
            v-model="layer2Url"
            type="password"
            placeholder="postgres://user:pass@ep-xxx.aws.neon.tech/neondb?sslmode=require"
            class="w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-xs text-neutral-100"
          />
          <div class="grid grid-cols-2 gap-2.5">
            <input
              v-model="layer2Label"
              placeholder="Label (neon / supabase / vps2)"
              class="w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3 py-1.5 text-xs text-neutral-100"
            />
            <select
              v-model="layer2SyncMode"
              class="w-full rounded-xl border border-neutral-800 bg-neutral-950 px-2.5 py-1.5 text-xs text-neutral-100"
            >
              <option value="after_backup">Sync Otomatis Setelah Backup</option>
              <option value="manual">Sync Manual Saja</option>
            </select>
          </div>
          <div class="flex justify-end">
            <button
              @click="saveLayer2Target"
              :disabled="layer2Busy || !layer2Url.trim()"
              class="rounded-xl border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-xs font-medium text-neutral-100 hover:bg-neutral-700 disabled:opacity-50"
            >
              {{ layer2Inst.has_layer2 ? "Perbarui Target" : "Pasang Layer 2" }}
            </button>
          </div>
        </div>

        <div v-if="layer2Inst.has_layer2" class="flex flex-wrap items-center justify-between gap-2 pt-1">
          <button
            @click="syncLayer2Now"
            :disabled="layer2Busy"
            class="rounded-xl border border-neutral-800 bg-neutral-900 px-3.5 py-2 text-xs font-medium text-neutral-200 hover:bg-neutral-800 disabled:opacity-50"
          >
            {{ layer2Inst.primary_tier === "external" ? "Sync Eksternal -> Tusk" : "Sync Tusk -> Layer 2" }}
          </button>
          <button
            v-if="layer2Inst.primary_tier !== 'external'"
            @click="switchPrimaryTier('external')"
            :disabled="layer2Busy"
            class="rounded-xl bg-indigo-500 px-3.5 py-2 text-xs font-semibold text-white hover:bg-indigo-400 disabled:opacity-50"
          >
            Jadikan Eksternal Primary
          </button>
          <button
            v-else
            @click="switchPrimaryTier('local')"
            :disabled="layer2Busy"
            class="rounded-xl bg-emerald-500 px-3.5 py-2 text-xs font-semibold text-neutral-950 hover:bg-emerald-400 disabled:opacity-50"
          >
            Kembalikan Tusk Primary (Failback)
          </button>
        </div>

        <div v-if="layer2Error" class="text-xs text-rose-400">{{ layer2Error }}</div>
        <pre
          v-if="layer2Logs.length > 0"
          class="max-h-40 overflow-y-auto rounded-lg border border-neutral-800 bg-neutral-950 p-3 font-mono text-[11px] text-emerald-400"
        >{{ layer2Logs.join("\n") }}</pre>
      </div>
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
