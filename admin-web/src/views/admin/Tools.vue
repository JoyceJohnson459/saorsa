<template>
  <div class="page">
    <div class="page-head">
      <div>
        <div class="eyebrow">{{ $route.meta.eyebrow }}</div>
        <h1>工具中心</h1>
        <p>固定支持 12 款 AI 编程工具。状态只来自证据：成员 Launcher 的安装上报、网关里的真实请求与精确计费；“出现在列表中”不等于“已完成接入”。</p>
      </div>
    </div>
    <el-tabs v-model="tab">
      <el-tab-pane label="工具与接入状态" name="tools">
        <div v-if="error" class="card"><empty :text="error" /><el-button @click="load">重试</el-button></div>
        <div v-else v-loading="!tools.length" class="toolgrid">
          <div v-for="tool in tools" :key="tool.id" class="card tool">
            <div class="head">
              <div>
                <h3><router-link :to="`/tools/${tool.id}`">{{ tool.name }}</router-link></h3>
                <div class="muted small">{{ tool.vendor }} · {{ tool.forms.map((form: string) => formLabel[form]).join(" / ") }}</div>
              </div>
              <span class="muted small">{{ tool.projects }} 个项目组已授权</span>
            </div>
            <div class="flags">
              <flag :on="tool.status.available" label="已安装（Launcher 上报）" :detail="tool.evidence.installedDevices ? `${tool.evidence.installedDevices} 台设备` : '暂无上报'" />
              <flag :on="tool.status.gatewayCompatible" label="网关可用" :detail="tool.evidence.succeeded ? `${tool.evidence.succeeded} 次成功请求` : '暂无请求'" />
              <flag :on="tool.status.usageVerified" label="用量已核实" :detail="tool.evidence.exact ? `${tool.evidence.exact} 次精确计费` : '暂无'" />
              <flag v-if="tool.status.partiallyManaged" warn on label="部分托管" detail="部分能力不经网关" />
              <flag v-if="tool.status.officialAccountRequired" warn on label="需官方账户" :detail="tool.officialAccount" />
            </div>
            <div class="meta small">
              <div><span class="muted">协议</span> {{ tool.routes.map((route: any) => protocolLabel[route.protocol]).join("、") }}</div>
              <div><span class="muted">凭据</span> {{ deliveryLabel[tool.delivery] }}</div>
              <div v-if="tool.evidence.lastVersion"><span class="muted">最近版本</span> {{ tool.evidence.lastVersion }}</div>
            </div>
            <div v-if="tool.lab" class="lab small">
              <b>实验室验证</b> {{ tool.lab.version }} · {{ tool.lab.platform }} · {{ tool.lab.date }} ·
              <span class="warntext">mock 上游（非真实模型）</span>
              <div class="muted">{{ tool.lab.notes }}</div>
            </div>
            <div v-else class="lab small muted"><b>实验室验证</b> 未在本仓库测试中验证</div>
            <router-link :to="`/tools/${tool.id}`" class="guide-link">查看成员看到的详细连接方式 →</router-link>
            <details>
              <summary class="small">边界、限制与官方来源</summary>
              <div class="small">
                <p v-if="tool.unmanaged.length"><b>不经网关的能力</b></p>
                <ul><li v-for="item in tool.unmanaged" :key="item">{{ item }}</li></ul>
                <p v-if="tool.limitations.length"><b>已知限制</b></p>
                <ul><li v-for="item in tool.limitations" :key="item">{{ item }}</li></ul>
                <p><b>官方来源</b>（{{ tool.docsCheckedAt }} 核对）</p>
                <ul><li v-for="source in tool.sources" :key="source"><a :href="source" target="_blank" rel="noreferrer noopener">{{ source }}</a></li></ul>
              </div>
            </details>
          </div>
        </div>
      </el-tab-pane>
      <el-tab-pane label="Launcher 安装状态" name="installs">
        <div class="card">
          <el-table :data="installations" size="small">
            <el-table-column label="成员" min-width="120"><template #default="{ row }">{{ row.display_name }}<div class="muted small">{{ row.username }}</div></template></el-table-column>
            <el-table-column label="设备" min-width="140"><template #default="{ row }">{{ row.device_label ?? row.device_id }}<div class="muted small">{{ row.os }} · {{ row.arch }}</div></template></el-table-column>
            <el-table-column label="工具" min-width="120"><template #default="{ row }">{{ toolName(row.tool_id) }}</template></el-table-column>
            <el-table-column label="状态" width="120">
              <template #default="{ row }"><el-tag size="small" :type="row.installed ? 'success' : 'info'">{{ row.installed ? "已安装" : "未安装" }}</el-tag></template>
            </el-table-column>
            <el-table-column label="版本" prop="version" width="110" />
            <el-table-column label="已配置" width="80"><template #default="{ row }">{{ row.configured ? "是" : "否" }}</template></el-table-column>
            <el-table-column label="最近错误" min-width="160"><template #default="{ row }"><span class="muted small">{{ row.last_error ?? "" }}</span></template></el-table-column>
            <el-table-column label="上报时间" width="150"><template #default="{ row }">{{ time(row.reported_at) }}</template></el-table-column>
            <template #empty><empty text="还没有成员的 Launcher 上报过安装状态" /></template>
          </el-table>
          <p class="muted small">由成员本机的 Saorsa Launcher 检测后上报，反映该设备的检测结果，不是服务端担保。</p>
        </div>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup lang="ts">
