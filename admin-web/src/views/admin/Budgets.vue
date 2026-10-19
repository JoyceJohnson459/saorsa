<template>
  <div class="page">
    <div class="page-head">
      <div>
        <div class="eyebrow">{{ $route.meta.eyebrow }}</div>
        <h1>预算与额度</h1>
        <p>请求前按最坏情况预留额度、完成后按实际用量结算，并发请求不会无界超额。月底预测为线性外推，不代表实际账单。</p>
      </div>
      <el-button type="primary" @click="openCreate">新建预算</el-button>
    </div>
    <div class="card">
      <el-table :data="budgets">
        <el-table-column label="范围" min-width="200">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">{{ scopeLabel[row.scope_type] }}</el-tag>
            <span style="margin-left: 6px">{{ target(row) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="周期" width="70"><template #default="{ row }">{{ periodLabel[row.period] }}</template></el-table-column>
        <el-table-column label="已用 / 额度" min-width="190">
          <template #default="{ row }">
            {{ money(row.spent_micros, row.currency) }} / {{ money(row.effective_limit_micros, row.currency) }}
            <div v-if="row.raise_micros" class="muted small">含临时提额 {{ money(row.raise_micros, row.currency) }}</div>
            <div v-if="row.reserved_micros" class="muted small">进行中预留 {{ money(row.reserved_micros, row.currency) }}</div>
          </template>
        </el-table-column>
        <el-table-column label="使用率" width="170">
          <template #default="{ row }"><el-progress :percentage="Math.min(100, row.percent ?? 0)" :status="(row.percent ?? 0) >= 100 ? 'exception' : (row.percent ?? 0) >= 80 ? 'warning' : undefined" /></template>
        </el-table-column>
        <el-table-column label="周期末预测" width="130"><template #default="{ row }"><span v-if="row.forecast_micros !== null" class="muted">≈ {{ money(row.forecast_micros, row.currency) }}</span><span v-else>—</span></template></el-table-column>
        <el-table-column label="策略" width="150">
          <template #default="{ row }">
            <el-tag size="small" :type="row.hard_limit ? 'danger' : 'info'" effect="plain">{{ row.hard_limit ? "超额拒绝" : "仅告警" }}</el-tag>
            <div class="muted small">告警 {{ row.warn_thresholds.join("/") }}%</div>
          </template>
        </el-table-column>
        <el-table-column label="启用" width="70"><template #default="{ row }"><el-switch :model-value="row.enabled" size="small" @change="(value: any) => patch(row.id, { enabled: value })" /></template></el-table-column>
        <el-table-column width="170" align="right">
          <template #default="{ row }">
            <el-button link size="small" @click="openEdit(row)">修改额度</el-button>
            <el-button link size="small" @click="openRaise(row)">临时提额</el-button>
            <el-button link size="small" @click="openHistory(row)">历史</el-button>
          </template>
        </el-table-column>
        <template #empty><empty text="尚未设置预算" /></template>
      </el-table>
    </div>
    <div class="card mt">
      <h3>额度告警</h3>
      <el-table :data="alerts" size="small">
        <el-table-column label="时间" width="160"><template #default="{ row }">{{ time(row.created_at) }}</template></el-table-column>
        <el-table-column label="范围"><template #default="{ row }">{{ scopeLabel[row.scope_type] }} {{ row.project_code ?? row.username ?? row.model_alias ?? "" }} · {{ periodLabel[row.period] }}</template></el-table-column>
        <el-table-column label="阈值" width="90"><template #default="{ row }"><el-tag :type="row.threshold >= 100 ? 'danger' : 'warning'" size="small">{{ row.threshold }}%</el-tag></template></el-table-column>
        <el-table-column label="已用 / 额度"><template #default="{ row }">{{ money(row.spent_micros, row.currency) }} / {{ money(row.limit_micros, row.currency) }}</template></el-table-column>
        <template #empty><empty text="暂无告警" /></template>
      </el-table>
    </div>

    <el-dialog v-model="createOpen" title="新建预算" width="560px">
      <el-form label-position="top">
        <div class="grid halves">
          <el-form-item label="范围">
            <el-select v-model="form.scopeType" style="width: 100%"><el-option v-for="(label, value) in scopeLabel" :key="value" :label="label" :value="value" /></el-select>
          </el-form-item>
          <el-form-item label="周期">
            <el-select v-model="form.period" style="width: 100%"><el-option v-for="(label, value) in periodLabel" :key="value" :label="label" :value="value" /></el-select>
          </el-form-item>
          <el-form-item v-if="['project', 'user_project'].includes(form.scopeType)" label="项目组">
            <el-select v-model="form.projectID" filterable style="width: 100%"><el-option v-for="project in projects" :key="project.id" :label="`${project.code} · ${project.name}`" :value="project.id" /></el-select>
          </el-form-item>
          <el-form-item v-if="['user', 'user_project'].includes(form.scopeType)" label="成员">
            <el-select v-model="form.userID" filterable style="width: 100%"><el-option v-for="user in users" :key="user.id" :label="`${user.display_name} (${user.username})`" :value="user.id" /></el-select>
          </el-form-item>
          <el-form-item v-if="form.scopeType === 'model'" label="模型">
            <el-select v-model="form.modelID" style="width: 100%"><el-option v-for="model in models" :key="model.id" :label="model.alias" :value="model.id" /></el-select>
          </el-form-item>
          <el-form-item label="额度（美元）"><el-input v-model="form.limit" /></el-form-item>
          <el-form-item label="单次请求上限（可选）"><el-input v-model="form.perRequestMax" placeholder="留空 = 不限" /></el-form-item>
          <el-form-item label="告警阈值 %">
            <el-select v-model="form.warnThresholds" multiple filterable allow-create style="width: 100%"><el-option v-for="value in [50, 80, 90, 95]" :key="value" :value="value" /></el-select>
          </el-form-item>
          <el-form-item label="超额策略"><el-switch v-model="form.hardLimit" active-text="超额拒绝" inactive-text="仅告警" /></el-form-item>
        </div>
      </el-form>
      <template #footer><el-button @click="createOpen = false">取消</el-button><el-button type="primary" @click="create">创建</el-button></template>
    </el-dialog>
    <el-dialog v-model="editOpen" title="修改额度" width="420px">
      <el-form label-position="top">
        <el-form-item label="新额度（美元）"><el-input v-model="edit.limit" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="edit.note" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="editOpen = false">取消</el-button><el-button type="primary" @click="saveEdit">保存</el-button></template>
    </el-dialog>
    <el-dialog v-model="raiseOpen" title="临时提额（仅当前周期有效）" width="420px">
      <el-form label-position="top">
        <el-form-item label="提高金额（美元）"><el-input v-model="raise.amount" /></el-form-item>
        <el-form-item label="到期时间（可选）"><el-date-picker v-model="raise.expiresAt" type="datetime" style="width: 100%" /></el-form-item>
        <el-form-item label="原因（必填，记入调整历史）"><el-input v-model="raise.note" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="raiseOpen = false">取消</el-button><el-button type="primary" @click="saveRaise">确认提额</el-button></template>
    </el-dialog>
    <el-dialog v-model="historyOpen" title="调整历史" width="640px">
      <el-table :data="history" size="small">
        <el-table-column label="时间" width="160"><template #default="{ row }">{{ time(row.created_at) }}</template></el-table-column>
        <el-table-column label="类型" width="100"><template #default="{ row }">{{ ({ set_limit: "修改额度", temporary_raise: "临时提额", reset_period: "重置" } as any)[row.kind] }}</template></el-table-column>
        <el-table-column label="变化"><template #default="{ row }">{{ row.kind === "set_limit" ? `${money(row.old_limit_micros)} → ${money(row.new_limit_micros)}` : `+${money(row.delta_micros)}` }}</template></el-table-column>
        <el-table-column label="管理员" prop="admin_username" width="100" />
        <el-table-column label="备注" prop="note" />
      </el-table>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ElMessage } from "element-plus"
import { onMounted, reactive, ref } from "vue"
import { api } from "../../api"
import { money, periodLabel, scopeLabel, time } from "../../format"
import Empty from "../../components/Empty.vue"

const budgets = ref<any[]>([])
const alerts = ref<any[]>([])
const projects = ref<any[]>([])
const users = ref<any[]>([])
const models = ref<any[]>([])
const createOpen = ref(false)
const editOpen = ref(false)
const raiseOpen = ref(false)
const historyOpen = ref(false)
const history = ref<any[]>([])
const current = ref("")
const form = reactive({ scopeType: "project", period: "monthly", projectID: "", userID: "", modelID: "", limit: "100", perRequestMax: "", warnThresholds: [80, 95] as number[], hardLimit: true })
const edit = reactive({ limit: "", note: "" })
const raise = reactive({ amount: "", expiresAt: null as Date | null, note: "" })

const target = (row: any) =>
  row.scope_type === "org" ? "全企业" : [row.project_code, row.display_name, row.model_alias].filter(Boolean).join(" · ")

async function load() {
  const [list, alertList] = await Promise.all([api.get("/api/admin/budgets"), api.get("/api/admin/budget-alerts")])
  budgets.value = list.budgets
  alerts.value = alertList.alerts
}

async function openCreate() {
  const [projectList, userList, modelList] = await Promise.all([api.get("/api/admin/projects?status=active"), api.get("/api/admin/users?status=active"), api.get("/api/admin/models")])
  projects.value = projectList.projects
  users.value = userList.users
  models.value = modelList.models
  createOpen.value = true
}

async function create() {
  await api.post("/api/admin/budgets", {
    scopeType: form.scopeType,
    period: form.period,
    projectID: ["project", "user_project"].includes(form.scopeType) ? form.projectID : null,
    userID: ["user", "user_project"].includes(form.scopeType) ? form.userID : null,
    modelID: form.scopeType === "model" ? form.modelID : null,
    limit: form.limit,
    perRequestMax: form.perRequestMax || null,
    warnThresholds: form.warnThresholds.map(Number),
    hardLimit: form.hardLimit,
  })
  createOpen.value = false
  ElMessage.success("预算已创建")
  await load()
}

async function patch(id: string, body: Record<string, unknown>) {
  await api.patch(`/api/admin/budgets/${id}`, body)
  await load()
}

function openEdit(row: any) {
  current.value = row.id
  Object.assign(edit, { limit: String(row.limit_micros / 1e6), note: "" })
  editOpen.value = true
}

async function saveEdit() {
  await patch(current.value, { limit: edit.limit, note: edit.note || undefined })
  editOpen.value = false
}

function openRaise(row: any) {
  current.value = row.id
  Object.assign(raise, { amount: "", expiresAt: null, note: "" })
  raiseOpen.value = true
}

async function saveRaise() {
  await api.post(`/api/admin/budgets/${current.value}/raise`, { amount: raise.amount, expiresAt: raise.expiresAt?.toISOString() ?? null, note: raise.note })
  raiseOpen.value = false
  await load()
}

async function openHistory(row: any) {
  history.value = (await api.get(`/api/admin/budgets/${row.id}/adjustments`)).adjustments
  historyOpen.value = true
}

onMounted(load)
</script>
