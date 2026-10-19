<template>
  <div ref="el" :style="{ height: `${height}px`, width: '100%' }" />
</template>

<script setup lang="ts">
import { init, type EChartsOption, type ECharts } from "echarts"
import { onBeforeUnmount, onMounted, ref, watch } from "vue"

const props = withDefaults(defineProps<{ option: EChartsOption; height?: number }>(), { height: 280 })
const el = ref<HTMLDivElement>()
let chart: ECharts | undefined
const observer = new ResizeObserver(() => chart?.resize())

function render() {
  if (!el.value) return
  chart?.dispose()
  // Colors come from the option builders (theme tokens), so no ECharts built-in theme is applied.
  chart = init(el.value, undefined, { renderer: "canvas" })
  chart.setOption({ backgroundColor: "transparent", ...props.option })
}

onMounted(() => {
  render()
  if (el.value) observer.observe(el.value)
})
watch(() => props.option, () => chart?.setOption({ backgroundColor: "transparent", ...props.option }, true), { deep: true })

onBeforeUnmount(() => {
  observer.disconnect()
  chart?.dispose()
})
</script>
