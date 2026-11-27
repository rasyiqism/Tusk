<script setup lang="ts">
import { ref, watch } from "vue";
import { api } from "../lib/api";
import { useToast } from "./useToast";
import BottomSheet from "./BottomSheet.vue";

const props = defineProps<{
  modelValue: boolean;
  initialName?: string;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void;
  (
    e: "created",
    creds: {
      dbName: string;
      password: string;
      primaryTier?: "local" | "external";
      connectionStrings: { internal: string; transaction: string; session: string; direct: string };
    }
  ): void;
}>();

const toast = useToast();
const creating = ref(false);
const createMode = ref<"local" | "external">("local");
const newName = ref("");
const newEnv = ref<"prod" | "staging" | "dev">("prod");
const retentionDays = ref(14);
const connectionLimit = ref(25);
const backupCron = ref("0 2 * * *");
const externalUrl = ref("");
const layer2Label = ref("");
const layer2SyncMode = ref<"after_backup" | "manual">("after_backup");
const errorMsg = ref("");

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      errorMsg.value = "";
      if (props.initialName) newName.value = props.initialName;
    }
  }
);

async function createDb() {
  errorMsg.value = "";
  creating.value = true;

  const res =
    createMode.value === "external"
      ? await api.api.instances.external.post({
          name: newName.value.trim(),
          env: newEnv.value,
          target_url: externalUrl.value.trim(),
          layer2_label: layer2Label.value.trim() || undefined,
          layer2_sync_mode: layer2SyncMode.value,
          retention_days: retentionDays.value,
          backup_cron: backupCron.value,
        })
      : await api.api.instances.post({
          name: newName.value.trim(),
          env: newEnv.value,
          retention_days: retentionDays.value,
          connection_limit: connectionLimit.value,
          backup_cron: backupCron.value,
        });

  creating.value = false;

  if (res.error || (res.data && "error" in res.data)) {
    errorMsg.value = String((res.data as { error?: string })?.error || "Gagal membuat database");
    return;
  }
  if (res.data && "connectionStrings" in res.data) {
    const dbName = newName.value.trim();
    toast.success(
      createMode.value === "external"
        ? `Database eksternal ${dbName} terdaftar (slot Layer 2 lokal disiapkan)`
        : `Database ${dbName} dibuat`
    );
    emit("created", {
      dbName,
      password: res.data.password,
      primaryTier: createMode.value,
      connectionStrings: res.data.connectionStrings,
    });
    newName.value = "";
    externalUrl.value = "";
    layer2Label.value = "";
    emit("update:modelValue", false);
  }
}
</script>

