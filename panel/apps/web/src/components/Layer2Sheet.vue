<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { api } from "../lib/api";
import { useToast } from "./useToast";
import BottomSheet from "./BottomSheet.vue";

export interface Layer2Instance {
  id: string;
  db_name: string;
  primary_tier?: "local" | "external";
  has_layer2?: boolean;
  layer2_target?: string | null;
  layer2_label?: string | null;
  layer2_sync_mode?: "manual" | "after_backup";
  layer2_last_sync_at?: string | null;
  layer2_last_sync_status?: string | null;
  layer2_last_error?: string | null;
}

const props = defineProps<{
  modelValue: boolean;
  instance: Layer2Instance | null;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void;
  (e: "updated"): void;
}>();

const toast = useToast();
const targetUrl = ref("");
const label = ref("");
const syncMode = ref<"after_backup" | "manual">("after_backup");
const busy = ref(false);
const logs = ref<string[]>([]);
const errorMsg = ref("");
let activeEs: EventSource | null = null;

function closeEs() {
  if (activeEs) {
    activeEs.close();
    activeEs = null;
  }
}

watch(
  () => [props.modelValue, props.instance] as const,
  ([open, inst]) => {
    if (open && inst) {
      closeEs();
      targetUrl.value = "";
      label.value = inst.layer2_label || "";
      syncMode.value = inst.layer2_sync_mode || "after_backup";
      logs.value = [];
      errorMsg.value = "";
      busy.value = false;
    } else if (!open) {
      closeEs();
    }
  }
);

function watchJob(jobId: string, okMsg: string, failMsg: string) {
  closeEs();
  const es = new EventSource(`/api/backups/jobs/${jobId}/stream`);
  activeEs = es;
  es.onmessage = (ev) => {
    logs.value.push(ev.data);
    if (
      ev.data.includes("completed") ||
      ev.data.includes("Switch completed") ||
      ev.data.includes("ERROR:")
    ) {
      busy.value = false;
      closeEs();
      if (ev.data.includes("ERROR:")) {
        toast.error(failMsg);
      } else {
        toast.success(okMsg);
        emit("updated");
      }
    }
  };
  es.onerror = () => {
    busy.value = false;
    closeEs();
  };
}

async function saveTarget() {
  if (!props.instance || !targetUrl.value.trim() || busy.value) return;
  errorMsg.value = "";
  busy.value = true;
  const res = await api.api.instances({ id: props.instance.id }).layer2.put({
    target_url: targetUrl.value.trim(),
    label: label.value.trim() || undefined,
    sync_mode: syncMode.value,
  });
  busy.value = false;
  if (res.data && "ok" in res.data && res.data.ok) {
    toast.success("Layer 2 target saved");
    targetUrl.value = "";
    emit("updated");
  } else {
    errorMsg.value =
      (res.data && "error" in res.data && String(res.data.error)) || "Failed to save Layer 2 target";
  }
}

async function detachTarget() {
  if (!props.instance || busy.value) return;
  errorMsg.value = "";
  const res = await api.api.instances({ id: props.instance.id }).layer2.delete();
  if (res.data && "ok" in res.data && res.data.ok) {
    toast.info("Layer 2 target detached");
    emit("updated");
  } else {
    errorMsg.value =
      (res.data && "error" in res.data && String(res.data.error)) || "Failed to detach Layer 2";
  }
}

async function syncNow() {
  if (!props.instance || busy.value) return;
  errorMsg.value = "";
  busy.value = true;
  logs.value = ["Starting snapshot sync..."];
  const res = await api.api.instances({ id: props.instance.id }).layer2.sync.post();
  if (res.data && "jobId" in res.data && res.data.jobId) {
    watchJob(res.data.jobId, "Sync completed", "Sync failed");
  } else {
    busy.value = false;
    errorMsg.value =
      (res.data && "error" in res.data && String(res.data.error)) || "Failed to start sync";
  }
}

async function switchTier(targetTier: "local" | "external") {
  if (!props.instance || busy.value) return;
  errorMsg.value = "";
  busy.value = true;
  logs.value = [
    targetTier === "external"
      ? "Promoting External node to Primary..."
      : "Failing back to Tusk Local Primary...",
  ];
  const res = await api.api.instances({ id: props.instance.id }).layer2.switch.post({
    target_tier: targetTier,
    pause_cutover: true,
  });
  if (res.data && "jobId" in res.data && res.data.jobId) {
    watchJob(
      res.data.jobId,
      targetTier === "external" ? "External is now Primary" : "Tusk Local is now Primary",
      "Failed to switch Primary"
    );
  } else {
    busy.value = false;
    errorMsg.value =
      (res.data && "error" in res.data && String(res.data.error)) || "Failed to switch Primary tier";
  }
}

