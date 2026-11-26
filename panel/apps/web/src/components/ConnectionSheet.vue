<script setup lang="ts">
import { ref } from "vue";
import { useToast } from "./useToast";
import AppIcon from "./AppIcon.vue";
import BottomSheet from "./BottomSheet.vue";

const props = defineProps<{
  modelValue: boolean;
  creds: {
    dbName: string;
    password: string;
    connectionStrings: { internal: string; transaction: string; session: string; direct: string };
  } | null;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void;
}>();

const toast = useToast();
const activeTab = ref<"internal" | "transaction" | "session" | "direct">("transaction");
const copied = ref(false);

async function copyEnv() {
  if (!props.creds) return;
  const text = `DATABASE_URL="${props.creds.connectionStrings[activeTab.value]}"`;
  await navigator.clipboard.writeText(text);
  copied.value = true;
  toast.success("Disalin ke clipboard");
  setTimeout(() => {
    copied.value = false;
  }, 2000);
}
</script>

<template>
  <BottomSheet
    :model-value="modelValue"
    :title="`Koneksi · ${creds?.dbName || ''}`"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div v-if="creds" class="space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex flex-wrap gap-1.5 text-xs">
          <button
            v-for="tab in (['internal', 'transaction', 'session', 'direct'] as const)"
            :key="tab"
            @click="activeTab = tab"
            :class="
              activeTab === tab
                ? 'bg-white text-neutral-950 font-semibold'
                : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
            "
            class="rounded-lg px-2.5 py-1 capitalize transition"
          >
            {{ tab }}
          </button>
        </div>
        <button
          @click="copyEnv"
          class="inline-flex items-center gap-1.5 rounded-lg border border-neutral-700 bg-neutral-800 px-2.5 py-1 text-xs text-neutral-100 hover:bg-neutral-700"
        >
          <AppIcon name="copy" size="xs" />
          <span>{{ copied ? "Tersalin" : "Salin" }}</span>
        </button>
      </div>
      <pre class="overflow-x-auto rounded-xl border border-neutral-800 bg-neutral-950 p-3 font-mono text-xs text-emerald-400">DATABASE_URL="{{ creds.connectionStrings[activeTab] }}"</pre>
    </div>
  </BottomSheet>
</template>
