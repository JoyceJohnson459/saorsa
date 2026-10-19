<template>
  <div class="metric">
    <div class="metrictop">
      <span>{{ label }}</span>
      <span v-if="icon" class="metricicon"><icon :name="icon" :size="15" /></span>
    </div>
    <div class="metricval">{{ value }}<small v-if="unit">{{ unit }}</small></div>
    <div class="metricfoot">
      <span v-if="trend !== undefined && trend !== null" :class="trend >= 0 ? 'up' : 'down'">
        <icon :name="trend >= 0 ? 'arrow-up-right' : 'arrow-down-right'" :size="13" :stroke="2" />{{ Math.abs(trend).toFixed(1) }}%
      </span>
      <span v-if="tag" class="tag" :class="tagTone">{{ tag }}</span>
      <span v-if="hint">{{ hint }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import Icon from "./Icon.vue"

defineProps<{
  label: string
  value: string | number
  unit?: string
  hint?: string
  icon?: string
  /** Percent change against the previous period (real data); omitted when there is no baseline. */
  trend?: number | null
  tag?: string
  tagTone?: "amber" | "red" | "blue" | ""
}>()
</script>

<style scoped>
.metric {
  padding: 19px 20px 17px;
  min-height: 150px;
  position: relative;
  background: var(--panel-bg);
  border: 1px solid var(--line);
  border-radius: 13px;
  box-shadow: var(--shadow);
  overflow: hidden;
}
.metric::after {
  content: "";
  position: absolute;
  right: 0;
  top: 0;
  width: 60px;
  height: 60px;
  background: radial-gradient(circle at 100% 0%, color-mix(in srgb, var(--mint) 9%, transparent), transparent 70%);
}
.metrictop { display: flex; justify-content: space-between; align-items: center; color: var(--muted); font-size: 11px; }
.metricicon {
  height: 26px;
  width: 26px;
  border: 1px solid var(--line);
  border-radius: 7px;
  display: grid;
  place-items: center;
  color: color-mix(in srgb, var(--text) 70%, var(--muted));
}
.metricval { font-size: 31px; font-weight: 720; letter-spacing: -0.05em; margin-top: 18px; line-height: 1; font-variant-numeric: tabular-nums; }
.metricval small { font-size: 16px; color: var(--muted); margin-left: 2px; }
.metricfoot { font-size: 11px; color: var(--muted); margin-top: 13px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.up, .down { display: inline-flex; align-items: center; gap: 3px; }
.up { color: var(--mint); }
.down { color: var(--red); }
.tag {
  font-size: 10px;
  padding: 3px 7px;
  border-radius: 5px;
  background: var(--mint-soft);
  color: var(--mint);
  border: 1px solid var(--mint-line);
}
.tag.amber { background: color-mix(in srgb, var(--orange) 9%, transparent); color: var(--orange); border-color: color-mix(in srgb, var(--orange) 25%, transparent); }
.tag.red { background: color-mix(in srgb, var(--red) 10%, transparent); color: var(--red); border-color: color-mix(in srgb, var(--red) 28%, transparent); }
.tag.blue { background: color-mix(in srgb, var(--blue) 9%, transparent); color: var(--blue); border-color: color-mix(in srgb, var(--blue) 25%, transparent); }
</style>