import { defineComponent, h, onMounted, ref } from "vue"
import { api, type ApiError } from "../../api"
import { time } from "../../format"
import Empty from "../../components/Empty.vue"
import { deliveryLabel, formLabel, protocolLabel } from "../../tools"

const tab = ref("tools")
const tools = ref<any[]>([])
const installations = ref<any[]>([])
const error = ref("")
const toolName = (id: string) => tools.value.find((tool) => tool.id === id)?.name ?? id

const Flag = defineComponent({
  props: { on: Boolean, warn: Boolean, label: String, detail: String },
  setup: (props) => () =>
    h("div", { class: ["flag", props.on ? (props.warn ? "warn" : "on") : "off"] }, [
      h("span", { class: "dot", "aria-hidden": "true" }),
      h("span", [props.label, h("small", props.detail ?? "")]),
    ]),
})

async function load() {
  error.value = ""
  try {
    const [catalog, installs] = await Promise.all([api.get("/api/admin/tools", { quiet: true }), api.get("/api/admin/installations", { quiet: true })])
    tools.value = catalog.tools
    installations.value = installs.installations
  } catch (cause) {
    error.value = `加载失败：${(cause as ApiError).message}`
  }
}

onMounted(load)
</script>

<style scoped>
.toolgrid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(min(340px, 100%), 1fr)); }
.tool { display: flex; flex-direction: column; gap: 12px; min-width: 0; overflow-wrap: anywhere; }
.tool .head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
.tool .head > div { min-width: 0; }
.tool .head > :last-child { flex: none; }
.tool h3 { margin: 0 0 4px; }
.flags { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.flags :deep(.flag) { display: flex; gap: 8px; align-items: flex-start; font-size: 12px; line-height: 1.4; }
.flags :deep(.flag small) { display: block; color: var(--muted); }
.flags :deep(.dot) { width: 8px; height: 8px; border-radius: 50%; margin-top: 4px; flex: 0 0 auto; background: var(--line); }
.flags :deep(.on .dot) { background: var(--mint); }
.flags :deep(.warn .dot) { background: var(--orange); }
.flags :deep(.off) { color: var(--muted); }
.meta { display: flex; flex-wrap: wrap; gap: 6px 16px; }
.lab { border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; background: var(--raised); }
.warntext { color: var(--orange); }
details summary { cursor: pointer; color: var(--muted); }
.tool h3 a { color: var(--text); }
.guide-link { font-size: 13px; font-weight: 600; }
details ul { margin: 4px 0 8px; padding-left: 18px; }
details p { margin: 8px 0 0; }
@media (max-width: 520px) { .flags { grid-template-columns: 1fr; } }
</style>
