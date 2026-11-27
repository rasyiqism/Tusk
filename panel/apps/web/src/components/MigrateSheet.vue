<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { api } from "../lib/api";
import { useToast } from "./useToast";
import BottomSheet from "./BottomSheet.vue";

const props = defineProps<{
  modelValue: boolean;
  instance: { id: string; db_name: string } | null;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void;
  (e: "completed"): void;
}>();

const toast = useToast();
const targetUrl = ref("");
const pauseSource = ref(true);
const promoteRemote = ref(false);
const checking = ref(false);
const migrating = ref(false);
const errorMsg = ref("");
const logs = ref<string[]>([]);
const preflightInfo = ref<{
  targetHost: string;
  targetDatabase: string;
  targetVersion: string;
  sourceTables: number;
  targetExistingTables: number;
} | null>(null);
let activeEs: EventSource | null = null;

function closeEs() {
  if (activeEs) {
    activeEs.close();
    activeEs = null;
  }
}

watch(
  () => props.modelValue,
  (open) => {
    closeEs();
    if (open) {
      targetUrl.value = "";
      pauseSource.value = true;
      promoteRemote.value = false;
      preflightInfo.value = null;
      errorMsg.value = "";
      logs.value = [];
      migrating.value = false;
    }
  }
);

async function testConnection() {
  if (!props.instance || !targetUrl.value.trim() || checking.value) return;
  errorMsg.value = "";
  preflightInfo.value = null;
  checking.value = true;
  const res = await api.api.instances({ id: props.instance.id }).migrate.preflight.post({
    target_url: targetUrl.value.trim(),
  });
  checking.value = false;
  if (res.data && "preflight" in res.data && res.data.preflight) {
    preflightInfo.value = res.data.preflight;
  } else {
    errorMsg.value =
      (res.data && "error" in res.data && String(res.data.error)) ||
      "Failed to connect to target server";
  }
}

async function startMigration() {
  if (!props.instance || !targetUrl.value.trim() || migrating.value) return;
  closeEs();
  errorMsg.value = "";
  migrating.value = true;
  logs.value = ["Starting streaming scale-out migration..."];

  const res = await api.api.instances({ id: props.instance.id }).migrate.post({
    target_url: targetUrl.value.trim(),
    pause_source: pauseSource.value,
    promote_remote: promoteRemote.value,
  });

  if (res.data && "jobId" in res.data && res.data.jobId) {
    const es = new EventSource(`/api/backups/jobs/${res.data.jobId}/stream`);
    activeEs = es;
    es.onmessage = (ev) => {
      logs.value.push(ev.data);
      if (ev.data.includes("completed") || ev.data.includes("ERROR:")) {
        migrating.value = false;
        closeEs();
        if (ev.data.includes("completed")) {
          toast.success("Migration completed");
          emit("completed");
        } else {
          toast.error("Migration failed; check logs");
        }
      }
    };
    es.onerror = () => {
      migrating.value = false;
      closeEs();
    };
  } else {
    migrating.value = false;
    errorMsg.value =
      (res.data && "error" in res.data && String(res.data.error)) || "Failed to start migration";
  }
}

onBeforeUnmount(closeEs);
</script>

<template>
  <BottomSheet
    :model-value="modelValue"
    :title="`Migrate · ${instance?.db_name || ''}`"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="space-y-3.5">
      <div class="space-y-1.5">
        <label class="block text-xs font-semibold text-neutral-700">Target PostgreSQL URL</label>
        <input
          v-model="targetUrl"
          type="password"
          placeholder="postgres://postgres:pass@new-db.domain.com:5432/target_db?sslmode=require"
          class="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 font-mono text-xs text-neutral-900 placeholder:text-neutral-500 focus:border-emerald-600 focus:outline-none"
        />
      </div>

      <div class="flex flex-col gap-2 text-xs text-neutral-700">
        <label class="inline-flex items-center gap-2 cursor-pointer">
          <input v-model="pauseSource" type="checkbox" class="rounded border-neutral-300 bg-white" />
          <span>Pause source writes during cutover</span>
        </label>
        <label class="inline-flex items-center gap-2 cursor-pointer">
          <input v-model="promoteRemote" type="checkbox" class="rounded border-neutral-300 bg-white" />
          <span>Promote target to Primary</span>
        </label>
      </div>

      <div
        v-if="preflightInfo"
        class="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800 space-y-1"
      >
        <div class="font-semibold">Target Ready</div>
        <div class="font-mono text-[11px]">
          {{ preflightInfo.targetHost }} / {{ preflightInfo.targetDatabase }} ({{ preflightInfo.targetVersion }})
        </div>
        <div class="text-[11px] text-emerald-700">
          Source: {{ preflightInfo.sourceTables }} tables &middot; Target: {{ preflightInfo.targetExistingTables }} tables
        </div>
      </div>

      <div v-if="errorMsg" class="text-xs text-rose-600">{{ errorMsg }}</div>

      <pre
        v-if="logs.length > 0"
        class="max-h-40 overflow-y-auto rounded-lg border border-neutral-200 bg-neutral-50 p-3 font-mono text-[11px] text-emerald-700"
      >{{ logs.join("\n") }}</pre>
    </div>

    <template #footer>
      <div class="flex justify-between gap-2 w-full">
        <button
          @click="testConnection"
          :disabled="checking || migrating || !targetUrl.trim()"
          class="rounded-lg border border-neutral-200 bg-white px-3.5 py-2 text-xs font-medium text-neutral-700 transition active:scale-[0.98] hover:bg-neutral-100 disabled:opacity-50"
        >
          {{ checking ? "Testing..." : "Test" }}
        </button>
        <div class="flex gap-2">
          <button
            @click="emit('update:modelValue', false)"
            class="rounded-lg border border-neutral-200 bg-white px-4 py-2 text-xs font-medium text-neutral-700 transition active:scale-[0.98] hover:bg-neutral-100"
          >
            Close
          </button>
          <button
            @click="startMigration"
            :disabled="migrating || !targetUrl.trim()"
            class="rounded-lg bg-neutral-900 px-4 py-2 text-xs font-semibold text-white transition active:scale-[0.98] hover:bg-neutral-800 disabled:opacity-50"
          >
            {{ migrating ? "Migrating..." : "Migrate" }}
          </button>
        </div>
      </div>
    </template>
  </BottomSheet>
</template>
