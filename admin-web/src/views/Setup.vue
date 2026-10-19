<template>
  <auth-layout
    eyebrow="FIRST RUN / 初始化"
    title="初始化 Saorsa"
    :intro="'需要服务器上配置的一次性初始化令牌（SAORSA_BOOTSTRAP_TOKEN）。\n完成后此入口永久关闭，系统不开放注册。'"
  >
    <form novalidate @submit.prevent="submit">
      <label class="fieldlabel" for="token">初始化令牌</label>
      <div class="fieldrow"><icon name="key-round" :size="17" :stroke="1.6" /><input id="token" v-model="form.token" type="password" autocomplete="off" /></div>
      <label class="fieldlabel" for="organization">组织名称</label>
      <div class="fieldrow"><icon name="layers" :size="17" :stroke="1.6" /><input id="organization" v-model="form.organization" /></div>
      <label class="fieldlabel" for="timezone">时区 <span class="muted">预算与报表按此切分自然日/月</span></label>
      <div class="fieldrow"><icon name="activity" :size="17" :stroke="1.6" /><input id="timezone" v-model="form.timezone" /></div>
      <label class="fieldlabel" for="admin-username">管理员用户名</label>
      <div class="fieldrow"><icon name="user" :size="17" :stroke="1.6" /><input id="admin-username" v-model="form.username" autocomplete="username" /></div>
      <label class="fieldlabel" for="display-name">显示名称</label>
      <div class="fieldrow"><icon name="user" :size="17" :stroke="1.6" /><input id="display-name" v-model="form.displayName" /></div>
      <label class="fieldlabel" for="email">邮箱 <span class="muted">可选</span></label>
      <div class="fieldrow"><icon name="mail" :size="17" :stroke="1.6" /><input id="email" v-model="form.email" type="email" /></div>
      <label class="fieldlabel" for="admin-password">密码 <span class="muted">至少 12 位，混合三类字符</span></label>
      <div class="fieldrow"><icon name="lock" :size="17" :stroke="1.6" /><input id="admin-password" v-model="form.password" type="password" autocomplete="new-password" /></div>
      <div class="errmsg" role="alert">{{ error }}</div>
      <button class="signin" type="submit" :disabled="busy">创建管理员 <icon name="arrow-right" :size="17" :stroke="2" /></button>
    </form>
  </auth-layout>
</template>

<script setup lang="ts">
import { reactive, ref } from "vue"
import { api, type ApiError } from "../api"
import AuthLayout from "../components/AuthLayout.vue"
import Icon from "../components/Icon.vue"

const form = reactive({ token: "", organization: "", timezone: "Asia/Shanghai", username: "", displayName: "", email: "", password: "" })
const busy = ref(false)
const error = ref("")

async function submit() {
  busy.value = true
  error.value = ""
  try {
    await api.post("/api/auth/bootstrap", { ...form, email: form.email || undefined }, { quiet: true })
    location.href = "/login"
  } catch (cause) {
    error.value = (cause as ApiError).message
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.muted { color: #6f7d90; font-weight: 400; }
</style>
