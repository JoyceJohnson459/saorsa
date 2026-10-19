import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test"
import { readFile } from "node:fs/promises"
import path from "node:path"

// One stateful journey through the real console and API: first-run setup → project group → member →
// provider key → model + price → authorization → member onboarding → OpenCode device login → usage and
// cost → risk review → budgets, plus member isolation. Uses the TEST-labelled mock upstream only.

test.describe.configure({ mode: "serial" })

const MOCK_KEY = "mock-upstream-test-key-not-a-secret"
const ADMIN_PASSWORD = "E2e!Owner-Passphrase-1"
const MEMBER_PASSWORD = "E2e!Member-Passphrase-2"
const LEAKED = "AKIAE2ETESTLEAKKEY12"

let state: { origin: string; bootstrapToken: string; mockURL: string }
let adminContext: BrowserContext
let admin: Page
let memberContext: BrowserContext
let member: Page
let projectID = ""
let temporaryPassword = ""

/** Element Plus form item by its exact label text (or a regex for long labels). */
const field = (scope: Page | Locator, label: string | RegExp) => {
  // `has` locators are resolved relative to the outer match, so they must be built from the page root.
  const root = "goto" in scope ? scope : scope.page()
  return scope
    .locator(".el-form-item")
    .filter({ has: root.locator(".el-form-item__label", { hasText: typeof label === "string" ? new RegExp(`^${label}$`) : label }) })
    .locator("input, textarea")
    .first()
}

const pickOption = async (page: Page, select: Locator, option: string | RegExp) => {
  await select.click()
  await page.locator(".el-select-dropdown__item:visible", { hasText: option }).first().click()
}

const fresh = async (browser: Browser) => {
  const context = await browser.newContext({ locale: "zh-CN" })
  return { context, page: await context.newPage() }
}

test.beforeAll(async ({ browser }) => {
  state = JSON.parse(await readFile(path.join(import.meta.dirname, ".state.json"), "utf8"))
  ;({ context: adminContext, page: admin } = await fresh(browser))
  ;({ context: memberContext, page: member } = await fresh(browser))
})

test.afterAll(async () => {
  await adminContext.close()
  await memberContext.close()
})

test("first-run setup creates the only administrator and closes itself", async () => {
  await admin.goto("/")
  await expect(admin).toHaveURL(/\/setup$/)
  await admin.getByLabel("初始化令牌").fill(state.bootstrapToken)
  await admin.getByLabel("组织名称").fill("E2E 企业")
  await admin.getByLabel("管理员用户名").fill("e2e-admin")
  await admin.getByLabel("显示名称").fill("E2E 管理员")
  await admin.getByLabel(/^密码/).fill(ADMIN_PASSWORD)
  await admin.getByRole("button", { name: "创建管理员" }).click()
  await expect(admin).toHaveURL(/\/login$/)
  await admin.getByLabel("账户").fill("e2e-admin")
  await admin.getByLabel("登录密码").fill(ADMIN_PASSWORD)
  await admin.getByRole("button", { name: "登录控制台" }).click()
  await expect(admin).toHaveURL(/\/admin$/)
  await expect(admin.getByRole("heading", { name: /一切 AI 使用，尽在掌控/ })).toBeVisible()
  const again = await admin.request.post("/api/auth/bootstrap", {
    data: { token: state.bootstrapToken, organization: "x", username: "second", displayName: "x", password: ADMIN_PASSWORD },
  })
  expect(again.status()).toBe(409)
})

test("admin creates a project group", async () => {
  await admin.goto("/admin/projects")
  await admin.getByRole("button", { name: "新建项目组" }).click()
  const dialog = admin.getByRole("dialog", { name: "新建项目组" })
  await field(dialog, /^项目编号/).fill("E2E")
  await field(dialog, "项目名称").fill("端到端项目")
  await field(dialog, /^项目用途说明/).fill("图像预处理与缺陷检测模型训练 image preprocessing defect detection")
  await dialog.getByRole("button", { name: "创建" }).click()
  await expect(admin).toHaveURL(/\/admin\/projects\/[0-9a-f-]{36}$/)
  projectID = admin.url().split("/").at(-1)!
  await expect(admin.getByRole("heading", { name: "E2E · 端到端项目" })).toBeVisible()
})

