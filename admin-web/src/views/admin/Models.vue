<template>
  <div class="page">
    <div class="page-head">
      <div>
        <div class="eyebrow">{{ $route.meta.eyebrow }}</div>
        <h1>模型与密钥</h1>
        <p>供应商 API Key 使用 AES-256-GCM 加密存储，主密钥不在数据库中；界面只显示遮罩，永不回显完整 Key。</p>
      </div>
      <div class="row">
        <el-button @click="providerOpen = true">添加供应商</el-button>
        <el-button type="primary" :disabled="!providers.length" @click="openModel">添加模型</el-button>
      </div>
    </div>
    <div class="grid" style="grid-template-columns: repeat(auto-fill, minmax(420px, 1fr))">
      <div v-for="provider in providers" :key="provider.id" class="card">
        <h3>
          <span>
            {{ provider.name }}
            <el-tag v-for="protocol in [provider.protocol, ...(provider.extra_protocols ?? [])]" :key="protocol" size="small" effect="plain" style="margin-left: 4px">{{ protocolLabel[protocol] }}</el-tag>
          </span>
          <span class="row">
            <el-tag :type="healthType(provider.health_status)" size="small">{{ healthLabel[provider.health_status] }}</el-tag>
            <el-switch :model-value="provider.enabled" size="small" @change="(value: any) => patchProvider(provider.id, { enabled: value })" />
          </span>
        </h3>
        <div class="muted small mono">{{ provider.base_url }}</div>
        <div class="row small muted">
          并发上限
          <el-input-number :model-value="provider.concurrency_limit ?? undefined" size="small" :min="1" controls-position="right" placeholder="不限" style="width: 110px"
            @change="(value: any) => patchProvider(provider.id, { concurrencyLimit: value ?? null })" />
          每分钟请求
          <el-input-number :model-value="provider.requests_per_minute ?? undefined" size="small" :min="1" controls-position="right" placeholder="不限" style="width: 120px"
            @change="(value: any) => patchProvider(provider.id, { requestsPerMinute: value ?? null })" />
        </div>
        <div class="muted small" v-if="provider.health_message">{{ provider.health_message }} · {{ time(provider.health_checked_at) }}</div>
        <el-table :data="provider.credentials" size="small" class="mt">
          <el-table-column label="Key" min-width="150">
            <template #default="{ row }"><div>{{ row.label }}</div><div class="mono muted">{{ row.masked }}</div></template>
          </el-table-column>
          <el-table-column label="状态" width="120">
            <template #default="{ row }">
              <el-tag size="small" :type="row.status === 'active' ? (row.cooldown_until && new Date(row.cooldown_until) > new Date() ? 'warning' : 'success') : row.status === 'revoked' ? 'danger' : 'info'">
                {{ row.status === "active" ? (row.cooldown_until && new Date(row.cooldown_until) > new Date() ? "冷却中" : "启用") : row.status === "revoked" ? "已撤销" : "停用" }}
              </el-tag>
              <el-tooltip v-if="row.last_error" :content="row.last_error"><el-icon class="warn"><Warning /></el-icon></el-tooltip>
            </template>
          </el-table-column>
          <el-table-column label="最后使用" width="120"><template #default="{ row }">{{ time(row.last_used_at) }}</template></el-table-column>
          <el-table-column label="占用成员" min-width="130">
            <template #default="{ row }">
              <template v-if="row.lease">
                <div>{{ row.lease.display_name }}</div>
                <div class="muted small">{{ time(row.lease.last_used_at) }}使用</div>
              </template>
              <span v-else-if="row.status === 'active'" class="muted">空闲</span>
            </template>
          </el-table-column>
          <el-table-column width="130" align="right">
            <template #default="{ row }">
              <el-dropdown v-if="row.status !== 'revoked'" trigger="click" @command="(command: string) => credentialAction(row, command)">
                <el-button link size="small">操作</el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item v-if="row.lease" command="release">释放占用</el-dropdown-item>
                    <el-dropdown-item command="rotate">轮换 Key</el-dropdown-item>
                    <el-dropdown-item :command="row.status === 'active' ? 'disable' : 'enable'">{{ row.status === "active" ? "停用" : "启用" }}</el-dropdown-item>
                    <el-dropdown-item command="revoke" divided>撤销并销毁</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </template>
          </el-table-column>
        </el-table>
        <div class="row mt">
          <el-button size="small" @click="openKey(provider)">添加 Key</el-button>
          <el-button size="small" @click="health(provider)">健康检查</el-button>
        </div>
      </div>
      <div v-if="!providers.length" class="card"><empty text="尚未添加模型供应商" /></div>
    </div>

    <div class="card mt">
      <h3>模型目录与计价</h3>
      <el-table :data="models">
        <el-table-column label="别名（客户端可见）" min-width="150"><template #default="{ row }"><b>{{ row.alias }}</b><div class="muted small">{{ row.display_name }}</div></template></el-table-column>
        <el-table-column label="供应商 / 上游模型" min-width="180"><template #default="{ row }">{{ row.provider_name }}<div class="mono muted">{{ row.upstream_model }}</div></template></el-table-column>
        <el-table-column label="输入 / 输出 (每百万)" min-width="150"><template #default="{ row }">{{ price(row.input_per_mtok_micros, row.currency) }} / {{ price(row.output_per_mtok_micros, row.currency) }}</template></el-table-column>
        <el-table-column label="缓存读 (每百万)" width="120"><template #default="{ row }">{{ price(row.cache_read_per_mtok_micros, row.currency) }}</template></el-table-column>
        <el-table-column label="价格生效" width="120"><template #default="{ row }">{{ row.effective_from ? date(row.effective_from) : "未定价" }}</template></el-table-column>
        <el-table-column label="上下文 / 输出上限" width="140"><template #default="{ row }">{{ row.context_limit ?? "—" }} / {{ row.output_limit ?? "—" }}</template></el-table-column>
        <el-table-column label="并发 / RPM / TPM 上限" width="180">
          <template #default="{ row }">
            <el-button link size="small" @click="openLimits(row)">{{ row.concurrency_limit ?? "∞" }} / {{ row.requests_per_minute ?? "∞" }} / {{ row.tokens_per_minute ?? "∞" }}</el-button>
          </template>
        </el-table-column>
        <el-table-column label="能力 / 工具" min-width="170">
          <template #default="{ row }">
            <div class="small">{{ capabilities(row) }}</div>
            <el-select :model-value="row.allowed_tools ?? []" multiple collapse-tags size="small" placeholder="全部工具" style="width: 100%" :aria-label="`${row.alias} 允许的工具`"
              @change="(value: string[]) => patchModel(row.id, { allowedTools: value.length ? value : null })">
              <el-option v-for="tool in toolCatalog" :key="tool.id" :label="tool.name" :value="tool.id" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="授权项目" prop="project_count" width="90" align="right" />
        <el-table-column label="启用" width="70"><template #default="{ row }"><el-switch :model-value="row.enabled" size="small" @change="(value: any) => patchModel(row.id, { enabled: value })" /></template></el-table-column>
        <el-table-column width="90" align="right"><template #default="{ row }"><el-button link size="small" @click="openPrice(row)">调价</el-button></template></el-table-column>
        <template #empty><empty text="尚未添加模型" /></template>
      </el-table>
      <p class="muted small">价格为追加式版本：每次请求冻结其发生时生效的价格版本，历史报表不会因调价而改变。</p>
    </div>

    <el-dialog v-model="providerOpen" title="添加供应商" width="520px">
      <el-form label-position="top">
        <el-form-item label="名称"><el-input v-model="providerForm.name" placeholder="例如 DeepSeek 官方" /></el-form-item>
        <el-form-item label="协议">
          <el-select v-model="providerForm.protocol" style="width: 100%">
            <el-option label="OpenAI Chat Completions 兼容" value="openai-chat" />
            <el-option label="Anthropic Messages（Claude 原生协议）" value="anthropic-messages" />
            <el-option label="OpenAI Responses（Codex CLI 需要）" value="openai-responses" />
            <el-option label="Gemini 原生 API（Gemini CLI 需要）" value="gemini" />
          </el-select>
        </el-form-item>
        <el-form-item label="同一 Base URL 还支持的协议（可选）">
          <el-select v-model="providerForm.extraProtocols" multiple style="width: 100%" placeholder="例如 OpenAI 同时支持 Chat 与 Responses">
            <el-option v-for="(label, value) in protocolLabel" :key="value" :label="label" :value="value" :disabled="value === providerForm.protocol" />
          </el-select>
        </el-form-item>
        <el-form-item label="Base URL（必须为 HTTPS 且在允许列表中）">
          <el-input v-model="providerForm.baseURL" :placeholder="baseURLExample[providerForm.protocol]" />
        </el-form-item>
        <p class="muted small">
          网关按原协议透传，不做协议互转：Codex CLI 只能使用支持 Responses 的供应商，Gemini CLI 只能使用 Gemini 原生 API。OpenAI 兼容模型在 OpenCode 中显示于 “Saorsa” 供应商下，Anthropic 协议模型显示于 “Saorsa Claude” 下。
        </p>
      </el-form>
      <template #footer><el-button @click="providerOpen = false">取消</el-button><el-button type="primary" @click="createProvider">添加</el-button></template>
    </el-dialog>

    <el-dialog v-model="keyOpen" :title="keyTitle" width="480px">
      <el-form label-position="top">
        <el-form-item v-if="!keyForm.credentialID" label="标签"><el-input v-model="keyForm.label" /></el-form-item>
        <el-form-item label="API Key"><el-input v-model="keyForm.apiKey" type="password" show-password autocomplete="off" /></el-form-item>
        <el-form-item v-if="!keyForm.credentialID" label="优先级（数字越小越优先）"><el-input-number v-model="keyForm.priority" :min="0" :max="1000" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="keyOpen = false">取消</el-button><el-button type="primary" @click="saveKey">保存</el-button></template>
    </el-dialog>

    <el-dialog v-model="modelOpen" title="添加模型" width="620px">
      <el-form label-position="top">
        <div class="grid halves">
          <el-form-item label="供应商">
            <el-select v-model="modelForm.providerID" style="width: 100%"><el-option v-for="provider in providers" :key="provider.id" :label="provider.name" :value="provider.id" /></el-select>
          </el-form-item>
          <el-form-item label="上游模型 ID"><el-input v-model="modelForm.upstreamModel" placeholder="deepseek-chat" /></el-form-item>
          <el-form-item label="别名（成员在 OpenCode 中看到的 ID）"><el-input v-model="modelForm.alias" /></el-form-item>
          <el-form-item label="显示名称"><el-input v-model="modelForm.displayName" /></el-form-item>
          <el-form-item label="上下文上限"><el-input-number v-model="modelForm.contextLimit" :min="1" controls-position="right" style="width: 100%" /></el-form-item>
          <el-form-item label="输出上限"><el-input-number v-model="modelForm.outputLimit" :min="1" controls-position="right" style="width: 100%" /></el-form-item>
          <el-form-item label="默认最大输出（未指定时网关强制）"><el-input-number v-model="modelForm.defaultMaxOutput" :min="1" controls-position="right" style="width: 100%" /></el-form-item>
          <el-form-item label="能力（只勾选供应商确认支持的）">
            <el-checkbox v-model="modelForm.supportsTools">工具调用</el-checkbox>
            <el-checkbox v-model="modelForm.supportsStreaming">流式</el-checkbox>
            <el-checkbox v-model="modelForm.supportsVision">图片输入</el-checkbox>
            <el-checkbox v-model="modelForm.supportsStructuredOutput">结构化输出</el-checkbox>
            <el-checkbox v-model="modelForm.supportsReasoning">推理</el-checkbox>
          </el-form-item>
          <el-form-item label="允许的工具（留空 = 项目组授权的全部工具）">
            <el-select v-model="modelForm.allowedTools" multiple clearable style="width: 100%">
              <el-option v-for="tool in toolCatalog" :key="tool.id" :label="tool.name" :value="tool.id" />
            </el-select>
          </el-form-item>
        </div>
        <price-fields v-model="modelForm.price" />
      </el-form>
      <template #footer><el-button @click="modelOpen = false">取消</el-button><el-button type="primary" @click="createModel">添加</el-button></template>
    </el-dialog>

    <el-dialog v-model="limitsOpen" title="模型限流（留空 = 不限）" width="440px">
      <el-form label-position="top">
        <el-form-item label="全企业并发上限"><el-input-number v-model="limits.concurrencyLimit" :min="1" controls-position="right" style="width: 100%" /></el-form-item>
        <el-form-item label="每分钟请求上限"><el-input-number v-model="limits.requestsPerMinute" :min="1" controls-position="right" style="width: 100%" /></el-form-item>
        <el-form-item label="每分钟 Token 上限"><el-input-number v-model="limits.tokensPerMinute" :min="1000" :step="10000" controls-position="right" style="width: 100%" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="limitsOpen = false">取消</el-button><el-button type="primary" @click="saveLimits">保存</el-button></template>
    </el-dialog>

    <el-dialog v-model="priceOpen" title="追加价格版本" width="520px">
      <price-fields v-model="priceForm" />
      <template #footer><el-button @click="priceOpen = false">取消</el-button><el-button type="primary" @click="savePrice">保存</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { Warning } from "@element-plus/icons-vue"
