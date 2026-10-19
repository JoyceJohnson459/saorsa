<template>
  <div class="page">
    <div class="page-head">
      <div>
        <div class="eyebrow">{{ $route.meta.eyebrow }}</div>
        <h1>一切 AI 使用，尽在掌控</h1>
        <p>从调用流量到每一笔费用，实时掌握各项目组的 AI 资源使用情况。数据来自企业网关的受管调用记录。</p>
      </div>
      <div class="row">
        <div class="segment" role="tablist" aria-label="时间范围">
          <button v-for="option in ranges" :key="option.id" type="button" :class="{ active: range === option.id }" @click="setRange(option.id)">{{ option.label }}</button>
        </div>
        <a class="headbtn" :href="exportURL"><icon name="download" :size="15" />导出报表</a>
      </div>
    </div>

    <div class="grid four">
      <stat label="AI 总花费" icon="wallet" :value="money(current?.costMicros)" :trend="delta('costMicros')" :hint="current?.estimatedCostMicros ? `含估算 ${money(current.estimatedCostMicros)}` : '相较上一时段'" />
      <stat label="Token 消耗" icon="zap" :value="tokenValue.value" :unit="tokenValue.unit" :trend="tokenTrend" hint="输入 + 输出" />
      <stat label="模型调用" icon="activity" :value="(current?.requests ?? 0).toLocaleString()" :hint="`${successRate} 请求成功率`" />
      <stat
        label="待复核风险"
        icon="shield-alert"
        :value="String(openRisks.total).padStart(2, '0')"
        unit="项"
        :tag="openRisks.high ? `${openRisks.high} 项高危` : openRisks.total ? '需要人工核实' : '暂无待处理'"
        :tag-tone="openRisks.high ? 'red' : openRisks.total ? 'amber' : ''"
      />
    </div>

    <div class="grid two mt">
      <section class="card">
        <div class="panelhead">
          <div>
            <h3>资源消耗趋势</h3>
            <div class="sub">网关请求产生的费用 · USD{{ range === "today" ? " · 按小时" : " · 按天" }}</div>
          </div>
          <div class="legend">
            <span><i class="mint" />当前周期</span>
            <span><i class="blue" />上个周期</span>
          </div>
        </div>
        <chart v-if="current?.requests || previous?.requests" :option="costOption(series, bucket, previousSeries)" :height="260" />
        <empty v-else text="该时段与上一时段均无受管调用" />
      </section>

      <section class="card">
        <div class="panelhead">
          <div>
            <h3>项目组费用分布</h3>
            <div class="sub">识别费用集中度，聚焦资源优化</div>
          </div>
          <router-link to="/admin/usage" class="squarebtn" aria-label="查看用量分析"><icon name="arrow-up-right" :size="16" /></router-link>
        </div>
        <template v-if="distribution.length">
          <div class="donutrow">
            <div class="donut"><chart :option="ringOption(distribution.map((item) => ({ label: item.label, value: item.value })), String(distribution.length), 'PROJECTS')" :height="146" /></div>
            <div class="donutlist">
              <div v-for="(item, index) in distribution" :key="item.label" class="donutitem">
                <span><i class="swatch" :style="{ background: colors[index % colors.length] }" />{{ item.label }}</span>
                <b>{{ item.percent }}%</b>
              </div>
            </div>
          </div>
          <div class="insight">
            <strong><icon name="arrow-up-right" :size="13" :stroke="2" /> 洞察</strong>
            {{ distribution[0]!.label }} 占当前支出的 {{ distribution[0]!.percent }}%。可以进一步查看其模型与成员用量。
          </div>
        </template>
        <empty v-else text="暂无项目组费用" />
      </section>
    </div>

    <div class="grid two mt">
      <section class="card">
        <div class="panelhead">
          <div>
            <h3>项目组监控</h3>
            <div class="sub">点击项目查看成员使用详情</div>
          </div>
          <router-link to="/admin/projects" class="headbtn">全部项目 <icon name="arrow-right" :size="15" /></router-link>
        </div>
        <div class="tablewrap">
          <table class="datatable">
            <thead>
              <tr><th>项目组</th><th>成员数</th><th>{{ rangeLabel }}费用</th><th>月预算使用</th><th>状态</th></tr>
            </thead>
            <tbody>
              <tr v-for="(project, index) in monitored" :key="project.id" @click="router.push(`/admin/projects/${project.id}`)">
                <td>
                  <span class="projecticon" :class="tones[index % tones.length]">{{ project.code.slice(0, 1) }}</span>
                  <span class="primarytxt">{{ project.name }}</span>
                  <div class="secondarytxt indent">{{ project.code }}</div>
                </td>
                <td>{{ project.member_count }}</td>
                <td class="primarytxt">{{ money(project.cost) }}</td>
                <td>
                  <template v-if="project.budget">
                    <div class="progress"><div :style="{ width: `${Math.min(100, project.budget.percent ?? 0)}%` }" :class="statusOf(project).tone" /></div>
                    <span class="secondarytxt">{{ Math.round(project.budget.percent ?? 0) }}% / {{ money(project.budget.effective_limit_micros, project.budget.currency) }}</span>
                  </template>
                  <span v-else class="secondarytxt">未设置月预算</span>
                </td>
                <td><span class="statuspill" :class="statusOf(project).tone">{{ statusOf(project).label }}</span></td>
              </tr>
              <tr v-if="!monitored.length"><td colspan="5" class="emptycell">还没有项目组</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="card">
        <div class="panelhead">
          <div>
            <h3>实时网关事件</h3>
            <div class="sub">最近的请求、风险与额度事件</div>
          </div>
          <div class="row">
            <span v-if="live && !paused" class="live">LIVE</span>
            <span v-else-if="paused" class="tiny muted">已暂停</span>
            <button class="squarebtn" type="button" :aria-label="paused ? '继续' : '暂停'" @click="togglePause"><icon :name="paused ? 'play' : 'pause'" :size="15" /></button>
          </div>
        </div>
        <div class="feed">
          <div v-for="item in feed" :key="item.key" class="feeditem">
            <div class="eventmark" :class="item.tone"><icon :name="item.icon" :size="15" /></div>
            <div class="feedbody"><strong>{{ item.title }}</strong> · {{ item.who }}<small>{{ item.desc }}</small></div>
            <span class="feedtime">{{ ago(item.at) }}</span>
          </div>
          <empty v-if="!feed.length" text="暂无网关事件" />
        </div>
      </section>
    </div>

    <div class="banner mt">
      监控覆盖范围：仅限经 Saorsa 企业网关的受管调用。成员若使用未纳管的 OpenCode 或个人供应商 Key，则不在统计范围内；强制管控需结合托管客户端配置、出口网络策略与终端管理（见部署文档）。
    </div>
    <div class="copyright"><span>SAORSA / ENTERPRISE AI GOVERNANCE</span><span>{{ updated ? `数据更新于 ${time(updated)}` : "" }}</span></div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue"
