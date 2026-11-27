<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { api } from "../lib/api";
import { useToast } from "../components/useToast";
import AppIcon from "../components/AppIcon.vue";
import ConfirmModal from "../components/ConfirmModal.vue";

interface BackupItem {
  id: string;
  instance_id: string;
  instance_name: string;
  db_name: string;
  type: string;
  size_bytes: number;
  duration_ms: number;
  storage_key: string;
  encryption_algo: string;
  status: string;
  error_message: string | null;
  verified_restore: number;
  created_at: string;
}

interface InstanceOpt {
  id: string;
  name: string;
  db_name: string;
}

const toast = useToast();
const backups = ref<BackupItem[]>([]);
const instances = ref<InstanceOpt[]>([]);
const selectedInstanceId = ref("");
const verifying = ref(false);
const liveLogs = ref<string[]>([]);
const activeJobId = ref<string | null>(null);
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
      } else {
        liveLogs.value.push("ERROR: Gagal memulai job backup.");
        toast.error("Gagal memulai backup");
      }
    });
}

async function verifyLatest() {
  verifying.value = true;
  const res = await api.api.backups["verify-latest"].post();
  verifying.value = false;
  if (res.data && "tested" in res.data && res.data.tested) {
    toast.success(`Integritas arsip teruji valid (${res.data.tableCount} tabel)`);
    await load();
  } else {
    const err = res.data && "error" in res.data && res.data.error ? res.data.error : "Gagal menguji backup";
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
  } else {
    toast.success("Database berhasil dipulihkan");
    await load();
  }
}

onMounted(load);
onBeforeUnmount(() => {
  if (activeEs) {
    activeEs.close();
    activeEs = null;
  }
});
</script>

<template>
  <div class="w-full divide-y divide-neutral-800">
    <!-- Action Bar -->
    <div class="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
      <div class="flex flex-wrap items-center gap-2">
        <select
          v-model="selectedInstanceId"
          class="rounded-xl border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-100"
        >
          <option v-for="inst in instances" :key="inst.id" :value="inst.id">
            {{ inst.name }} ({{ inst.db_name }})
          </option>
        </select>
        <button
          @click="runBackupStream"
          :disabled="!selectedInstanceId"
          class="inline-flex items-center gap-1.5 rounded-xl bg-white px-3.5 py-1.5 text-xs font-semibold text-neutral-950 transition hover:bg-neutral-200 disabled:opacity-50"
        >
          <AppIcon name="database" size="xs" />
          <span>Backup Sekarang</span>
        </button>
      </div>

      <div class="flex items-center gap-2">
        <button
          @click="verifyLatest"
          :disabled="verifying"
          class="inline-flex items-center gap-1.5 rounded-xl border border-neutral-800 bg-neutral-900 px-3.5 py-1.5 text-xs font-medium text-neutral-200 transition hover:bg-neutral-800 disabled:opacity-50"
        >
          <AppIcon name="verified" size="xs" />
          <span>{{ verifying ? "Menguji..." : "Uji Integritas" }}</span>
        </button>
        <button
          @click="load"
          class="rounded-xl border border-neutral-800 bg-neutral-900 p-1.5 text-neutral-400 hover:text-neutral-100"
          aria-label="Refresh"
        >
          <AppIcon name="refresh" size="xs" />
        </button>
      </div>
    </div>

    <!-- Live Backup Log Console -->
    <div v-if="liveLogs.length > 0" class="space-y-2 px-4 py-3 sm:px-6 bg-neutral-950/60">
      <div class="flex items-center justify-between text-xs text-neutral-400">
        <span class="font-mono">Live Job Output</span>
        <button @click="liveLogs = []" class="hover:text-neutral-200 text-[11px]">Tutup</button>
      </div>
      <pre class="max-h-44 overflow-y-auto rounded-lg border border-neutral-800 bg-neutral-950 p-3 font-mono text-xs text-emerald-400">{{ liveLogs.join("\n") }}</pre>
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

    <ConfirmModal
      :open="restoreTarget !== null"
      title="Pulihkan Database"
      :message="`Timpa ${restoreTarget?.db_name} dengan backup ${restoreTarget?.created_at}? Snapshot pengaman pre_restore akan dibuat otomatis terlebih dahulu.`"
      confirm-label="Pulihkan Database"
      :danger="true"
      @confirm="confirmRestore"
      @cancel="restoreTarget = null"
    />
  </div>
</template>
