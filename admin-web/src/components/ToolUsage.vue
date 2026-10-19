<template>
  <div class="card">
    <div class="head">
      <div>
        <h3>我连接的工具</h3>
        <p class="muted small">每个已连接工具的使用量、连接与设备（仅你本人经网关的受管调用）。在“连接与设备”中可切换每个连接的计费项目组。</p>
      </div>
      <el-radio-group v-model="days" size="small" aria-label="统计周期" @change="load">
        <el-radio-button :value="7">近 7 天</el-radio-button>
        <el-radio-button :value="30">近 30 天</el-radio-button>
        <el-radio-button :value="90">近 90 天</el-radio-button>
      </el-radio-group>
    </div>

    <div v-if="error" class="state"><empty :text="error" /><el-button size="small" @click="load">重试</el-button></div>
    <div v-else-if="!data" v-loading="true" class="state" />
    <div v-else-if="!data.tools.length" class="state">
      <empty text="还没有连接任何工具" />
      <router-link to="/me/tools">去工具中心选择并连接 →</router-link>
    </div>

    <div v-else class="tools">
      <article v-for="tool in data.tools" :key="tool.id" class="tool">
        <header>
          <div>
            <router-link :to="`/tools/${tool.id}?from=me`" class="name">{{ tool.name }}</router-link>
            <span class="muted small"> · {{ tool.vendor }}</span>
            <div class="chips small">
              <span v-if="tool.connections.length" class="chip">{{ tool.connections.length }} 个连接</span>
              <span v-if="tool.launches" class="chip">Launcher 启动 {{ tool.launches.count }} 次</span>
              <span v-if="installedDevices(tool).length" class="chip">{{ installedDevices(tool).length }} 台设备已安装</span>
              <span v-if="tool.usage?.lastVersion" class="chip">版本 {{ tool.usage.lastVersion }}</span>
              <span v-if="!tool.usage" class="chip idle">周期内未使用</span>
            </div>
          </div>
          <svg v-if="tool.usage" class="spark" viewBox="0 0 120 32" preserveAspectRatio="none" role="img" :aria-label="`${tool.name} 每日请求趋势`">
            <polyline :points="spark(tool.usage.series)" fill="none" stroke="currentColor" stroke-width="1.6" />
          </svg>
        </header>

        <dl v-if="tool.usage" class="stats">
          <div><dt>请求</dt><dd>{{ tool.usage.requests }}</dd></div>
          <div><dt>成功率</dt><dd>{{ successRate(tool.usage) }}</dd></div>
          <div><dt>费用</dt><dd>{{ money(tool.usage.costMicros) }}<small v-if="tool.usage.estimatedRequests" class="muted"> 含 {{ tool.usage.estimatedRequests }} 次估算</small></dd></div>
          <div><dt>输入 / 输出 Token</dt><dd>{{ tokens(tool.usage.inputTokens) }} / {{ tokens(tool.usage.outputTokens) }}</dd></div>
          <div><dt>缓存读取</dt><dd>{{ tokens(tool.usage.cacheReadTokens) }}</dd></div>
          <div><dt>平均耗时</dt><dd>{{ tool.usage.avgDurationMs === null ? "—" : `${(tool.usage.avgDurationMs / 1000).toFixed(1)}s` }}</dd></div>
          <div><dt>最近使用</dt><dd>{{ time(tool.usage.lastRequestAt) }}</dd></div>
          <div><dt>失败 / 被拒</dt><dd>{{ tool.usage.failed }} / {{ tool.usage.rejected }}</dd></div>
        </dl>

        <div v-if="tool.usage?.models.length" class="models small">
          <span class="muted">模型</span>
          <span v-for="model in tool.usage.models" :key="model.alias" class="chip">{{ model.alias }} · {{ model.requests }} 次 · {{ money(model.costMicros) }}</span>
        </div>

        <details v-if="tool.connections.length || tool.devices.length">
          <summary class="small">连接与设备</summary>
          <el-table v-if="tool.connections.length" :data="tool.connections" size="small" class="mt-s">
            <el-table-column label="连接方式" min-width="120"><template #default="{ row }">{{ row.kind === "opencode-login" ? "OpenCode 登录" : "工具 Key" }}</template></el-table-column>
            <el-table-column label="计费项目组" min-width="170">
              <template #default="{ row }">
                <el-select
                  v-if="tool.projects.length > 1"
                  :model-value="row.projectID"
                  size="small"
                  style="width: 100%"
                  :aria-label="`${tool.name} 的计费项目组`"
                  @change="(value: string) => switchProject(tool, row, value)"
                >
                  <el-option v-for="project in tool.projects" :key="project.id" :label="`${project.code} · ${project.name}`" :value="project.id" />
                </el-select>
                <span v-else>{{ row.projectCode }}</span>
              </template>
            </el-table-column>
            <el-table-column label="最近使用" width="150"><template #default="{ row }">{{ row.lastUsedAt ? time(row.lastUsedAt) : "尚未使用" }}</template></el-table-column>
            <el-table-column label="创建于" width="150"><template #default="{ row }">{{ time(row.createdAt) }}</template></el-table-column>
            <el-table-column width="70" align="right">
              <template #default="{ row }"><el-button link type="danger" size="small" @click="revoke(tool, row)">撤销</el-button></template>
            </el-table-column>
          </el-table>
          <el-table v-if="tool.devices.length" :data="tool.devices" size="small" class="mt-s">
            <el-table-column label="设备（Launcher 上报）" min-width="140"><template #default="{ row }">{{ row.label }}<div class="muted small">{{ row.os }} · {{ row.arch }}</div></template></el-table-column>
            <el-table-column label="状态" width="90"><template #default="{ row }">{{ row.installed ? "已安装" : "未安装" }}</template></el-table-column>
            <el-table-column label="版本" width="110"><template #default="{ row }">{{ row.version ?? "—" }}</template></el-table-column>
            <el-table-column label="上报时间" width="150"><template #default="{ row }">{{ time(row.reportedAt) }}</template></el-table-column>
          </el-table>
        </details>

        <footer class="small">
          <router-link v-if="tool.usage" :to="`/me/usage?tool=${tool.id}`">查看请求明细 →</router-link>
          <router-link :to="`/tools/${tool.id}?from=me`">连接方式</router-link>
        </footer>
      </article>
      <p v-if="data.notConnected" class="muted small">另有 {{ data.notConnected }} 款工具尚未连接，<router-link to="/me/tools">去工具中心</router-link>。</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ElMessage, ElMessageBox } from "element-plus"