test("admin creates a member and sees the one-time password exactly once", async () => {
  await admin.goto("/admin/members")
  await admin.getByRole("button", { name: "新增成员" }).click()
  const dialog = admin.getByRole("dialog", { name: "新增成员" })
  await field(dialog, "用户名").fill("e2e-member")
  await field(dialog, "显示名称").fill("E2E 成员")
  await pickOption(admin, dialog.locator(".el-form-item", { hasText: "加入项目组" }).locator(".el-select"), "E2E")
  await dialog.getByRole("button", { name: "创建" }).click()
  const secret = admin.getByRole("dialog", { name: "临时密码（只显示一次）" })
  await expect(secret).toBeVisible()
  temporaryPassword = await secret.locator("input").inputValue()
  expect(temporaryPassword.length).toBeGreaterThanOrEqual(12)
  await secret.getByRole("button", { name: /Close|关闭/ }).click()
  const row = admin.locator(".el-table__row", { hasText: "e2e-member" })
  await expect(row).toContainText("E2E")
  await expect(row).toContainText("待改密")
})

test("admin adds a provider key that is only ever shown masked", async () => {
  await admin.goto("/admin/models")
  await admin.getByRole("button", { name: "添加供应商" }).click()
  const provider = admin.getByRole("dialog", { name: "添加供应商" })
  await field(provider, "名称").fill("Mock Upstream (TEST)")
  await field(provider, /^Base URL/).fill(state.mockURL)
  await provider.getByRole("button", { name: "添加" }).click()
  const card = admin.locator(".card", { hasText: "Mock Upstream (TEST)" })
  await expect(card).toBeVisible()
  await card.getByRole("button", { name: "添加 Key" }).click()
  const key = admin.getByRole("dialog", { name: "添加 Key" })
  await field(key, "API Key").fill(MOCK_KEY)
  await key.getByRole("button", { name: "保存" }).click()
  await expect(card).toContainText("••••••••cret")
  await card.getByRole("button", { name: "健康检查" }).click()
  await expect(card.locator(".el-tag", { hasText: /^健康$/ })).toBeVisible()
  expect(await admin.content()).not.toContain(MOCK_KEY)
  const api = await admin.request.get("/api/admin/providers")
  expect(await api.text()).not.toContain(MOCK_KEY)
})

test("admin registers a priced model and authorizes it for the project", async () => {
  await admin.getByRole("button", { name: "添加模型" }).click()
  const dialog = admin.getByRole("dialog", { name: "添加模型" })
  await field(dialog, "上游模型 ID").fill("mock-chat")
  await field(dialog, /^别名/).fill("mock-chat")
  await field(dialog, "显示名称").fill("Mock Chat (TEST)")
  await field(dialog, "输入").fill("3")
  await field(dialog, "输出").fill("15")
  await dialog.getByRole("button", { name: "添加" }).click()
  const row = admin.locator(".el-table__row", { hasText: "mock-chat" })
  await expect(row).toContainText("$3.00 / $15.00")
  await admin.goto(`/admin/projects/${projectID}`)
  await admin.locator(".el-checkbox", { hasText: "mock-chat" }).click()
  await admin.locator(".card", { hasText: "模型授权" }).getByRole("button", { name: "保存" }).click()
  await expect(admin.getByText("模型授权已保存")).toBeVisible()
})

test("the member must change the temporary password, then sees their project and model", async () => {
  await member.goto("/login")
  await member.getByLabel("账户").fill("e2e-member")
  await member.getByLabel("登录密码").fill(temporaryPassword)
  await member.getByRole("button", { name: "登录控制台" }).click()
  await expect(member).toHaveURL(/\/password/)
  await member.getByLabel("当前密码").fill(temporaryPassword)
  await member.getByLabel(/^新密码/).fill(MEMBER_PASSWORD)
  await member.getByLabel("确认新密码").fill(MEMBER_PASSWORD)
  await member.getByRole("button", { name: "保存新密码" }).click()
  await expect(member).toHaveURL(/\/me$/)
  const projects = member.locator(".card", { hasText: "我的项目组与可用模型" })
  await expect(projects).toContainText("E2E")
  await expect(projects).toContainText("mock-chat")
})

