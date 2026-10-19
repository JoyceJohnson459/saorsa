<template>
  <div class="app">
    <aside class="side" aria-label="主导航">
      <router-link to="/" class="brand" aria-label="Saorsa 首页">
        <logo :size="34" />
        <span class="brandtext">Saorsa<small>AI development under control</small></span>
      </router-link>

      <nav>
        <template v-for="section in sections" :key="section.title">
          <div class="navtitle">{{ section.title }}</div>
          <router-link
            v-for="item in section.items"
            :key="item.path"
            :to="item.path"
            class="navbutton"
            :class="{ active: active === item.path }"
            :title="item.label"
          >
            <icon :name="item.icon" />
            <span class="navlabel">{{ item.label }}</span>
            <b v-if="item.count" class="navcount">{{ item.count }}</b>
          </router-link>
        </template>
      </nav>

      <div class="sidefooter">
        <div class="statuspanel" :title="gateway.detail">
          <div class="statushead">
            <span>GATEWAY STATUS</span>
            <span class="online" :class="{ down: !gateway.ok }"><i class="dot" />{{ gateway.label }}</span>
          </div>
          <div class="statusline"><div :style="{ width: `${gateway.health}%` }" /></div>
          <div class="statusfoot">{{ gateway.protocols }}</div>
        </div>
        <el-dropdown trigger="click" placement="top-start" @command="onUser">
          <button class="sideprofile" type="button">
            <span class="avatar">{{ initials }}</span>
            <span class="profiletext">
              <b>{{ session.user?.displayName }}</b>
              <small>{{ isAdmin ? "Administrator" : "Member" }}</small>
            </span>
            <icon name="chevrons-up-down" :size="15" class="profilechev" />
          </button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="settings">个人设置</el-dropdown-item>
              <el-dropdown-item command="theme:dark" :disabled="themeMode === 'dark'">深色主题</el-dropdown-item>
              <el-dropdown-item command="theme:light" :disabled="themeMode === 'light'">浅色主题</el-dropdown-item>
              <el-dropdown-item command="theme:system" :disabled="themeMode === 'system'">跟随系统</el-dropdown-item>
              <el-dropdown-item command="logout" divided>退出登录</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </aside>

    <div class="main">
      <header class="topbar">
        <div class="crumb">
          <icon name="command" :size="16" />
          <span>CONSOLE</span>
          <span class="slash">/</span>
          <span class="current">{{ route.meta.title }}</span>
        </div>
        <div class="topactions">
          <span v-if="session.organization" class="orgchip" :title="session.organization">{{ session.organization }}</span>
          <button class="kbdsearch" type="button" @click="paletteOpen = true">
            <icon name="search" :size="16" />
            <span>搜索功能或页面</span>
            <kbd>⌘ K</kbd>
          </button>
          <button class="iconbtn" type="button" aria-label="我的通知" @click="router.push('/me/notifications')">
            <icon name="bell" :size="17" />
            <i v-if="unread" class="badge">{{ unread > 99 ? "99+" : unread }}</i>
          </button>
          <button class="iconbtn avatarbtn" type="button" aria-label="个人设置" @click="router.push('/me/settings')">{{ initials }}</button>
        </div>
      </header>
      <main class="content-wrap">
        <router-view :key="route.fullPath" />
      </main>
    </div>

    <el-dialog v-model="paletteOpen" :show-close="false" width="540px" class="palette" align-center @opened="focusPalette">
      <input ref="paletteInput" v-model="query" class="palette-input" placeholder="输入页面名称，例如：风险审计、模型与密钥…" @keydown.enter="openFirst" />
      <div class="palette-list">
        <button v-for="item in matches" :key="item.path" type="button" class="palette-item" @click="openPage(item.path)">
          <icon name="arrow-right" :size="16" />{{ item.label }}<span class="muted tiny">{{ item.section }}</span>
        </button>
        <div v-if="!matches.length" class="muted small palette-empty">没有匹配页面</div>
      </div>
      <div class="tiny muted palette-hint">Enter 打开 · Esc 关闭</div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue"
import { useRoute, useRouter } from "vue-router"
import { api, session, subscribe } from "../api"
import { applyTheme, themeMode } from "../theme"
import Icon from "./Icon.vue"
import Logo from "./Logo.vue"

