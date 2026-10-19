<template>
  <div class="page">
    <div class="page-head">
      <div>
        <div class="eyebrow">{{ $route.meta.eyebrow }}</div>
        <h1>系统设置</h1>
        <p>企业策略、检测规则、员工告知、审计日志与网关状态。</p>
      </div>
    </div>
    <el-tabs v-model="tab">
      <el-tab-pane label="企业策略" name="org">
        <div class="card" v-if="settings">
          <el-form label-position="top" style="max-width: 760px">
            <div class="grid halves">
              <el-form-item label="组织名称"><el-input v-model="settings.name" /></el-form-item>
              <el-form-item label="时区"><el-input v-model="settings.timezone" /></el-form-item>
              <el-form-item label="成员请求频率（次/分钟）"><el-input-number v-model="settings.userRequestsPerMinute" :min="1" /></el-form-item>
              <el-form-item label="项目组请求频率（次/分钟）"><el-input-number v-model="settings.projectRequestsPerMinute" :min="1" /></el-form-item>
              <el-form-item label="成员并发上限"><el-input-number v-model="settings.userConcurrency" :min="1" /></el-form-item>
              <el-form-item label="成员每分钟 Token 上限（空 = 不限）"><el-input-number v-model="settings.userTokensPerMinute" :min="1000" :step="100000" /></el-form-item>
              <el-form-item label="项目组每分钟 Token 上限（空 = 不限）"><el-input-number v-model="settings.projectTokensPerMinute" :min="1000" :step="1000000" /></el-form-item>
              <el-form-item label="请求明细保留天数"><el-input-number v-model="settings.requestRetentionDays" :min="30" /></el-form-item>
              <el-form-item label="风险证据保留天数"><el-input-number v-model="settings.riskRetentionDays" :min="30" /></el-form-item>
              <el-form-item label="最低 OpenCode 版本（可选）">
                <el-input v-model="settings.minOpenCodeVersion" placeholder="例如 1.19.0，留空表示不限制" clearable style="max-width: 260px" @clear="settings.minOpenCodeVersion = null" />
                <span class="muted small" style="margin-left: 8px">低于该版本的客户端会被提示运行 opencode upgrade</span>
              </el-form-item>
              <el-form-item label="Key 分配方式">
                <el-radio-group v-model="settings.keyAssignment">
                  <el-radio-button value="exclusive">独占（先选先得）</el-radio-button>
                  <el-radio-button value="shared">共享</el-radio-button>
                </el-radio-group>
                <div class="muted small">独占：每个 Key 同一时间只给一位成员使用，n 个 Key 即 n 人同时工作；共享：所有成员共用全部 Key。</div>
              </el-form-item>
              <el-form-item label="独占 Key 空闲自动释放（分钟）">
                <el-input-number v-model="settings.keyLeaseIdleMinutes" :min="5" :max="1440" :disabled="settings.keyAssignment !== 'exclusive'" />
              </el-form-item>
              <el-form-item label="单设备登录">
                <el-switch v-model="settings.singleDeviceLogin" />
                <span class="muted small" style="margin-left: 8px">在新设备登录后，其他设备上的同一账号自动退出（网页与 OpenCode 分别计算）</span>
              </el-form-item>
              <el-form-item label="受管客户端仅允许企业模型">
                <el-switch v-model="settings.restrictToManagedProviders" />
                <span class="muted small" style="margin-left: 8px">向已连接 Saorsa 的 OpenCode 下发“禁用其他供应商”策略</span>
              </el-form-item>
            </div>
            <el-form-item label="对话全文保留">
              <el-tag type="success">已关闭（默认最小化采集，仅保存脱敏证据片段）</el-tag>
            </el-form-item>
            <el-form-item label="员工使用告知（修改后版本号 +1，成员连接客户端前需重新确认）">
              <el-input v-model="settings.noticeText" type="textarea" :rows="10" />
              <div class="muted small">当前版本 v{{ settings.noticeVersion }}</div>
            </el-form-item>
            <el-button type="primary" @click="saveSettings">保存</el-button>
          </el-form>
        </div>
      </el-tab-pane>
      <el-tab-pane label="检测规则" name="rules">
        <div class="card">
          <el-table :data="policies">
            <el-table-column label="规则" width="190"><template #default="{ row }"><b>{{ ruleLabel[row.rule_type] ?? row.rule_type }}</b><div class="mono muted">{{ row.rule_type }}</div></template></el-table-column>
            <el-table-column label="启用" width="80"><template #default="{ row }"><el-switch v-model="row.enabled" /></template></el-table-column>
            <el-table-column label="动作" width="150">
              <template #default="{ row }">
                <el-select v-model="row.action" size="small" :disabled="row.rule_type !== 'secret_leak'">
                  <el-option label="标记待复核" value="flag" />
                  <el-option label="直接阻断" value="block" />
                </el-select>
              </template>
            </el-table-column>
            <el-table-column label="配置（JSON）" min-width="300"><template #default="{ row }"><el-input v-model="row.configText" type="textarea" :rows="2" class="mono" /></template></el-table-column>
            <el-table-column width="90"><template #default="{ row }"><el-button size="small" @click="savePolicy(row)">保存</el-button></template></el-table-column>
          </el-table>
          <div class="banner mt">
            只有确定性的敏感凭据规则可以设置为阻断。“项目相关性”默认关闭；关键词模式只产生信息提示；若启用 audit_model 模式（脱敏后的提示词会发送给 model_alias 指定的、已在“模型与 Key”中纳管的 OpenAI 兼容模型），必须设置 allow_audit_model=true，并先更新员工告知说明数据外发范围，推荐把本地部署的分类模型注册为供应商后使用。
          </div>
        </div>
      </el-tab-pane>
      <el-tab-pane label="审计日志" name="audit">
        <div class="card">
          <div class="row" style="margin-bottom: 12px">
            <el-input v-model="auditAction" placeholder="按动作前缀筛选，如 user. / risk. / auth." clearable style="width: 300px" @change="loadAudit" />
          </div>
          <el-table :data="audit.items" size="small">
            <el-table-column label="时间" width="160"><template #default="{ row }">{{ time(row.created_at) }}</template></el-table-column>
            <el-table-column label="操作者" width="140"><template #default="{ row }">{{ row.actor_username ?? row.actor_type }}</template></el-table-column>
            <el-table-column label="动作" prop="action" width="200" />
            <el-table-column label="对象" width="200"><template #default="{ row }"><span class="mono">{{ row.target_type }} {{ row.target_id?.slice(0, 8) }}</span></template></el-table-column>
            <el-table-column label="详情（已脱敏）"><template #default="{ row }"><span class="mono small">{{ JSON.stringify(row.metadata_redacted) }}</span></template></el-table-column>
            <el-table-column label="IP" prop="ip" width="120" />
          </el-table>
          <el-pagination class="mt" layout="total, prev, pager, next" :total="audit.total" :page-size="50" v-model:current-page="auditPage" @change="loadAudit" />
        </div>
      </el-tab-pane>
      <el-tab-pane label="网关状态" name="system">
        <div class="card" v-if="system">
          <el-descriptions :column="1" border>
            <el-descriptions-item label="数据库"><el-tag type="success" size="small">正常</el-tag> <span class="muted small">{{ system.database.version.split(" on ")[0] }}</span></el-descriptions-item>
            <el-descriptions-item label="Redis"><el-tag :type="system.redis.ok ? 'success' : 'danger'" size="small">{{ system.redis.ok ? "正常" : system.redis.detail }}</el-tag></el-descriptions-item>
            <el-descriptions-item label="网关地址"><span class="mono">{{ system.gatewayURL }}</span></el-descriptions-item>
            <el-descriptions-item label="进行中请求">{{ system.inFlightRequests }}</el-descriptions-item>
            <el-descriptions-item label="近 1 小时限流拒绝">
              <span v-for="(count, reason) in system.rateLimitRejectionsLastHour" :key="reason" class="reject">{{ rejectLabel[reason] ?? reason }} {{ count }}</span>
            </el-descriptions-item>
            <el-descriptions-item label="上游超时">响应头 {{ system.limits.upstreamHeaderTimeoutSeconds }}s · 流空闲 {{ system.limits.upstreamIdleTimeoutSeconds }}s</el-descriptions-item>
            <el-descriptions-item label="监控覆盖范围">{{ system.coverage }}</el-descriptions-item>
          </el-descriptions>
          <h4>供应商健康</h4>
          <el-table :data="system.providers" size="small">
            <el-table-column label="供应商" prop="name" />
            <el-table-column label="协议" prop="protocol" />
            <el-table-column label="状态" prop="health_status" />
            <el-table-column label="信息" prop="health_message" />
            <el-table-column label="检查时间"><template #default="{ row }">{{ time(row.health_checked_at) }}</template></el-table-column>
          </el-table>
          <h4>OpenCode 客户端接入</h4>
          <pre class="notice mono"># 成员使用官方 OpenCode（自行通过 opencode upgrade / brew / npm 更新）
