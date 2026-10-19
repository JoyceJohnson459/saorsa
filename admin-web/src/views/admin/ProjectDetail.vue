<template>
  <div class="page" v-if="data">
    <div class="page-head">
      <div>
        <div class="eyebrow">{{ $route.meta.eyebrow }}</div>
        <h1>{{ data.project.code }} · {{ data.project.name }}</h1>
        <p>{{ data.project.purpose || "未填写用途说明" }}</p>
      </div>
      <div class="row">
        <el-button @click="editOpen = true">编辑</el-button>
        <el-button v-if="data.project.status === 'active'" type="warning" plain @click="archive(true)">归档</el-button>
        <el-button v-else type="success" plain @click="archive(false)">恢复</el-button>
      </div>
    </div>
    <div class="grid four">
      <stat label="近 30 天费用" :value="money(usage?.summary.costMicros)" />
      <stat label="近 30 天请求" :value="usage?.summary.requests ?? 0" />
      <stat label="输入 / 输出 Token" :value="`${tokens(usage?.summary.inputTokens)} / ${tokens(usage?.summary.outputTokens)}`" />
      <stat label="成员" :value="data.members.length" />
    </div>
    <div class="grid two mt">
      <div class="card">
        <h3>费用趋势（近 30 天）</h3>
        <chart v-if="series.length" :option="trendOption(series, 'day')" />
        <empty v-else />
      </div>
      <div class="card">
        <h3>成员用量排行</h3>
        <chart v-if="members.length" :option="barOption(members)" />
        <empty v-else />
      </div>
    </div>
    <div class="grid halves mt">
      <div class="card">
        <h3>
          成员
          <el-button size="small" type="primary" plain @click="addOpen = true">添加成员</el-button>
        </h3>
        <el-table :data="data.members" size="small">
          <el-table-column label="用户名" prop="username" />
          <el-table-column label="姓名" prop="display_name" />
          <el-table-column label="加入时间"><template #default="{ row }">{{ date(row.joined_at) }}</template></el-table-column>
          <el-table-column width="80" align="right">
            <template #default="{ row }"><el-button link type="danger" size="small" @click="remove(row)">移出</el-button></template>
          </el-table-column>
          <template #empty><empty text="暂无成员" /></template>
        </el-table>
        <p class="muted small">移出后立即生效：该成员以本项目组计费的客户端会话将无法再发起新调用。</p>
      </div>
      <div class="card">
        <h3>
          模型授权
          <el-button size="small" type="primary" :loading="saving" @click="saveModels">保存</el-button>
        </h3>
        <el-checkbox-group v-model="allowed" class="models">
          <el-checkbox v-for="model in data.models" :key="model.id" :value="model.id" border>
            {{ model.alias }} <span class="muted small">· {{ model.provider_name }}</span>
          </el-checkbox>
        </el-checkbox-group>
        <empty v-if="!data.models.length" text="尚未配置模型" />
      </div>
    </div>
    <div class="card mt">
      <h3>
        工具授权
        <el-button size="small" type="primary" :loading="savingTools" @click="saveTools">保存</el-button>
      </h3>
      <p class="muted small">以本项目组计费时，成员可以使用哪些工具。未授权的工具无法签发 Saorsa Key，已有 Key 的调用会被网关拒绝。</p>
      <el-checkbox-group v-model="tools" class="models">
        <el-checkbox v-for="tool in catalog" :key="tool.id" :value="tool.id" border>
          {{ tool.name }} <span class="muted small">· {{ tool.vendor }}</span>
        </el-checkbox>
      </el-checkbox-group>
    </div>
    <div class="grid halves mt">
      <div class="card">
        <h3>项目预算 <router-link to="/admin/budgets" class="small">管理预算 →</router-link></h3>
        <el-table :data="data.budgets" size="small">
          <el-table-column label="周期"><template #default="{ row }">{{ periodLabel[row.period] }}</template></el-table-column>
          <el-table-column label="已用 / 额度"><template #default="{ row }">{{ money(row.spent_micros, row.currency) }} / {{ money(row.effective_limit_micros, row.currency) }}</template></el-table-column>
          <el-table-column label="使用率" width="160"><template #default="{ row }"><el-progress :percentage="Math.min(100, row.percent ?? 0)" :status="(row.percent ?? 0) >= 100 ? 'exception' : (row.percent ?? 0) >= 80 ? 'warning' : undefined" /></template></el-table-column>
          <template #empty><empty text="未设置项目预算" /></template>
        </el-table>
      </div>
      <div class="card">
        <h3>最近告警</h3>
        <el-table :data="data.alerts" size="small">
          <el-table-column label="时间"><template #default="{ row }">{{ time(row.created_at) }}</template></el-table-column>
          <el-table-column label="阈值"><template #default="{ row }">{{ row.threshold }}%</template></el-table-column>
          <el-table-column label="已用"><template #default="{ row }">{{ money(row.spent_micros) }}</template></el-table-column>
          <template #empty><empty text="暂无告警" /></template>
        </el-table>
      </div>
    </div>

    <el-dialog v-model="editOpen" title="编辑项目组" width="560px">
      <project-form v-model="form" />
      <template #footer>
        <el-button @click="editOpen = false">取消</el-button>
        <el-button type="primary" @click="saveProject">保存</el-button>
      </template>
    </el-dialog>
    <el-dialog v-model="addOpen" title="添加成员" width="480px">
      <el-select v-model="toAdd" multiple filterable placeholder="选择成员" style="width: 100%">
        <el-option v-for="user in candidates" :key="user.id" :label="`${user.display_name} (${user.username})`" :value="user.id" />
      </el-select>
      <template #footer>
        <el-button @click="addOpen = false">取消</el-button>
        <el-button type="primary" :disabled="!toAdd.length" @click="addMembers">添加</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ElMessage, ElMessageBox } from "element-plus"
