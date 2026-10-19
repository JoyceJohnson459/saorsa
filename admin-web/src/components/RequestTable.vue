<template>
  <el-table :data="rows" size="small" v-loading="loading" @row-click="(row: any) => $emit('select', row)" :row-class-name="selectable ? 'clickable' : ''">
    <el-table-column label="开始时间" width="150"><template #default="{ row }">{{ time(row.started_at) }}</template></el-table-column>
    <el-table-column v-if="showUser" label="成员" min-width="100"><template #default="{ row }">{{ row.display_name ?? row.username }}</template></el-table-column>
    <el-table-column label="项目组" prop="project_code" width="90" />
    <el-table-column label="模型" prop="model_alias" min-width="110" />
    <el-table-column label="工具" min-width="110"><template #default="{ row }">{{ row.tool_id ? (toolByID(row.tool_id)?.name ?? row.tool_id) : "—" }}<div v-if="row.tool_version" class="muted small">{{ row.tool_version }}</div></template></el-table-column>
    <el-table-column label="状态" width="120">
      <template #default="{ row }">
        <el-tooltip :content="row.error_message ?? ''" :disabled="!row.error_message" placement="top">
          <el-tag :type="statusType(row.status)" size="small">{{ statusLabel[row.status] ?? row.status }}<span v-if="row.http_status"> · {{ row.http_status }}</span></el-tag>
        </el-tooltip>
      </template>
    </el-table-column>
    <el-table-column label="输入" width="80" align="right"><template #default="{ row }">{{ tokens(row.input_tokens) }}</template></el-table-column>
    <el-table-column label="输出" width="80" align="right"><template #default="{ row }">{{ tokens(row.output_tokens) }}</template></el-table-column>
    <el-table-column label="缓存" width="70" align="right"><template #default="{ row }">{{ tokens(row.cache_read_tokens) }}</template></el-table-column>
    <el-table-column label="费用" width="100" align="right"><template #default="{ row }">{{ money(row.cost_micros, row.currency) }}</template></el-table-column>
    <el-table-column label="计费" width="80">
      <template #default="{ row }"><el-tag size="small" :type="row.billing_status === 'exact' ? 'success' : row.billing_status === 'none' ? 'info' : 'warning'" effect="plain">{{ billingLabel[row.billing_status] ?? row.billing_status }}</el-tag></template>
    </el-table-column>
    <el-table-column label="耗时" width="80" align="right"><template #default="{ row }">{{ row.duration_ms ? `${(row.duration_ms / 1000).toFixed(1)}s` : "—" }}</template></el-table-column>
    <el-table-column label="风险" width="80"><template #default="{ row }"><el-tag v-if="row.risk_level" type="danger" size="small" effect="plain">{{ severityLabel[row.risk_level] }}</el-tag></template></el-table-column>
    <template #empty><empty /></template>
  </el-table>
</template>

<script setup lang="ts">
import { billingLabel, money, severityLabel, statusLabel, time, tokens } from "../format"
import Empty from "./Empty.vue"
import { toolByID } from "../../../catalog/tools"

withDefaults(defineProps<{ rows: any[]; loading?: boolean; showUser?: boolean; selectable?: boolean }>(), { showUser: true })
defineEmits<{ select: [row: any] }>()
const statusType = (status: string) => (status === "succeeded" ? "success" : status === "rejected" ? "warning" : status === "failed" ? "danger" : "info")
</script>

<style scoped>
:deep(.clickable) { cursor: pointer; }
</style>