test("admin sees exactly the 12 supported tools and authorizes Claude Code for the project", async () => {
  await admin.goto("/admin/tools")
  await expect(admin.locator(".tool")).toHaveCount(12)
  await expect(admin.locator(".tool", { hasText: "Cursor" })).toContainText("部分托管")
  await expect(admin.locator(".tool", { hasText: "Claude Code" })).toContainText("实验室验证")
  await admin.goto(`/admin/projects/${projectID}`)
  const card = admin.locator(".card", { hasText: "工具授权" })
  await card.locator(".el-checkbox", { hasText: "Claude Code" }).click()
  await card.getByRole("button", { name: "保存" }).click()
  await expect(admin.getByText("工具授权已保存")).toBeVisible()
})

test("the member creates a Claude Code key in the tool center; it is shown once and works at the gateway", async () => {
  await member.goto("/me/tools")
  const card = member.locator(".tool", { hasText: "Claude Code" })
  await expect(card).toContainText("已授权")
  await expect(member.locator(".tool", { hasText: "Cursor" })).toContainText("未授权")
  await card.getByRole("button", { name: "生成 Saorsa Key" }).click()
  const dialog = member.getByRole("dialog", { name: /只显示一次/ })
  const key = (await dialog.locator(".key").textContent())?.trim() ?? ""
  expect(key).toMatch(/^tos_at_/)
  await dialog.getByRole("button", { name: "我已保存" }).click()
  await expect(member.getByText(key)).toHaveCount(0)
  const models = await member.request.get("/gateway/anthropic/v1/models", { headers: { authorization: `Bearer ${key}` } })
  expect(models.status()).toBe(200)
})

test("each tool has a detailed connection guide; a key generated there is filled into the steps", async () => {
  await member.goto("/me/tools")
  await member.locator(".tool", { hasText: "Claude Code" }).getByRole("link", { name: /查看详细连接方式/ }).click()
  await expect(member.getByRole("heading", { name: "Claude Code" })).toBeVisible()
  // The E2E project has no Anthropic-protocol model, and the guide says so instead of offering one.
  await expect(member.getByText(/没有 Claude Code 可用的模型/)).toBeVisible()
  await member.getByRole("tab", { name: /手动配置环境变量/ }).click()
  // The default shell follows the browser's OS (Playwright's Desktop Chrome reports Windows); pick explicitly.
  await member.locator(".el-radio-button", { hasText: "macOS / Linux" }).click()
  await expect(member.locator(".code pre", { hasText: "ANTHROPIC_BASE_URL" })).toContainText("<你的 Saorsa Key>")
  await member.getByRole("button", { name: /生成 Claude Code 专用 Saorsa Key/ }).click()
  await expect(member.locator(".code pre", { hasText: "ANTHROPIC_BASE_URL" })).toContainText('ANTHROPIC_AUTH_TOKEN="tos_at_')
  await member.locator(".el-radio-button", { hasText: "Windows PowerShell" }).click()
  await expect(member.locator(".code pre", { hasText: "ANTHROPIC_BASE_URL" })).toContainText('$env:ANTHROPIC_AUTH_TOKEN = "tos_at_')
  // `saorsa` only exists once installed, so the tool center and every Launcher method start with the install line.
  await member.goto("/me/tools")
  const launcher = member.locator(".card", { hasText: "Saorsa Launcher" }).first()
  await launcher.locator(".el-radio-button", { hasText: "Windows" }).click()
  await expect(launcher.locator(".code pre")).toHaveText(/^\[Net\.ServicePointManager\]::SecurityProtocol = .+ -bor 3072; irm https?:\/\/\S+\/install\.ps1 \| iex$/)
  await launcher.locator(".el-radio-button", { hasText: "macOS" }).click()
  await expect(launcher.locator(".code pre")).toHaveText(/^curl -fsSL https?:\/\/\S+\/install\.sh \| sh$/)
  await member.goto("/tools/codex?from=me")
  await member.getByRole("tab", { name: /通过 Saorsa Launcher/ }).click()
  await member.locator(".el-radio-button", { hasText: "Windows PowerShell" }).click()
  const steps = member.locator(".el-tab-pane:visible .steps > li")
  await expect(steps.nth(0)).toContainText("安装 Saorsa Launcher")
  await expect(steps.nth(0).locator(".code pre")).toHaveText(/\/install\.ps1 \| iex$/)
  await expect(steps.nth(1).locator(".code pre")).toHaveText(/^saorsa login --server /)
  expect((await member.request.get("/install.ps1")).status()).toBe(200)
  // Every section of the guide is its own card with visible space between them.
  const boxes = await member.locator(".page > .card, .page > .grid").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect()).map((box) => ({ top: box.top, bottom: box.bottom })))
  expect(boxes.length).toBeGreaterThan(4)
  for (const [index, box] of boxes.slice(1).entries()) expect(box.top - boxes[index]!.bottom).toBeGreaterThanOrEqual(12)
  // OpenCode spawns its login command without a shell, so Windows logs in at /windows and never sees curl | bash.
  await member.goto("/tools/opencode?from=me")
  await member.locator(".el-radio-button", { hasText: "Windows PowerShell" }).click()
  await expect(member.locator(".code pre", { hasText: "opencode auth login" })).toHaveText(/^opencode auth login https?:\/\/\S+\/windows$/)
  await expect(member.locator(".code pre", { hasText: "| bash" })).toHaveCount(0)
  await expect(member.locator(".code pre", { hasText: "scoop install opencode" })).toBeVisible()
  await member.locator(".el-radio-button", { hasText: "macOS / Linux" }).click()
  await expect(member.locator(".code pre", { hasText: "opencode auth login" })).toHaveText(/^opencode auth login https?:\/\/[^/\s]+$/)
  await expect(member.locator(".code pre", { hasText: "| bash" })).toHaveCount(1)
  for (const tool of ["opencode", "codex", "gemini-cli", "cline", "kilo-code", "qwen-code", "trae", "qoder", "jetbrains-ai", "github-copilot", "cursor"]) {
    await member.goto(`/tools/${tool}?from=me`)
    await expect(member.getByRole("heading", { name: "连接方式" })).toBeVisible()
  }
})

