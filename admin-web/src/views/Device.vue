<template>
  <auth-layout eyebrow="CONNECT DEVICE / 设备授权" :title="done ? '已授权' : denied ? '已拒绝' : launcher ? '连接 Saorsa Launcher' : '连接 OpenCode 客户端'" :intro="intro" :width="520">
    <template v-if="done">
      <div class="result ok">
        <icon name="check" :size="20" :stroke="2" />
        <div>{{ launcher ? "Saorsa Launcher 已登录，默认计费项目组" : "OpenCode 将以项目组" }} <b>{{ chosenLabel }}</b>{{ launcher ? "" : " 计费" }}。可以回到终端继续使用。</div>
      </div>
    </template>
    <template v-else-if="denied">
      <div class="result warn">
        <icon name="shield-alert" :size="20" />
        <div>如果这不是你发起的登录，请修改密码并在“个人设置”中检查设备会话。</div>
      </div>
    </template>
    <template v-else>
      <label class="fieldlabel" for="code">终端中显示的验证码</label>
      <div class="coderow">
        <div class="fieldrow"><icon name="terminal" :size="17" :stroke="1.6" /><input id="code" v-model="code" placeholder="XXXX-XXXX" class="mono" @keydown.enter="load" /></div>
        <button class="secondary narrow" type="button" :disabled="loading" @click="load">查询</button>
      </div>
      <div v-if="error" class="errmsg" role="alert">{{ error }}</div>
      <template v-if="info">
        <div class="meta">客户端 {{ info.clientLabel }} · 有效期至 {{ time(info.expiresAt) }}</div>
        <div class="fieldlabel">选择本次连接的计费项目组 <span class="muted">费用只计入这一个项目组</span></div>
        <div class="projects" role="radiogroup">
          <button
            v-for="project in info.projects"
            :key="project.id"
            type="button"
            role="radio"
            :aria-checked="projectID === project.id"
            class="project"
            :class="{ selected: projectID === project.id }"
            @click="projectID = project.id"
          >
            <span class="projecticon">{{ project.code.slice(0, 1) }}</span>
            <span><b>{{ project.name }}</b><small>{{ project.code }}</small></span>
            <icon v-if="projectID === project.id" name="check" :size="16" :stroke="2.2" class="tick" />
          </button>
          <div v-if="!info.projects.length" class="errmsg">你还没有加入任何项目组，请联系管理员。</div>
        </div>
        <div class="fieldlabel">使用告知 <span class="muted">版本 {{ info.notice.version }}</span></div>
        <div class="notice-box">{{ info.notice.text }}</div>
        <label class="ack">
          <input v-model="ack" type="checkbox" />
          <span>我已阅读并了解上述审计范围、目的、查看权限、保留期与申诉方式</span>
        </label>
        <button class="signin" type="button" :disabled="!projectID || !ack || busy" @click="approve">
          授权此客户端 <icon name="arrow-right" :size="17" :stroke="2" />
        </button>
        <button class="secondary" type="button" @click="deny">这不是我发起的</button>
      </template>
    </template>
  </auth-layout>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import { useRoute } from "vue-router"
import { api, type ApiError } from "../api"
import { time } from "../format"
import AuthLayout from "../components/AuthLayout.vue"
import Icon from "../components/Icon.vue"

interface Info {
  userCode: string
  clientLabel: string
  expiresAt: string
  projects: Array<{ id: string; code: string; name: string }>
  notice: { version: number; text: string; acknowledged: boolean }
}

const route = useRoute()
const code = ref(typeof route.query.code === "string" ? route.query.code : "")
const info = ref<Info>()
const projectID = ref("")
const ack = ref(false)
const loading = ref(false)
const busy = ref(false)
const done = ref(false)
const denied = ref(false)
const error = ref("")
const chosenLabel = computed(() => {
  const project = info.value?.projects.find((item) => item.id === projectID.value)
  return project ? `${project.code} · ${project.name}` : ""
})
// Launcher logins reuse this page; the device label they register starts with "Saorsa Launcher".
const launcher = computed(() => info.value?.clientLabel.startsWith("Saorsa Launcher") ?? false)
const intro = computed(() =>
  done.value || denied.value ? "" : "确认终端中的验证码，选择计费项目组并阅读使用告知后授权。授权只发生在浏览器中，终端不会接触你的密码。",
)

async function load() {
  if (!code.value.trim()) return
  loading.value = true
  error.value = ""
  try {
    info.value = await api.get<Info>(`/api/device/${encodeURIComponent(code.value.trim())}`, { quiet: true })
    ack.value = info.value.notice.acknowledged
    if (info.value.projects.length === 1) projectID.value = info.value.projects[0]!.id
  } catch (cause) {
    info.value = undefined
    error.value = (cause as ApiError).message
  } finally {
    loading.value = false
  }
}

async function approve() {
  busy.value = true
  try {
    await api.post("/api/device/approve", { userCode: code.value.trim(), projectID: projectID.value, acknowledgeNotice: ack.value }, { quiet: true })
    done.value = true
  } catch (cause) {
    error.value = (cause as ApiError).message
  } finally {
    busy.value = false
  }
}

async function deny() {
  await api.post("/api/device/deny", { userCode: code.value.trim() })
  denied.value = true
}

onMounted(load)
</script>

<style scoped>
.muted { color: #738c78; font-weight: 400; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.08em; }
.coderow { display: flex; gap: 10px; }
.coderow .fieldrow { flex: 1; }
.narrow { width: 96px !important; margin-top: 0 !important; height: 51px !important; }
.meta { color: #849b89; font-size: 11px; margin-top: 12px; }
.projects { display: grid; gap: 8px; }
.project {
  display: flex;
  align-items: center;
  gap: 12px;
  text-align: left;
  border: 1px solid #38443b;
  background: #1a1f1b;
  border-radius: 10px;
  padding: 10px 14px;
  color: #e5e9e6;
  cursor: pointer;
  font-family: inherit;
}
.project:hover { border-color: #536657; }
.project.selected { border-color: #55f68aa0; background: #55f68a0d; }
.project b { display: block; font-size: 13px; }
.project small { display: block; font-size: 10px; color: #849b89; letter-spacing: 0.08em; }
.projecticon {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  background: #22322b;
  border: 1px solid #335647;
  color: #55f68a;
  font-weight: 760;
  font-size: 12px;
}
.tick { margin-left: auto; color: #55f68a; }
.notice-box {
  white-space: pre-wrap;
  max-height: 210px;
  overflow-y: auto;
  border: 1px solid #55f68a26;
  background: #55f68a0b;
  color: #b7d5a5;
  border-radius: 10px;
  padding: 14px 16px;
  font-size: 11px;
  line-height: 1.8;
}
.ack { display: flex; gap: 10px; align-items: flex-start; margin-top: 16px; font-size: 12px; color: #cbd5cd; cursor: pointer; line-height: 1.6; }
.ack input { accent-color: #55f68a; margin-top: 3px; }
.result { display: flex; gap: 12px; align-items: flex-start; border-radius: 10px; padding: 16px 18px; font-size: 13px; line-height: 1.7; }
.result.ok { border: 1px solid #55f68a3a; background: #55f68a0e; color: #c9f9d8; }
.result.ok svg { color: #55f68a; }
.result.warn { border: 1px solid #f5b84b38; background: #f5b84b0c; color: #ebc798; }
</style>