import { useRouter } from "vue-router"
import { api, query, subscribe } from "../../api"
import { categoryLabel, money, scopeLabel, statusLabel, time } from "../../format"
import { costOption, fillBuckets, palette, ringOption, type SeriesPoint } from "../../charts"
import Chart from "../../components/Chart.vue"
import Stat from "../../components/Stat.vue"
import Empty from "../../components/Empty.vue"
import Icon from "../../components/Icon.vue"

type Range = "today" | "week" | "month"
type Totals = { costMicros: number; estimatedCostMicros: number; requests: number; succeeded: number; inputTokens: number; outputTokens: number }

const router = useRouter()
const ranges = [
  { id: "today" as const, label: "今天" },
  { id: "week" as const, label: "近 7 天" },
  { id: "month" as const, label: "近 30 天" },
]
const tones = ["", "purple", "orange", "gray"]
const colors = computed(() => palette())
const range = ref<Range>("today")
const current = ref<Totals>()
const previous = ref<Totals>()
const series = ref<SeriesPoint[]>([])
const previousSeries = ref<SeriesPoint[]>([])
const byProject = ref<Array<{ key: string; label: string; costMicros: number }>>([])
const projects = ref<any[]>([])
const budgets = ref<any[]>([])
const openRisks = reactive({ total: 0, high: 0 })
const feed = ref<Array<{ key: string; title: string; who: string; desc: string; at: string; icon: string; tone: string }>>([])
const live = ref(false)
const paused = ref(false)
const updated = ref<Date>()
const now = ref(Date.now())

const bucket = computed(() => (range.value === "today" ? "hour" : "day"))
const rangeLabel = computed(() => ({ today: "今日", week: "7 天", month: "30 天" })[range.value])

function windows() {
  const end = new Date()
  const start =
    range.value === "today"
      ? new Date(new Date().setHours(0, 0, 0, 0))
      : new Date(end.getTime() - (range.value === "week" ? 7 : 30) * 86400_000)
  const span = end.getTime() - start.getTime()
  const startDay = range.value === "today" ? new Date(start.getTime() - 86400_000) : new Date(start.getTime() - span)
  return {
    current: { from: start.toISOString(), to: end.toISOString() },
    previous: { from: startDay.toISOString(), to: (range.value === "today" ? new Date(end.getTime() - 86400_000) : start).toISOString() },
  }
}