test("an OpenCode device login is approved in the browser and its usage is metered", async () => {
  const start = await (await member.request.post("/auth/device/code", { data: { client_id: "opencode-cli" } })).json()
  await member.goto(start.verification_uri_complete)
  await expect(member.getByRole("heading", { name: /连接 OpenCode 客户端/ })).toBeVisible()
  await expect(member.getByRole("radio", { checked: true })).toContainText("E2E")
  await member.getByText("我已阅读并了解").click()
  await member.getByRole("button", { name: "授权此客户端" }).click()
  await expect(member.getByRole("heading", { name: /已授权/ })).toBeVisible()
  const token = await (
    await member.request.post("/auth/device/token", {
      data: { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: start.device_code },
    })
  ).json()
  expect(token.org_id).toBe(projectID)
  const call = (content: string, stream: boolean) =>
    member.request.post("/gateway/v1/chat/completions", {
      headers: { authorization: `Bearer ${token.access_token}` },
      data: { model: "mock-chat", stream, messages: [{ role: "user", content }] },
    })
  expect((await call("Refactor the image preprocessing step", true)).status()).toBe(200)
  expect((await call(`deploy with ${LEAKED}`, false)).status()).toBe(200)
})

test("the workbench shows each connected tool with its usage, and links to that tool's requests", async () => {
  await member.goto("/me")
  const section = member.locator(".card", { hasText: "我连接的工具" })
  const opencode = section.locator(".tool", { hasText: "OpenCode" })
  await expect(opencode).toContainText("1 个连接")
  await expect(opencode.locator(".stats")).toContainText("请求2")
  await expect(opencode).toContainText("mock-chat")
  // Claude Code has a key (created earlier) but no traffic yet.
  await expect(section.locator(".tool", { hasText: "Claude Code" })).toContainText("周期内未使用")
  await expect(section).toContainText("另有 10 款工具尚未连接")
  // Connections and billing projects live in each tool's card; there is no OpenCode-only sessions card.
  await expect(member.getByText("OpenCode 客户端会话与当前计费项目")).toHaveCount(0)
  await opencode.getByRole("link", { name: /查看请求明细/ }).click()
  await expect(member).toHaveURL(/\/me\/usage\?tool=opencode/)
  await expect(member.locator(".el-table__row", { hasText: "mock-chat" }).first()).toContainText("OpenCode")
  await expect(member.locator(".card", { hasText: "按工具" })).toContainText("OpenCode")
})

