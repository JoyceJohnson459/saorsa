<template>
  <el-form label-position="top">
    <div class="grid halves">
      <el-form-item label="项目编号（2-32 位字母数字）"><el-input v-model="model.code" /></el-form-item>
      <el-form-item label="项目名称"><el-input v-model="model.name" /></el-form-item>
    </div>
    <el-form-item label="项目用途说明（用于“项目相关性”提示的比对依据，请写清楚业务范围）">
      <el-input v-model="model.purpose" type="textarea" :rows="3" />
    </el-form-item>
    <el-form-item label="描述"><el-input v-model="model.description" type="textarea" :rows="2" /></el-form-item>
    <div class="grid halves">
      <el-form-item label="标签">
        <el-select v-model="model.tags" multiple filterable allow-create default-first-option placeholder="输入后回车" style="width: 100%" />
      </el-form-item>
      <el-form-item label="项目并发上限（空 = 不限）">
        <el-input-number v-model="model.concurrencyLimit" :min="1" :max="1000" controls-position="right" style="width: 100%" />
      </el-form-item>
      <el-form-item label="每分钟请求上限（空 = 企业默认）">
        <el-input-number v-model="model.requestsPerMinute" :min="1" controls-position="right" style="width: 100%" />
      </el-form-item>
      <el-form-item label="每分钟 Token 上限（空 = 企业默认）">
        <el-input-number v-model="model.tokensPerMinute" :min="1000" :step="10000" controls-position="right" style="width: 100%" />
      </el-form-item>
    </div>
  </el-form>
</template>

<script setup lang="ts">
export interface ProjectFormValue {
  code: string
  name: string
  description: string
  purpose: string
  tags: string[]
  concurrencyLimit: number | null
  requestsPerMinute: number | null
  tokensPerMinute: number | null
}
const model = defineModel<ProjectFormValue>({ required: true })
</script>
