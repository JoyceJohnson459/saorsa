<template>
  <div class="page">
    <div class="page-head">
      <div>
        <div class="eyebrow">{{ $route.meta.eyebrow }}</div>
        <h1>使用量与费用</h1>
        <p>按项目组、成员、模型、供应商与时间组合筛选。费用以请求发生时冻结的价格版本计算；“估算”表示供应商未回传用量。</p>
      </div>
      <div class="row">
        <el-dropdown @command="exportCSV">
          <el-button>导出 CSV</el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="requests">请求明细</el-dropdown-item>
              <el-dropdown-item command="project">按项目组汇总</el-dropdown-item>
              <el-dropdown-item command="user">按成员汇总</el-dropdown-item>
              <el-dropdown-item command="model">按模型汇总</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </div>
    <div class="card filters">
      <el-date-picker v-model="range" type="datetimerange" range-separator="至" start-placeholder="开始" end-placeholder="结束" :shortcuts="shortcuts" style="max-width: 380px" />
      <el-select v-model="filters.project" multiple collapse-tags clearable placeholder="项目组" style="width: 180px">
        <el-option v-for="project in options.projects" :key="project.id" :label="project.code" :value="project.id" />
      </el-select>
      <el-select v-model="filters.user" multiple collapse-tags clearable filterable placeholder="成员" style="width: 180px">
        <el-option v-for="user in options.users" :key="user.id" :label="user.display_name" :value="user.id" />
      </el-select>
      <el-select v-model="filters.model" multiple collapse-tags clearable placeholder="模型" style="width: 160px">
        <el-option v-for="model in options.models" :key="model.id" :label="model.alias" :value="model.id" />
      </el-select>
      <el-select v-model="filters.provider" multiple collapse-tags clearable placeholder="供应商" style="width: 160px">
        <el-option v-for="provider in options.providers" :key="provider.id" :label="provider.name" :value="provider.id" />
      </el-select>
      <el-select v-model="filters.tool" multiple collapse-tags clearable placeholder="工具" style="width: 150px">
        <el-option v-for="tool in options.tools" :key="tool.id" :label="tool.name" :value="tool.id" />
      </el-select>
      <el-select v-model="filters.status" clearable placeholder="状态" style="width: 110px">
        <el-option v-for="(label, value) in statusLabel" :key="value" :label="label" :value="value" />
      </el-select>
      <el-select v-model="filters.billing" clearable placeholder="计费口径" style="width: 110px">
        <el-option v-for="(label, value) in billingLabel" :key="value" :label="label" :value="value" />
      </el-select>
      <el-select v-model="filters.risk" clearable placeholder="风险" style="width: 100px">
        <el-option label="任意风险" value="any" />
        <el-option label="高危" value="high" />
      </el-select>
      <el-button type="primary" @click="load">查询</el-button>
      <el-button @click="reset">重置</el-button>
    </div>
    <div v-if="summary" class="grid four mt">
      <stat label="费用" :value="money(summary.costMicros)" :hint="`估算部分 ${money(summary.estimatedCostMicros)}`" />
      <stat label="请求" :value="summary.requests" :hint="`成功 ${summary.succeeded} · 失败 ${summary.failed} · 拒绝 ${summary.rejected}`" />
      <stat label="输入 Token" :value="tokens(summary.inputTokens)" :hint="`缓存读 ${tokens(summary.cacheReadTokens)} / 写 ${tokens(summary.cacheWriteTokens)}`" />
      <stat label="输出 Token" :value="tokens(summary.outputTokens)" :hint="`推理 ${tokens(summary.reasoningTokens)}`" />
    </div>
    <div class="card mt">
      <h3>
        趋势
        <el-radio-group v-model="bucket" size="small" @change="load"><el-radio-button value="hour">按小时</el-radio-button><el-radio-button value="day">按天</el-radio-button></el-radio-group>
      </h3>
      <chart v-if="series.length" :option="trendOption(series, bucket)" :height="280" />
      <empty v-else />
    </div>
    <div class="card mt">
      <el-tabs v-model="by" @tab-change="loadBreakdown">
        <el-tab-pane label="按项目组" name="project" />
        <el-tab-pane label="按成员" name="user" />
        <el-tab-pane label="按模型" name="model" />
        <el-tab-pane label="按供应商" name="provider" />
        <el-tab-pane label="按工具" name="tool" />
      </el-tabs>
      <el-table :data="breakdown" size="small" :default-sort="{ prop: 'costMicros', order: 'descending' }">
        <el-table-column label="名称" min-width="180"><template #default="{ row }">{{ by === "tool" ? toolName(row.label) : row.label }}</template></el-table-column>
        <el-table-column label="请求" prop="requests" sortable width="90" align="right" />
        <el-table-column label="成功率" width="90" align="right"><template #default="{ row }">{{ row.requests ? ((row.succeeded / row.requests) * 100).toFixed(1) : 0 }}%</template></el-table-column>
        <el-table-column label="输入 Token" prop="inputTokens" sortable width="120" align="right"><template #default="{ row }">{{ tokens(row.inputTokens) }}</template></el-table-column>
        <el-table-column label="输出 Token" prop="outputTokens" sortable width="120" align="right"><template #default="{ row }">{{ tokens(row.outputTokens) }}</template></el-table-column>
        <el-table-column label="缓存 Token" prop="cacheReadTokens" sortable width="110" align="right"><template #default="{ row }">{{ tokens(row.cacheReadTokens) }}</template></el-table-column>
        <el-table-column label="费用" prop="costMicros" sortable width="120" align="right"><template #default="{ row }">{{ money(row.costMicros) }}</template></el-table-column>
        <el-table-column label="含估算请求" prop="estimatedRequests" width="110" align="right" />
        <template #empty><empty /></template>
      </el-table>
    </div>
    <div class="card mt">
      <h3>
        请求明细（默认不显示对话正文）
        <el-select v-model="sort" size="small" style="width: 120px" @change="loadRequests"><el-option label="按时间" value="time" /><el-option label="按费用" value="cost" /></el-select>
      </h3>
      <request-table :rows="requests.items" :loading="loadingRequests" selectable @select="openRequest" />
      <el-pagination class="mt" layout="total, prev, pager, next, sizes" :total="requests.total" v-model:current-page="page" v-model:page-size="pageSize" :page-sizes="[20, 50, 100, 200]" @change="loadRequests" />
    </div>
    <el-drawer v-model="detailOpen" title="请求详情" size="560px">
      <template v-if="detail">
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="Request ID"><span class="mono">{{ detail.request.request_id }}</span></el-descriptions-item>
          <el-descriptions-item label="Trace ID"><span class="mono">{{ detail.request.trace_id }}</span></el-descriptions-item>
          <el-descriptions-item label="上游 Request ID"><span class="mono">{{ detail.request.upstream_request_id ?? "—" }}</span></el-descriptions-item>
          <el-descriptions-item label="OpenCode 会话"><span class="mono">{{ detail.request.opencode_session_id ?? "—" }}</span></el-descriptions-item>
          <el-descriptions-item label="成员 / 项目组">{{ detail.request.username }} / {{ detail.request.project_code }}</el-descriptions-item>
          <el-descriptions-item label="模型 / 供应商">{{ detail.request.model_alias }} / {{ detail.request.provider_name }}</el-descriptions-item>
          <el-descriptions-item label="工具">{{ toolName(detail.request.tool_id) }}{{ detail.request.tool_version ? ` ${detail.request.tool_version}` : "" }}</el-descriptions-item>
          <el-descriptions-item label="状态">{{ statusLabel[detail.request.status] }} {{ detail.request.http_status }} {{ detail.request.error_code ?? "" }}</el-descriptions-item>
          <el-descriptions-item v-if="detail.request.error_message" label="错误">{{ detail.request.error_message }}</el-descriptions-item>
          <el-descriptions-item label="时间">{{ time(detail.request.started_at) }} → {{ time(detail.request.ended_at) }}（首字节 {{ time(detail.request.first_byte_at) }}）</el-descriptions-item>
          <el-descriptions-item label="计费口径">{{ billingLabel[detail.request.billing_status] }} · 预留 {{ money(detail.request.reserved_micros) }}</el-descriptions-item>
        </el-descriptions>
        <h4>账本（Ledger）</h4>
        <el-table :data="detail.ledger" size="small">
          <el-table-column label="类型" width="80"><template #default="{ row }">{{ row.entry_type === "charge" ? "计费" : "调整" }}</template></el-table-column>
          <el-table-column label="类别" prop="category" />
          <el-table-column label="Token" prop="tokens" align="right" />
          <el-table-column label="费用" align="right"><template #default="{ row }">{{ money(row.cost_micros, row.currency) }}</template></el-table-column>
          <el-table-column label="来源" width="90"><template #default="{ row }">{{ row.estimated ? "估算" : row.source }}</template></el-table-column>
        </el-table>
        <h4>上游尝试</h4>
        <el-table :data="detail.attempts" size="small">
          <el-table-column label="#" prop="attempt" width="40" />
          <el-table-column label="Key" prop="credential_label" />
          <el-table-column label="HTTP" prop="http_status" width="70" />
          <el-table-column label="错误" prop="error" />
        </el-table>
        <h4>预算预留与结算</h4>
        <el-table :data="detail.reservations" size="small">
          <el-table-column label="预算"><template #default="{ row }">{{ scopeLabel[row.scope_type] }} · {{ periodLabel[row.period] }}</template></el-table-column>
          <el-table-column label="预留" align="right"><template #default="{ row }">{{ money(row.reserved_micros) }}</template></el-table-column>
          <el-table-column label="结算" align="right"><template #default="{ row }">{{ money(row.settled_micros) }}</template></el-table-column>
          <el-table-column label="状态" prop="status" />
        </el-table>
        <h4>对账调整</h4>
        <div class="row">
          <el-input v-model="adjust.amount" placeholder="差额（美元，可为负）" style="width: 180px" />
          <el-input v-model="adjust.note" placeholder="依据，如供应商账单编号" style="flex: 1" />
          <el-button @click="applyAdjust">记录调整</el-button>
        </div>
      </template>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { ElMessage } from "element-plus"
