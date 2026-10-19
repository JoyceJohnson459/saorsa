<template>
  <div class="page">
    <div v-if="error" class="card"><empty :text="error" /><el-button @click="load">重试</el-button></div>
    <template v-else-if="data">
      <div class="page-head">
        <div>
          <div class="eyebrow">TOOL GUIDE / 连接方式</div>
          <h1>{{ data.tool.name }}</h1>
          <p>{{ data.guide.summary }}</p>
        </div>
        <router-link :to="back" class="small">← 返回工具中心</router-link>
      </div>

      <div class="card flags">
        <span class="muted small">{{ data.tool.vendor }} · {{ data.tool.forms.map((form: string) => formLabel[form]).join(" / ") }} · {{ data.tool.routes.map((route: any) => protocolLabel[route.protocol]).join("、") }}</span>
        <span v-if="data.tool.lab" class="tag ok">实验室已验证 {{ data.tool.lab.version }}（{{ data.tool.lab.platform }}，mock 上游，非真实模型）</span>
        <span v-else class="tag muted">尚未在实验室中验证</span>
        <span v-if="data.tool.officialAccount" class="tag warn">需官方账户：{{ data.tool.officialAccount }}</span>
      </div>

      <div class="card selectors mt">
        <div class="row">
          <label class="small muted" for="guide-project">计费项目组</label>
          <el-select id="guide-project" v-model="projectID" placeholder="选择项目组" style="width: 200px" :disabled="!authorized.length">
            <el-option v-for="project in authorized" :key="project.id" :label="`${project.code} · ${project.name}`" :value="project.id" />
          </el-select>
          <label class="small muted" for="guide-model">模型</label>
          <el-select id="guide-model" v-model="model" placeholder="选择模型" style="width: 220px" :disabled="!models.length">
            <el-option v-for="entry in models" :key="entry.alias" :label="`${entry.alias} · ${entry.provider}`" :value="entry.alias" />
          </el-select>
          <span class="spacer" />
          <el-radio-group v-model="os" size="small" aria-label="操作系统">
            <el-radio-button value="unix">macOS / Linux</el-radio-button>
            <el-radio-button value="windows">Windows PowerShell</el-radio-button>
          </el-radio-group>
        </div>
        <p v-if="!authorized.length" class="warntext small">你的项目组尚未授权 {{ data.tool.name }}，以下步骤仅供参考；如需使用请联系管理员在「项目组详情 → 工具授权」中开启。</p>
        <p v-else-if="!models.length" class="warntext small">该项目组没有 {{ data.tool.name }} 可用的模型（需要 {{ data.tool.routes.map((route: any) => protocolLabel[route.protocol]).join(" 或 ") }} 协议），请联系管理员。</p>
        <div v-if="canIssueKey" class="row keyrow">
          <el-button size="small" type="primary" :loading="creating" :disabled="!projectID" @click="createKey">生成 {{ data.tool.name }} 专用 Saorsa Key</el-button>
          <span v-if="key" class="small">已生成，下面的步骤已自动填入；离开本页后无法再次查看。</span>
          <span v-else class="muted small">需要 Key 的步骤会显示 &lt;你的 Saorsa Key&gt;，生成后自动填入。</span>
        </div>
      </div>

      <div class="card mt">
        <h3>准备</h3>
        <ul class="small"><li v-for="item in data.guide.prerequisites" :key="item">{{ fill(item) }}</li></ul>
        <h3>安装</h3>
        <guide-steps :steps="data.guide.install" />
      </div>

      <div class="card mt">
        <h3>连接方式</h3>
        <el-tabs v-model="method">
          <el-tab-pane v-for="entry in data.guide.methods" :key="entry.id" :name="entry.id">
            <template #label>
              <span>{{ entry.title }}</span>
              <el-tag v-if="entry.recommended" size="small" type="success" class="tabtag">推荐</el-tag>
            </template>
            <p class="small" :class="entry.verified === 'lab' ? 'oktext' : 'warntext'">
              {{ entry.verified === "lab" ? "本方法已在实验室中用真实工具验证（mock 上游）。" : "本方法依据官方文档整理，尚未在实验室中验证。" }}
            </p>
            <guide-steps :steps="entry.steps" />
          </el-tab-pane>
        </el-tabs>
      </div>

      <div class="grid halves mt">
        <div class="card">
          <h3>如何确认已接通</h3>
          <ul class="small"><li v-for="item in data.guide.verify" :key="item">{{ fill(item) }}</li></ul>
        </div>
        <div class="card">
          <h3>常见问题</h3>
          <dl class="small trouble">
            <template v-for="item in data.guide.troubleshooting" :key="item.problem">
              <dt>{{ fill(item.problem) }}</dt>
              <dd class="muted">{{ fill(item.fix) }}</dd>
            </template>
          </dl>
        </div>
      </div>

      <div class="card small mt">
        <h3>边界与来源</h3>
        <p v-if="data.tool.unmanaged.length"><b>不经过 Saorsa 的能力：</b>{{ data.tool.unmanaged.join("；") }}</p>
        <p v-if="data.tool.limitations.length"><b>已知限制：</b>{{ data.tool.limitations.join("；") }}</p>
        <p>
          <b>官方文档</b>（{{ data.tool.docsCheckedAt }} 核对）：
          <template v-for="(source, index) in data.tool.sources" :key="source"><a :href="source" target="_blank" rel="noreferrer noopener">{{ source }}</a><span v-if="index < data.tool.sources.length - 1">、</span></template>
        </p>
      </div>
    </template>
    <div v-else v-loading="true" class="card" style="min-height: 200px" />
  </div>
