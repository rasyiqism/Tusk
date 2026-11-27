<script setup lang="ts">
import { ref, watch } from "vue";
import { api } from "../lib/api";
import { useToast } from "./useToast";
import AppIcon from "./AppIcon.vue";
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
  if (creating.value || !newName.value.trim()) return;
  if (createMode.value === "external" && !externalUrl.value.trim()) return;
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
    errorMsg.value = String((res.data as { error?: string })?.error || "Failed to create database");
    return;
  }
  if (res.data && "connectionStrings" in res.data) {
    const dbName = newName.value.trim();
    toast.success(
      createMode.value === "external"
        ? `External database ${dbName} registered (local Layer 2 slot provisioned)`
        : `Database ${dbName} created`
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
  <BottomSheet :model-value="modelValue" title="New Database" @update:model-value="emit('update:modelValue', $event)">
    <div class="space-y-4">
      <div class="grid grid-cols-2 gap-1 rounded-lg border border-neutral-200 bg-neutral-100 p-1 text-xs">
        <button
          type="button"
          @click="createMode = 'local'"
          :class="createMode === 'local' ? 'bg-white text-neutral-900 font-semibold shadow-2xs' : 'text-neutral-600 hover:text-neutral-900'"
          class="rounded-md py-1.5 transition active:scale-[0.98]"
        >
          Tusk Local (Primary)
        </button>
        <button
          type="button"
          @click="createMode = 'external'"
          :class="createMode === 'external' ? 'bg-indigo-600 text-white font-semibold shadow-2xs' : 'text-neutral-600 hover:text-neutral-900'"
          class="rounded-md py-1.5 transition active:scale-[0.98]"
        >
          External (Ex. Neon / Supabase, etc)
        </button>
      </div>

      <div class="space-y-1.5">
        <label class="block text-xs font-semibold text-neutral-700">Database Alias</label>
        <input
          v-model="newName"
          placeholder="my_app_prod"
          class="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 font-mono text-sm text-neutral-900 placeholder:text-neutral-500 focus:border-emerald-600 focus:outline-none"
        />
      </div>

      <div class="grid grid-cols-2 gap-3">
        <div class="space-y-1.5">
          <label class="block text-xs font-semibold text-neutral-700">Environment</label>
          <select
            v-model="newEnv"
            class="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus:border-emerald-600 focus:outline-none"
          >
            <option value="prod">prod</option>
            <option value="staging">staging</option>
            <option value="dev">dev</option>
          </select>
        </div>
        <div class="space-y-1.5">
          <label class="block text-xs font-semibold text-neutral-700">Backup Retention (Days)</label>
          <input
            v-model.number="retentionDays"
            type="number"
            min="1"
            max="365"
            class="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 font-mono text-sm text-neutral-900 focus:border-emerald-600 focus:outline-none"
          />
        </div>
      </div>

      <div v-if="createMode === 'external'" class="space-y-3 border-t border-neutral-200 pt-3">
        <div class="space-y-1.5">
          <label class="flex items-center gap-1.5 text-xs font-semibold text-indigo-700">
            <span>External PostgreSQL URL</span>
            <span title="Tusk automatically provisions a paused local database slot (Layer 2) for instant sync and failback to this VPS.">
              <AppIcon name="info" size="xs" class="text-neutral-500" />
            </span>
          </label>
          <input
            v-model="externalUrl"
            type="password"
            placeholder="postgres://user:pass@ep-xxx.aws.neon.tech/neondb?sslmode=require"
            class="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 font-mono text-xs text-neutral-900 placeholder:text-neutral-500 focus:border-emerald-600 focus:outline-none"
          />
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div class="space-y-1.5">
            <label class="block text-xs font-semibold text-neutral-700">Provider Label</label>
            <input
              v-model="layer2Label"
              placeholder="neon / supabase"
              class="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-xs text-neutral-900 placeholder:text-neutral-500 focus:border-emerald-600 focus:outline-none"
            />
          </div>
          <div class="space-y-1.5">
            <label class="block text-xs font-semibold text-neutral-700">Layer 2 Mirror</label>
            <select
              v-model="layer2SyncMode"
              class="w-full rounded-lg border border-neutral-300 bg-white px-2.5 py-2 text-xs text-neutral-900 focus:border-emerald-600 focus:outline-none"
            >
              <option value="after_backup">After Each Backup</option>
              <option value="manual">Manual Only</option>
            </select>
          </div>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-3 border-t border-neutral-200 pt-3">
        <div v-if="createMode === 'local'" class="space-y-1.5">
          <label class="block text-xs font-semibold text-neutral-700">Max Connections (Role)</label>
          <input
            v-model.number="connectionLimit"
            type="number"
            min="1"
            max="500"
            class="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 font-mono text-sm text-neutral-900 focus:border-emerald-600 focus:outline-none"
          />
        </div>
        <div :class="createMode === 'external' ? 'col-span-2' : ''" class="space-y-1.5">
          <label class="block text-xs font-semibold text-neutral-700">Backup Schedule</label>
          <select
            v-model="backupCron"
            class="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 font-mono text-xs text-neutral-900 focus:border-emerald-600 focus:outline-none"
          >
            <option value="0 2 * * *">Daily · 02:00</option>
            <option value="0 */6 * * *">Every 6h</option>
            <option value="0 */12 * * *">Every 12h</option>
            <option value="0 3 * * 0">Weekly · Sun</option>
          </select>
        </div>
      </div>

      <div v-if="errorMsg" class="text-xs text-rose-600">{{ errorMsg }}</div>
    </div>

    <template #footer>
      <div class="flex justify-end gap-2">
        <button
          @click="emit('update:modelValue', false)"
          class="rounded-lg border border-neutral-200 bg-white px-4 py-2 text-xs font-medium text-neutral-700 transition hover:bg-neutral-100 active:scale-[0.98]"
        >
          Cancel
        </button>
        <button
          @click="createDb"
          :disabled="creating || !newName.trim() || (createMode === 'external' && !externalUrl.trim())"
          class="rounded-lg bg-neutral-900 px-4 py-2 text-xs font-semibold text-white transition hover:bg-neutral-800 hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:hover:scale-100"
        >
          {{ creating ? "Saving..." : "Save" }}
        </button>
      </div>
    </template>
  </BottomSheet>
</template>