const route = useRoute()
const router = useRouter()
const isAdmin = computed(() => session.user?.accountType === "ADMIN")
const unread = ref(0)
const counts = reactive({ projects: 0, risks: 0 })
const gateway = reactive({ ok: true, label: "检测中", health: 0, protocols: "受管网关", detail: "" })
const paletteOpen = ref(false)
const query = ref("")
const paletteInput = ref<HTMLInputElement>()

const initials = computed(() => {
  const name = session.user?.displayName ?? session.user?.username ?? "?"
  return /^[\x00-\x7F]+$/.test(name) ? name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() : name.slice(0, 2)
})

const sections = computed(() => {
  const personal = {
    title: isAdmin.value ? "Personal" : "Workspace",
    items: [
      { path: "/me", label: "我的工作台", icon: "home" },
      { path: "/me/tools", label: "工具中心", icon: "terminal" },
      { path: "/me/usage", label: "我的使用量", icon: "chart" },
      { path: "/me/notifications", label: "我的通知", icon: "mail", count: unread.value || undefined },
      { path: "/me/settings", label: "个人设置", icon: "user" },
    ],
  }
  if (!isAdmin.value) return [personal]
  return [
    {
      title: "Workspace",
      items: [
        { path: "/admin", label: "总览工作台", icon: "layout-dashboard" },
        { path: "/admin/projects", label: "项目组", icon: "layers", count: counts.projects || undefined },
        { path: "/admin/members", label: "成员管理", icon: "users" },
        { path: "/admin/tools", label: "工具中心", icon: "terminal" },
      ],
    },
    {
      title: "Governance",
      items: [
        { path: "/admin/models", label: "模型与密钥", icon: "cpu" },
        { path: "/admin/usage", label: "使用量与费用", icon: "chart" },
        { path: "/admin/risks", label: "风险审计", icon: "shield-alert", count: counts.risks || undefined },
        { path: "/admin/budgets", label: "预算与额度", icon: "wallet" },
      ],
    },
    { title: "System", items: [{ path: "/admin/settings", label: "系统设置", icon: "settings" }] },
    personal,
  ]
})

const flat = computed(() => sections.value.flatMap((section) => section.items.map((item) => ({ ...item, section: section.title }))))
const active = computed(() => {
  const paths = flat.value.map((item) => item.path).toSorted((a, b) => b.length - a.length)
  return paths.find((path) => route.path === path || route.path.startsWith(`${path}/`)) ?? route.path
})
const matches = computed(() => {
  const text = query.value.trim().toLowerCase()
  return flat.value.filter((item) => !text || item.label.toLowerCase().includes(text) || item.path.includes(text))
})

async function refresh() {
  unread.value = (await api.get<{ unread: number }>("/api/me/notifications", { quiet: true }).catch(() => ({ unread: 0 }))).unread
  if (isAdmin.value) {
    const [summary, system] = await Promise.all([
      api.get("/api/admin/usage/summary", { quiet: true }).catch(() => undefined),
      api.get("/api/admin/system", { quiet: true }).catch(() => undefined),
    ])
    if (summary) Object.assign(counts, { projects: summary.activeProjectCount, risks: summary.openRisks })
    if (!system) return Object.assign(gateway, { ok: false, label: "不可用", health: 0, detail: "无法读取网关状态" })
    const providers = (system.providers as Array<{ enabled: boolean; health_status: string; protocol: string }>).filter((item) => item.enabled)
    const healthy = providers.filter((item) => item.health_status === "healthy").length
    const ok = system.database.ok && system.redis.ok
    const protocols = [...new Set(providers.map((item) => (item.protocol === "anthropic-messages" ? "Anthropic" : "OpenAI")))]
    Object.assign(gateway, {
      ok,
      label: ok ? "在线" : "异常",
      health: providers.length ? Math.round((healthy / providers.length) * 100) : ok ? 100 : 0,
      protocols: protocols.length ? `${protocols.join(" / ")} 协议 · ${healthy}/${providers.length} 供应商健康` : "尚未配置供应商",
      detail: `数据库 ${system.database.ok ? "正常" : "异常"} · Redis ${system.redis.ok ? "正常" : "异常"} · 进行中 ${system.inFlightRequests}`,
    })
    return
  }
  const ok = await fetch("/healthz").then((response) => response.ok).catch(() => false)
  const sessions = await api.get("/api/me/sessions", { quiet: true }).catch(() => ({ sessions: [] }))
  const clients = (sessions.sessions as Array<{ kind: string }>).filter((item) => item.kind === "client").length
  Object.assign(gateway, { ok, label: ok ? "在线" : "不可用", health: ok ? 100 : 0, protocols: `${clients} 个已连接的 OpenCode 客户端` })
}