<template>
  <BottomSheet :model-value="modelValue" title="Database Baru" @update:model-value="emit('update:modelValue', $event)">
    <div class="space-y-4">
      <div class="grid grid-cols-2 gap-1.5 rounded-xl border border-neutral-800 bg-neutral-950 p-1 text-xs">
        <button
          type="button"
          @click="createMode = 'local'"
          :class="createMode === 'local' ? 'bg-white text-neutral-950 font-semibold' : 'text-neutral-400 hover:text-neutral-200'"
          class="rounded-lg py-1.5 transition"
        >
          Tusk Lokal (Primary)
        </button>
        <button
          type="button"
          @click="createMode = 'external'"
          :class="createMode === 'external' ? 'bg-indigo-500 text-white font-semibold' : 'text-neutral-400 hover:text-neutral-200'"
          class="rounded-lg py-1.5 transition"
        >
          Eksternal (Neon / Supabase)
        </button>
      </div>

      <div class="space-y-1.5">
        <label class="block text-xs font-semibold text-neutral-300">Nama Alias Database</label>
        <input
          v-model="newName"
          placeholder="my_app_prod"
          class="w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3.5 py-2.5 font-mono text-sm text-neutral-100 focus:border-indigo-500 focus:outline-none"
        />
      </div>

      <div class="grid grid-cols-2 gap-3">
        <div class="space-y-1.5">
          <label class="block text-xs font-semibold text-neutral-300">Environment</label>
          <select
            v-model="newEnv"
            class="w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3 py-2.5 text-sm text-neutral-100"
          >
            <option value="prod">prod</option>
            <option value="staging">staging</option>
            <option value="dev">dev</option>
          </select>
        </div>
        <div class="space-y-1.5">
          <label class="block text-xs font-semibold text-neutral-300">Retensi Backup (Hari)</label>
          <input
            v-model.number="retentionDays"
            type="number"
            min="1"
            max="365"
            class="w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3.5 py-2 font-mono text-sm text-neutral-100"
          />
        </div>
      </div>

      <div v-if="createMode === 'external'" class="space-y-3 rounded-xl border border-indigo-900/50 bg-indigo-950/20 p-3">
        <div class="space-y-1.5">
          <label class="block text-xs font-semibold text-indigo-200">PostgreSQL Eksternal URL</label>
          <input
            v-model="externalUrl"
            type="password"
            placeholder="postgres://user:pass@ep-xxx.aws.neon.tech/neondb?sslmode=require"
            class="w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-xs text-neutral-100"
          />
        </div>
        <div class="grid grid-cols-2 gap-2.5">
          <div class="space-y-1">
            <label class="block text-[11px] font-semibold text-neutral-300">Label Provider</label>
            <input
              v-model="layer2Label"
              placeholder="neon / supabase"
              class="w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3 py-1.5 text-xs text-neutral-100"
            />
          </div>
          <div class="space-y-1">
            <label class="block text-[11px] font-semibold text-neutral-300">Mirror Layer 2 Lokal</label>
            <select
              v-model="layer2SyncMode"
              class="w-full rounded-xl border border-neutral-800 bg-neutral-950 px-2.5 py-1.5 text-xs text-neutral-100"
            >
              <option value="after_backup">Tiap Selesai Backup</option>
              <option value="manual">Manual Saja</option>
            </select>
          </div>
        </div>
        <p class="text-[11px] text-indigo-200/75">
          Tusk otomatis menyiapkan slot database lokal dalam status jeda (Layer 2) agar sewaktu-waktu bisa di-Sync &amp; Failback ke VPS ini.
        </p>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <div v-if="createMode === 'local'" class="space-y-1.5">
          <label class="block text-xs font-semibold text-neutral-300">Koneksi Maks (Role)</label>
          <input
            v-model.number="connectionLimit"
            type="number"
            min="1"
            max="500"
            class="w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3.5 py-2 font-mono text-sm text-neutral-100"
          />
        </div>
        <div :class="createMode === 'external' ? 'col-span-2' : ''" class="space-y-1.5">
          <label class="block text-xs font-semibold text-neutral-300">Jadwal Backup</label>
          <select
            v-model="backupCron"
            class="w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3 py-2.5 font-mono text-xs text-neutral-100"
          >
            <option value="0 2 * * *">Harian · 02:00</option>
            <option value="0 */6 * * *">Tiap 6 Jam</option>
            <option value="0 */12 * * *">Tiap 12 Jam</option>
            <option value="0 3 * * 0">Mingguan · Minggu</option>
          </select>
        </div>
      </div>

      <div v-if="errorMsg" class="text-xs text-rose-400">{{ errorMsg }}</div>
    </div>

    <template #footer>
      <div class="flex justify-end gap-2">
        <button
          @click="emit('update:modelValue', false)"
          class="rounded-xl border border-neutral-800 bg-neutral-900 px-4 py-2 text-xs font-medium text-neutral-300"
        >
          Batal
        </button>
        <button
          @click="createDb"
          :disabled="creating"
          class="rounded-xl bg-white px-4 py-2 text-xs font-semibold text-neutral-950 hover:bg-neutral-200 disabled:opacity-50"
        >
          {{ creating ? "Menyimpan..." : "Simpan" }}
        </button>
      </div>
    </template>
  </BottomSheet>
</template>