const exportURL = computed(() => `/api/admin/reports/export${query({ ...windows().current, type: "requests" })}`)

/** Percent change vs. the previous window; null when there is no baseline to compare with. */
function change(now: number | undefined, before: number | undefined) {
  if (!now && !before) return null
  if (!before) return null
  return (((now ?? 0) - before) / before) * 100
}
const delta = (key: keyof Totals) => change(current.value?.[key], previous.value?.[key])
const tokenTrend = computed(() =>
  change((current.value?.inputTokens ?? 0) + (current.value?.outputTokens ?? 0), (previous.value?.inputTokens ?? 0) + (previous.value?.outputTokens ?? 0)),
)
const tokenValue = computed(() => {
  const total = (current.value?.inputTokens ?? 0) + (current.value?.outputTokens ?? 0)
  if (total >= 1e9) return { value: (total / 1e9).toFixed(1), unit: "B" }
  if (total >= 1e6) return { value: (total / 1e6).toFixed(1), unit: "M" }
  if (total >= 1e4) return { value: (total / 1e3).toFixed(1), unit: "K" }
  return { value: total.toLocaleString(), unit: "" }
})
const successRate = computed(() => (current.value?.requests ? `${((current.value.succeeded / current.value.requests) * 100).toFixed(1)}%` : "—"))

const distribution = computed(() => {
  const total = byProject.value.reduce((sum, row) => sum + row.costMicros, 0)
  if (!total) return []
  return byProject.value
    .filter((row) => row.costMicros > 0)
    .slice(0, 6)
    .map((row) => ({ label: row.label, value: row.costMicros / 1e6, percent: Math.round((row.costMicros / total) * 100) }))
})

const monitored = computed(() =>
  projects.value
    .filter((project) => project.status === "active")
    .map((project) => ({
      ...project,
      cost: byProject.value.find((row) => row.key === project.id)?.costMicros ?? 0,
      budget: budgets.value.find((budget) => budget.scope_type === "project" && budget.project_id === project.id && budget.period === "monthly" && budget.enabled),
    }))
    .toSorted((a, b) => b.cost - a.cost)
    .slice(0, 6),
)

function statusOf(project: { budget?: { percent: number | null } }) {
  const percent = project.budget?.percent ?? 0
  if (percent >= 100) return { label: "超额", tone: "red" }
  if (percent >= 80) return { label: "预警", tone: "amber" }
  return { label: "正常", tone: "" }
}

