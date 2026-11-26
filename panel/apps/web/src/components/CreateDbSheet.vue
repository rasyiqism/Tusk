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
      connectionStrings: { internal: string; transaction: string; session: string; direct: string };
    }
  ): void;
}>();

const toast = useToast();
const creating = ref(false);
const newName = ref("");
const newMode = ref<"shared" | "dedicated">("shared");
const newEnv = ref<"prod" | "staging" | "dev">("prod");
const newCpu = ref(1);
const newRamMb = ref(512);
const enableWalg = ref(false);
const retentionDays = ref(14);
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
  const res = await api.api.instances.post({
    name: newName.value.trim(),
    mode: newMode.value,
    env: newEnv.value,
    cpu_limit: newMode.value === "dedicated" ? newCpu.value : undefined,
    ram_limit_mb: newMode.value === "dedicated" ? newRamMb.value : undefined,
    enable_walg: newMode.value === "dedicated" ? enableWalg.value : undefined,
    retention_days: retentionDays.value,
  });
  creating.value = false;

  if (res.error || (res.data && "error" in res.data)) {
    errorMsg.value = String((res.data as { error?: string })?.error || "Gagal membuat database");
    return;
  }
  if (res.data && "connectionStrings" in res.data) {
    const dbName = newName.value.trim();
    toast.success(`Database ${dbName} dibuat`);
    emit("created", {
      dbName,
      password: res.data.password,
      connectionStrings: res.data.connectionStrings,
    });
    newName.value = "";
    emit("update:modelValue", false);
  }
}
</script>

<template>
  <BottomSheet :model-value="modelValue" title="Database Baru" @update:model-value="emit('update:modelValue', $event)">
    <div class="space-y-4">
      <div class="space-y-1.5">
        <label class="block text-xs font-semibold text-neutral-300">Nama Database</label>
        <input
          v-model="newName"
          placeholder="kbm_printing_prod"
          class="w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3.5 py-2.5 font-mono text-sm text-neutral-100 focus:border-indigo-500 focus:outline-none"
        />
      </div>

      <div class="grid grid-cols-2 gap-3">
        <div class="space-y-1.5">
          <label class="block text-xs font-semibold text-neutral-300">Mode</label>
          <select
            v-model="newMode"
            class="w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3 py-2.5 text-sm text-neutral-100"
          >
            <option value="shared">Shared</option>
            <option value="dedicated">Dedicated</option>
          </select>
        </div>
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
      </div>

      <div v-if="newMode === 'dedicated'" class="grid grid-cols-2 gap-3">
        <div class="space-y-1.5">
          <label class="block text-xs font-semibold text-neutral-300">CPU (Core)</label>
          <input
            v-model.number="newCpu"
            type="number"
            step="0.5"
            min="0.5"
            class="w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-sm text-neutral-100"
          />
        </div>
        <div class="space-y-1.5">
          <label class="block text-xs font-semibold text-neutral-300">RAM (MB)</label>
          <input
            v-model.number="newRamMb"
            type="number"
            step="128"
            min="256"
            class="w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-sm text-neutral-100"
          />
        </div>
        <label class="col-span-2 flex items-center gap-2 text-xs text-neutral-300">
          <input v-model="enableWalg" type="checkbox" class="rounded border-neutral-700" />
          <span>Aktifkan WAL-G PITR</span>
        </label>
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
