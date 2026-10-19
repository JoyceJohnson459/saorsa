<template>
  <div class="empty">
    <span class="mark"><icon name="activity" :size="16" /></span>
    <span>{{ text }}</span>
  </div>
</template>

<script setup lang="ts">
import Icon from "./Icon.vue"

withDefaults(defineProps<{ text?: string }>(), { text: "暂无数据（仅统计经企业网关的受管调用）" })
</script>

<style scoped>
.empty { padding: 42px 16px; display: flex; flex-direction: column; align-items: center; gap: 12px; color: var(--muted); font-size: 12px; text-align: center; }
.mark {
  width: 34px;
  height: 34px;
  border-radius: 9px;
  display: grid;
  place-items: center;
  border: 1px solid var(--line);
  background: var(--raised);
  color: var(--dim);
}
</style>