onBeforeUnmount(closeEs);
</script>

<template>
  <BottomSheet
    :model-value="modelValue"
    :title="`Layer 2 & Failover · ${instance?.db_name || ''}`"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div v-if="instance" class="space-y-4">
      <div class="grid grid-cols-2 divide-x divide-neutral-200 rounded-lg border border-neutral-200 bg-neutral-50 text-xs">
        <div class="p-3 space-y-1">
          <div class="text-[10px] font-semibold uppercase tracking-wider text-neutral-600">Active Primary</div>
          <div class="font-mono font-semibold text-emerald-700 truncate">
            {{ instance.primary_tier === "external" ? `External (${instance.layer2_label || "remote"})` : "Tusk Local" }}
          </div>
        </div>
        <div class="p-3 space-y-1">
          <div class="text-[10px] font-semibold uppercase tracking-wider text-neutral-600">Layer 2 Standby</div>
          <div class="font-mono text-indigo-700 truncate">
            {{
              instance.primary_tier === "external"
                ? `Tusk Local (${instance.db_name})`
                : instance.has_layer2
                  ? `${instance.layer2_label || instance.layer2_target}`
                  : "Not attached"
            }}
          </div>
          <div v-if="instance.layer2_last_sync_at" class="text-[10px] text-neutral-600 truncate">
            Sync: {{ instance.layer2_last_sync_status || "-" }} · {{ instance.layer2_last_sync_at }}
          </div>
        </div>
      </div>

      <div v-if="instance.layer2_last_error" class="rounded-lg border border-rose-200 bg-rose-50 p-2.5 text-[11px] text-rose-700">
        {{ instance.layer2_last_error }}
      </div>

      <div class="space-y-3 border-t border-neutral-200 pt-3">
        <div class="flex items-center justify-between">
          <span class="text-xs font-semibold text-neutral-800">External Target Node</span>
          <button
            v-if="instance.has_layer2 && instance.primary_tier !== 'external'"
            @click="detachTarget"
            class="text-[11px] font-medium text-rose-600 hover:underline"
          >
            Detach
          </button>
        </div>
        <input
          v-model="targetUrl"
          type="password"
          placeholder="postgres://user:pass@ep-xxx.aws.neon.tech/neondb?sslmode=require"
          class="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 font-mono text-xs text-neutral-900 placeholder:text-neutral-500 focus:border-emerald-600 focus:outline-none"
        />
        <div class="grid grid-cols-2 gap-2.5">
          <input
            v-model="label"
            placeholder="Label (neon / supabase)"
            class="w-full rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-xs text-neutral-900 placeholder:text-neutral-500 focus:border-emerald-600 focus:outline-none"
          />
          <select
            v-model="syncMode"
            class="w-full rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-xs text-neutral-900 focus:border-emerald-600 focus:outline-none"
          >
            <option value="after_backup">Auto After Backup</option>
            <option value="manual">Manual</option>
          </select>
        </div>
        <div class="flex justify-end">
          <button
            @click="saveTarget"
            :disabled="busy || !targetUrl.trim()"
            class="rounded-lg border border-neutral-200 bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-900 transition active:scale-[0.98] hover:bg-neutral-200 disabled:opacity-50"
          >
            {{ instance.has_layer2 ? "Update" : "Save" }}
          </button>
        </div>
      </div>

      <div v-if="instance.has_layer2" class="flex flex-wrap items-center justify-between gap-2 border-t border-neutral-200 pt-3">
        <button
          @click="syncNow"
          :disabled="busy"
          class="rounded-lg border border-neutral-200 bg-white px-3.5 py-2 text-xs font-medium text-neutral-800 transition active:scale-[0.98] hover:bg-neutral-100 disabled:opacity-50"
        >
          Sync
        </button>
        <button
          v-if="instance.primary_tier !== 'external'"
          @click="switchTier('external')"
          :disabled="busy"
          class="rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white transition active:scale-[0.98] hover:bg-indigo-700 disabled:opacity-50"
        >
          Promote External
        </button>
        <button
          v-else
          @click="switchTier('local')"
          :disabled="busy"
          class="rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white transition active:scale-[0.98] hover:bg-emerald-700 disabled:opacity-50"
        >
          Failback Local
        </button>
      </div>

      <div v-if="errorMsg" class="text-xs text-rose-600">{{ errorMsg }}</div>
      <pre
        v-if="logs.length > 0"
        class="max-h-40 overflow-y-auto rounded-lg border border-neutral-200 bg-neutral-50 p-3 font-mono text-[11px] text-emerald-700"
      >{{ logs.join("\n") }}</pre>
    </div>
  </BottomSheet>
</template>
