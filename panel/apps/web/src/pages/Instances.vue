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

interface InstanceItem {
  id: string;
  name: string;
  mode: string;
  env: string;
  db_name: string;
  db_username: string;
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
  connectionStrings: { internal: string; transaction: string; session: string; direct: string };
} | null>(null);

const cloneSheetOpen = ref(false);
const cloneTargetInst = ref<InstanceItem | null>(null);
const cloneTargetName = ref("");
const cloning = ref(false);

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
              <div class="flex items-center gap-2">
                <span class="truncate font-mono text-xs font-semibold text-neutral-100">
                  {{ inst.db_name }}
                </span>
                <span class="rounded-sm bg-neutral-800 px-1.5 py-0.5 font-mono text-[10px] uppercase text-neutral-300">
                  {{ inst.env }}
                </span>
              </div>
              <div class="truncate text-[11px] text-neutral-400 font-mono">
                {{ inst.db_username }}
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