</template>

<script setup lang="ts">
import { ElMessage } from "element-plus"
import { computed, defineComponent, h, onMounted, ref, watch, type PropType } from "vue"
import { useRoute } from "vue-router"
import { api, session, type ApiError } from "../api"
import Empty from "../components/Empty.vue"
import { formLabel, protocolLabel } from "../tools"

type Step = {
  title: string
  text?: string
  commands?: string[]
  env?: Record<string, string>
  file?: { path: string; language: string; content: string }
  fields?: Array<[string, string]>
  note?: string
  os?: "unix" | "windows"
}

const route = useRoute()
const data = ref<any>()
const error = ref("")
const projectID = ref("")
const model = ref("")
const method = ref("")
const os = ref<"unix" | "windows">(navigator.userAgent.includes("Windows") ? "windows" : "unix")
const key = ref("")
const creating = ref(false)
const origin = location.origin
const back = computed(() => (session.user?.accountType === "ADMIN" && !String(route.query.from ?? "").startsWith("me") ? "/admin/tools" : "/me/tools"))

const authorized = computed(() => (data.value?.projects ?? []).filter((project: any) => project.authorized))
const models = computed(() => authorized.value.find((project: any) => project.id === projectID.value)?.models ?? [])
const canIssueKey = computed(() => data.value && data.value.tool.id !== "opencode" && authorized.value.length && data.value.guide.methods.some((entry: any) => entry.needsKey))

watch(models, (list) => {
  if (!list.some((entry: any) => entry.alias === model.value)) model.value = list[0]?.alias ?? ""
})
watch(projectID, () => (key.value = ""))

function fill(value: string) {
  const project = authorized.value.find((entry: any) => entry.id === projectID.value)
  return value
    .replaceAll("{origin}", origin)
    .replaceAll("{model}", model.value || "<模型别名>")
    .replaceAll("{key}", key.value || "<你的 Saorsa Key>")
    .replaceAll("{project}", project?.code ?? "<项目组>")
}

/** Environment variables as the member's shell expects them. */
function envLines(env: Record<string, string>) {
  return Object.entries(env)
    .map(([name, value]) => (os.value === "windows" ? `$env:${name} = "${fill(value)}"` : `export ${name}="${fill(value)}"`))
    .join("\n")
}

async function copy(text: string) {
  await navigator.clipboard.writeText(text)
  ElMessage.success("已复制")
}

