<template>
  <auth-layout eyebrow="WELCOME BACK / 登录系统" title="欢迎回到 Saorsa" :intro="'使用团队账户登录，继续管理 AI 资源。\n管理员与普通成员共用同一个登录入口。'">
    <form novalidate @submit.prevent="submit">
      <label class="fieldlabel" for="username">账户</label>
      <div class="fieldrow" :class="{ invalid: invalid === 'username' }">
        <icon name="user" :size="17" :stroke="1.6" />
        <input id="username" v-model="username" name="username" type="text" autocomplete="username" placeholder="输入你的团队账户" autofocus />
      </div>
      <label class="fieldlabel" for="password">登录密码</label>
      <div class="fieldrow" :class="{ invalid: invalid === 'password' }">
        <icon name="lock" :size="17" :stroke="1.6" />
        <input id="password" v-model="password" name="password" :type="reveal ? 'text' : 'password'" autocomplete="current-password" placeholder="输入登录密码" />
        <button class="ghost" type="button" :aria-pressed="reveal" :aria-label="reveal ? '隐藏密码' : '显示密码'" @click="reveal = !reveal">
          <icon name="eye" :size="18" />
        </button>
      </div>
      <div class="errmsg" role="alert" aria-live="polite">{{ error }}</div>
      <button class="signin" type="submit" :disabled="busy">
        {{ busy ? "正在登录…" : "登录控制台" }}
        <icon name="arrow-right" :size="17" :stroke="2" />
      </button>
    </form>
    <div class="hint">
      <icon name="shield-check" :size="16" />
      <span><strong>账户由管理员统一分配。</strong> 首次登录需要修改临时密码；连续 5 次输错密码会锁定 15 分钟。忘记密码请联系管理员重置。</span>
    </div>
  </auth-layout>
</template>

<script setup lang="ts">
import { ref } from "vue"
import { useRoute } from "vue-router"
import { api, loadSession, type ApiError } from "../api"
import AuthLayout from "../components/AuthLayout.vue"
import Icon from "../components/Icon.vue"

const route = useRoute()
const username = ref("")
const password = ref("")
const error = ref(route.query.reason === "replaced" ? "你的账号已在其他设备登录，本设备已自动退出。" : "")
const invalid = ref<"username" | "password" | "">("")
const reveal = ref(false)
const busy = ref(false)

async function submit() {
  invalid.value = ""
  if (!username.value.trim()) return fail("请输入账户", "username")
  if (!password.value) return fail("请输入登录密码", "password")
  busy.value = true
  error.value = ""
  try {
    await api.post("/api/auth/login", { username: username.value.trim(), password: password.value }, { quiet: true })
    await loadSession()
    const next = typeof route.query.next === "string" && route.query.next.startsWith("/") ? route.query.next : "/"
    location.href = next
  } catch (cause) {
    fail((cause as ApiError).message, "password")
  } finally {
    busy.value = false
  }
}

function fail(message: string, field: "username" | "password") {
  error.value = message
  invalid.value = field
}
</script>
