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
            v-for="tab in (['transaction', 'direct', 'internal'] as const)"
            :key="tab"
            @click="activeTab = tab"
            :class="
              activeTab === tab
                ? 'bg-white text-neutral-950 font-semibold'
                : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
            "
            class="rounded-lg px-2.5 py-1 capitalize transition"
          >
            {{ tab === "transaction" ? "Transaction (:6432)" : tab === "direct" ? "Direct / Migrasi (:5432)" : "Internal (Docker)" }}
          </button>
        </div>
        <button
          @click="copyEnv"
          class="inline-flex items-center gap-1.5 rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-1 text-xs font-medium text-neutral-200 transition hover:bg-neutral-800"
        >
          <AppIcon :name="copied ? 'check' : 'copy'" size="xs" />
          <span>{{ copied ? "Tersalin" : "Salin URL" }}</span>
        </button>
      </div>

      <div class="space-y-1.5">
        <div class="text-[11px] text-neutral-400">
          <span v-if="activeTab === 'transaction'">Direkomendasikan untuk aplikasi web & serverless (Next.js, Vue, Node, Go) via PgBouncer.</span>
          <span v-else-if="activeTab === 'direct'">Gunakan untuk migrasi skema (Drizzle, Prisma), DDL, dan sesi interaktif langsung ke PostgreSQL.</span>
          <span v-else>Koneksi jaringan internal Docker antar kontainer dalam satu VPS Dokploy.</span>
        </div>
        <pre class="overflow-x-auto rounded-xl border border-neutral-800 bg-neutral-950 p-3.5 font-mono text-xs text-emerald-400 break-all select-all">{{ creds.connectionStrings[activeTab] }}</pre>
      </div>

      <div class="rounded-xl border border-neutral-800 bg-neutral-900/50 p-3 text-xs text-neutral-400 space-y-1.5">
        <div><strong class="text-neutral-200">Database:</strong> <span class="font-mono">{{ creds.dbName }}</span></div>
        <div v-if="creds.password" class="flex items-center justify-between gap-2">
          <div>
            <strong class="text-neutral-200">Password:</strong>
            <span class="ml-1 font-mono text-neutral-300">{{ showPass ? creds.password : "••••••••••••••••••••" }}</span>
          </div>
          <button
            @click="showPass = !showPass"
            class="text-[11px] font-medium text-indigo-400 hover:text-indigo-300"
          >
            {{ showPass ? "Sembunyikan" : "Tampilkan" }}
          </button>
        </div>
      </div>
    </div>
  </BottomSheet>
</template>