function focusPalette() {
  query.value = ""
  void nextTick(() => paletteInput.value?.focus())
}

function openPage(path: string) {
  paletteOpen.value = false
  void router.push(path)
}

function openFirst() {
  const first = matches.value[0]
  if (first) openPage(first.path)
}

function onKey(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault()
    paletteOpen.value = true
  }
}

async function onUser(command: string) {
  if (command === "settings") return router.push("/me/settings")
  if (command.startsWith("theme:")) return applyTheme(command.slice(6) as "light" | "dark" | "system")
  await api.post("/api/auth/logout").catch(() => {})
  session.user = undefined
  location.href = "/login"
}

let stop: (() => void) | undefined
let timer: ReturnType<typeof setInterval> | undefined
let debounce: ReturnType<typeof setTimeout> | undefined
onMounted(() => {
  void refresh()
  const stream = isAdmin.value ? "/api/admin/events" : "/api/me/events"
  stop = subscribe(stream, (type) => {
    if (type === "ready") return
    clearTimeout(debounce)
    debounce = setTimeout(refresh, 800)
  })
  timer = setInterval(refresh, 60_000)
  window.addEventListener("keydown", onKey)
})
onBeforeUnmount(() => {
  stop?.()
  clearInterval(timer)
  clearTimeout(debounce)
  window.removeEventListener("keydown", onKey)
})
</script>

