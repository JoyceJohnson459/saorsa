<template>
  <div class="page">
    <div class="page-head">
      <div>
        <div class="eyebrow">{{ $route.meta.eyebrow }}</div>
        <h1>项目组</h1>
        <p>项目组仅用于成员归属、模型授权、费用归集、预算与合规审计，不包含代码仓库或任务。</p>
      </div>
      <div class="row">
        <el-select v-model="status" placeholder="状态" clearable style="width: 120px" @change="load">
          <el-option label="进行中" value="active" />
          <el-option label="已归档" value="archived" />
        </el-select>
        <el-button type="primary" :icon="Plus" @click="open = true">新建项目组</el-button>
      </div>
    </div>
    <div class="card">
      <el-table :data="projects" v-loading="loading" @row-click="(row: any) => $router.push(`/admin/projects/${row.id}`)" row-class-name="clickable">
        <el-table-column label="编号" prop="code" width="120"><template #default="{ row }"><b>{{ row.code }}</b></template></el-table-column>
        <el-table-column label="名称" prop="name" min-width="160" />
        <el-table-column label="用途说明" min-width="260"><template #default="{ row }"><span class="muted small clamp">{{ row.purpose || "—" }}</span></template></el-table-column>
        <el-table-column label="标签" min-width="140"><template #default="{ row }"><el-tag v-for="tag in row.tags" :key="tag" size="small" style="margin-right: 4px">{{ tag }}</el-tag></template></el-table-column>
        <el-table-column label="成员" prop="member_count" width="70" align="right" />
        <el-table-column label="模型" prop="model_count" width="70" align="right" />
        <el-table-column label="30 天请求" prop="requests_30d" width="100" align="right" />
        <el-table-column label="30 天费用" width="110" align="right"><template #default="{ row }">{{ money(row.cost_30d_micros) }}</template></el-table-column>
        <el-table-column label="状态" width="90"><template #default="{ row }"><el-tag :type="row.status === 'active' ? 'success' : 'info'" size="small">{{ row.status === "active" ? "进行中" : "已归档" }}</el-tag></template></el-table-column>
        <template #empty><empty text="还没有项目组" /></template>
      </el-table>
    </div>
    <el-dialog v-model="open" title="新建项目组" width="560px">
      <project-form v-model="form" />
      <template #footer>
        <el-button @click="open = false">取消</el-button>
        <el-button type="primary" :loading="busy" @click="create">创建</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { Plus } from "@element-plus/icons-vue"
import { ElMessage } from "element-plus"
import { onMounted, ref } from "vue"
import { useRouter } from "vue-router"
import { api, query } from "../../api"
import { money } from "../../format"
import Empty from "../../components/Empty.vue"
import ProjectForm from "./ProjectForm.vue"

const router = useRouter()
const projects = ref<any[]>([])
const loading = ref(false)
const status = ref("")
const open = ref(false)
const busy = ref(false)
const form = ref({ code: "", name: "", description: "", purpose: "", tags: [] as string[], concurrencyLimit: null as number | null, requestsPerMinute: null as number | null, tokensPerMinute: null as number | null })

async function load() {
  loading.value = true
  try {
    projects.value = (await api.get(`/api/admin/projects${query({ status: status.value })}`)).projects
  } finally {
    loading.value = false
  }
}

async function create() {
  busy.value = true
  try {
    const created = await api.post("/api/admin/projects", form.value)
    ElMessage.success("项目组已创建")
    open.value = false
    await router.push(`/admin/projects/${created.id}`)
  } finally {
    busy.value = false
  }
}

onMounted(load)
</script>

<style scoped>
:deep(.clickable) { cursor: pointer; }
.clamp { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
</style>
