<template>
  <div class="page">
    <div class="page-head">
      <div>
        <div class="eyebrow">{{ $route.meta.eyebrow }}</div>
        <h1>我的工作台</h1>
        <p>使用管理员分配的模型进行本地 AI 编程，无需自行配置供应商 API Key。</p>
      </div>
    </div>
    <div v-if="keys?.mode === 'exclusive'" class="card mb keycard">
      <div class="row">
        <div>
          <h3>我的 Key</h3>
          <p class="muted small">每个 Key 同一时间只给一位成员使用，先选先得。括号内为当前空闲 Key 数，为 0 时不能选择。</p>
        </div>
        <span class="spacer" />
        <el-select
          :model-value="current?.id"
          placeholder="选择要使用的模型"
          style="width: 280px"
          :disabled="!keys.connected || busy"
          aria-label="选择要使用的 Key"
          @change="claim"
        >
          <el-option v-for="pool in keys.pools" :key="pool.id" :value="pool.id" :label="optionLabel(pool)" :disabled="!pool.mine && pool.free === 0">
            <div class="option">
              <span>{{ pool.name }}</span>
              <span class="muted small">{{ pool.models.join(" · ") }}</span>
              <span class="spacer" />
              <el-tag v-if="pool.mine" size="small" type="success">使用中</el-tag>
              <span v-else class="count" :class="{ none: pool.free === 0 }">{{ pool.free }}</span>
            </div>
          </el-option>
        </el-select>
        <el-button :disabled="!current || busy" @click="release">释放</el-button>
      </div>
      <p v-if="!keys.connected" class="muted small">请先在 <router-link to="/me/tools">工具中心</router-link> 连接一个工具（例如运行 <span class="mono">opencode auth login</span>），再选择 Key。</p>
      <p v-else-if="current" class="muted small">
        正在使用 <b>{{ current.name }}</b> 的 Key（{{ time(keys.lease.claimed_at) }} 起），可在 OpenCode 中使用 {{ current.models.join("、") }}。
        {{ keys.idleMinutes }} 分钟内没有调用会自动释放；在 OpenCode 中切换到其他供应商的模型时，如有空闲 Key 会自动换过去。
      </p>
      <p v-else class="muted small">也可以直接在 OpenCode 中选择模型开始使用，第一次调用时自动分配空闲 Key。</p>
    </div>
    <tool-usage class="mb" />
    <div class="card">
      <h3>我的预算</h3>
      <div v-for="budget in budgets" :key="budget.id" class="budget">
        <div class="row"><b>{{ scopeLabel[budget.scope_type] }}</b><span class="muted">{{ budget.project_code ?? "" }} · {{ periodLabel[budget.period] }}</span><span class="spacer" /><span>{{ money(budget.spent_micros, budget.currency) }} / {{ money(budget.effective_limit_micros, budget.currency) }}</span></div>
        <el-progress :percentage="Math.min(100, budget.percent ?? 0)" :status="(budget.percent ?? 0) >= 100 ? 'exception' : (budget.percent ?? 0) >= 80 ? 'warning' : undefined" />
      </div>
      <empty v-if="!budgets.length" text="没有个人预算（仍受项目组与企业预算约束）" />
    </div>
    <div class="card mt">
      <h3>我的项目组与可用模型</h3>
      <el-table :data="projects">
        <el-table-column label="项目组" width="220"><template #default="{ row }"><b>{{ row.code }}</b> · {{ row.name }}</template></el-table-column>
        <el-table-column label="用途"><template #default="{ row }"><span class="muted small">{{ row.purpose }}</span></template></el-table-column>
        <el-table-column label="授权模型" min-width="220"><template #default="{ row }"><el-tag v-for="model in row.models" :key="model.id" size="small" style="margin: 2px">{{ model.alias }}</el-tag><span v-if="!row.models.length" class="muted">暂无</span></template></el-table-column>
        <template #empty><empty text="你还没有加入任何项目组，请联系管理员" /></template>
      </el-table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ElMessage } from "element-plus"
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import { api, subscribe } from "../../api"
import { money, periodLabel, scopeLabel, time } from "../../format"
import Empty from "../../components/Empty.vue"
import ToolUsage from "../../components/ToolUsage.vue"

const projects = ref<any[]>([])
const budgets = ref<any[]>([])

type Pool = { id: string; name: string; total: number; free: number; mine: boolean; models: string[] }
const keys = ref<{ mode: string; idleMinutes: number; connected: boolean; pools: Pool[]; lease: any } | undefined>()
const current = computed(() => keys.value?.pools.find((pool) => pool.mine))
const busy = ref(false)
const optionLabel = (pool: Pool) => (pool.mine ? `${pool.name} · 使用中` : `${pool.name} (${pool.free})`)

async function loadKeys() {
  keys.value = await api.get("/api/me/keys")
}

async function claim(providerID: string) {
  busy.value = true
  try {
    await api.post("/api/me/keys/claim", { providerID })
    ElMessage.success("已分配 Key")
  } finally {
    busy.value = false
    await loadKeys()
  }
}

async function release() {
  busy.value = true
  try {
    await api.post("/api/me/keys/release")
    ElMessage.success("已释放 Key")
  } finally {
    busy.value = false
    await loadKeys()
  }
}

async function load() {
  const [projectList, budgetList] = await Promise.all([api.get("/api/me/projects"), api.get("/api/me/budgets")])
  projects.value = projectList.projects
  budgets.value = budgetList.budgets
  await loadKeys()
}

// Counts change whenever anyone claims or releases a key; refresh on the event instead of polling.
let stop: (() => void) | undefined
onMounted(() => {
  void load()
  stop = subscribe("/api/me/events", (type) => {
    if (type === "key.lease") void loadKeys()
  })
})
onBeforeUnmount(() => stop?.())
</script>

<style scoped>
.budget { margin-bottom: 14px; }
.mb { margin-bottom: 18px; }
.keycard .row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.keycard h3 { margin: 0 0 4px; }
.keycard p { margin: 4px 0 0; }
.option { display: flex; align-items: center; gap: 10px; width: 100%; }
.count { font-variant-numeric: tabular-nums; font-weight: 700; color: var(--mint); }
.count.none { color: var(--dim); }
</style>
