<script setup lang="ts">
import { ref, watch } from "vue";
import { useToast } from "./useToast";
import AppIcon from "./AppIcon.vue";
import BottomSheet from "./BottomSheet.vue";

const props = defineProps<{
  modelValue: boolean;
  creds: {
    dbName: string;
    password: string;
    primaryTier?: "local" | "external";
    standby?: {
      configured: boolean;
      tier: "local" | "external";
      target: string | null;
      label: string | null;
      lastSyncAt: string | null;
      lastSyncStatus: string | null;
    } | null;
    connectionStrings: { internal: string; transaction: string; session: string; direct: string };
  } | null;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void;
}>();

const toast = useToast();
const activeTab = ref<"transaction" | "direct" | "internal">("transaction");
const copied = ref(false);
const showPass = ref(false);

watch(
  () => props.modelValue,
  (open) => {
    if (!open) showPass.value = false;
  }
);

async function copyEnv() {
  if (!props.creds) return;
  const text = `DATABASE_URL="${props.creds.connectionStrings[activeTab.value]}"`;
  await navigator.clipboard.writeText(text);
  copied.value = true;
  toast.success("Copied to clipboard");
  setTimeout(() => {
    copied.value = false;
  }, 2000);
}
</script>

<template>
  <BottomSheet
    :model-value="modelValue"
    :title="`Connection · ${creds?.dbName || ''}`"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div v-if="creds" class="space-y-4">
      <div
        v-if="creds.primaryTier"
        :class="
          creds.primaryTier === 'external'
            ? 'border-indigo-200 bg-indigo-50 text-indigo-800'
            : 'border-emerald-200 bg-emerald-50 text-emerald-800'
        "
        class="rounded-lg border px-3 py-2 text-xs flex flex-wrap items-center justify-between gap-2"
      >
        <span class="font-semibold">
          {{ creds.primaryTier === "external" ? "Active Primary: External Node" : "Active Primary: Tusk Local" }}
        </span>
        <span v-if="creds.standby?.configured" class="font-mono text-[11px] text-neutral-700">
          Layer 2 ({{ creds.standby.tier === "local" ? "Tusk Local" : creds.standby.label || creds.standby.target }})
          &middot; {{ creds.standby.lastSyncStatus || "ready" }}
        </span>
      </div>

      <div class="flex items-center justify-between gap-2">
        <div class="flex min-w-0 items-center gap-1 overflow-x-auto snap-x text-xs">
          <button
            v-for="tab in (['transaction', 'direct', 'internal'] as const)"
            :key="tab"
            @click="activeTab = tab"
            :class="
              activeTab === tab
                ? 'bg-neutral-900 text-white font-semibold'
                : 'bg-neutral-100 text-neutral-700 hover:bg-neutral-200'
            "
            class="shrink-0 snap-start whitespace-nowrap rounded-lg px-2.5 py-1.5 transition active:scale-[0.98]"
          >
            {{ tab === "transaction" ? "Pool (:6432)" : tab === "direct" ? "Direct (:5432)" : "Docker" }}
          </button>
        </div>
        <button
          @click="copyEnv"
          class="inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 transition hover:bg-neutral-100 active:scale-[0.98]"
        >
          <AppIcon :name="copied ? 'check' : 'copy'" size="xs" />
          <span>{{ copied ? "Copied" : "Copy" }}</span>
        </button>
      </div>

      <div class="space-y-1.5">
        <div class="text-[11px] text-neutral-600">
          <span v-if="activeTab === 'transaction'">Recommended for web apps &amp; serverless functions via PgBouncer.</span>
          <span v-else-if="activeTab === 'direct'">Use for schema migrations (Drizzle, Prisma), DDL, and direct PostgreSQL sessions.</span>
          <span v-else>Internal Docker network connection between containers on this host.</span>
        </div>
        <pre class="overflow-x-auto rounded-lg border border-neutral-200 bg-neutral-50 p-3.5 font-mono text-xs text-emerald-700 break-all select-all">{{ creds.connectionStrings[activeTab] }}</pre>
      </div>

      <div class="divide-y divide-neutral-200 border-t border-neutral-200 pt-2 text-xs text-neutral-600">
        <div class="py-1.5"><strong class="text-neutral-900">Database:</strong> <span class="font-mono text-neutral-800">{{ creds.dbName }}</span></div>
        <div v-if="creds.password" class="flex items-center justify-between gap-2 py-1.5">
          <div>
            <strong class="text-neutral-900">Password:</strong>
            <span class="ml-1 font-mono text-neutral-800">{{ showPass ? creds.password : "••••••••••••••••••••" }}</span>
          </div>
          <button
            @click="showPass = !showPass"
            class="rounded-md px-2 py-1 text-[11px] font-medium text-emerald-700 transition hover:bg-emerald-50 active:scale-95"
          >
            {{ showPass ? "Hide" : "Show" }}
          </button>
        </div>
      </div>
    </div>
  </BottomSheet>
</template>
