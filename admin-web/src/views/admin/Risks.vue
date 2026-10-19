<template>
  <div class="page">
    <div class="page-head">
      <div>
        <div class="eyebrow">{{ $route.meta.eyebrow }}</div>
        <h1>风险审计</h1>
        <p>审计异常调用与项目无关使用风险。AI 分类只提供线索，不直接认定违规；所有结论都需要人工复核。</p>
      </div>
      <el-button @click="principlesOpen = true"><icon name="sliders-horizontal" :size="15" />&nbsp;审计原则</el-button>
    </div>

    <div class="grid four">
      <stat label="待人工复核" :value="pad(counts.pending)" :tag="counts.pending ? '需要关注' : '暂无待办'" :tag-tone="counts.pending ? 'amber' : ''" />
      <stat label="确定性规则命中" :value="pad(counts.rules)" hint="可直接阻断高危密钥暴露" />
      <stat label="AI 相关性标记" :value="pad(counts.relevance)" hint="仅作为人工调查线索" />
      <stat label="已复核" :value="pad(counts.reviewed)" :hint="counts.falsePositive ? `其中误报 ${counts.falsePositive} 项` : '复核结果会通知成员'" />
    </div>

    <section class="card mt">
      <div class="listhead">
        <div>
          <h3>事件列表</h3>
          <div class="sub">必要证据摘要 · 不展示完整私人会话</div>
        </div>
        <div class="row">
          <el-select v-model="filters.status" clearable placeholder="处理状态" style="width: 120px" @change="load"><el-option v-for="(label, value) in riskStatusLabel" :key="value" :label="label" :value="value" /></el-select>
          <el-select v-model="filters.severity" clearable placeholder="等级" style="width: 110px" @change="load"><el-option v-for="(label, value) in levelLabel" :key="value" :label="label" :value="value" /></el-select>
          <el-select v-model="filters.category" clearable placeholder="类别" style="width: 150px" @change="load"><el-option v-for="(label, value) in categoryLabel" :key="value" :label="label" :value="value" /></el-select>
        </div>
      </div>
      <el-table :data="risks" @row-click="open" row-class-name="clickable">
        <el-table-column label="风险事件" min-width="300">
          <template #default="{ row }">
            <div class="primarytxt">{{ categoryLabel[row.category] ?? row.category }}</div>
            <div class="secondarytxt">#RSK-{{ row.id.slice(0, 6).toUpperCase() }} · {{ row.summary_redacted }}</div>
          </template>
        </el-table-column>
        <el-table-column label="项目 / 人员" width="190"><template #default="{ row }">{{ row.project_code ?? "—" }} / {{ row.display_name }}</template></el-table-column>
        <el-table-column label="分类" width="120"><template #default="{ row }">{{ kindOf(row.detector) }}</template></el-table-column>
        <el-table-column label="等级" width="90">
          <template #default="{ row }"><el-tag :type="row.severity === 'high' ? 'danger' : row.severity === 'review' ? 'warning' : 'info'">{{ levelLabel[row.severity] }}</el-tag></template>
        </el-table-column>
        <el-table-column label="时间" width="150"><template #default="{ row }">{{ time(row.created_at) }}</template></el-table-column>
        <el-table-column label="处理状态" width="120">
          <template #default="{ row }">
            <el-tag :type="row.status === 'open' || row.status === 'appealed' ? 'info' : row.status === 'false_positive' ? 'success' : 'warning'">{{ riskStatusLabel[row.status] }}</el-tag>
            <span v-if="row.appeal_count" class="tiny muted"> · 申诉 {{ row.appeal_count }}</span>
          </template>
        </el-table-column>
        <template #empty><empty text="暂无风险事件" /></template>
      </el-table>
    </section>

    <div class="banner mt">
      保护成员隐私：只记录企业网关中已告知的业务流量；提示词相关性偏低不等于“干私活”；所有处罚或账号处理都需要授权人员复核。
    </div>

    <el-dialog v-model="principlesOpen" title="风险审计原则" width="560px">
      <ol class="principles">
        <li>只审计经企业网关、且已向成员告知的受管调用；不采集个人账户、私人仓库或终端活动。</li>
        <li>确定性规则（如密钥、私钥、带口令的连接串）可按策略阻断；证据只保存脱敏片段与哈希指纹。</li>
        <li>项目相关性（关键词或审计模型）只能生成“信息提示”，不得单独认定违规或用于绩效评价。</li>
        <li>查看风险详情会写入审计日志；复核结果会通知成员，成员可以随时申诉。</li>
        <li>风险证据按保留期自动清理，默认不保存对话全文。</li>
      </ol>
      <template #footer><el-button type="primary" @click="principlesOpen = false">我已了解</el-button></template>
    </el-dialog>

    <el-drawer v-model="drawer" title="风险详情（查看行为已记入审计日志）" size="600px">
      <template v-if="detail">
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="类别">{{ categoryLabel[detail.event.category] ?? detail.event.category }} · {{ severityLabel[detail.event.severity] }}</el-descriptions-item>
          <el-descriptions-item label="检测器"><span class="mono">{{ detail.event.detector }}</span></el-descriptions-item>
          <el-descriptions-item label="成员">{{ detail.event.display_name }} ({{ detail.event.username }})</el-descriptions-item>
          <el-descriptions-item label="项目组">{{ detail.event.project_code }} · {{ detail.event.project_name }}</el-descriptions-item>
          <el-descriptions-item v-if="detail.event.project_purpose" label="项目用途">{{ detail.event.project_purpose }}</el-descriptions-item>
          <el-descriptions-item label="关联请求"><span class="mono">{{ detail.event.gateway_request_id ?? "—" }}</span> {{ detail.event.model_alias ?? "" }}</el-descriptions-item>
          <el-descriptions-item label="摘要">{{ detail.event.summary_redacted }}</el-descriptions-item>
        </el-descriptions>
        <h4>可解释依据（已脱敏）</h4>
        <div class="evidence">
          <div v-if="detail.event.evidence.explanation" class="notice">{{ detail.event.evidence.explanation }}</div>
          <div v-for="(value, key) in evidenceFields" :key="key" class="kv"><span class="muted">{{ key }}</span><span class="mono">{{ Array.isArray(value) ? value.join(", ") : value }}</span></div>
        </div>
        <h4 v-if="detail.appeals.length">成员申诉</h4>
        <div v-for="appeal in detail.appeals" :key="appeal.created_at" class="card small" style="margin-bottom: 8px">{{ appeal.message }}<div class="muted">{{ time(appeal.created_at) }}</div></div>
        <h4>复核记录</h4>
        <el-timeline v-if="detail.reviews.length">
          <el-timeline-item v-for="review in detail.reviews" :key="review.created_at" :timestamp="time(review.created_at)">{{ review.reviewer }}：{{ riskStatusLabel[review.decision] }} — {{ review.note }}</el-timeline-item>
        </el-timeline>
        <p v-else class="muted small">尚未复核</p>
        <h4>人工复核</h4>
        <el-radio-group v-model="review.decision">
          <el-radio-button value="false_positive">误报</el-radio-button>
          <el-radio-button value="confirmed">确认</el-radio-button>
          <el-radio-button value="resolved">已处理</el-radio-button>
          <el-radio-button value="open">重新打开</el-radio-button>
        </el-radio-group>
        <el-input v-model="review.note" type="textarea" :rows="3" placeholder="复核说明（成员将收到通知）" class="mt" />
        <el-button type="primary" class="mt" :disabled="!review.note" @click="submitReview">提交复核</el-button>
      </template>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue"
