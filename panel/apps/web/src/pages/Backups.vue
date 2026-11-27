<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { api } from "../lib/api";
import { useToast } from "../components/useToast";
import AppIcon from "../components/AppIcon.vue";
import ConfirmModal from "../components/ConfirmModal.vue";
import TableSkeleton from "../components/TableSkeleton.vue";

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
const loading = ref(true);
const loadError = ref(false);
const runningBackup = ref(false);
const verifying = ref(false);
const restoring = ref(false);
const liveLogs = ref<string[]>([]);
const activeJobId = ref<string | null>(null);
const restoreTarget = ref<BackupItem | null>(null);
let activeEs: EventSource | null = null;

async function load() {
  loading.value = backups.value.length === 0;
  loadError.value = false;
  try {
    const [bRes, iRes] = await Promise.all([api.api.backups.get(), api.api.instances.get()]);
    if (bRes.error && iRes.error) {
      loadError.value = true;
      return;
    }
    if (bRes.data && "backups" in bRes.data) {
      backups.value = bRes.data.backups as BackupItem[];
    }
    if (Array.isArray(iRes.data)) {
      instances.value = iRes.data as InstanceOpt[];
      if (!selectedInstanceId.value && instances.value.length > 0) {
        selectedInstanceId.value = instances.value[0].id;
      }
    }
  } catch {
    loadError.value = true;
  } finally {
    loading.value = false;
  }
}

function runBackupStream() {
  if (!selectedInstanceId.value || runningBackup.value) return;
  if (activeEs) activeEs.close();
  runningBackup.value = true;
  liveLogs.value = ["Starting backup job..."];
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
            runningBackup.value = false;
            void load();
          }
        };
        es.onerror = () => {
          es.close();
          runningBackup.value = false;
          void load();
        };
      } else {
        runningBackup.value = false;
        liveLogs.value.push("ERROR: Failed to start backup job.");
        toast.error("Failed to start backup");
      }
    })
    .catch(() => {
      runningBackup.value = false;
      liveLogs.value.push("ERROR: Server connection lost.");
      toast.error("Failed to start backup");
    });
}

async function verifyLatest() {
  if (verifying.value) return;
  verifying.value = true;
  try {
    const res = await api.api.backups["verify-latest"].post();
    if (res.data && "tested" in res.data && res.data.tested) {
      toast.success(`Archive integrity verified (${res.data.tableCount} tables)`);
      await load();
    } else {
      const err = res.data && "error" in res.data && res.data.error ? res.data.error : "Failed to verify backup";
      toast.error(err);
    }
  } finally {
    verifying.value = false;
  }
}

