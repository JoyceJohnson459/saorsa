# Saorsa 架构说明

> 范围：Saorsa——统一 AI 编程工具入口、企业模型网关、用量计费与治理平台（固定支持 12 款工具）。**不含任何项目协作功能**（无共享仓库、代码同步、任务/工单、PR/Issue/CI、共享工作区、多 Agent 协作）。项目组只是成员归属、模型授权、费用归集、预算与合规审计的逻辑维度。

## 1. 现场勘查结论（OpenCode v2.0.32，`dev` 分支 `22e771f589`）

| 项 | 实际情况 |
|---|---|
| 技术栈 | Bun 1.4.2 + TypeScript + Effect 4，Turbo monorepo（`packages/*`），SQLite（Drizzle）本地存储 |
| 模型调用链 | `core/src/session/model-request.ts` → `ModelResolver`（凭据来自 `Integration.connection`）→ `@opencode/ai` 协议适配（`openai-chat` 等） |
| 关键发现 | `core/src/plugin/provider/opencode.ts` 已内置 **“OpenCode Console” 组织连接**：OAuth 设备码登录（服务器地址可配置）、组织（org）作用域、远程下发 provider/模型配置（`/api/v2/config`）、组织策略（`provider.use` deny/allow）、Console 鉴权的远程 MCP |
| 请求头 | 每次模型请求携带 `x-opencode-session-id`、`x-opencode-project`（本地 Git 项目 ID）等 |

**最小侵入方案**：Saorsa 是纯服务端扩展，**对 OpenCode 源码零修改**，成员使用官方发布版并自行更新：

* **官方 1.x（当前稳定版）**：`opencode auth login <Saorsa>` → `/.well-known/opencode` 登录命令 + 每次启动拉取的 `remote_config`（`/api/opencode/config`，1.x 配置格式，令牌以 `{env:NEXCODE_TOKEN}` 占位）。已用官方 1.17.0、1.19.3 实测。
* **2.x（尚未正式发布）**：OpenCode 内置的 Console 组织连接协议（设备码 + `/api/v2/config`）。

两条路径共用同一网关、计费、预算与审计。

## 2. 组件

```
┌──────────────── 成员设备 ────────────────┐        ┌──────────────── Saorsa 服务（）────────────────┐
│ OpenCode CLI/TUI（原生 Agent 能力不变）   │        │ Hono on Bun（单进程，可水平扩展）                          │
│  ├ 组织连接（Console 协议，设备码登录）────┼─HTTPS─▶│  /auth/device/*、/api/user、/api/orgs、/api/v2/config   │
│  ├ provider "saorsa"（openai-compatible）─┼─HTTPS─▶│  /gateway/v1/chat/completions ─┐ 鉴权/授权/限流/预留 ───┼─▶ 上游供应商
  ├ provider "saorsa-anthropic"（anthropic）┼─HTTPS─▶│  /gateway/anthropic/v1/messages ┘ （协议适配器）          │
│  └ MCP "saorsa"（个人用量工具）───────────┼─HTTPS─▶│  /mcp                                                   │   (服务端持有 Key)
└──────────────────────────────────────────┘        │  /api/admin/*、/api/me/*、SSE /api/*/events             │
                                                     │  Vue 3 + Element Plus + ECharts 管理/成员控制台          │
浏览器（管理员 / 成员 / 设备授权页 /device）──HTTPS──▶│                                                         │
                                                     └───────────┬───────────────────────────┬────────────────┘
                                                                 │ PostgreSQL（业务+账本）    │ Redis（限流、并发槽、pub/sub）
```

* **服务端**：`server`（TypeScript、Hono、zod、Bun.SQL、Bun 内置 Redis 客户端与 Argon2id）。API 与网关同进程，便于单机部署；无状态，可多副本（实时事件经 Redis pub/sub 扇出）。
* **数据库**：PostgreSQL 16，版本化 SQL 迁移（`server/migrations`，带校验和与 advisory lock）。
* **前端**：`admin-web`（Vue 3 + Vite + Element Plus + ECharts），由服务端同源托管。
* **客户端**：原生 OpenCode。企业模式 = 连接 Saorsa 组织；非企业模式完全不受影响。

