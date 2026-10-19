<template>
  <div class="card">
    <div class="head">
      <div>
        <h3>Saorsa Launcher</h3>
        <p class="muted small">命令行工具（Claude Code、Codex、Gemini CLI、Qwen Code、Copilot CLI）通过 Launcher 登录、安装与启动。{{ data?.version ? `当前版本 ${data.version}。` : "" }}</p>
      </div>
      <div class="row">
        <el-radio-group v-model="os" size="small" aria-label="操作系统">
          <el-radio-button value="windows">Windows</el-radio-button>
          <el-radio-button value="macos">macOS</el-radio-button>
        </el-radio-group>
      </div>
    </div>
    <p v-if="data && !data.files.length" class="muted small">服务器尚未提供 Launcher 下载，请联系管理员。</p>
    <template v-else-if="file">
      <p class="small">在{{ os === "windows" ? " PowerShell " : "终端" }}中运行这一行即可安装（安装到当前用户目录，不需要管理员权限，自动校验 SHA-256 并加入 PATH）：</p>
      <div class="code">
        <pre class="notice mono">{{ script }}</pre>
        <button class="copy small" type="button" @click="copy">复制</button>
      </div>
      <p class="small">安装完成后运行：<code>saorsa login --server {{ origin }}</code>{{ os === "windows" ? "（提示找不到 saorsa 时，重新打开一个 PowerShell 窗口）" : "" }}</p>
      <details class="small">
        <summary>手动下载</summary>
        <div class="row small">
          <el-radio-group v-if="os === 'macos'" v-model="chip" size="small" aria-label="Mac 芯片">
            <el-radio-button value="arm64">Apple 芯片</el-radio-button>
            <el-radio-button value="x64">Intel</el-radio-button>
          </el-radio-group>
          <a :href="file.url" download class="el-button el-button--small">下载 {{ file.name }}</a>
          <span class="muted">{{ (file.size / 1024 / 1024).toFixed(1) }} MB</span>
          <span v-if="file.sha256" class="muted">SHA-256：<code>{{ file.sha256 }}</code></span>
        </div>
      </details>
      <p class="warntext small">
        Launcher 目前尚未进行代码签名{{ os === "windows" ? "，Windows 可能提示“未知发布者”或被 SmartScreen 拦截" : "，macOS 可能提示无法验证开发者" }}；请确认校验值一致后再运行。{{ os === "windows" ? "Windows 版尚未经过完整验证，遇到问题请运行 saorsa doctor 并把输出发给管理员。" : "" }}
      </p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ElMessage } from "element-plus"
import { computed, onMounted, ref } from "vue"
import { api } from "../api"

type Download = { name: string; platform: string; size: number; sha256: string | null; url: string }

const origin = location.origin
const data = ref<{ version: string | null; files: Download[] }>()
const os = ref<"windows" | "macos">(navigator.userAgent.includes("Windows") ? "windows" : "macos")
// Browsers report "Intel Mac OS X" on Apple silicon too, so the member picks the chip.
const chip = ref<"arm64" | "x64">("arm64")

const file = computed(() => {
  const files = data.value?.files ?? []
  if (os.value === "windows") return files.find((entry) => entry.platform === "windows-x64")
  return files.find((entry) => entry.platform === `macos-${chip.value}`)
})

// Windows PowerShell 5.1 does not enable TLS 1.2 by default, so the one-liner turns it on before fetching the
// script. The served installers pick the build, verify its SHA-256 and update PATH (install.sh also detects the Mac chip).
const script = computed(() => (os.value === "windows" ? `[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; irm ${origin}/install.ps1 | iex` : `curl -fsSL ${origin}/install.sh | sh`))

async function copy() {
  await navigator.clipboard.writeText(script.value)
  ElMessage.success("已复制")
}

onMounted(async () => {
  data.value = await api.get("/api/downloads", { quiet: true }).catch(() => ({ version: null, files: [] }))
})
</script>

<style scoped>
.head { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; align-items: flex-start; }
.head h3 { margin: 0 0 4px; }
.head p { margin: 0; }
.row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.row.small { margin-top: 10px; }
.code { position: relative; margin-top: 6px; }
.code pre { margin: 0; white-space: pre-wrap; word-break: break-all; padding-right: 64px; }
.copy { position: absolute; right: 8px; top: 8px; border: 1px solid var(--line); background: var(--raised); color: var(--muted); border-radius: 6px; padding: 2px 8px; cursor: pointer; }
.warntext { color: var(--orange); }
code { word-break: break-all; }
.card { overflow-wrap: anywhere; }
</style>