function ago(at: string) {
  const seconds = Math.max(0, Math.round((now.value - new Date(at).getTime()) / 1000))
  if (seconds < 45) return "刚刚"
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分前`
  if (seconds < 86400) return `${Math.round(seconds / 3600)} 小时前`
  return `${Math.round(seconds / 86400)} 天前`
}

async function load() {
  const w = windows()
  const [summary, before, timeseries, previousTimeseries, breakdown, projectList, budgetList, risks, requests, alerts] = await Promise.all([
    api.get(`/api/admin/usage/summary${query(w.current)}`),
    api.get(`/api/admin/usage/summary${query(w.previous)}`),
    api.get(`/api/admin/usage/timeseries${query({ ...w.current, bucket: bucket.value })}`),
    api.get(`/api/admin/usage/timeseries${query({ ...w.previous, bucket: bucket.value })}`),
    api.get(`/api/admin/usage/breakdown${query({ ...w.current, by: "project" })}`),
    api.get("/api/admin/projects"),
    api.get("/api/admin/budgets"),
    api.get("/api/admin/risks"),
    api.get(`/api/admin/usage/requests${query({ limit: 8 })}`),
    api.get("/api/admin/budget-alerts"),
  ])
  current.value = summary.summary
  previous.value = before.summary
  series.value = fillBuckets(timeseries.timeseries, w.current.from, w.current.to, bucket.value)
  previousSeries.value = fillBuckets(previousTimeseries.timeseries, w.previous.from, w.previous.to, bucket.value)
  byProject.value = breakdown.rows
  projects.value = projectList.projects
  budgets.value = budgetList.budgets
  const pending = (risks.risks as any[]).filter((risk) => risk.status === "open" || risk.status === "appealed")
  Object.assign(openRisks, { total: pending.length, high: pending.filter((risk) => risk.severity === "high").length })
  if (!paused.value) feed.value = buildFeed(requests.items, risks.risks, alerts.alerts)
  updated.value = new Date()
  now.value = Date.now()
}

function buildFeed(requests: any[], risks: any[], alerts: any[]) {
  const items = [
    ...requests.map((request) => {
      const ok = request.status === "succeeded"
      return {
        key: `r-${request.id}`,
        title: ok ? "模型调用完成" : `调用${statusLabel[request.status] ?? request.status}`,
        who: request.display_name ?? request.username,
        desc: ok
          ? `${request.project_code} · ${request.model_alias} · ${(Number(request.input_tokens) + Number(request.output_tokens)).toLocaleString()} tokens · ${money(request.cost_micros)}`
          : `${request.project_code} · ${request.model_alias} · ${request.error_code ?? "未知原因"}`,
        at: request.started_at,
        icon: "activity",
        tone: ok ? (request.billing_status === "exact" ? "" : "blue") : "amber",
      }
    }),
    ...risks.slice(0, 6).map((risk) => ({
      key: `k-${risk.id}`,
      title: categoryLabel[risk.category] ?? risk.category,
      who: risk.display_name,
      desc: risk.summary_redacted,
      at: risk.created_at,
      icon: "shield-alert",
      tone: risk.severity === "high" ? "red" : "amber",
    })),
    ...alerts.slice(0, 6).map((alert) => ({
      key: `b-${alert.id}`,
      title: "费用阈值提醒",
      who: `${scopeLabel[alert.scope_type] ?? alert.scope_type} ${alert.project_code ?? alert.username ?? alert.model_alias ?? ""}`.trim(),
      desc: `已达到 ${alert.threshold}%：${money(alert.spent_micros, alert.currency)} / ${money(alert.limit_micros, alert.currency)}`,
      at: alert.created_at,
      icon: "wallet",
      tone: alert.threshold >= 100 ? "red" : "amber",
    })),
  ]
  return items.toSorted((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).slice(0, 6)
}

function setRange(next: Range) {
  range.value = next
  void load()
}

function togglePause() {
  paused.value = !paused.value
  if (!paused.value) void load()
}

let stop: (() => void) | undefined
let debounce: ReturnType<typeof setTimeout> | undefined
let clock: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  void load()
  // SSE only signals change; the dashboard always re-reads authoritative numbers from the database.
  stop = subscribe("/api/admin/events", (type) => {
    if (type === "ready") return void (live.value = true)
    clearTimeout(debounce)
    debounce = setTimeout(load, 400)
  })
  clock = setInterval(() => (now.value = Date.now()), 30_000)
})
onBeforeUnmount(() => {
  stop?.()
  clearTimeout(debounce)
  clearInterval(clock)
})
</script>

<style scoped>
.segment { display: inline-flex; padding: 3px; border: 1px solid var(--line); border-radius: 9px; background: var(--raised); gap: 1px; }
.segment button { background: none; color: var(--muted); border: 0; border-radius: 6px; padding: 5px 11px; font-size: 11px; cursor: pointer; font-family: inherit; }
.segment button.active { background: color-mix(in srgb, var(--muted) 24%, var(--raised)); color: var(--text); }
.headbtn {
  height: 35px;
  border: 1px solid var(--input-line);
  color: var(--text);
  background: var(--raised);
  padding: 0 13px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  white-space: nowrap;
  text-decoration: none !important;
}
.headbtn:hover { border-color: color-mix(in srgb, var(--muted) 60%, var(--input-line)); }
.squarebtn {
  width: 35px;
  height: 35px;
  display: grid;
  place-items: center;
  border: 1px solid var(--input-line);
  border-radius: 9px;
  background: var(--raised);
  color: var(--text);
  cursor: pointer;
}
.panelhead { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
.panelhead h3 { margin: 0; }
.panelhead .sub { margin: 4px 0 0; }
.legend { display: flex; gap: 13px; color: var(--muted); font-size: 10px; }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.legend i { width: 7px; height: 7px; border-radius: 50%; }
.legend .mint { background: var(--mint); }
.legend .blue { background: #778ff2; }
.donutrow { display: flex; align-items: center; gap: 28px; padding: 16px 4px 10px; }
.donut { width: 146px; flex: 0 0 146px; }
.donutlist { flex: 1; min-width: 0; display: grid; gap: 14px; }
.donutitem { font-size: 11px; color: color-mix(in srgb, var(--text) 70%, var(--muted)); display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.donutitem span { display: flex; align-items: center; gap: 8px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.donutitem b { color: var(--text); }
.swatch { height: 7px; width: 7px; flex: 0 0 7px; border-radius: 2px; }
.insight { margin-top: 6px; border-top: 1px solid var(--line); padding-top: 14px; color: var(--muted); font-size: 11px; line-height: 1.8; }
.insight strong { color: var(--mint); font-weight: 650; display: inline-flex; align-items: center; gap: 4px; margin-right: 6px; }
.tablewrap { overflow-x: auto; margin: 0 -7px; }
.datatable { border-collapse: collapse; width: 100%; min-width: 520px; }
.datatable th { text-align: left; font-size: 10px; color: var(--dim); letter-spacing: 0.09em; font-weight: 680; padding: 11px 10px; border-bottom: 1px solid var(--line); }
.datatable td { padding: 14px 10px; border-bottom: 1px solid var(--line2); color: color-mix(in srgb, var(--text) 82%, var(--muted)); font-size: 11px; }
.datatable tr:last-child td { border-bottom: 0; }
.datatable tbody tr { cursor: pointer; }
.datatable tbody tr:hover { background: color-mix(in srgb, var(--hover) 60%, transparent); }
.primarytxt { font-weight: 650; color: var(--text); font-size: 12px; }
.secondarytxt { font-size: 10px; color: var(--dim); margin-top: 3px; display: block; }
.indent { padding-left: 42px; }
.emptycell { text-align: center; color: var(--muted); padding: 34px !important; }
.progress { height: 4px; width: 93px; background: var(--line); border-radius: 9px; overflow: hidden; }
.progress div { height: 100%; border-radius: 9px; background: var(--mint); }
.progress div.amber { background: var(--orange); }
.progress div.red { background: var(--red); }
.projecticon {
  width: 32px;
  height: 32px;
  background: color-mix(in srgb, var(--mint) 12%, var(--raised));
  border: 1px solid color-mix(in srgb, var(--mint) 28%, var(--line));
  color: var(--mint);
  border-radius: 8px;
  display: inline-grid;
  place-items: center;
  font-size: 12px;
  font-weight: 760;
  margin-right: 9px;
  vertical-align: middle;
}
.projecticon.purple { background: color-mix(in srgb, #b5bdfb 12%, var(--raised)); color: #9da8f5; border-color: color-mix(in srgb, #b5bdfb 30%, var(--line)); }
.projecticon.orange { background: color-mix(in srgb, #f1bd84 12%, var(--raised)); color: #e0a868; border-color: color-mix(in srgb, #f1bd84 30%, var(--line)); }
.projecticon.gray { background: color-mix(in srgb, #a7bed4 10%, var(--raised)); color: #8fa7bd; border-color: color-mix(in srgb, #a7bed4 25%, var(--line)); }
.statuspill { font-size: 10px; border-radius: 5px; padding: 4px 8px; background: var(--mint-soft); border: 1px solid var(--mint-line); color: var(--mint); white-space: nowrap; }
.statuspill.amber { background: color-mix(in srgb, var(--orange) 9%, transparent); border-color: color-mix(in srgb, var(--orange) 26%, transparent); color: var(--orange); }
.statuspill.red { background: color-mix(in srgb, var(--red) 10%, transparent); border-color: color-mix(in srgb, var(--red) 28%, transparent); color: var(--red); }
.feed { margin-top: 4px; }
.feeditem { display: flex; align-items: flex-start; gap: 12px; padding: 15px 2px; border-bottom: 1px solid var(--line2); }
.feeditem:last-child { border: 0; }
.eventmark { height: 28px; width: 28px; border-radius: 8px; background: var(--mint-soft); display: grid; place-items: center; color: var(--mint); flex: 0 0 auto; }
.eventmark.amber { background: color-mix(in srgb, var(--orange) 10%, transparent); color: var(--orange); }
.eventmark.red { background: color-mix(in srgb, var(--red) 11%, transparent); color: var(--red); }
.eventmark.blue { background: color-mix(in srgb, var(--blue) 10%, transparent); color: var(--blue); }
.feedbody { flex: 1; min-width: 0; font-size: 11px; color: color-mix(in srgb, var(--text) 72%, var(--muted)); line-height: 1.5; }
.feedbody strong { color: var(--text); font-weight: 650; }
.feedbody small { display: block; color: var(--dim); font-size: 10px; margin-top: 5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.feedtime { font-size: 10px; color: var(--dim); white-space: nowrap; }
@media (max-width: 500px) {
  .donutrow { flex-direction: column; align-items: stretch; }
  .donut { align-self: center; }
}
</style>