<style scoped>
.app { display: grid; grid-template-columns: var(--sidebar) minmax(0, 1fr); min-height: 100vh; }
.side {
  border-right: 1px solid var(--line2);
  background: var(--side);
  padding: 28px 16px 17px;
  display: flex;
  flex-direction: column;
  position: sticky;
  top: 0;
  height: 100vh;
  overflow-y: auto;
}
.brand { display: flex; gap: 10px; align-items: center; padding: 0 10px 34px; color: var(--text); text-decoration: none; }
.brandtext { font-size: 21px; font-weight: 760; letter-spacing: -0.055em; line-height: 1; }
.brandtext > span { color: var(--mint); }
.brandtext small { display: block; font-size: 7px; white-space: nowrap; text-transform: uppercase; letter-spacing: 0.07em; color: var(--muted); font-weight: 600; margin-top: 7px; }
.navtitle { font-size: 10px; font-weight: 700; letter-spacing: 0.18em; color: var(--dim); padding: 14px 16px 10px; text-transform: uppercase; }
.navbutton {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border: 1px solid transparent;
  border-radius: 10px;
  color: color-mix(in srgb, var(--muted) 80%, var(--text));
  margin: 2px 0;
  transition: 0.16s ease;
  font-weight: 540;
  text-decoration: none !important;
}
.navbutton:hover { background: var(--hover); color: var(--text); }
.navbutton.active { background: var(--mint-soft); border-color: var(--mint-line); color: var(--mint); }
.navcount { margin-left: auto; background: color-mix(in srgb, var(--muted) 22%, var(--raised)); color: var(--text); font-size: 10px; border-radius: 6px; padding: 1px 6px; font-weight: 600; }
.navbutton.active .navcount { background: color-mix(in srgb, var(--mint) 18%, transparent); color: var(--mint); }
.sidefooter { margin-top: auto; padding-top: 28px; }
.statuspanel { padding: 13px; border: 1px solid var(--line); background: var(--raised); border-radius: 13px; }
.statushead { display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: var(--muted); letter-spacing: 0.04em; }
.online { display: inline-flex; gap: 6px; align-items: center; color: var(--mint2); }
.online.down { color: var(--red); }
.dot { height: 7px; width: 7px; border-radius: 50%; background: currentColor; box-shadow: 0 0 0 4px color-mix(in srgb, currentColor 14%, transparent); }
.statusline { height: 3px; background: var(--line); margin-top: 12px; border-radius: 10px; overflow: hidden; }
.statusline div { height: 100%; background: linear-gradient(90deg, var(--mint2), var(--mint)); transition: width 0.4s; }
.statusfoot { font-size: 10px; color: var(--dim); margin-top: 10px; }
.sideprofile {
  width: 100%;
  margin-top: 14px;
  padding: 8px;
  display: flex;
  align-items: center;
  gap: 10px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--text);
  text-align: left;
}
.sideprofile:hover { background: var(--hover); }
.avatar, .avatarbtn {
  width: 31px;
  height: 31px;
  display: grid;
  place-items: center;
  border-radius: 9px;
  background: color-mix(in srgb, var(--muted) 28%, var(--raised));
  color: var(--text);
  font-size: 11px;
  font-weight: 700;
  flex: 0 0 auto;
}
.profiletext { min-width: 0; flex: 1; }
.profiletext b { display: block; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.profiletext small { display: block; color: var(--dim); font-size: 11px; }
.profilechev { color: var(--muted); }
.main {
  min-width: 0;
  background: radial-gradient(ellipse 900px 430px at 65% -20%, color-mix(in srgb, var(--mint) 7%, transparent), transparent), var(--canvas);
}
.topbar {
  height: 79px;
  border-bottom: 1px solid var(--line2);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 39px;
  gap: 15px;
}
.crumb { display: flex; gap: 11px; align-items: center; color: var(--muted); font-size: 12px; letter-spacing: 0.04em; min-width: 0; }
.crumb .current { color: var(--text); font-weight: 650; letter-spacing: 0; white-space: nowrap; }
.slash { color: var(--dim); }
.topactions { display: flex; gap: 10px; align-items: center; }
.orgchip {
  font-size: 10px;
  letter-spacing: 0.08em;
  font-weight: 700;
  color: var(--mint);
  border: 1px solid var(--mint-line);
  background: var(--mint-soft);
  border-radius: 6px;
  padding: 4px 8px;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.iconbtn {
  height: 35px;
  width: 35px;
  background: var(--raised);
  border: 1px solid var(--line);
  border-radius: 9px;
  color: var(--muted);
  display: grid;
  place-items: center;
  position: relative;
  cursor: pointer;
}
.iconbtn:hover { color: var(--text); border-color: color-mix(in srgb, var(--muted) 60%, var(--line)); }
.avatarbtn { width: 35px; height: 35px; border: 1px solid var(--line); cursor: pointer; }
.badge {
  position: absolute;
  top: -5px;
  right: -5px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--mint);
  color: var(--mint-ink);
  font-size: 9px;
  font-style: normal;
  font-weight: 800;
  display: grid;
  place-items: center;
}
.kbdsearch {
  height: 35px;
  width: 218px;
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--raised);
  color: var(--dim);
  border: 1px solid var(--line);
  padding: 0 11px;
  border-radius: 9px;
  font-size: 12px;
  cursor: pointer;
}
.kbdsearch kbd { margin-left: auto; color: var(--dim); border: 1px solid var(--line); border-radius: 5px; padding: 0 5px; font-size: 10px; font-family: inherit; }
.palette-input { width: 100%; border: 0; outline: 0; color: var(--text); background: var(--input-bg); border-radius: 8px; padding: 16px; font-size: 14px; }
.palette-list { margin-top: 8px; max-height: 320px; overflow-y: auto; }
.palette-item {
  width: 100%;
  padding: 12px 13px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--text);
  display: flex;
  gap: 10px;
  align-items: center;
  cursor: pointer;
  font-size: 13px;
}
.palette-item .tiny { margin-left: auto; text-transform: uppercase; letter-spacing: 0.12em; }
.palette-item:hover { background: var(--hover); }
.palette-empty { padding: 30px; text-align: center; }
.palette-hint { padding: 10px 4px 0; }
:deep(.palette) { padding: 12px; }
:deep(.palette .el-dialog__header) { display: none; }

@media (max-width: 1250px) { .topbar { padding: 0 24px; } }
@media (max-width: 780px) {
  .app { --sidebar: 65px; }
  .side { padding-left: 9px; padding-right: 9px; }
  .brand { padding: 0 0 26px; justify-content: center; }
  .brandtext, .navtitle, .navlabel, .navcount, .profiletext, .profilechev, .statuspanel, .orgchip { display: none !important; }
  .navbutton { justify-content: center; padding: 11px; }
  .sideprofile { justify-content: center; padding: 6px 0; }
  .topbar { height: 64px; padding: 0 13px; }
  .kbdsearch { width: 35px; justify-content: center; padding: 0; }
  .kbdsearch span, .kbdsearch kbd { display: none; }
  .crumb > span:not(.current), .crumb .slash { display: none; }
}
</style>
