<script setup lang="ts">
import { ref, watch } from "vue";
import { api } from "../lib/api";
import { useToast } from "./useToast";
import BottomSheet from "./BottomSheet.vue";

export interface TuningTarget {
  id: string;
  db_name: string;
  connection_limit: number;
  statement_timeout_sec: number;
  backup_cron: string;
  retention_days: number;
  primary_tier?: "local" | "external";
}

const props = defineProps<{
  modelValue: boolean;
  instance: TuningTarget | null;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void;
  (e: "saved"): void;
}>();

const toast = useToast();
const connLimit = ref(25);
const timeoutSec = ref(30);
const cronExpr = ref("0 2 * * *");
const retentionDays = ref(14);
const saving = ref(false);
const errorMsg = ref("");

watch(
  () => [props.modelValue, props.instance] as const,
  ([open, inst]) => {
    if (open && inst) {
      connLimit.value = inst.connection_limit || 25;
      timeoutSec.value = inst.statement_timeout_sec || 30;
      cronExpr.value = inst.backup_cron || "0 2 * * *";
      retentionDays.value = inst.retention_days || 14;
      errorMsg.value = "";
    }
  }
);

async function saveTuning() {
  if (!props.instance || saving.value) return;
  errorMsg.value = "";
  saving.value = true;
  const inst = props.instance;

  if (inst.primary_tier !== "external") {
    const limRes = await api.api.instances({ id: inst.id }).limits.patch({
      connection_limit: connLimit.value,
      statement_timeout_sec: timeoutSec.value,
    });
    if (limRes.error || (limRes.data && "error" in limRes.data)) {
      saving.value = false;
      errorMsg.value = "Failed to save role limits";
      return;
    }
  }

  const schRes = await api.api.instances({ id: inst.id }).schedule.patch({
    backup_cron: cronExpr.value.trim(),
    retention_days: retentionDays.value,
  });
  saving.value = false;

  if (schRes.error || (schRes.data && "error" in schRes.data)) {
    errorMsg.value =
      schRes.data && "error" in schRes.data ? String(schRes.data.error) : "Invalid cron expression";
    return;
  }

  toast.success(`Configuration saved for ${inst.db_name}`);
  emit("update:modelValue", false);
  emit("saved");
}
</script>

<template>
  <BottomSheet
    :model-value="modelValue"
    :title="`Scale & Schedule · ${instance?.db_name || ''}`"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="space-y-4">
      <div v-if="instance?.primary_tier !== 'external'" class="grid grid-cols-2 gap-3">
        <div class="space-y-1.5">
          <label class="block text-xs font-semibold text-neutral-700">Max Connections</label>
          <input
            v-model.number="connLimit"
            type="number"
            min="1"
            max="500"
            class="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 font-mono text-sm text-neutral-900 focus:border-emerald-600 focus:outline-none"
          />
        </div>
        <div class="space-y-1.5">
          <label class="block text-xs font-semibold text-neutral-700">Timeout (sec)</label>
          <input
            v-model.number="timeoutSec"
            type="number"
            min="1"
            max="3600"
            class="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 font-mono text-sm text-neutral-900 focus:border-emerald-600 focus:outline-none"
          />
        </div>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <div class="space-y-1.5">
          <label class="block text-xs font-semibold text-neutral-700" title="5-field cron expression (min hour dom mon dow)">
            Backup Cron
          </label>
          <input
            v-model="cronExpr"
            placeholder="0 */6 * * *"
            class="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 font-mono text-sm text-neutral-900 placeholder:text-neutral-500 focus:border-emerald-600 focus:outline-none"
          />
        </div>
        <div class="space-y-1.5">
          <label class="block text-xs font-semibold text-neutral-700">Retention (Days)</label>
          <input
            v-model.number="retentionDays"
            type="number"
            min="1"
            max="3650"
            class="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 font-mono text-sm text-neutral-900 focus:border-emerald-600 focus:outline-none"
          />
        </div>
      </div>

      <div v-if="errorMsg" class="text-xs text-rose-600">{{ errorMsg }}</div>
    </div>

    <template #footer>
      <div class="flex justify-end gap-2">
        <button
          @click="emit('update:modelValue', false)"
          class="rounded-lg border border-neutral-200 bg-white px-4 py-2 text-xs font-medium text-neutral-700 transition active:scale-[0.98] hover:bg-neutral-100"
        >
          Cancel
        </button>
        <button
          @click="saveTuning"
          :disabled="saving"
          class="rounded-lg bg-neutral-900 px-4 py-2 text-xs font-semibold text-white transition active:scale-[0.98] hover:bg-neutral-800 disabled:opacity-50"
        >
          {{ saving ? "Saving..." : "Save" }}
        </button>
      </div>
    </template>
  </BottomSheet>
</template>