## 3. 一次受管请求的链路

1. 成员 `opencode auth login <Saorsa>`（官方 1.x）→ 登录命令显示验证码并打开 `/device` → 成员登录、**选择计费项目组**、确认使用告知 → 客户端获得**绑定该项目组**的令牌（1.x：随使用滑动续期的会话令牌；2.x：1h access token + 可轮换 refresh token）。
2. 客户端拉取配置（1.x：`/api/opencode/config`，每次启动；2.x：`/api/v2/config`，每分钟）：只包含 `saorsa` provider（OpenAI 兼容模型，baseURL 指向 `/gateway/v1`）与（项目组有 Anthropic 协议模型时）`saorsa-anthropic` provider（OpenCode 原生 Anthropic 包，baseURL 指向 `/gateway/anthropic/v1`）、该项目组已授权模型、`provider.use` 策略（禁用其他供应商）、`saorsa` MCP。**上游 Key 从不下发。**
3. 每个 LLM step 调用 `/gateway/v1/chat/completions` 或 `/gateway/anthropic/v1/messages`（两者共享同一治理流水线，差异只在 `server/src/protocols.ts` 的协议适配器：请求改写、上游头、usage 解析、错误格式）：
   * Bearer token → `user_sessions`（未撤销、未过期、用户 active）；**项目组来自服务端会话**，忽略客户端的 `x-opencode-project` 等头；
   * 校验项目组 active 且成员仍在组内、模型对该项目组授权、价格已配置；
   * **Key 独占分配**（默认，`server/src/keys.ts`）：成员持有该供应商的 Key 则继续使用；否则在一个事务内（成员行加锁 + `for update skip locked`）先选先得占用一个空闲 Key，`credential_leases` 的主键/唯一键保证一 Key 一人、一人一 Key；没有空闲 Key 时返回 429 `no_free_key`（不重试）并列出仍有空闲 Key 的模型；
   * **分布式限流**（`server/src/ratelimit.ts`，每类检查一个原子 Lua 脚本，键带 `{teamos}` hash tag 兼容 Redis Cluster）：
     * 每分钟请求数（滑动窗口）：成员、项目组（企业默认 + 项目覆盖）、模型、供应商；
     * 每分钟 Token（滑动窗口）：成员、项目组、模型。准入时按输入估算（请求字节/4）占用，结算后以真实输入+输出修正同一窗口；单个请求超过窗口上限直接 413（不可重试）；
     * 并发（租约信号量，有序集合按租约到期打分，长流每 40s 续租）：成员、项目组、模型、供应商。进程崩溃遗留的租约 2 分钟内自动失效，不会泄漏；
     * 所有维度先检查后扣减，任一维度拒绝都不会消耗其他维度；被拒请求退还已准入的 Token；
   * 确定性敏感凭据扫描（仅扫描最后一条 assistant 之后的新内容，按指纹去重；可配置阻断）；
   * **预算预留**：按 `请求字节/3` 估算输入 + `max_tokens` 上限估算输出，事务内对所有适用预算行 `FOR UPDATE`（按 id 排序防死锁）检查 `spent+reserved+estimate ≤ limit`；网关强制写入 `max_tokens`，保证预留是真实上限；
   * 选择 Key（优先级/最近使用，401/403/429 冷却并切换，5xx/529/网络错误同 Key 退避重试，最多 3 次，均记 `gateway_attempts`）；OpenAI 协议强制 `stream_options.include_usage=true`；Anthropic 协议转发 `anthropic-version`/`anthropic-beta`，以组织 Key 的 `x-api-key` 替换成员令牌；
   * 流式透传 SSE，同时解析 usage。只有收到供应商**最终**用量才记为精确（Anthropic 的 `message_start` 用量是初步值，需等 `message_delta`）；中断或客户端断开时保留已知的输入/缓存数，输出按已流出内容估算并标记**估算**；Anthropic 的 `input_tokens` 不含缓存，网关统一归一化后再分类计费；
   * **结算**：单事务内写 `usage_ledger`（`(request, category)` 唯一）、更新请求行、释放预留并累加 spent、检测阈值告警；之后发布实时事件、异步规则检测。