import { ElMessage, ElMessageBox } from "element-plus"
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue"
import { api, subscribe } from "../../api"
import { date, money, time } from "../../format"
import { protocolLabel } from "../../tools"
import Empty from "../../components/Empty.vue"
import PriceFields from "./PriceFields.vue"

const providers = ref<any[]>([])
const models = ref<any[]>([])
const providerOpen = ref(false)
const keyOpen = ref(false)
const modelOpen = ref(false)
const priceOpen = ref(false)
const providerForm = reactive({ name: "", protocol: "openai-chat", baseURL: "", extraProtocols: [] as string[] })
const baseURLExample: Record<string, string> = {
  "openai-chat": "https://api.deepseek.com/v1",
  "anthropic-messages": "https://api.anthropic.com/v1",
  "openai-responses": "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
}
const toolCatalog = ref<Array<{ id: string; name: string }>>([])
const capabilities = (row: any) =>
  [row.supports_tools && "工具", row.supports_streaming && "流式", row.supports_vision && "图片", row.supports_structured_output && "结构化", row.supports_reasoning && "推理"]
    .filter(Boolean)
    .join(" · ") || "仅文本"
const keyForm = reactive({ providerID: "", credentialID: "", label: "primary", apiKey: "", priority: 100 })
const emptyPrice = () => ({ currency: "USD", input: "0", output: "0", cacheRead: "0", cacheWrite: "0", source: "供应商官网价格" })
const modelForm = reactive({
  providerID: "",
  upstreamModel: "",
  alias: "",
  displayName: "",
  contextLimit: 128000 as number | undefined,
  outputLimit: 8192 as number | undefined,
  defaultMaxOutput: 4096,
  supportsTools: true,
  supportsReasoning: false,
  supportsStreaming: true,
  supportsVision: false,
  supportsStructuredOutput: false,
  allowedTools: [] as string[],
  price: emptyPrice(),
})
const priceForm = ref(emptyPrice())
const priceModelID = ref("")
const limitsOpen = ref(false)
const limitsModelID = ref("")
const limits = reactive({ concurrencyLimit: undefined as number | undefined, requestsPerMinute: undefined as number | undefined, tokensPerMinute: undefined as number | undefined })
const keyTitle = computed(() => (keyForm.credentialID ? "轮换 Key" : "添加 Key"))
const healthLabel: Record<string, string> = { unknown: "未检查", healthy: "健康", degraded: "降级", down: "不可用" }
const healthType = (status: string) => (status === "healthy" ? "success" : status === "degraded" ? "warning" : status === "down" ? "danger" : "info")
const price = (micros: string | null, currency: string) => (micros === null || micros === undefined ? "—" : money(micros, currency))

