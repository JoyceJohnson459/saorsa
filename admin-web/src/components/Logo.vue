<template>
  <svg class="brand-mark" viewBox="0 0 64 64" fill="none" :width="size" :height="size" aria-hidden="true">
    <!-- Saorsa mark: one data-flow trace forming an "S" from an open source node to a filled destination node. -->
    <path d="M41.5 15H27a8.5 8.5 0 0 0 0 17h10a8.5 8.5 0 0 1 0 17H17" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" />
    <circle cx="47" cy="15" r="5.5" stroke="currentColor" stroke-width="4" />
    <circle cx="17" cy="49" r="5.5" fill="currentColor" />
  </svg>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ size?: number }>(), { size: 34 })
</script>

<style scoped>
.brand-mark {
  flex: 0 0 auto;
  color: var(--mint);
}
</style>