import { ElMessage } from "element-plus"
import { api, query } from "../../api"
import { categoryLabel, riskStatusLabel, severityLabel, time } from "../../format"
import Empty from "../../components/Empty.vue"
import Icon from "../../components/Icon.vue"
import Stat from "../../components/Stat.vue"

const risks = ref<any[]>([])
const filters = reactive({ status: "", severity: "", category: "" })
const drawer = ref(false)
const detail = ref<any>()
const review = reactive({ decision: "false_positive", note: "" })
const evidenceFields = computed(() =>
  Object.fromEntries(Object.entries(detail.value?.event.evidence ?? {}).filter(([key]) => key !== "explanation")),
)

const principlesOpen = ref(false)
const all = ref<any[]>([])
const levelLabel: Record<string, string> = { high: "高风险", review: "中风险", info: "低风险" }
const pad = (value: number) => String(value).padStart(2, "0")
const counts = computed(() => ({
  pending: all.value.filter((risk) => risk.status === "open" || risk.status === "appealed").length,
  rules: all.value.filter((risk) => String(risk.detector).startsWith("rule:secret_leak")).length,
  relevance: all.value.filter((risk) => risk.category === "project_relevance").length,
  reviewed: all.value.filter((risk) => ["confirmed", "false_positive", "resolved"].includes(risk.status)).length,
  falsePositive: all.value.filter((risk) => risk.status === "false_positive").length,
}))

function kindOf(detector: string) {
  if (detector.startsWith("rule:secret_leak")) return "确定性规则"
  if (detector.startsWith("classifier:") || detector.startsWith("heuristic:")) return "AI 相关性"
  if (detector === "rule:request_burst") return "频率异常"
  if (detector === "rule:cost_spike") return "费用异常"
  if (detector === "rule:project_switching") return "归属切换"
  return detector
}

async function load() {
  const [filtered, everything] = await Promise.all([api.get(`/api/admin/risks${query(filters)}`), api.get("/api/admin/risks")])
  risks.value = filtered.risks
  all.value = everything.risks
}

async function open(row: any) {
  detail.value = await api.get(`/api/admin/risks/${row.id}`)
  Object.assign(review, { decision: "false_positive", note: "" })
  drawer.value = true
}

async function submitReview() {
  await api.post(`/api/admin/risks/${detail.value.event.id}/review`, review)
  ElMessage.success("已提交复核，成员已收到通知")
  drawer.value = false
  await load()
}

onMounted(load)
</script>

<style scoped>
:deep(.clickable) { cursor: pointer; }
h4 { margin: 18px 0 8px; }
.kv { display: grid; grid-template-columns: 160px 1fr; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--tos-border); font-size: 12px; word-break: break-all; }
.evidence .notice { margin-bottom: 8px; }
</style>

<style scoped>
.listhead { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; margin-bottom: 6px; }
.listhead h3 { margin: 0; }
.listhead .sub { margin: 4px 0 0; }
.primarytxt { font-weight: 650; color: var(--text); font-size: 12px; }
.secondarytxt { font-size: 10px; color: var(--dim); margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 520px; }
.principles { margin: 0; padding-left: 18px; color: var(--muted); font-size: 13px; line-height: 2; }
</style>
