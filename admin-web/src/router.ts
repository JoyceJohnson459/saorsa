import { createRouter, createWebHistory } from "vue-router"
import { loadSession, session } from "./api"

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/setup", component: () => import("./views/Setup.vue"), meta: { public: true } },
    { path: "/login", component: () => import("./views/Login.vue"), meta: { public: true } },
    { path: "/device", component: () => import("./views/Device.vue") },
    { path: "/password", component: () => import("./views/ChangePassword.vue") },
    {
      path: "/",
      component: () => import("./components/Shell.vue"),
      children: [
        // Resolved in the guard below, after the session has loaded.
        { path: "", component: () => import("./views/NotFound.vue") },
        { path: "admin", component: () => import("./views/admin/Dashboard.vue"), meta: { admin: true, title: "总览工作台", eyebrow: "Mission control / 01" } },
        { path: "admin/projects", component: () => import("./views/admin/Projects.vue"), meta: { admin: true, title: "项目组", eyebrow: "Workspace / 02" } },
        { path: "admin/projects/:id", component: () => import("./views/admin/ProjectDetail.vue"), meta: { admin: true, title: "项目组详情", eyebrow: "Workspace / 02" } },
        { path: "admin/members", component: () => import("./views/admin/Members.vue"), meta: { admin: true, title: "成员管理", eyebrow: "Workspace / 03" } },
        { path: "admin/members/:id", component: () => import("./views/admin/MemberDetail.vue"), meta: { admin: true, title: "成员详情", eyebrow: "Workspace / 03" } },
        { path: "admin/tools", component: () => import("./views/admin/Tools.vue"), meta: { admin: true, title: "工具中心", eyebrow: "Workspace / 04" } },
        { path: "admin/models", component: () => import("./views/admin/Models.vue"), meta: { admin: true, title: "模型与密钥", eyebrow: "Governance / 04" } },
        { path: "admin/usage", component: () => import("./views/admin/Usage.vue"), meta: { admin: true, title: "使用量与费用", eyebrow: "Cost intelligence / 05" } },
        { path: "admin/budgets", component: () => import("./views/admin/Budgets.vue"), meta: { admin: true, title: "预算与额度", eyebrow: "Budget control / 07" } },
        { path: "admin/risks", component: () => import("./views/admin/Risks.vue"), meta: { admin: true, title: "风险审计", eyebrow: "Safety & governance / 06" } },
        { path: "admin/settings", component: () => import("./views/admin/Settings.vue"), meta: { admin: true, title: "系统设置", eyebrow: "System / 08" } },
        { path: "me", component: () => import("./views/member/Workbench.vue"), meta: { title: "我的工作台", eyebrow: "Personal / 01" } },
        { path: "tools/:id", component: () => import("./views/ToolGuide.vue"), meta: { title: "连接方式", eyebrow: "Tool guide" } },
        { path: "me/tools", component: () => import("./views/member/Tools.vue"), meta: { title: "工具中心", eyebrow: "Personal / 02" } },
        { path: "me/usage", component: () => import("./views/member/Usage.vue"), meta: { title: "我的使用量", eyebrow: "Personal / 02" } },
        { path: "me/notifications", component: () => import("./views/member/Notifications.vue"), meta: { title: "我的通知", eyebrow: "Personal / 03" } },
        { path: "me/settings", component: () => import("./views/member/Settings.vue"), meta: { title: "个人设置", eyebrow: "Personal / 04" } },
        { path: ":pathMatch(.*)*", component: () => import("./views/NotFound.vue"), meta: { title: "页面不存在" } },
      ],
    },
  ],
})

router.beforeEach(async (to) => {
  if (!session.loaded) await loadSession()
  if (to.meta.public) return true
  if (!session.user) {
    const status = await fetch("/api/auth/status").then((response) => response.json()).catch(() => ({ initialized: true }))
    if (!status.initialized) return "/setup"
    return { path: "/login", query: { next: to.fullPath } }
  }
  if (session.user.mustChangePassword && to.path !== "/password") return { path: "/password", query: { next: to.fullPath } }
  if (to.path === "/") return session.user.accountType === "ADMIN" ? "/admin" : "/me"
  // The UI guard is cosmetic; every admin API is enforced server-side.
  if (to.meta.admin && session.user.accountType !== "ADMIN") return "/me"
  return true
})