test("the member sees the key they hold, the admin sees the holder, and releasing frees it", async () => {
  await member.goto("/me")
  const card = member.locator(".card", { hasText: "我的 Key" })
  await expect(card).toContainText("正在使用")
  await card.locator(".el-select").click()
  await expect(member.locator(".el-select-dropdown__item:visible").first()).toContainText("使用中")
  await member.keyboard.press("Escape")

  await admin.goto("/admin/models")
  await expect(admin.locator(".card", { hasText: "占用成员" }).first()).toContainText("E2E 成员")

  await card.getByRole("button", { name: "释放" }).click()
  await expect(member.getByText("已释放 Key")).toBeVisible()
  await expect(card).not.toContainText("正在使用")
  await card.locator(".el-select").click()
  await expect(member.locator(".el-select-dropdown__item:visible").first().locator(".count")).toHaveText("1")
  await member.keyboard.press("Escape")
  // The admin view follows over SSE without a reload.
  await expect(admin.locator(".card", { hasText: "占用成员" }).first()).toContainText("空闲")
})

test("admin sees the member's requests, tokens and cost, and exports them without the key", async () => {
  await admin.goto("/admin/usage")
  const requests = admin.locator(".card", { hasText: "请求明细" })
  await expect(requests.locator(".el-table__row")).toHaveCount(2)
  await expect(requests).toContainText("E2E 成员")
  await expect(requests).toContainText("精确")
  const download = admin.waitForEvent("download")
  await admin.getByRole("button", { name: "导出 CSV" }).hover()
  await admin.getByRole("menuitem", { name: "请求明细" }).click()
  const csv = await readFile(await (await download).path(), "utf8")
  expect(csv).toContain("mock-chat")
  expect(csv).toContain("e2e-member")
  expect(csv).not.toContain(MOCK_KEY)
  await admin.goto("/admin")
  await expect(admin.locator(".metric", { hasText: "模型调用" })).toContainText("2")
})

test("the leaked credential is a redacted risk record the admin can mark as a false positive", async () => {
  await admin.goto("/admin/risks")
  const row = admin.locator(".el-table__row", { hasText: "敏感凭据泄露" })
  await expect(row).toContainText("E2E 成员")
  await row.click()
  const drawer = admin.locator(".el-drawer")
  await expect(drawer).toContainText("REDACTED")
  expect(await drawer.innerText()).not.toContain(LEAKED)
  await drawer.getByText("误报", { exact: true }).click()
  await drawer.locator("textarea").fill("测试用假密钥")
  await drawer.getByRole("button", { name: "提交复核" }).click()
  await expect(admin.locator(".el-table__row", { hasText: "敏感凭据泄露" })).toContainText("误报")
  await member.goto("/me/notifications")
  await expect(member.getByText("A risk notice was marked as a false positive")).toBeVisible()
})

test("admin creates a project budget and sees spend against it", async () => {
  await admin.goto("/admin/budgets")
  await admin.getByRole("button", { name: "新建预算" }).click()
  const dialog = admin.getByRole("dialog", { name: "新建预算" })
  await pickOption(admin, dialog.locator(".el-form-item", { hasText: /^项目组/ }).locator(".el-select"), "E2E")
  await field(dialog, "额度（美元）").fill("10")
  await dialog.getByRole("button", { name: "创建" }).click()
  const row = admin.locator(".el-table__row", { hasText: "E2E" })
  await expect(row).toContainText("$10.00")
})

test("the member cannot reach admin pages or admin APIs", async () => {
  await member.goto("/admin/members")
  await expect(member).toHaveURL(/\/me$/)
  await expect(member.getByText("成员管理")).toHaveCount(0)
  expect((await member.request.get("/api/admin/users")).status()).toBe(403)
  expect((await member.request.get("/api/admin/usage/requests")).status()).toBe(403)
  const own = await (await member.request.get("/api/me/requests")).json()
  expect(own.total).toBe(2)
})