import { computed, onMounted, ref } from "vue"
import { useRoute } from "vue-router"
import { api, query } from "../../api"
import { date, money, periodLabel, rangeDays, time, tokens } from "../../format"
import { barOption, fillBuckets, trendOption } from "../../charts"
import Chart from "../../components/Chart.vue"
import Stat from "../../components/Stat.vue"
import Empty from "../../components/Empty.vue"
import ProjectForm from "./ProjectForm.vue"

const route = useRoute()
const id = route.params.id as string
const data = ref<any>()
const usage = ref<any>()
const series = ref<any[]>([])
const members = ref<any[]>([])
const allowed = ref<string[]>([])
const tools = ref<string[]>([])
const catalog = ref<Array<{ id: string; name: string; vendor: string }>>([])
const savingTools = ref(false)
const users = ref<any[]>([])
const saving = ref(false)
const editOpen = ref(false)
const addOpen = ref(false)
const toAdd = ref<string[]>([])
const form = ref({ code: "", name: "", description: "", purpose: "", tags: [] as string[], concurrencyLimit: null as number | null, requestsPerMinute: null as number | null, tokensPerMinute: null as number | null })
const candidates = computed(() => users.value.filter((user) => user.status === "active" && !data.value?.members.some((member: any) => member.id === user.id)))

async function load() {
  const range = { ...rangeDays(30), project: id }
  const [detail, summary, timeseries, breakdown, list] = await Promise.all([
    api.get(`/api/admin/projects/${id}`),
    api.get(`/api/admin/usage/summary${query(range)}`),
    api.get(`/api/admin/usage/timeseries${query(range)}`),
    api.get(`/api/admin/usage/breakdown${query({ ...range, by: "user" })}`),
    api.get("/api/admin/users"),
  ])
  catalog.value = (await api.get("/api/admin/tools")).tools
  data.value = detail
  usage.value = summary
  series.value = summary.summary.requests ? fillBuckets(timeseries.timeseries, range.from, range.to, "day") : []
  members.value = breakdown.rows
  users.value = list.users
  allowed.value = detail.models.filter((model: any) => model.allowed).map((model: any) => model.id)
  tools.value = detail.tools
  const project = detail.project
  form.value = { code: project.code, name: project.name, description: project.description, purpose: project.purpose, tags: project.tags ?? [], concurrencyLimit: project.concurrency_limit, requestsPerMinute: project.requests_per_minute, tokensPerMinute: project.tokens_per_minute }
}

async function saveModels() {
  saving.value = true
  try {
    await api.put(`/api/admin/projects/${id}/models`, { modelIDs: allowed.value })
    ElMessage.success("模型授权已保存，客户端将在约 1 分钟内同步")
  } finally {
    saving.value = false
  }
}

async function saveTools() {
  savingTools.value = true
  try {
    await api.put(`/api/admin/projects/${id}/tools`, { toolIDs: tools.value })
    ElMessage.success("工具授权已保存，立即生效")
  } finally {
    savingTools.value = false
  }
}

async function saveProject() {
  await api.patch(`/api/admin/projects/${id}`, form.value)
  editOpen.value = false
  ElMessage.success("已保存")
  await load()
}

async function archive(value: boolean) {
  if (value) await ElMessageBox.confirm("归档后，所有以该项目组计费的客户端将无法发起新调用。确定归档？", "归档项目组", { type: "warning" })
  await api.patch(`/api/admin/projects/${id}`, { status: value ? "archived" : "active" })
  await load()
}

async function remove(member: any) {
  await ElMessageBox.confirm(`将 ${member.display_name} 移出 ${data.value.project.code}？`, "移出成员", { type: "warning" })
  await api.del(`/api/admin/projects/${id}/members/${member.id}`)
  await load()
}

async function addMembers() {
  await api.post(`/api/admin/projects/${id}/members`, { userIDs: toAdd.value })
  toAdd.value = []
  addOpen.value = false
  await load()
}

onMounted(load)
</script>

<style scoped>
.models { display: flex; flex-wrap: wrap; gap: 8px; }
.models :deep(.el-checkbox) { margin-right: 0; }
</style>