opencode auth login {{ origin }}</pre>
          <p class="muted small">模型、价格、授权与限制都由 Saorsa 在 OpenCode 每次启动时下发，升级 Saorsa 后无需更新客户端。</p>
        </div>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup lang="ts">
import { ElMessage } from "element-plus"
import { onMounted, ref, watch } from "vue"
import { api, query, session } from "../../api"
import { time } from "../../format"

const tab = ref("org")
const settings = ref<any>()
const policies = ref<any[]>([])
const audit = ref<{ total: number; items: any[] }>({ total: 0, items: [] })
const auditAction = ref("")
const auditPage = ref(1)
const system = ref<any>()
const origin = location.origin
const rejectLabel: Record<string, string> = {
  requests_per_minute: "请求频率",
  tokens_per_minute: "Token 频率",
  concurrency_limited: "成员/项目并发",
  model_busy: "模型并发",
  provider_busy: "供应商并发",
}
const ruleLabel: Record<string, string> = {
  secret_leak: "敏感凭据泄露",
  project_relevance: "项目相关性提示",
  request_burst: "短时高频请求",
  cost_spike: "费用突增",
  project_switching: "频繁切换计费项目",
}

async function loadSettings() {
  settings.value = (await api.get("/api/admin/settings")).settings
}

async function saveSettings() {
  const { noticeVersion: _version, retainFullContent: _retain, ...body } = settings.value
  settings.value = (await api.patch("/api/admin/settings", { ...body, minOpenCodeVersion: body.minOpenCodeVersion?.trim() || null })).settings
  session.organization = settings.value.name
  ElMessage.success("已保存")
}

async function loadPolicies() {
  policies.value = (await api.get("/api/admin/policies")).policies.map((policy: any) => ({ ...policy, configText: JSON.stringify(policy.config) }))
}

async function savePolicy(row: any) {
  let config: unknown
  try {
    config = JSON.parse(row.configText)
  } catch {
    return ElMessage.error("配置不是有效 JSON")
  }
  await api.patch(`/api/admin/policies/${row.rule_type}`, { enabled: row.enabled, action: row.action, config })
  ElMessage.success("规则已保存")
  await loadPolicies()
}

async function loadAudit() {
  audit.value = await api.get(`/api/admin/audit-logs${query({ action: auditAction.value, limit: 50, offset: (auditPage.value - 1) * 50 })}`)
}

watch(tab, async (value) => {
  if (value === "rules") await loadPolicies()
  if (value === "audit") await loadAudit()
  if (value === "system") system.value = await api.get("/api/admin/system")
})

onMounted(loadSettings)
</script>

<style scoped>
h4 { margin: 18px 0 8px; }
pre { margin: 0; }
.reject { margin-right: 14px; }
</style>
