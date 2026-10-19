<template>
  <div class="page">
    <div class="page-head">
      <div><div class="eyebrow">{{ $route.meta.eyebrow }}</div><h1>我的通知</h1><p>额度提醒、风险提示与复核结果。</p></div>
      <el-button @click="readAll" :disabled="!unread">全部标为已读</el-button>
    </div>
    <div class="card">
      <div v-for="note in notifications" :key="note.id" class="note" :class="{ unread: !note.read_at }">
        <div class="row">
          <el-tag size="small" :type="note.category === 'budget' ? 'warning' : note.category.startsWith('risk') ? 'danger' : 'info'" effect="plain">{{ categoryText[note.category] ?? note.category }}</el-tag>
          <b>{{ note.title }}</b><span class="spacer" /><span class="muted small">{{ time(note.created_at) }}</span>
        </div>
        <div class="body">{{ note.body }}</div>
      </div>
      <empty v-if="!notifications.length" text="没有通知" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue"
import { api } from "../../api"
import { time } from "../../format"
import Empty from "../../components/Empty.vue"

const notifications = ref<any[]>([])
const unread = ref(0)
const categoryText: Record<string, string> = { budget: "额度", risk: "风险提示", risk_review: "复核结果" }

async function load() {
  const result = await api.get("/api/me/notifications")
  notifications.value = result.notifications
  unread.value = result.unread
}

async function readAll() {
  await api.post("/api/me/notifications/read", {})
  await load()
}

onMounted(load)
</script>

<style scoped>
.note { padding: 12px 4px; border-bottom: 1px solid var(--tos-border); }
.note.unread b::before { content: "● "; color: var(--tos-accent); }
.body { white-space: pre-wrap; color: var(--tos-muted); margin-top: 6px; font-size: 13px; }
</style>
