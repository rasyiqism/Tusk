<script setup lang="ts">
import { useToast } from './useToast';
import AppIcon from './AppIcon.vue';

const { toasts, dismiss, triggerUndo } = useToast();

const typeIcons: Record<string, string> = {
  success: 'check',
  error: 'x',
  warning: 'warning',
  info: 'info'
};

const typeAccentClasses: Record<string, string> = {
  success: 'border-l-4 border-l-emerald-600 text-emerald-700',
  error: 'border-l-4 border-l-rose-600 text-rose-700',
  warning: 'border-l-4 border-l-amber-600 text-amber-700',
  info: 'border-l-4 border-l-indigo-600 text-indigo-700'
};
</script>

<template>
  <div
    role="region"
    aria-label="Notifications"
    class="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm w-full px-4 sm:px-0 pointer-events-none"
  >
    <TransitionGroup
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="transform translate-y-3 opacity-0 scale-95"
      enter-to-class="transform translate-y-0 opacity-100 scale-100"
      leave-active-class="transition duration-150 ease-in"
      leave-from-class="opacity-100 scale-100"
      leave-to-class="opacity-0 scale-95"
    >
      <div
        v-for="toast in toasts"
        :key="toast.id"
        class="pointer-events-auto flex items-center justify-between gap-3 p-3.5 rounded-lg bg-white/95 text-neutral-900 shadow-lg border border-neutral-200 backdrop-blur-md transition-all duration-150 hover:border-neutral-300"
        :class="typeAccentClasses[toast.type]"
      >
        <div class="flex items-center gap-2.5 min-w-0 flex-1">
          <AppIcon
            :name="typeIcons[toast.type] || 'info'"
            size="md"
            class="shrink-0"
          />
          <p class="text-xs font-medium leading-snug text-neutral-900 truncate">
            {{ toast.message }}
          </p>
        </div>

        <div class="flex items-center gap-2 shrink-0">
          <!-- Undo Button (Instant Execution Pattern) -->
          <button
            v-if="toast.undo"
            type="button"
            @click="triggerUndo(toast.id)"
            class="px-2.5 py-1 text-xs font-semibold rounded bg-neutral-100 hover:bg-neutral-200 active:scale-95 text-amber-700 border border-neutral-200 transition-all duration-100 cursor-pointer"
          >
            {{ toast.undo.label || 'Undo' }}
          </button>

          <!-- Dismiss Button -->
          <button
            type="button"
            @click="dismiss(toast.id)"
            class="p-1 rounded text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100 active:scale-90 transition-all cursor-pointer"
            aria-label="Close"
          >
            <AppIcon name="x" size="xs" />
          </button>
        </div>
      </div>
    </TransitionGroup>
  </div>
</template>