4. 管理后台通过 SSE 收到变更信号后，从数据库重新读取权威数据（SSE 不是唯一数据源）。

### 3.1 错误与重试语义（与 OpenCode 客户端对齐）

OpenCode 按 `x-should-retry`、`retry-after(-ms)` 与状态码决定是否重试（`packages/ai/src/provider-error.ts`）。网关据此输出：

| 场景 | 状态 | x-should-retry | 说明 |
|---|---|---|---|
| RPM/TPM/并发超限、上游限流 | 429 | true | 带 `retry-after`（上游给出的值会透传，最长 300s） |
| 单请求超过 TPM 窗口 | 413 | false | 需缩小上下文或提高限额 |
| 预算耗尽 / 单次请求超预算 | 402 | false | OpenCode 显示为额度不足并停止 |
| 无权限、项目被移出、模型未授权 | 401/403 | false | |
| 上游 400/404/413/422（如上下文超长） | 原状态 | false | 透传上游错误码（如 `context_length_exceeded`），OpenCode 可据此自动压缩上下文 |
| 组织上游账号额度耗尽（insufficient_quota） | 503 | false | 不是限流，重试无意义 |
| 上游 5xx/529/网络错误 | 503/502 | true | 网关已在同 Key 上退避重试 |
| 上游响应头超时 / 流空闲超时 | 504 / 流内错误事件 | true | 超时可配置；流空闲超时会释放租约与预留并按估算计费 |

## 4. 数据模型（ER 摘要）

`organization`(1) · `users`(ADMIN|MEMBER) ─< `project_members` >─ `projects`
`users` ─< `user_sessions`(web|client; client 绑定 project_id) ─< `project_sessions`(OpenCode 会话关联)
`providers` ─< `provider_credentials`(AES-GCM 密文, key_version) · `providers` ─< `models` ─< `pricing_versions`(追加式) · `models` ─< `model_permissions` >─ `projects`
`gateway_requests`(request_id, idempotency_key, user/project/session/model/credential, 状态机, token, cost, billing_status, price_version) ─< `gateway_attempts` · ─< `usage_ledger`(charge/adjustment) · ─< `budget_reservations`
`budgets`(org|project|user|user_project|model × daily|monthly|total) ─< `budget_counters`(period) · ─< `budget_adjustments` · ─< `budget_alerts`
`policy_rules` · `risk_events` ─< `risk_reviews` · ─< `risk_appeals` · `notifications` · `audit_logs`(数据库触发器保证只追加) · `device_authorizations`

金额全部为 BIGINT 微单位（1 USD = 1,000,000），价格为“每百万 Token 的微单位”。**不存在** repositories/tasks/issues/pull_requests/workspaces/agent_jobs 表，项目组无仓库字段（有自动测试守护）。

## 5. 安全边界

* 只有两类账户：ADMIN、MEMBER；全部权限在服务端校验（`requireAdmin` 中间件 + 成员接口强制 `user_id = 本人`）。
* Web 会话：HttpOnly + SameSite=Strict Cookie，写操作额外要求 `x-teamos-csrf` 头；网关**不接受** Cookie。
* 密码 Argon2id；登录 IP 限流、连续失败 5 次锁定 15 分钟；初始化需一次性令牌，之后永久关闭；无注册接口。
* 刷新令牌轮换，旧令牌重放即撤销整个会话；改密/禁用/删除/重置均撤销会话。
* 上游 Key：AES-256-GCM（随机 nonce，AAD=凭据 ID），主密钥只在环境变量（可多版本轮换并重加密），日志/审计统一脱敏器。
* SSRF：上游 base URL 只能由管理员设置，必须 HTTPS + 主机允许列表 + 解析结果非私网；`redirect: "error"`。AI 相关性审计模型只能引用已纳管的模型别名，不能填写任意 URL。
* 未鉴权端点（设备码、设备令牌轮询、初始化）按 IP 限流；请求体在读入内存前限制为 24MB。
* 上游错误文本在存储、展示和返回前统一脱敏；客户端提供的会话/追踪/幂等标识只保留安全字符。
* CSV 导出防公式注入；CSP、nosniff；审计日志不可改删。

