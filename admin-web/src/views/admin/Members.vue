<template>
  <div class="page">
    <div class="page-head">
      <div>
        <div class="eyebrow">{{ $route.meta.eyebrow }}</div>
        <h1>成员管理</h1>
        <p>系统仅有管理员与普通成员两类账户；项目组成员关系不产生任何管理权限。</p>
      </div>
      <div class="row">
        <el-input v-model="q" placeholder="搜索用户名 / 姓名 / 邮箱" clearable style="width: 220px" @change="load" />
        <el-select v-model="status" placeholder="状态" clearable style="width: 110px" @change="load">
          <el-option label="正常" value="active" />
          <el-option label="已禁用" value="disabled" />
        </el-select>
        <el-button @click="importOpen = true">批量导入</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">新增成员</el-button>
      </div>
    </div>
    <div class="card">
      <el-table :data="users" v-loading="loading">
        <el-table-column label="成员" min-width="180">
          <template #default="{ row }">
            <router-link :to="`/admin/members/${row.id}`"><b>{{ row.display_name }}</b></router-link>
            <div class="muted small">{{ row.username }}<span v-if="row.email"> · {{ row.email }}</span></div>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="90"><template #default="{ row }"><el-tag :type="row.account_type === 'ADMIN' ? 'primary' : 'info'" size="small">{{ row.account_type === "ADMIN" ? "管理员" : "成员" }}</el-tag></template></el-table-column>
        <el-table-column label="所属项目组" min-width="200">
          <template #default="{ row }"><el-tag v-for="project in row.projects" :key="project.id" size="small" effect="plain" style="margin: 2px">{{ project.code }}</el-tag><span v-if="!row.projects.length" class="muted">—</span></template>
        </el-table-column>
        <el-table-column label="客户端会话" prop="client_sessions" width="100" align="right" />
        <el-table-column label="最近登录" width="160"><template #default="{ row }">{{ time(row.last_login_at) }}</template></el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag v-if="row.status !== 'active'" type="danger" size="small">已禁用</el-tag>
            <el-tag v-else-if="row.locked_until && new Date(row.locked_until) > new Date()" type="warning" size="small">已锁定</el-tag>
            <el-tag v-else-if="row.must_change_password" type="warning" size="small" effect="plain">待改密</el-tag>
            <el-tag v-else type="success" size="small">正常</el-tag>
          </template>
        </el-table-column>
        <el-table-column width="90" align="right"><template #default="{ row }"><router-link :to="`/admin/members/${row.id}`">详情</router-link></template></el-table-column>
      </el-table>
    </div>

    <el-dialog v-model="createOpen" title="新增成员" width="520px">
      <el-form label-position="top">
        <div class="grid halves">
          <el-form-item label="用户名"><el-input v-model="form.username" /></el-form-item>
          <el-form-item label="显示名称"><el-input v-model="form.displayName" /></el-form-item>
        </div>
        <el-form-item label="邮箱（可选）"><el-input v-model="form.email" /></el-form-item>
        <el-form-item label="账户类型">
          <el-radio-group v-model="form.accountType">
            <el-radio value="MEMBER">普通成员</el-radio>
            <el-radio value="ADMIN">管理员（与其他管理员权限相同）</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="加入项目组">
          <el-select v-model="form.projectIDs" multiple style="width: 100%">
            <el-option v-for="project in projects" :key="project.id" :label="`${project.code} · ${project.name}`" :value="project.id" />
          </el-select>
        </el-form-item>
        <p class="muted small">系统将生成一次性临时密码，仅显示一次；成员首次登录必须修改密码。</p>
      </el-form>
      <template #footer>
        <el-button @click="createOpen = false">取消</el-button>
        <el-button type="primary" :loading="busy" @click="create">创建</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="importOpen" title="批量导入成员" width="600px">
      <p class="muted small">每行一个成员：用户名,显示名称,邮箱(可选),项目编号(可选,多个用 | 分隔)</p>
      <el-input v-model="importText" type="textarea" :rows="8" placeholder="zhangsan,张三,zhangsan@example.com,VISION|LEDGER" class="mono" />
      <el-table v-if="importResults.length" :data="importResults" size="small" class="mt" max-height="240">
        <el-table-column label="用户名" prop="username" />
        <el-table-column label="结果"><template #default="{ row }"><span :class="row.ok ? '' : 'error'">{{ row.ok ? "已创建" : row.error }}</span></template></el-table-column>
        <el-table-column label="临时密码"><template #default="{ row }"><span class="mono">{{ row.temporaryPassword ?? "" }}</span></template></el-table-column>
      </el-table>
      <template #footer>
        <el-button @click="importOpen = false">关闭</el-button>
        <el-button type="primary" @click="runImport">导入</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="secretOpen" title="临时密码（只显示一次）" width="460px">
      <p>请通过安全渠道告知 <b>{{ secret.username }}</b>：</p>
      <el-input :model-value="secret.password" readonly class="mono"><template #append><el-button @click="copy">复制</el-button></template></el-input>
      <p class="muted small">关闭后无法再次查看；如遗失请重置密码。</p>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { Plus } from "@element-plus/icons-vue"
import { ElMessage } from "element-plus"
import { onMounted, reactive, ref } from "vue"
import { api, query } from "../../api"
import { time } from "../../format"

const users = ref<any[]>([])
const projects = ref<any[]>([])
const loading = ref(false)
const q = ref("")
const status = ref("")
const createOpen = ref(false)
const importOpen = ref(false)
const secretOpen = ref(false)
const busy = ref(false)
const form = reactive({ username: "", displayName: "", email: "", accountType: "MEMBER", projectIDs: [] as string[] })
const secret = reactive({ username: "", password: "" })
const importText = ref("")
const importResults = ref<any[]>([])

async function load() {
  loading.value = true
  try {
    const [list, projectList] = await Promise.all([api.get(`/api/admin/users${query({ q: q.value, status: status.value })}`), api.get("/api/admin/projects?status=active")])
    users.value = list.users
    projects.value = projectList.projects
  } finally {
    loading.value = false
  }
}

function openCreate() {
  Object.assign(form, { username: "", displayName: "", email: "", accountType: "MEMBER", projectIDs: [] })
  createOpen.value = true
}

async function create() {
  busy.value = true
  try {
    const created = await api.post("/api/admin/users", { ...form, email: form.email || undefined })
    createOpen.value = false
    Object.assign(secret, { username: created.username, password: created.temporaryPassword })
    secretOpen.value = true
    await load()
  } finally {
    busy.value = false
  }
}

async function runImport() {
  const byCode = new Map(projects.value.map((project) => [project.code.toLowerCase(), project.id]))
  const rows = importText.value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [username = "", displayName = "", email = "", codes = ""] = line.split(",").map((part) => part.trim())
      return {
        username,
        displayName: displayName || username,
        email: email || undefined,
        projectIDs: codes.split("|").map((code) => byCode.get(code.toLowerCase())).filter((value): value is string => Boolean(value)),
      }
    })
  if (!rows.length) return
  importResults.value = (await api.post("/api/admin/users/import", { users: rows })).results
  await load()
}

async function copy() {
  await navigator.clipboard.writeText(secret.password)
  ElMessage.success("已复制")
}

onMounted(load)
</script>

<style scoped>
.error { color: var(--tos-danger); }
</style>
