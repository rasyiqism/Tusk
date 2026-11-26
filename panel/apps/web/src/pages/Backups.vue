<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { api } from "../lib/api";
import { useToast } from "../components/useToast";
import AppIcon from "../components/AppIcon.vue";
import BottomSheet from "../components/BottomSheet.vue";
import ConfirmModal from "../components/ConfirmModal.vue";

interface BackupItem {
  id: string;
  instance_id: string;
  instance_name: string;
  db_name: string;
  type: string;
  size_bytes: number;
  duration_ms: number;
  status: string;
  encryption_algo: string;
  error_message: string | null;
  verified_restore: number;
  created_at: string;
}

interface InstanceOpt {
  id: string;
  name: string;
  mode: string;
}

const toast = useToast();
const backups = ref<BackupItem[]>([]);
const instances = ref<InstanceOpt[]>([]);
const selectedInstanceId = ref("");
const verifying = ref(false);
const liveLogs = ref<string[]>([]);
const activeJobId = ref<string | null>(null);
const pitrTargetTime = ref("");
const pitrInstanceId = ref<string | null>(null);
const pitrSheetOpen = ref(false);
const pitrSubmitting = ref(false);
const restoreTarget = ref<BackupItem | null>(null);
let activeEs: EventSource | null = null;

async function load() {
  const [bRes, iRes] = await Promise.all([api.api.backups.get(), api.api.instances.get()]);
  if (bRes.data && "backups" in bRes.data) {
    backups.value = bRes.data.backups as BackupItem[];
  }
  if (Array.isArray(iRes.data)) {
    instances.value = iRes.data as InstanceOpt[];
    if (!selectedInstanceId.value && instances.value.length > 0) {
      selectedInstanceId.value = instances.value[0].id;
    }
  }
}

function runBackupStream() {
  if (!selectedInstanceId.value) return;
  if (activeEs) activeEs.close();
  liveLogs.value = ["Memulai proses backup..."];
  api.api.backups({ id: selectedInstanceId.value })
    .run.post(undefined, { query: { async: "1" } })
    .then((res) => {
      if (res.data && "jobId" in res.data && res.data.jobId) {
        const jobId = res.data.jobId;
        activeJobId.value = jobId;
        const es = new EventSource(`/api/backups/jobs/${jobId}/stream`);
        activeEs = es;
        es.onmessage = (ev) => {
          liveLogs.value.push(ev.data);
          if (ev.data.includes("completed") || ev.data.includes("ERROR:")) {
            es.close();
            void load();
          }
        };
        es.onerror = () => {
          es.close();
          void load();
        };
      }
    });
}

async function runWalgBase(id: string) {
  const res = await api.api.backups({ id })["walg-base"].post();
  if (res.data && "ok" in res.data && res.data.ok) {
    toast.success("Base backup WAL-G dijalankan");
  } else {
    toast.error("Gagal menjalankan WAL-G base backup");
  }
}

function openPitr(id: string) {
  pitrInstanceId.value = id;
  pitrTargetTime.value = new Date().toISOString();
  pitrSheetOpen.value = true;
}

async function submitPitr() {
  if (!pitrInstanceId.value || !pitrTargetTime.value) return;
  pitrSubmitting.value = true;
  const res = await api.api.backups({ id: pitrInstanceId.value })["pitr-restore"].post({
    targetTime: pitrTargetTime.value,
  });
  pitrSubmitting.value = false;
  if (res.data && "ok" in res.data && res.data.ok) {
    toast.success(res.data.message || "PITR selesai");
    pitrSheetOpen.value = false;
    pitrInstanceId.value = null;
    await load();
  } else {
    const err =
      (res.data && "error" in res.data && String(res.data.error)) ||
      (res.error?.value && typeof res.error.value === "object" && "error" in res.error.value
        ? String((res.error.value as { error: unknown }).error)
        : "PITR gagal");
    toast.error(err);
  }
}

async function verifyLatest() {
  verifying.value = true;
  const res = await api.api.backups["verify-latest"].post();
  verifying.value = false;
  if (res.data && "tested" in res.data && res.data.tested) {
    toast.success(`Uji restore lulus (${res.data.tableCount} tabel)`);
    await load();
  } else {
    const err = res.data && "error" in res.data && res.data.error ? res.data.error : "Gagal menguji restore";
    toast.error(err);
  }
}

