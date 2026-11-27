<script setup lang="ts">
withDefaults(
  defineProps<{
    rows?: number;
    cols?: number;
  }>(),
  {
    rows: 4,
    cols: 3,
  }
);
</script>

<template>
  <tr v-for="r in rows" :key="r" class="animate-pulse">
    <td v-for="c in cols" :key="c" class="px-4 py-3.5 sm:px-6">
      <div
        class="h-3 rounded bg-neutral-200"
        :class="c === 1 ? 'w-32' : c === cols ? 'ml-auto w-20' : 'w-20'"
      />
      <div v-if="c === 1" class="mt-2 h-2.5 w-44 rounded bg-neutral-100" />
    </td>
  </tr>
</template>