const codeBlock = (text: string, label?: string) =>
  h("div", { class: "code" }, [
    label ? h("div", { class: "codelabel muted small" }, label) : null,
    h("pre", { class: "notice mono" }, text),
    h("button", { class: "copy small", type: "button", onClick: () => copy(text), "aria-label": "复制" }, "复制"),
  ])

const GuideSteps = defineComponent({
  props: { steps: { type: Array as PropType<Step[]>, required: true } },
  setup: (props) => () =>
    h(
      "ol",
      { class: "steps" },
      props.steps.filter((step) => !step.os || step.os === os.value).map((step) =>
        h("li", [
          h("b", fill(step.title)),
          step.text ? h("p", { class: "small" }, fill(step.text)) : null,
          step.commands?.length ? codeBlock(step.commands.map(fill).join("\n")) : null,
          step.env ? codeBlock(envLines(step.env), os.value === "windows" ? "PowerShell（当前窗口有效）" : "终端（当前窗口有效）") : null,
          step.file ? codeBlock(fill(step.file.content), step.file.path) : null,
          step.fields
            ? h(
                "table",
                { class: "fields small" },
                h(
                  "tbody",
                  step.fields.map(([label, value]) =>
                    h("tr", [h("th", fill(label)), h("td", [h("code", fill(value)), h("button", { class: "copy small", type: "button", onClick: () => copy(fill(value)) }, "复制")])]),
                  ),
                ),
              )
            : null,
          step.note ? h("p", { class: "small warntext" }, fill(step.note)) : null,
        ]),
      ),
    ),
})

async function load() {
  error.value = ""
  try {
    data.value = await api.get(`/api/tools/${encodeURIComponent(String(route.params.id))}`, { quiet: true })
    projectID.value = authorized.value[0]?.id ?? ""
    method.value = data.value.guide.methods.find((entry: any) => entry.recommended)?.id ?? data.value.guide.methods[0]?.id ?? ""
  } catch (cause) {
    error.value = `加载失败：${(cause as ApiError).message}`
  }
}

async function createKey() {
  creating.value = true
  try {
    key.value = (await api.post("/api/me/tool-keys", { toolID: data.value.tool.id, projectID: projectID.value })).key
    ElMessage.success("已生成 Key，并填入下方步骤")
  } finally {
    creating.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.flags { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; }
.tag { font-size: 12px; padding: 3px 8px; border-radius: 6px; border: 1px solid var(--line); }
.tag.ok { color: var(--mint); border-color: var(--mint-line); background: var(--mint-soft); }
.tag.warn { color: var(--orange); border-color: color-mix(in srgb, var(--orange) 35%, transparent); }
.selectors .row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.selectors p { margin: 10px 0 0; }
.keyrow { margin-top: 12px; }
.warntext { color: var(--orange); }
.oktext { color: var(--mint); }
.tabtag { margin-left: 6px; }
.card :deep(.steps) { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 14px; }
.card :deep(.steps p) { margin: 4px 0 0; }
.card :deep(.code) { position: relative; margin-top: 6px; }
.card :deep(.code pre) { margin: 0; white-space: pre-wrap; word-break: break-all; padding-right: 64px; }
.card :deep(.codelabel) { margin-bottom: 4px; font-family: var(--el-font-family); }
.card :deep(.copy) { position: absolute; right: 8px; top: 8px; border: 1px solid var(--line); background: var(--raised); color: var(--muted); border-radius: 6px; padding: 2px 8px; cursor: pointer; }
.card :deep(.codelabel + pre + .copy) { top: 26px; }
.card :deep(.fields) { margin-top: 6px; border-collapse: collapse; width: 100%; }
.card :deep(.fields th) { text-align: left; font-weight: 500; color: var(--muted); padding: 6px 12px 6px 0; width: 38%; vertical-align: top; }
.card :deep(.fields td) { padding: 6px 0; position: relative; word-break: break-all; }
.card :deep(.fields td .copy) { position: static; margin-left: 8px; }
.trouble dt { font-weight: 600; margin-top: 8px; }
.trouble dd { margin: 2px 0 0; }
.card { overflow-wrap: anywhere; }
</style>
