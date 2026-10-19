<template>
  <div class="page">
    <div class="page-head">
      <div><div class="eyebrow">{{ $route.meta.eyebrow }}</div><h1>我的使用量</h1><p>仅显示你本人经企业网关的受管调用。</p></div>
      <div class="row">
      <el-select :model-value="tool" clearable placeholder="全部工具" size="small" style="width: 150px" aria-label="按工具筛选" @change="(value: string) => $router.replace({ query: value ? { tool: value } : {} })">
        <el-option v-for="entry in TOOLS" :key="entry.id" :label="entry.name" :value="entry.id" />
      </el-select>
      <el-radio-group v-model="days" size="small" @change="load">
        <el-radio-button :value="1">今日</el-radio-button>
        <el-radio-button :value="7">近 7 天</el-radio-button>
        <el-radio-button :value="30">近 30 天</el-radio-button>
      </el-radio-group>
      </div>
    </div>
    <div v-if="data" class="grid four">
      <stat label="费用" :value="money(data.summary.costMicros)" :hint="data.summary.estimatedRequests ? `含 ${data.summary.estimatedRequests} 次估算` : undefined" />
      <stat label="请求" :value="data.summary.requests" />
      <stat label="输入 Token" :value="tokens(data.summary.inputTokens)" />
      <stat label="输出 Token" :value="tokens(data.summary.outputTokens)" />
    </div>
    <div class="grid two mt">
      <div class="card"><h3>时间曲线</h3><chart v-if="data?.timeseries.length" :option="trendOption(data.timeseries, days <= 1 ? 'hour' : 'day')" /><empty v-else /></div>
      <div class="card"><h3>按项目组</h3><chart v-if="data?.byProject.length" :option="pieOption(data.byProject)" /><empty v-else /></div>
    </div>
    <div class="card mt">
      <h3>按工具</h3>
      <el-table :data="data?.byTool ?? []" size="small">
        <el-table-column label="工具" min-width="140"><template #default="{ row }"><router-link :to="`/me/usage?tool=${row.key}`">{{ toolName(row.key) }}</router-link></template></el-table-column>
        <el-table-column label="请求" prop="requests" width="90" align="right" />
        <el-table-column label="成功率" width="90" align="right"><template #default="{ row }">{{ row.requests ? ((row.succeeded / row.requests) * 100).toFixed(1) : 0 }}%</template></el-table-column>
        <el-table-column label="输入 Token" width="110" align="right"><template #default="{ row }">{{ tokens(row.inputTokens) }}</template></el-table-column>
        <el-table-column label="输出 Token" width="110" align="right"><template #default="{ row }">{{ tokens(row.outputTokens) }}</template></el-table-column>
        <el-table-column label="费用" width="110" align="right"><template #default="{ row }">{{ money(row.costMicros) }}</template></el-table-column>
        <template #empty><empty text="周期内没有工具的使用记录" /></template>
      </el-table>
    </div>
    <div class="card mt">
      <el-tabs v-model="tab">
        <el-tab-pane label="请求记录" name="requests">
          <request-table :rows="requests.items" :show-user="false" />
          <el-pagination class="mt" layout="total, prev, pager, next" :total="requests.total" :page-size="50" v-model:current-page="page" @change="loadRequests" />
        </el-tab-pane>
        <el-tab-pane :label="`风险提示 (${risks.length})`" name="risks">
          <p class="muted small">风险提示需管理员人工复核，不代表违规认定。如有异议可提交申诉。</p>
          <el-table :data="risks" size="small">
            <el-table-column label="时间" width="160"><template #default="{ row }">{{ time(row.created_at) }}</template></el-table-column>
            <el-table-column label="类别" width="150"><template #default="{ row }">{{ categoryLabel[row.category] ?? row.category }}</template></el-table-column>
            <el-table-column label="级别" width="90"><template #default="{ row }">{{ severityLabel[row.severity] }}</template></el-table-column>
            <el-table-column label="摘要" min-width="260" prop="summary_redacted" />
            <el-table-column label="状态" width="90"><template #default="{ row }">{{ riskStatusLabel[row.status] }}</template></el-table-column>
            <el-table-column label="复核" min-width="160"><template #default="{ row }"><div v-for="review in row.reviews ?? []" :key="review.created_at" class="small">{{ riskStatusLabel[review.decision] }}：{{ review.note }}</div></template></el-table-column>
            <el-table-column width="80"><template #default="{ row }"><el-button link size="small" @click="appeal(row)">申诉</el-button></template></el-table-column>
            <template #empty><empty text="没有风险提示" /></template>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ElMessage, ElMessageBox } from "element-plus"
import { onMounted, ref, watch } from "vue"
import { useRoute } from "vue-router"
import { api, query } from "../../api"
import { categoryLabel, money, rangeDays, riskStatusLabel, severityLabel, time, tokens } from "../../format"
import { fillBuckets, pieOption, trendOption } from "../../charts"
import Chart from "../../components/Chart.vue"
import Stat from "../../components/Stat.vue"
import Empty from "../../components/Empty.vue"
import RequestTable from "../../components/RequestTable.vue"
import { TOOLS, toolByID } from "../../../../catalog/tools"

const route = useRoute()
const days = ref(7)
// Opened from a workbench tool card as /me/usage?tool=<id>.
const tool = ref(typeof route.query.tool === "string" ? route.query.tool : "")
const toolName = (id: string | null) => (id ? (toolByID(id)?.name ?? id) : "未知")
watch(
  () => route.query.tool,
  (value) => {
    tool.value = typeof value === "string" ? value : ""
    void load()
  },
)
const data = ref<any>()
const requests = ref<{ total: number; items: any[] }>({ total: 0, items: [] })
const risks = ref<any[]>([])
const page = ref(1)
const tab = ref("requests")

async function load() {
  const range = rangeDays(days.value)
  const bucket = days.value <= 1 ? "hour" : "day"
  const usage = await api.get(`/api/me/usage${query({ ...range, bucket, tool: tool.value })}`)
  data.value = { ...usage, timeseries: usage.summary.requests ? fillBuckets(usage.timeseries, range.from, range.to, bucket) : [] }
  risks.value = (await api.get("/api/me/risks")).risks
  page.value = 1
  await loadRequests()
}

async function loadRequests() {
  requests.value = await api.get(`/api/me/requests${query({ ...rangeDays(days.value), tool: tool.value, limit: 50, offset: (page.value - 1) * 50 })}`)
}

async function appeal(row: any) {
  const { value } = await ElMessageBox.prompt("请说明情况（管理员复核后会通知你）", "申诉", { inputType: "textarea", inputValidator: (text) => (text?.length >= 5 ? true : "至少 5 个字") })
  await api.post(`/api/me/risks/${row.id}/appeal`, { message: value })
  ElMessage.success("申诉已提交")
  await load()
}

onMounted(load)
</script>