async function confirmRestore() {
  const b = restoreTarget.value;
  if (!b) return;
  restoreTarget.value = null;
  const res = await api.api.backups({ id: b.id }).restore.post();
  if (res.error) {
    toast.error("Restore gagal");
    return;
  }
  toast.success("Restore selesai");
  await load();
}

onMounted(load);
onBeforeUnmount(() => {
  if (activeEs) activeEs.close();
});
</script>

<template>
  <div class="w-full divide-y divide-neutral-800">
    <!-- Toolbar -->
    <div class="flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6">
      <div class="flex flex-wrap items-center gap-2">
        <select
          v-model="selectedInstanceId"
          class="rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200"
        >
          <option v-for="inst in instances" :key="inst.id" :value="inst.id">
            {{ inst.name }} ({{ inst.mode }})
          </option>
        </select>
        <button
          @click="runBackupStream"
          :disabled="!selectedInstanceId"
          class="inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-neutral-950 transition hover:bg-neutral-200 disabled:opacity-50"
        >
          <AppIcon name="upload" size="xs" />
          <span>Backup</span>
        </button>
      </div>

      <div class="flex items-center gap-2">
        <button
          @click="verifyLatest"
          :disabled="verifying"
          class="inline-flex items-center gap-1.5 rounded-lg border border-emerald-800 bg-emerald-950/40 px-3 py-1.5 text-xs font-medium text-emerald-300 transition hover:bg-emerald-950/70 disabled:opacity-50"
        >
          <AppIcon :name="verifying ? 'spinner' : 'verified'" size="xs" :class="{ 'animate-spin': verifying }" />
          <span>{{ verifying ? "Menguji..." : "Uji" }}</span>
        </button>
        <button
          @click="load"
          class="inline-flex items-center gap-1.5 rounded-lg border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-xs text-neutral-200 hover:bg-neutral-800"
          aria-label="Segarkan"
        >
          <AppIcon name="refresh" size="xs" />
        </button>
      </div>
    </div>

    <!-- Live SSE Terminal -->
    <div v-if="liveLogs.length > 0" class="bg-neutral-900/70 px-4 py-3 sm:px-6 space-y-2">
      <div class="flex items-center justify-between text-xs text-neutral-400">
        <span class="font-mono">Job {{ activeJobId }}</span>
        <button @click="liveLogs = []" class="hover:text-neutral-200">Tutup</button>
      </div>
      <pre class="max-h-44 overflow-y-auto rounded-lg border border-neutral-800 bg-neutral-950 p-3 font-mono text-xs text-emerald-400">{{ liveLogs.join("\n") }}</pre>
    </div>

    <!-- Dedicated WAL-G Bar -->
    <div
      v-if="instances.some((i) => i.mode === 'dedicated')"
      class="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-6 bg-neutral-900/30"
    >
      <span class="text-xs font-semibold uppercase tracking-wider text-neutral-400">WAL-G PITR:</span>
      <div
        v-for="inst in instances.filter((i) => i.mode === 'dedicated')"
        :key="inst.id"
        class="inline-flex items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-900 px-2.5 py-1 text-xs"
      >
        <span class="font-mono text-emerald-400">{{ inst.name }}</span>
        <button @click="runWalgBase(inst.id)" class="text-indigo-400 hover:underline">Base</button>
        <button @click="openPitr(inst.id)" class="text-amber-400 hover:underline">PITR</button>
      </div>
    </div>

    <!-- Backups Table -->
    <div class="overflow-x-auto">
      <table class="w-full text-left text-sm">
        <thead class="border-b border-neutral-800 text-xs text-neutral-400">
          <tr>
            <th class="px-4 py-2.5 sm:px-6">Database</th>
            <th class="px-4 py-2.5">Tipe</th>
            <th class="px-4 py-2.5">Ukuran</th>
            <th class="px-4 py-2.5">Status</th>
            <th class="px-4 py-2.5 text-right sm:px-6">Aksi</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-neutral-800/80">
          <tr v-for="b in backups" :key="b.id" class="align-middle hover:bg-neutral-900/60">
            <td class="px-4 py-3 sm:px-6">
              <div class="font-mono text-xs font-semibold text-neutral-100">{{ b.db_name }}</div>
              <div class="text-[11px] text-neutral-400">{{ b.created_at }}</div>
            </td>
            <td class="px-4 py-3 text-xs">
              <span class="text-neutral-200">{{ b.type }}</span>
              <span class="ml-1.5 rounded-sm bg-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-neutral-400">
                {{ b.encryption_algo }}
              </span>
            </td>
            <td class="px-4 py-3 font-mono text-xs text-neutral-200">
              {{ (b.size_bytes / 1024).toFixed(1) }} KB
              <span class="text-neutral-500">&middot; {{ b.duration_ms }}ms</span>
            </td>
            <td class="px-4 py-3">
              <span
                :class="b.status === 'success' ? 'text-emerald-400' : 'text-rose-400'"
                class="text-xs font-semibold uppercase"
              >
                {{ b.status }}
              </span>
              <span
                v-if="b.verified_restore"
                class="ml-2 inline-flex items-center gap-1 rounded-full border border-emerald-800 bg-emerald-950/40 px-2 py-0.5 text-[10px] text-emerald-300"
              >
                <AppIcon name="verified" size="xs" />
                <span>Teruji</span>
              </span>
              <div v-if="b.error_message" class="mt-0.5 max-w-xs truncate text-[11px] text-rose-400">
                {{ b.error_message }}
              </div>
            </td>
            <td class="px-4 py-3 text-right sm:px-6">
              <div v-if="b.status === 'success'" class="inline-flex items-center gap-1">
                <a
                  :href="`/api/backups/${b.id}/download`"
                  class="rounded-lg p-1.5 text-neutral-400 transition hover:bg-neutral-800 hover:text-neutral-100"
                  aria-label="Unduh"
                  title="Unduh"
                >
                  <AppIcon name="arrow-left" size="sm" class="-rotate-90" />
                </a>
                <button
                  @click="restoreTarget = b"
                  class="rounded-lg p-1.5 text-amber-400 transition hover:bg-amber-950/60"
                  aria-label="Pulihkan"
                  title="Pulihkan"
                >
                  <AppIcon name="refresh" size="sm" />
                </button>
              </div>
            </td>
          </tr>
          <tr v-if="backups.length === 0">
            <td colspan="5" class="px-4 py-8 text-center text-xs text-neutral-500">
              Belum ada riwayat backup.
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <BottomSheet v-model="pitrSheetOpen" title="Point-in-Time Recovery (PITR)">
      <div class="space-y-4">
        <div class="space-y-1.5">
          <label class="block text-xs font-semibold text-neutral-300">Target Timestamp (ISO UTC)</label>
          <input
            v-model="pitrTargetTime"
            placeholder="2026-11-26T15:00:00Z"
            class="w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3.5 py-2.5 font-mono text-sm text-neutral-100"
          />
        </div>
      </div>
      <template #footer>
        <div class="flex justify-end gap-2">
          <button
            @click="pitrSheetOpen = false"
            class="rounded-xl border border-neutral-800 bg-neutral-900 px-4 py-2 text-xs font-medium text-neutral-300"
          >
            Batal
          </button>
          <button
            @click="submitPitr"
            :disabled="pitrSubmitting"
            class="rounded-xl bg-amber-600 px-4 py-2 text-xs font-semibold text-white hover:bg-amber-500 disabled:opacity-50"
          >
            {{ pitrSubmitting ? "Memulihkan..." : "Pulihkan" }}
          </button>
        </div>
      </template>
    </BottomSheet>

    <ConfirmModal
      :open="restoreTarget !== null"
      title="Pulihkan Database"
      :message="`Timpa ${restoreTarget?.db_name} dengan backup ${restoreTarget?.created_at}? Snapshot pengaman pre_restore akan dibuat otomatis terlebih dahulu.`"
      confirm-label="Pulihkan"
      :danger="true"
      @confirm="confirmRestore"
      @cancel="restoreTarget = null"
    />
  </div>
</template>