## 6. 无法强制的边界（如实说明）

Saorsa **只能看见经网关的受管流量**。成员若在本机运行未纳管的 OpenCode 构建、删除组织连接、或使用个人 Key/其他工具，即可绕过。组织策略（禁用其他 provider）只在已连接 Saorsa 的标准客户端中生效，**不是**安全边界。可执行的受控部署方案见 `deployment.md` 第 5 节（托管配置 + 出口网络策略 + MDM）。

## 7. Saorsa：12 款工具、四种协议与 Launcher

```
成员设备                                                      Saorsa 服务
┌───────────────────────────────┐                            ┌──────────────────────────────────────────────┐
│ saorsa Launcher（Bun 单文件）  │── 设备码登录、me、上报 ───▶│ /api/launcher/*（launcher 会话）             │
│  ├ 检测 / 安装（npm、VS Code） │◀── 短期工具子令牌 ─────────│ /api/launcher/tool-token                     │
│  └ 启动工具（令牌只在子进程环境）│                            │                                              │
│ Claude Code ──────────────────┼── Anthropic Messages ────▶│ /gateway/anthropic/v1/messages(+count_tokens)│
│ Codex CLI ────────────────────┼── OpenAI Responses ──────▶│ /gateway/v1/responses                        │──▶ 支持该协议的上游
│ Gemini CLI ───────────────────┼── Gemini 原生 ───────────▶│ /gateway/gemini/v1beta/models/{m}:{method}   │    （原样透传，
│ OpenCode / Qwen / Copilot CLI │── Chat Completions ──────▶│ /gateway/v1/chat/completions                 │      不做协议互转）
│ Cline / Kilo / Cursor / TRAE /│                            │                                              │
│ JetBrains（IDE 中填工具 Key）  │                            │ 工具中心 /api/tools、/api/admin/tools        │
└───────────────────────────────┘                            └──────────────────────────────────────────────┘
```

* **工具目录**：`catalog/tools.ts` 是 12 款工具的唯一来源（服务端与 Launcher 共用、经代码审查），包含官方来源、形态、平台、安装/检测方式、网关路由、凭据交付方式、启动配方、官方账户依赖、不经网关的能力、限制与实验记录。
* **工具身份**：每个客户端会话绑定一个工具（`user_sessions.tool_id`），来源分别是 OpenCode 登录（`opencode`）、成员签发的工具 Key、Launcher 签发的子令牌（`parent_session_id` 指向 Launcher 会话，父会话失效则子令牌失效）。网关只认会话里的工具，不认请求头；`gateway_requests.tool_id/tool_version` 记录归属，版本从 User-Agent 识别（识别不到则为空）。
* **授权**：`project_tools` 决定项目组可用的工具；`models.allowed_tools` 可进一步限定模型可用于哪些工具；模型能力（工具调用、流式、图片、结构化输出）在网关前置校验。
* **协议适配器**（`server/src/protocols.ts`）：Chat Completions、Anthropic Messages、OpenAI Responses、Gemini 原生。最终用量判定：Chat 取含 usage 的末块；Anthropic 取 `message_delta`（`message_start` 只是初步计数）；Responses 取 `response.completed/incomplete/failed`；Gemini 取带 `finishReason` 的块（中间块的累计 usage 不视为最终）。供应商可声明同一 Base URL 还支持的协议（`providers.extra_protocols`）。
* **工具状态**：Available（Launcher 上报已安装）、Gateway compatible（有成功请求）、Usage verified（有精确计费请求）来自部署内证据；Partially managed / Official account required / Unsupported capability 来自目录；实验室验证来自本仓库测试，单独展示。