import { onMounted, reactive, ref } from "vue"
import { useRoute } from "vue-router"
import { api, query } from "../../api"
import { billingLabel, money, periodLabel, scopeLabel, statusLabel, time, tokens } from "../../format"
import { fillBuckets, trendOption } from "../../charts"
import Chart from "../../components/Chart.vue"
import Stat from "../../components/Stat.vue"
import Empty from "../../components/Empty.vue"
import RequestTable from "../../components/RequestTable.vue"

const route = useRoute()
const day = 86400_000
const range = ref<[Date, Date]>([new Date(Date.now() - 7 * day), new Date()])
const shortcuts = [
  { text: "今天", value: () => [new Date(new Date().setHours(0, 0, 0, 0)), new Date()] },
  { text: "近 7 天", value: () => [new Date(Date.now() - 7 * day), new Date()] },
  { text: "近 30 天", value: () => [new Date(Date.now() - 30 * day), new Date()] },
  { text: "本月", value: () => [new Date(new Date().getFullYear(), new Date().getMonth(), 1), new Date()] },
]
const initialUser = typeof route.query.user === "string" ? [route.query.user] : []
const filters = reactive({ project: [] as string[], user: initialUser, model: [] as string[], provider: [] as string[], tool: [] as string[], status: "", billing: "", risk: "" })
const options = reactive({ projects: [] as any[], users: [] as any[], models: [] as any[], providers: [] as any[], tools: [] as any[] })
const toolName = (id: string | null) => (id ? (options.tools.find((tool) => tool.id === id)?.name ?? id) : "未知")
const summary = ref<any>()
const series = ref<any[]>([])
const breakdown = ref<any[]>([])
const requests = ref<{ total: number; items: any[] }>({ total: 0, items: [] })
const bucket = ref<"hour" | "day">("day")
const by = ref<"project" | "user" | "model" | "provider" | "tool">("project")
const sort = ref("time")
const page = ref(1)
const pageSize = ref(50)
const loadingRequests = ref(false)
const detailOpen = ref(false)
const detail = ref<any>()
const adjust = reactive({ amount: "", note: "" })

