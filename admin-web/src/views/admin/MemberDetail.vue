<template>
  <div class="page" v-if="data">
    <div class="page-head">
      <div>
        <div class="eyebrow">{{ $route.meta.eyebrow }}</div>
        <h1>{{ data.user.display_name }} <span class="muted" style="font-size: 14px">{{ data.user.username }}</span></h1>
        <p>
          {{ data.user.account_type === "ADMIN" ? "管理员" : "普通成员" }} · 创建于 {{ date(data.user.created_at) }} · 最近登录 {{ time(data.user.last_login_at) }}
          · 使用告知 {{ data.user.notice_ack_version ? `已确认 v${data.user.notice_ack_version}` : "未确认" }}
        </p>
      </div>
      <div class="row">
        <el-button v-if="data.user.locked_until" @click="patch({ unlock: true })">解除锁定</el-button>
        <el-button @click="resetPassword">重置密码</el-button>
        <el-button @click="revoke()">强制下线</el-button>
        <el-button v-if="data.user.status === 'active'" type="warning" plain @click="setStatus('disabled')">禁用</el-button>
        <el-button v-else type="success" plain @click="setStatus('active')">恢复</el-button>
        <el-button type="danger" plain @click="remove">删除</el-button>
      </div>
    </div>
    <div class="grid four">
      <stat label="近 30 天费用" :value="money(data.usage.costMicros)" />
      <stat label="近 30 天请求" :value="data.usage.requests" />
      <stat label="输入 / 输出 Token" :value="`${tokens(data.usage.inputTokens)} / ${tokens(data.usage.outputTokens)}`" />
      <stat label="活跃项目组" :value="data.usage.activeProjects" />
    </div>
    <div class="grid halves mt">
      <div class="card">
        <h3>各项目组用量（近 30 天）</h3>
        <chart v-if="byProject.length" :option="barOption(byProject)" :height="220" />
        <empty v-else />
      </div>
      <div class="card">
        <h3>常用模型</h3>
        <chart v-if="byModel.length" :option="pieOption(byModel, 'requests')" :height="220" />
        <empty v-else />
      </div>
    </div>
    <div class="grid halves mt">
      <div class="card">
        <h3>所属项目组</h3>
        <el-table :data="data.projects" size="small">
          <el-table-column label="项目组"><template #default="{ row }"><router-link :to="`/admin/projects/${row.id}`">{{ row.code }} · {{ row.name }}</router-link></template></el-table-column>
          <el-table-column label="加入时间"><template #default="{ row }">{{ date(row.joined_at) }}</template></el-table-column>
          <template #empty><empty text="未加入项目组" /></template>
        </el-table>
      </div>
      <div class="card">
        <h3>有效会话与设备</h3>
        <el-table :data="data.sessions" size="small">
          <el-table-column label="类型" width="90"><template #default="{ row }">{{ row.kind === "client" ? "OpenCode" : "Web" }}</template></el-table-column>
          <el-table-column label="计费项目" prop="project_code" />
          <el-table-column label="客户端版本" width="110"><template #default="{ row }">{{ clientVersion(row.client_agent) }}</template></el-table-column>
          <el-table-column label="最近使用"><template #default="{ row }">{{ time(row.last_used_at ?? row.created_at) }}</template></el-table-column>
          <el-table-column width="70" align="right"><template #default="{ row }"><el-button link type="danger" size="small" @click="revoke(row.id)">撤销</el-button></template></el-table-column>
          <template #empty><empty text="无有效会话" /></template>
        </el-table>
      </div>
    </div>
    <div class="card mt">
      <h3>请求时间线 <router-link :to="`/admin/usage?user=${id}`" class="small">在用量分析中查看 →</router-link></h3>
      <request-table :rows="requests" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ElMessage, ElMessageBox } from "element-plus"
import { onMounted, ref } from "vue"
import { useRoute, useRouter } from "vue-router"
import { api, query } from "../../api"
import { date, money, rangeDays, time, tokens } from "../../format"
import { barOption, pieOption } from "../../charts"
import Chart from "../../components/Chart.vue"
import Stat from "../../components/Stat.vue"
import Empty from "../../components/Empty.vue"
import RequestTable from "../../components/RequestTable.vue"

const route = useRoute()
const router = useRouter()
const id = route.params.id as string
const data = ref<any>()
const byProject = ref<any[]>([])
const byModel = ref<any[]>([])
const requests = ref<any[]>([])

const clientVersion = (agent: string | null) => (agent ? (/opencode\/([\w.-]+)/.exec(agent)?.[1] ?? "—") : "—")

async function load() {
  const range = { ...rangeDays(30), user: id }
  const [detail, projects, models, list] = await Promise.all([
    api.get(`/api/admin/users/${id}`),
    api.get(`/api/admin/usage/breakdown${query({ ...range, by: "project" })}`),
    api.get(`/api/admin/usage/breakdown${query({ ...range, by: "model" })}`),
    api.get(`/api/admin/usage/requests${query({ ...range, limit: 30 })}`),
  ])
  data.value = detail
  byProject.value = projects.rows
  byModel.value = models.rows
  requests.value = list.items
}

async function patch(body: Record<string, unknown>) {
  await api.patch(`/api/admin/users/${id}`, body)
  await load()
}

async function setStatus(status: "active" | "disabled") {
  if (status === "disabled") await ElMessageBox.confirm("禁用后该成员的所有会话（含 OpenCode 客户端）立即失效。", "禁用成员", { type: "warning" })
  await patch({ status })
}

async function resetPassword() {
  await ElMessageBox.confirm("重置后旧密码与所有会话立即失效。", "重置密码", { type: "warning" })
  const result = await api.post(`/api/admin/users/${id}/reset-password`)
  await ElMessageBox.alert(`临时密码（只显示一次）：${result.temporaryPassword}`, "已重置", { confirmButtonText: "我已安全记录" })
  await load()
}

async function revoke(sessionID?: string) {
  const result = await api.post(`/api/admin/users/${id}/revoke-sessions`, sessionID ? { sessionID } : {})
  ElMessage.success(`已撤销 ${result.revoked} 个会话`)
  await load()
}

async function remove() {
  await ElMessageBox.confirm("删除为软删除：保留历史用量与审计记录，账户无法再登录，并移出全部项目组。此操作不可在界面中撤销。", "删除成员", {
    type: "warning",
    confirmButtonText: "确认删除",
  })
  await api.del(`/api/admin/users/${id}`)
  await router.push("/admin/members")
}

onMounted(load)
</script>