async function load() {
  const [providerList, modelList, tools] = await Promise.all([api.get("/api/admin/providers"), api.get("/api/admin/models"), api.get("/api/admin/tools")])
  providers.value = providerList.providers
  models.value = modelList.models
  toolCatalog.value = tools.tools
}

async function createProvider() {
  await api.post("/api/admin/providers", providerForm)
  providerOpen.value = false
  Object.assign(providerForm, { name: "", baseURL: "", extraProtocols: [] })
  await load()
}

async function patchProvider(id: string, body: Record<string, unknown>) {
  await api.patch(`/api/admin/providers/${id}`, body)
  await load()
}

function openKey(provider: any) {
  Object.assign(keyForm, { providerID: provider.id, credentialID: "", label: "primary", apiKey: "", priority: 100 })
  keyOpen.value = true
}

async function saveKey() {
  if (keyForm.credentialID) await api.post(`/api/admin/credentials/${keyForm.credentialID}/rotate`, { apiKey: keyForm.apiKey })
  else await api.post(`/api/admin/providers/${keyForm.providerID}/credentials`, { label: keyForm.label, apiKey: keyForm.apiKey, priority: keyForm.priority })
  keyForm.apiKey = ""
  keyOpen.value = false
  ElMessage.success("Key 已加密保存")
  await load()
}

