<template>
  <div class="page">
    <div class="page-head">
      <div>
        <div class="eyebrow">{{ $route.meta.eyebrow }}</div>
        <h1>工具中心</h1>
        <p>选择管理员为你的项目组授权的工具。命令行工具可由 Saorsa Launcher 安装、配置并启动；IDE 类工具在其设置中填写 Saorsa Key。所有受管调用都经企业网关计费。</p>
      </div>
    </div>
    <launcher-download class="launcher" />
    <div v-if="error" class="card"><empty :text="error" /><el-button @click="load">重试</el-button></div>
    <div v-else v-loading="loading" class="toolgrid">
      <div v-for="tool in tools" :key="tool.id" class="card tool" :class="{ locked: !tool.projects.length }">
        <div class="head">
          <div>
            <h3><router-link :to="`/tools/${tool.id}?from=me`">{{ tool.name }}</router-link></h3>
            <div class="muted small">{{ tool.vendor }} · {{ tool.forms.map((form: string) => formLabel[form]).join(" / ") }}</div>
          </div>
          <el-tag v-if="tool.projects.length" size="small" type="success">已授权</el-tag>
          <el-tag v-else size="small" type="info">未授权</el-tag>
        </div>
        <template v-if="tool.projects.length">
          <div class="small muted">可用项目组：{{ tool.projects.map((project: any) => project.code).join("、") }}</div>
          <div v-if="tool.delivery === 'opencode-login'" class="steps">
            <div class="small">在终端运行：</div>
            <pre class="notice mono">opencode auth login {{ origin }}</pre>
          </div>
          <div v-else-if="tool.delivery === 'launch-env'" class="steps">
            <div class="small">用 Saorsa Launcher 启动（凭证只在启动时注入，不写入磁盘）：</div>
            <pre class="notice mono">saorsa launch {{ tool.id }} --dir &lt;你的项目目录&gt;</pre>
          </div>
          <div v-if="tool.delivery !== 'opencode-login'" class="steps">
            <div class="small">{{ tool.delivery === "ide-key" ? "在工具设置中填写：" : "不用 Launcher 时手动配置：" }}</div>
            <dl v-for="route in tool.routes" :key="route.protocol" class="settings small">
              <dt class="muted">{{ protocolLabel[route.protocol] }}</dt>
              <dd v-for="(value, name) in route.settings" :key="name"><span class="muted">{{ name }}</span> <code>{{ fillSetting(value, { origin }) }}</code></dd>
            </dl>
          </div>
          <div v-if="tool.delivery !== 'opencode-login'" class="row">
            <el-select v-model="projectFor[tool.id]" size="small" placeholder="计费项目组" style="width: 160px" :aria-label="`${tool.name} 的计费项目组`">
              <el-option v-for="project in tool.projects" :key="project.id" :label="project.code" :value="project.id" />
            </el-select>
            <el-button size="small" :loading="creating === tool.id" :disabled="!projectFor[tool.id]" @click="createKey(tool)">生成 Saorsa Key</el-button>
          </div>
        </template>
        <p v-else class="muted small">你的项目组尚未授权此工具，如需使用请联系管理员。</p>
        <router-link :to="`/tools/${tool.id}?from=me`" class="guide-link">查看详细连接方式（安装、配置、验证、排错）→</router-link>
        <div class="flags small">
          <span v-if="tool.status.partiallyManaged" class="warntext">部分托管：{{ tool.unmanaged[0] }}</span>
          <span v-if="tool.officialAccount" class="warntext">需官方账户：{{ tool.officialAccount }}</span>
          <span v-if="tool.lab" class="muted">实验室已验证 {{ tool.lab.version }}（mock 上游）</span>
          <span v-else class="muted">尚未在实验室中验证</span>
        </div>
      </div>
    </div>
    <el-dialog v-model="keyOpen" title="你的 Saorsa Key（只显示一次）" width="min(560px, 92vw)">
      <p class="small">这把 Key 只能用于 <b>{{ issued?.tool }}</b>，按所选项目组计费，可在“个人设置 → 登录设备”中撤销。请立即复制到工具设置中，关闭后无法再次查看。不要发到聊天或提交到代码仓库。</p>
      <pre class="notice mono key">{{ issued?.key }}</pre>
      <template #footer>
        <el-button @click="copy">复制</el-button>
        <el-button type="primary" @click="closeKey">我已保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ElMessage } from "element-plus"
import { onMounted, reactive, ref } from "vue"
import { api, type ApiError } from "../../api"
import Empty from "../../components/Empty.vue"
import LauncherDownload from "../../components/LauncherDownload.vue"
import { fillSetting, formLabel, protocolLabel } from "../../tools"

const origin = location.origin
const tools = ref<any[]>([])
const loading = ref(true)
const error = ref("")
const projectFor = reactive<Record<string, string>>({})
const creating = ref("")
const keyOpen = ref(false)
const issued = ref<{ tool: string; key: string }>()

async function load() {
  loading.value = true
  error.value = ""
  try {
    tools.value = (await api.get("/api/tools", { quiet: true })).tools
    for (const tool of tools.value) if (tool.projects.length === 1) projectFor[tool.id] = tool.projects[0].id
  } catch (cause) {
    error.value = `加载失败：${(cause as ApiError).message}`
  } finally {
    loading.value = false
  }
}

async function createKey(tool: any) {
  creating.value = tool.id
  try {
    const result = await api.post("/api/me/tool-keys", { toolID: tool.id, projectID: projectFor[tool.id] })
    issued.value = { tool: tool.name, key: result.key }
    keyOpen.value = true
  } finally {
    creating.value = ""
  }
}

async function copy() {
  await navigator.clipboard.writeText(issued.value?.key ?? "")
  ElMessage.success("已复制")
}

function closeKey() {
  issued.value = undefined
  keyOpen.value = false
}

onMounted(load)
</script>

<style scoped>
.launcher { margin-bottom: 16px; }
.toolgrid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(min(320px, 100%), 1fr)); }
.tool { display: flex; flex-direction: column; gap: 10px; min-width: 0; overflow-wrap: anywhere; }
.tool.locked { opacity: 0.72; }
.tool .head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
.tool .head > div { min-width: 0; }
.tool .head > :last-child { flex: none; }
.tool h3 { margin: 0 0 4px; }
.steps pre { margin: 6px 0 0; white-space: pre-wrap; word-break: break-all; }
.settings { margin: 6px 0 0; }
.settings dt { margin-bottom: 2px; }
.settings dd { margin: 0 0 3px; word-break: break-all; }
.flags { display: flex; flex-direction: column; gap: 4px; }
.tool h3 a { color: var(--text); }
.guide-link { font-size: 13px; font-weight: 600; }
.warntext { color: var(--orange); }
.key { user-select: all; word-break: break-all; white-space: pre-wrap; }
</style>
