<template>
  <div>
    <h4 style="margin: 4px 0 10px">计价（每百万 Token，最多 6 位小数）</h4>
    <div class="grid" style="grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0 12px">
      <el-form-item label="币种"><el-select v-model="model.currency"><el-option value="USD" /><el-option value="CNY" /></el-select></el-form-item>
      <el-form-item label="输入"><el-input v-model="model.input" /></el-form-item>
      <el-form-item label="输出"><el-input v-model="model.output" /></el-form-item>
      <el-form-item label="缓存读取"><el-input v-model="model.cacheRead" /></el-form-item>
      <el-form-item label="缓存写入"><el-input v-model="model.cacheWrite" /></el-form-item>
      <el-form-item label="价格来源"><el-input v-model="model.source" /></el-form-item>
    </div>
    <p class="muted small">推理 Token 默认按输出价计费。价格请以供应商官方账单口径为准。</p>
  </div>
</template>

<script setup lang="ts">
const model = defineModel<{ currency: string; input: string; output: string; cacheRead: string; cacheWrite: string; source: string }>({ required: true })
</script>