async function credentialAction(credential: any, command: string) {
  if (command === "rotate") {
    Object.assign(keyForm, { credentialID: credential.id, apiKey: "" })
    keyOpen.value = true
    return
  }
  if (command === "release") {
    await ElMessageBox.confirm(`释放后 ${credential.lease.display_name} 下一次调用会重新分配空闲 Key。确定？`, "释放 Key", { type: "warning" })
    await api.del(`/api/admin/key-leases/${credential.id}`)
  } else if (command === "revoke") {
    await ElMessageBox.confirm("撤销将销毁加密密文，无法恢复。确定？", "撤销 Key", { type: "warning" })
    await api.post(`/api/admin/credentials/${credential.id}/revoke`)
  } else await api.patch(`/api/admin/credentials/${credential.id}`, { status: command === "enable" ? "active" : "disabled" })
  await load()
}

async function health(provider: any) {
  const result = await api.post(`/api/admin/providers/${provider.id}/health`)
  ElMessage({ type: result.status === "healthy" ? "success" : "warning", message: `${provider.name}: ${result.message}` })
  await load()
}

function openModel() {
  Object.assign(modelForm, { providerID: providers.value[0]?.id ?? "", upstreamModel: "", alias: "", displayName: "", price: emptyPrice() })
  modelOpen.value = true
}