const params = () => ({ from: range.value?.[0]?.toISOString(), to: range.value?.[1]?.toISOString(), ...filters })

async function load() {
  const [totals, timeseries] = await Promise.all([
    api.get(`/api/admin/usage/summary${query(params())}`),
    api.get(`/api/admin/usage/timeseries${query({ ...params(), bucket: bucket.value })}`),
  ])
  summary.value = totals.summary
  const window = params()
  series.value = totals.summary.requests && window.from && window.to ? fillBuckets(timeseries.timeseries, window.from, window.to, bucket.value) : []
  page.value = 1
  await Promise.all([loadBreakdown(), loadRequests()])
}

async function loadBreakdown() {
  breakdown.value = (await api.get(`/api/admin/usage/breakdown${query({ ...params(), by: by.value })}`)).rows
}

async function loadRequests() {
  loadingRequests.value = true
  try {
    requests.value = await api.get(`/api/admin/usage/requests${query({ ...params(), sort: sort.value, limit: pageSize.value, offset: (page.value - 1) * pageSize.value })}`)
  } finally {
    loadingRequests.value = false
  }
}

function reset() {
  Object.assign(filters, { project: [], user: [], model: [], provider: [], tool: [], status: "", billing: "", risk: "" })
  range.value = [new Date(Date.now() - 7 * day), new Date()]
  void load()
}

function exportCSV(kind: string) {
  const extra = kind === "requests" ? { type: "requests" } : { type: "breakdown", by: kind }
  window.location.href = `/api/admin/reports/export${query({ ...params(), ...extra })}`
}

async function openRequest(row: any) {
  detail.value = await api.get(`/api/admin/usage/requests/${row.id}`)
  detailOpen.value = true
}

async function applyAdjust() {
  const value = Number(adjust.amount)
  if (!Number.isFinite(value) || !adjust.note) return ElMessage.warning("请填写差额与依据")
  await api.post(`/api/admin/usage/requests/${detail.value.request.id}/adjust`, { deltaMicros: Math.round(value * 1_000_000), note: adjust.note })
  ElMessage.success("已记录对账调整")
  detail.value = await api.get(`/api/admin/usage/requests/${detail.value.request.id}`)
  await load()
}

onMounted(async () => {
  const [projects, users, models, providers, tools] = await Promise.all([
    api.get("/api/admin/projects"),
    api.get("/api/admin/users"),
    api.get("/api/admin/models"),
    api.get("/api/admin/providers"),
    api.get("/api/admin/tools"),
  ])
  Object.assign(options, { projects: projects.projects, users: users.users, models: models.models, providers: providers.providers, tools: tools.tools })
  await load()
})
</script>

<style scoped>
.filters { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; padding: 14px 16px; }
h4 { margin: 18px 0 8px; }
</style>
