<script setup lang="ts">
defineProps<{
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
}>();

const emit = defineEmits<{
  confirm: [];
  cancel: [];
}>();
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 backdrop-blur-xs"
  >
    <div class="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl space-y-4">
      <div class="space-y-1">
        <h3 class="text-base font-semibold text-zinc-100">{{ title }}</h3>
        <p class="text-xs leading-relaxed text-zinc-400">{{ message }}</p>
      </div>
      <div class="flex justify-end gap-2 pt-1">
        <button
          @click="emit('cancel')"
          class="rounded-md bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-700"
        >
          Cancel
        </button>
        <button
          @click="emit('confirm')"
          :class="
            danger
              ? 'bg-red-600 hover:bg-red-500 text-white'
              : 'bg-emerald-600 hover:bg-emerald-500 text-white'
          "
          class="rounded-md px-3 py-1.5 text-xs font-medium"
        >
          {{ confirmLabel || "Confirm" }}
        </button>
      </div>
    </div>
  </div>
</template>