async function createModel() {
  await api.post("/api/admin/models", {
    ...modelForm,
    contextLimit: modelForm.contextLimit ?? null,
    outputLimit: modelForm.outputLimit ?? null,
    allowedTools: modelForm.allowedTools.length ? modelForm.allowedTools : null,
  })
  modelOpen.value = false
  ElMessage.success("模型已添加，请到项目组中授权")
  await load()
}

async function patchModel(id: string, body: Record<string, unknown>) {
  await api.patch(`/api/admin/models/${id}`, body)
  await load()
}

function openLimits(model: any) {
  limitsModelID.value = model.id
  Object.assign(limits, {
    concurrencyLimit: model.concurrency_limit ?? undefined,
    requestsPerMinute: model.requests_per_minute ?? undefined,
    tokensPerMinute: model.tokens_per_minute ?? undefined,
  })
  limitsOpen.value = true
}

async function saveLimits() {
  await patchModel(limitsModelID.value, {
    concurrencyLimit: limits.concurrencyLimit ?? null,
    requestsPerMinute: limits.requestsPerMinute ?? null,
    tokensPerMinute: limits.tokensPerMinute ?? null,
  })
  limitsOpen.value = false
}

function openPrice(model: any) {
  priceModelID.value = model.id
  priceForm.value = emptyPrice()
  priceForm.value.currency = model.currency ?? "USD"
  priceOpen.value = true
}

async function savePrice() {
  await api.post(`/api/admin/models/${priceModelID.value}/prices`, priceForm.value)
  priceOpen.value = false
  await load()
}

// Key holders change as members claim and release keys.
let stop: (() => void) | undefined
onMounted(() => {
  void load()
  stop = subscribe("/api/admin/events", (type) => {
    if (type === "key.lease") void load()
  })
})
onBeforeUnmount(() => stop?.())
</script>

<style scoped>
.warn { color: var(--tos-warn); margin-left: 4px; vertical-align: middle; }
</style>
