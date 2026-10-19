<template>
  <div class="page">
    <div class="page-head">
      <div>
        <div class="eyebrow">{{ $route.meta.eyebrow }}</div>
        <h1>个人设置</h1>
        <p>密码、当前设备与使用告知。</p>
      </div>
    </div>
    <div>
      <div class="grid halves">
        <div class="card">
          <h3>修改密码</h3>
          <el-form label-position="top" @submit.prevent="changePassword">
            <el-form-item label="当前密码"><el-input v-model="form.current" type="password" show-password autocomplete="current-password" /></el-form-item>
            <el-form-item label="新密码（至少 12 位，混合三类字符，不含用户名）"><el-input v-model="form.next" type="password" show-password autocomplete="new-password" /></el-form-item>
            <el-form-item label="确认新密码"><el-input v-model="form.confirm" type="password" show-password autocomplete="new-password" /></el-form-item>
            <el-button type="primary" native-type="submit" :disabled="!form.next || form.next !== form.confirm">保存新密码</el-button>
            <p class="muted small">修改后，其他所有会话（包括 OpenCode 客户端）将被注销。</p>
          </el-form>
        </div>
        <div class="card">
          <h3>当前设备与会话</h3>
          <el-table :data="sessions" size="small">
            <el-table-column label="类型" width="100"><template #default="{ row }">{{ row.kind === "client" ? "OpenCode" : "Web" }}<el-tag v-if="row.current" size="small" style="margin-left: 4px">当前</el-tag></template></el-table-column>
            <el-table-column label="计费项目" prop="project_code" width="90" />
            <el-table-column label="IP" prop="ip" />
            <el-table-column label="创建" width="150"><template #default="{ row }">{{ time(row.created_at) }}</template></el-table-column>
            <el-table-column width="70"><template #default="{ row }"><el-button v-if="!row.current" link type="danger" size="small" @click="revoke(row.id)">注销</el-button></template></el-table-column>
          </el-table>
        </div>
      </div>
      <div class="card mt">
        <h3>使用告知</h3>
        <div class="notice">{{ notice }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ElMessage } from "element-plus"
import { onMounted, reactive, ref } from "vue"
import { api, loadSession } from "../../api"
import { time } from "../../format"

const form = reactive({ current: "", next: "", confirm: "" })
const sessions = ref<any[]>([])
const notice = ref("")

async function load() {
  const [sessionList, noticeInfo] = await Promise.all([api.get("/api/me/sessions"), api.get("/api/notice")])
  sessions.value = sessionList.sessions
  notice.value = noticeInfo.text
}

async function changePassword() {
  await api.post("/api/me/password", { current: form.current, next: form.next })
  ElMessage.success("密码已更新")
  Object.assign(form, { current: "", next: "", confirm: "" })
  await loadSession()
  await load()
}

async function revoke(id: string) {
  await api.del(`/api/me/sessions/${id}`)
  await load()
}

onMounted(load)
</script>