async function confirmRestore() {
  const b = restoreTarget.value;
  if (!b || restoring.value) return;
  restoring.value = true;
  restoreTarget.value = null;
  try {
    const res = await api.api.backups({ id: b.id }).restore.post();
    if (res.error) {
      toast.error("Restore failed");
    } else {
      toast.success("Database restored");
      await load();
    }
  } finally {
    restoring.value = false;
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
  <div class="w-full divide-y divide-neutral-200">
    <!-- Action Bar -->
    <div class="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
      <div class="flex flex-wrap items-center gap-2">
        <select
          v-model="selectedInstanceId"
          aria-label="Select database instance"
          class="rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-xs text-neutral-900 focus:border-emerald-600 focus:outline-none"
        >
          <option v-for="inst in instances" :key="inst.id" :value="inst.id">
            {{ inst.name }} ({{ inst.db_name }})
          </option>
        </select>
        <button
          @click="runBackupStream"
          :disabled="!selectedInstanceId || runningBackup"
          class="inline-flex items-center gap-1.5 rounded-lg bg-neutral-900 px-3.5 py-1.5 text-xs font-semibold text-white transition hover:bg-neutral-800 active:scale-[0.98] disabled:opacity-50"
        >
          <AppIcon name="database" size="xs" />
          <span>{{ runningBackup ? "Running..." : "Backup" }}</span>
        </button>
      </div>

      <div class="flex items-center gap-2">
        <button
          @click="verifyLatest"
          :disabled="verifying"
          class="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-3.5 py-1.5 text-xs font-medium text-neutral-700 transition hover:bg-neutral-100 active:scale-[0.98] disabled:opacity-50"
        >
          <AppIcon name="verified" size="xs" />
          <span>{{ verifying ? "Verifying..." : "Verify" }}</span>
        </button>
        <button
          @click="load"
          class="rounded-lg border border-neutral-200 bg-white p-2 text-neutral-600 transition hover:bg-neutral-100 hover:text-neutral-900 active:scale-[0.98] sm:p-1.5"
          aria-label="Refresh backup history"
          title="Refresh"
        >
          <AppIcon name="refresh" size="xs" />
        </button>
      </div>
    </div>

    <!-- Error Retry Banner -->
    <div v-if="loadError" class="flex items-center justify-between gap-3 bg-rose-50 px-4 py-3 text-xs text-rose-700 sm:px-6">
      <span>Failed to load backup history from server.</span>
      <button
        @click="load"
        class="rounded-lg border border-rose-200 bg-white px-2.5 py-1 font-medium text-rose-700 transition hover:bg-rose-100 active:scale-[0.98]"
      >
        Retry
      </button>
    </div>

    <!-- Live Backup Log Console -->
    <div v-if="liveLogs.length > 0" class="space-y-2 px-4 py-3 sm:px-6 bg-neutral-50">
      <div class="flex items-center justify-between text-xs text-neutral-600">
        <span class="font-mono font-semibold">Live Job Output</span>
        <button @click="liveLogs = []" class="hover:text-neutral-900 text-[11px]">Close</button>
      </div>
      <pre class="max-h-44 overflow-y-auto rounded-lg border border-neutral-200 bg-white p-3 font-mono text-xs text-emerald-700">{{ liveLogs.join("\n") }}</pre>
    </div>

    <!-- Backups Table -->
    <div class="overflow-x-auto">
      <table class="w-full text-left text-sm">
        <thead class="border-b border-neutral-200 text-xs text-neutral-600">
          <tr>
            <th class="px-4 py-2.5 sm:px-6">Database</th>
            <th class="px-4 py-2.5">Type</th>
            <th class="px-4 py-2.5">Size</th>
            <th class="px-4 py-2.5">Status</th>
            <th class="px-4 py-2.5 text-right sm:px-6">Actions</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-neutral-200/80">
          <TableSkeleton v-if="loading" :rows="4" :cols="5" />
          <tr v-for="b in backups" :key="b.id" class="align-middle hover:bg-neutral-50">
            <td class="px-4 py-3 sm:px-6">
              <div class="font-mono text-xs font-semibold text-neutral-900">{{ b.db_name }}</div>
              <div class="text-[11px] text-neutral-600">{{ b.created_at }}</div>
            </td>
            <td class="px-4 py-3 text-xs">
              <span class="text-neutral-800">{{ b.type }}</span>
              <span class="ml-1.5 rounded-sm bg-neutral-100 border border-neutral-200 px-1.5 py-0.5 font-mono text-[10px] text-neutral-700">
                {{ b.encryption_algo }}
              </span>
            </td>
            <td class="px-4 py-3 font-mono text-xs text-neutral-800">
              {{ (b.size_bytes / 1024).toFixed(1) }} KB
              <span class="text-neutral-600">&middot; {{ b.duration_ms }}ms</span>
            </td>
            <td class="px-4 py-3">
              <span
                :class="b.status === 'success' ? 'text-emerald-700' : 'text-rose-700'"
                class="text-xs font-semibold uppercase"
              >
                {{ b.status }}
              </span>
              <span
                v-if="b.verified_restore"
                class="ml-2 inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] text-emerald-700"
              >
                <AppIcon name="verified" size="xs" />
                <span>Verified</span>
              </span>
              <div v-if="b.error_message" class="mt-0.5 max-w-xs truncate text-[11px] text-rose-700">
                {{ b.error_message }}
              </div>
            </td>
            <td class="px-4 py-3 text-right sm:px-6">
              <div v-if="b.status === 'success'" class="inline-flex items-center gap-1">
                <a
                  :href="`/api/backups/${b.id}/download`"
                  class="inline-flex min-h-[36px] min-w-[36px] items-center justify-center rounded-lg p-1.5 text-neutral-600 transition hover:bg-neutral-100 hover:text-neutral-900 sm:min-h-0 sm:min-w-0"
                  aria-label="Download backup archive"
                  title="Download"
                >
                  <AppIcon name="arrow-left" size="sm" class="-rotate-90" />
                </a>
                <button
                  @click="restoreTarget = b"
                  :disabled="restoring"
                  class="inline-flex min-h-[36px] min-w-[36px] items-center justify-center rounded-lg p-1.5 text-amber-600 transition hover:bg-amber-50 active:scale-[0.98] disabled:opacity-50 sm:min-h-0 sm:min-w-0"
                  aria-label="Restore database"
                  title="Restore"
                >
                  <AppIcon name="refresh" size="sm" />
                </button>
              </div>
            </td>
          </tr>
          <tr v-if="!loading && backups.length === 0">
            <td colspan="5" class="px-4 py-8 text-center text-xs text-neutral-600">
              No backups recorded yet.
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <ConfirmModal
      :open="restoreTarget !== null"
      title="Restore Database"
      :message="`Overwrite ${restoreTarget?.db_name} with backup ${restoreTarget?.created_at}? A pre_restore safety snapshot will be created automatically first.`"
      confirm-label="Restore"
      :danger="true"
      @confirm="confirmRestore"
      @cancel="restoreTarget = null"
    />
  </div>
</template>
