<template>
  <auth-layout eyebrow="SECURE YOUR ACCOUNT / 修改密码" title="设置新密码" :intro="'首次登录或密码被重置后需要修改临时密码。\n修改后，其他已登录的设备与 OpenCode 客户端会被注销。'">
    <form novalidate @submit.prevent="submit">
      <label class="fieldlabel" for="current">当前密码</label>
      <div class="fieldrow"><icon name="lock" :size="17" :stroke="1.6" /><input id="current" v-model="form.current" type="password" autocomplete="current-password" /></div>
      <label class="fieldlabel" for="next">新密码 <span class="muted">至少 12 位，混合三类字符，不含用户名</span></label>
      <div class="fieldrow" :class="{ invalid: mismatch }"><icon name="key-round" :size="17" :stroke="1.6" /><input id="next" v-model="form.next" type="password" autocomplete="new-password" /></div>
      <label class="fieldlabel" for="confirm">确认新密码</label>
      <div class="fieldrow" :class="{ invalid: mismatch }"><icon name="key-round" :size="17" :stroke="1.6" /><input id="confirm" v-model="form.confirm" type="password" autocomplete="new-password" /></div>
      <div class="errmsg" role="alert">{{ error || (mismatch ? "两次输入的新密码不一致" : "") }}</div>
      <button class="signin" type="submit" :disabled="busy || !form.next || mismatch">保存新密码 <icon name="arrow-right" :size="17" :stroke="2" /></button>
    </form>
  </auth-layout>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from "vue"
import { useRoute } from "vue-router"
import { api, loadSession, type ApiError } from "../api"
import AuthLayout from "../components/AuthLayout.vue"
import Icon from "../components/Icon.vue"

const route = useRoute()
const form = reactive({ current: "", next: "", confirm: "" })
const busy = ref(false)
const error = ref("")
const mismatch = computed(() => Boolean(form.confirm) && form.next !== form.confirm)

async function submit() {
  busy.value = true
  error.value = ""
  try {
    await api.post("/api/me/password", { current: form.current, next: form.next }, { quiet: true })
    await loadSession()
    location.href = typeof route.query.next === "string" && route.query.next.startsWith("/") ? route.query.next : "/"
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
