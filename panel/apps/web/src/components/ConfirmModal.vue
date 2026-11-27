<script setup lang="ts">
import BottomSheet from "./BottomSheet.vue";

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
  <BottomSheet
    :model-value="open"
    :title="title"
    @update:model-value="(val) => { if (!val) emit('cancel'); }"
  >
    <p class="text-xs leading-relaxed text-neutral-600">
      {{ message }}
    </p>

    <template #footer>
      <div class="flex justify-end gap-2">
        <button
          type="button"
          @click="emit('cancel')"
          class="min-h-[38px] rounded-lg border border-neutral-200 bg-white px-4 py-2 text-xs font-medium text-neutral-700 transition-all duration-150 hover:bg-neutral-100 active:scale-[0.98]"
        >
          Cancel
        </button>
        <button
          type="button"
          @click="emit('confirm')"
          :class="
            danger
              ? 'bg-rose-600 hover:bg-rose-700 text-white'
              : 'bg-neutral-900 hover:bg-neutral-800 text-white'
          "
          class="min-h-[38px] rounded-lg px-4 py-2 text-xs font-semibold transition-all duration-150 active:scale-[0.98]"
        >
          {{ confirmLabel || "Confirm" }}
        </button>
      </div>
    </template>
  </BottomSheet>
</template>