import { onMounted, ref } from "vue"
import { api, type ApiError } from "../api"
import { money, time, tokens } from "../format"
import Empty from "./Empty.vue"

const days = ref(30)
const data = ref<{ tools: any[]; notConnected: number }>()
const error = ref("")

const installedDevices = (tool: any) => tool.devices.filter((device: any) => device.installed)
const successRate = (usage: any) => (usage.requests ? `${((usage.succeeded / usage.requests) * 100).toFixed(1)}%` : "—")

/** Daily request counts as sparkline points across the selected window (missing days are zero). */
function spark(series: Array<{ day: string; requests: number }>) {
  const start = Date.now() - days.value * 86400_000
  const buckets = Array.from({ length: days.value }, () => 0)
  for (const point of series) {
    const index = Math.min(days.value - 1, Math.max(0, Math.floor((new Date(point.day).getTime() - start) / 86400_000)))
    buckets[index] = (buckets[index] ?? 0) + point.requests
  }
  const max = Math.max(1, ...buckets)
  return buckets.map((value, index) => `${((index / Math.max(1, buckets.length - 1)) * 120).toFixed(1)},${(30 - (value / max) * 28).toFixed(1)}`).join(" ")
}

async function load() {
  error.value = ""
  try {
    data.value = await api.get(`/api/me/tools/usage?days=${days.value}`, { quiet: true })
  } catch (cause) {
    error.value = `加载失败：${(cause as ApiError).message}`
  }
}

/** Moves one connection to another billing project; the next request is billed there (each switch is audited). */
async function switchProject(tool: any, connection: any, projectID: string) {
  await api.post("/api/me/active-project", { sessionID: connection.id, projectID })
  ElMessage.success(tool.id === "opencode" ? "已切换计费项目组；OpenCode 下次启动时刷新模型列表" : "已切换计费项目组，下一次调用起生效")
  await load()
}

async function revoke(tool: any, connection: any) {
  await ElMessageBox.confirm(`撤销后，使用这个${connection.kind === "opencode-login" ? " OpenCode 登录" : " Key"} 的 ${tool.name} 将无法再调用网关。确定撤销？`, "撤销连接", { type: "warning" })
  await api.del(`/api/me/sessions/${connection.id}`)
  ElMessage.success("已撤销")
  await load()
}

defineExpose({ load })
onMounted(load)
</script>

<style scoped>
.head { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; align-items: flex-start; }
.head h3 { margin: 0 0 4px; }
.head p { margin: 0; }
.state { min-height: 120px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; }
.tools { display: grid; gap: 14px; margin-top: 14px; }
.tool { border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; background: var(--raised); display: flex; flex-direction: column; gap: 10px; min-width: 0; overflow-wrap: anywhere; }
.tool header { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
.name { font-weight: 650; font-size: 15px; color: var(--text); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.chip { border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; color: var(--muted); }
.chip.idle { color: var(--dim); }
.spark { width: 120px; height: 32px; color: var(--mint); flex: none; }
.stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(130px, 40%), 1fr)); gap: 8px 16px; margin: 0; }
.stats dt { font-size: 11px; color: var(--muted); }
.stats dd { margin: 2px 0 0; font-weight: 600; font-variant-numeric: tabular-nums; }
.models { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
details summary { cursor: pointer; color: var(--muted); }
.mt-s { margin-top: 8px; }
footer { display: flex; gap: 16px; }
@media (max-width: 520px) { .spark { display: none; } }
</style>
