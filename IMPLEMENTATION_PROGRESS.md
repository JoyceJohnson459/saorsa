# Saorsa 实施进度

更新：2026-10-18 · 分支 `teamos`（基于 `dev` @ `22e771f589`）· 首次提交 `452b7e3082`；Anthropic 适配为后续改动

## 阶段状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| 1 源码分析 | 完成 | 见 `docs/architecture.md` §1；确定复用内置 Console 组织连接协议 |
| 2 基础架构 | 完成 | 服务端（Hono/Bun）、PostgreSQL 迁移、Redis、认证、一次性管理员初始化、Vue 管理前端、Docker Compose |
| 3 核心业务 | 完成（mock 上游） | 成员/项目组/供应商/Key/模型/价格/授权；设备码登录与项目选择；OpenAI 兼容网关（流式、用量、计费、归集）；**原生 OpenCode 客户端端到端打通** |
| 4 监控与审计 | 完成 | 实时 SSE、预算预留/结算/告警/临时提额/预测、风险规则（凭据泄露、相关性提示、高频、费用突增、频繁切换）、复核与申诉、审计日志、个人页面与 OpenCode 内 MCP 用量工具 |
| 5 测试与部署 | 大部分完成 | 44 项自动测试通过；`bun run check` 通过；Docker 镜像构建与 Compose 启动已验证；见 `docs/acceptance.md` |

## Saorsa 升级（按《Saorsa 最终整体版开发提示词》，未提交，待确认）

验证口径：除特别说明外，所有“已验证”均指 **本机（macOS 27.2 arm64）+ 标记为 TEST 的 mock 上游**，不代表真实模型或真实供应商；真实 Provider 调用仍未验证（无真实 Key）。

### S0 现状盘点（完成）
* 分支 `teamos`，工作区干净；基线 99 项服务端测试通过（本地 PG/Redis 曾停止，已用 `scripts/dev-services.sh` 重启）。
* 本机工具：OpenCode 1.17.0、Claude Code 2.1.292、Copilot CLI、Cursor、Trae CN、VS Code（已装 Claude Code 与 Roo 扩展，未装 Cline/Kilo）、IntelliJ IDEA、PyCharm；全局 Codex 安装损坏（缺平台依赖），未修改用户全局环境，测试一律使用 scratch 目录隔离安装。

### S1 品牌与工具目录（完成）
* 品牌统一为 **Saorsa**：原创 SVG（数据流 “S” + 起止节点），横版深/浅、纯图标深/浅、favicon、App 图标 SVG/PNG（`admin-web/src/assets/brand/`）；设计 Token 按规范（#080B0A / #101512 / #151C18 / #55F68A / #16A34A / #F5F7F5 / #8C9A90 / #253128 / #EF6464 / #F5B84B）。
* 客户端可见 id：`saorsa` / `saorsa-anthropic` 供应商、`saorsa` MCP（`saorsa_status`、`saorsa_usage`）、`x-saorsa-request-id`、CSV `saorsa-*`。**`NEXCODE_TOKEN` 保持不变**（OpenCode 在登录时存储该变量名，改名会迫使所有成员重新登录）。环境变量 `SAORSA_*` 优先，`NEXCODE_*`、`TEAMOS_*` 继续兼容。
* 固定 12 款工具目录 `catalog/tools.ts`（服务端与 Launcher 共用，经审查的代码，不从服务器/数据库接收命令）：官方来源、形态、平台、安装/检测方式、网关路由、凭据交付方式、官方账户依赖、未托管能力、限制、实验室记录。
* 迁移 `0004_tools.sql`：`project_tools`（项目组工具授权，存量项目保留 OpenCode）、会话绑定工具（`tool_id`、`parent_session_id`、`device_id`、`launcher` 会话类型）、`gateway_requests.tool_id/tool_version`、模型能力（流式/视觉/结构化输出）与 `allowed_tools`、`managed_installations`、`launcher_events`、供应商多协议 `extra_protocols`。
* 工具状态只来自证据：Available = Launcher 上报已安装；Gateway compatible = 有成功的网关请求；Usage verified = 有按上游精确用量计费的请求；Partially managed / Official account required / Unsupported capability 来自目录。API：`GET /api/tools`、`GET /api/admin/tools`、`GET /api/admin/installations`、`PUT /api/admin/projects/:id/tools`、`POST /api/me/tool-keys`（工具专属、项目绑定、可撤销的 Saorsa Key，只显示一次）。

### S2 协议与模型目录（完成）
* `protocols.ts` 统一适配器接口；新增 **OpenAI Responses**（`/gateway/v1/responses`，最终 usage 取自 `response.completed/incomplete/failed`）与 **Gemini 原生**（`/gateway/gemini/v1beta/models/{model}:generateContent|streamGenerateContent?alt=sse`，仅在带 `finishReason` 的块后视为最终用量；`countTokens` 透传不计费）。各协议均为原生透传，不做协议互转。
* Claude Code 所需：`/v1/messages?beta=true`、`/v1/messages/count_tokens`（透传不计费）、`HEAD /api/hello` 探测、`GET /gateway/anthropic/v1/models`（模型发现）、`x-claude-code-session-id` 会话关联；`anthropic-beta` 原样转发。
* 网关在服务端校验：会话工具是否被项目组授权、模型是否允许该工具、模型能力（工具调用/流式/图片/结构化输出）不满足时 400 `model_capability_unsupported` 且不预留、不上游。
* 凭据头新增 `x-goog-api-key`（Gemini CLI）。`test/tools.test.ts` 16 项通过。

### S3–S6 真实工具实验（完成，mock 上游）
`SAORSA_LAB=1 SAORSA_LAB_BIN=<隔离安装的 node_modules/.bin> bun test test/lab.test.ts`：8 款真实 CLI 各自完成一次真实工具调用往返（读取工作区文件并把内容带回），全部流式、全部按上游精确用量计费、归属到正确的工具与成员。

| 工具 | 版本 | 协议 | 工具调用 |
|---|---|---|---|
| OpenCode（官方 well-known 登录） | 1.17.0 | Chat Completions | Read |
| Claude Code | 2.1.292 | Anthropic Messages | Read |
| Codex CLI | 0.163.0 | Responses | shell（只读沙箱内 `cat`） |
| Gemini CLI | 0.64.0 | Gemini 原生 | read_file |
| Qwen Code | 0.25.2 | Chat Completions | read_file |
| GitHub Copilot CLI（BYOK、离线） | 1.0.98 | Chat Completions | view |
| Cline **CLI**（非 VS Code 扩展） | 3.0.73 | Chat Completions | read_files |
| Kilo **CLI**（非 VS Code 扩展） | 7.8.12 | Chat Completions | Read |

未验证：Cline/Kilo 的 VS Code 扩展界面、VS Code 中的 Copilot Chat BYOK、Cursor、TRAE、Qoder、JetBrains AI Assistant（需图形界面与厂商账户，本机不代为登录）；Qoder 当前文档只提供交互式 BYOK 向导，是否接受任意 base URL 未得到确认。

### S7 IDE 与厂商工具（档案完成，未实测）
* Cline、Kilo Code、TRAE、Qoder、JetBrains AI Assistant、GitHub Copilot（VS Code）、Cursor：按官方文档建立档案（配置字段、协议、官方账户依赖、不经网关的能力、已知限制、来源链接，核对日期 2026-10-18）。成员在工具中心或用 `saorsa configure <tool> --key` 签发工具 Key 后填入 IDE 设置。
* 均未实测：需要图形界面驱动与厂商账户，Saorsa 不代为登录或接受条款。Qoder 当前文档未确认可填写任意 Base URL；Cursor 的 BYOK 请求从其云端发出且有已知问题（见兼容矩阵）。

### S8 Saorsa Launcher（完成，macOS arm64 实测）
* `launcher`：Bun 编译的单文件 CLI（决策 D36），命令 login / logout / status / tools / install / update / uninstall / configure / restore / launch / doctor；服务端 `/api/launcher/*`（设备码登录、me、短期工具子令牌、工具 Key、安装上报、事件、退出）。
* 安全：命令与启动配方只来自编译进去的审查目录；每个动作需同意（`--yes` 预先同意，非交互且无 `--yes` 拒绝）；npm/VS Code Marketplace 官方来源，IDE 只打开官方下载页；会话令牌存 Keychain / DPAPI / Secret Service；子令牌默认 12 小时、不续期、只在子进程环境；移除个人 Key 变量；只修改 Gemini 的一项设置且可还原；日志脱敏。
* 测试：`launcher` 18 项（单元 10、真实服务端端到端 8）；实验中经 Launcher 启动真实 Claude Code、Codex、Gemini CLI、Qwen Code、Copilot CLI；编译版在临时 npm 前缀完成 qwen-code 安装/更新/卸载；Keychain 读写在临时钥匙串中验证（未触碰登录钥匙串）。
* 一键安装：服务器提供 `/install.ps1`（`irm <origin>/install.ps1 | iex`）与 `/install.sh`（`curl -fsSL <origin>/install.sh | sh`），从 `SAORSA_DOWNLOADS_DIR` 下载对应构建，SHA-256 不一致即删除并失败，装到用户目录并加入 PATH；PowerShell 脚本在 `iex` 中运行，只 `return` 不 `exit`。下载时显示进度（百分比、MB、速度，单行刷新；install.ps1 自行分块下载，因为 5.1 的 Invoke-WebRequest 进度条会大幅拖慢下载；install.sh 用 curl 进度条）。脚本内嵌校验值（只接受 64 位十六进制）并下载 `.gz` 副本（Windows 86→40 MB），URL 带 `?v=<sha256>` 时返回 `immutable` 缓存头供 Cloudflare 边缘缓存；`launcher` 的 `bun run package` 生成构建、`.sha256`、`.gz` 与 `VERSION`。最初服务器出网带宽约 1 Mbps（下载约 110 KB/s），迁到 100 Mbps 服务器后实测 40 MB 的 Windows 压缩包 8.5 秒下完（约 4.7 MB/s）。已用真实 `sh`（macOS）与 PowerShell 7.6.7（macOS）跑通安装与篡改校验值被拒；Windows PowerShell 5.1 与真实 Windows 未实测。工具中心卡片与所有“通过 Launcher”的连接指南第一步都是这一行。
* 构建产物：`dist/saorsa-macos-arm64`、`dist/saorsa-macos-x64`（仅在 Rosetta 下运行过 `--version`）、`dist/saorsa-windows-x64.exe`（未在 Windows 上运行）。

### S9 治理与安全（完成）
* 用量按工具筛选与“按工具”分组、请求明细显示工具与版本；单设备登录改为按通道（网页 / Launcher 及其子令牌 / 各工具）。
* 实验中发现并修复的缺陷：① 很短的流式请求可能在结算后被“标记为 streaming”的异步写入覆盖，导致请求一直显示进行中（已改为只更新 pending 行，并加回归测试）；② Launcher 日志对 `Authorization: Bearer xxx` 只脱敏了 “Bearer” 一词（已修复并加测试）；③ Gemini CLI 以 `x-goog-api-key` 发送凭据，网关原先不认（已支持）。
* 新文档：`docs/security.md`、`docs/launcher.md`、`docs/tool-compatibility-matrix.md`；架构 §7、决策 D30–D38、部署 §10–12、验收（13 步链路）、使用指南（工具中心、Launcher）均已更新。

### S10 部署验收（完成）
* Docker Compose 以独立项目名与临时密钥实机构建启动：PG/Redis 健康、Saorsa 容器 healthy、迁移 0001–0004 全部应用、`/healthz`、`/.well-known/opencode`、控制台标题、初始化与登录、12 款工具中心、Launcher 登录端点正常；验证后已删除该项目与数据卷，Docker Desktop 已退出。
* 单机生产部署（Docker Compose：PostgreSQL、Redis、Saorsa，前置 Caddy 自动申请 Let's Encrypt 证书并以真实客户端 IP 覆盖 `X-Forwarded-For`）已实际完成，包括从旧服务器迁移：`pg_dump` 备份 → 恢复后各表行数一致、Provider Key 用原主密钥解密成功 → 切换解析 → 签发证书；已验证 HTTPS、控制台、OpenCode 两个登录清单、一键安装与下载、伪造的 `X-Forwarded-For` 被忽略。Launcher 在服务器上用同一源码构建，SHA-256 与本机构建完全一致（Bun 编译可复现）。
* 中国大陆云主机上，未在该云厂商备案的域名会在 80/443（以及带 ALPN 的 HTTPS，即使换端口）被拦截；此时可按服务器 IP 访问，Caddy 用 Let's Encrypt 的 IP 地址证书（`shortlived` 配置，约 6 天自动续期，需 `default_sni`）。
* 迁移中发现并修复：`${SAORSA_BOOTSTRAP_TOKEN:-}` 在未设置时传入空字符串，服务因长度校验拒绝启动；现在空环境变量视为未设置（加单元测试）。

### S11 每款工具的详细连接方式（未提交，待确认）
* `catalog/guides.ts`：12 款工具各自的连接指南——准备条件、安装方式、一种或多种连接方式（每种标注“实验室已验证”或“依据官方文档”，并给出逐步的命令、环境变量、配置文件、界面字段）、确认接通的方法、常见问题。
* `GET /api/tools/:id`：返回指南，以及成员每个项目组中该工具能用的模型（已授权、允许该工具、且协议是该工具支持的）。
* 控制台新增 `/tools/:id` 指南页：选择项目组与模型、切换 macOS/Linux 与 Windows PowerShell，命令与字段自动填入 Saorsa 地址、模型和当场生成的 Key，每段可一键复制；成员与管理员工具中心的卡片都链接到该页。Launcher 新增 `saorsa guide <工具>`。
* 测试：服务端 `tools.test` 新增指南与按协议过滤模型的用例；Launcher 单测检查 12 款都有指南、占位符只用约定的四种、“实验室已验证”只出现在确实做过实验的工具上；E2E 新增指南页生成 Key 并填入步骤、12 款指南页均可打开。

### S12 工作台显示每个已连接工具的使用详情（未提交，待确认）
* `GET /api/me/tools/usage?days=`：成员连接过的每款工具——有效的 OpenCode 登录 / 工具 Key（不含 Key 本身）、周期内 Launcher 启动次数、Launcher 上报的设备与版本、按工具汇总的用量（请求、成功/失败/被拒、Token、缓存、费用与估算次数、平均耗时、最近使用、最近版本）、用过的模型前 5 个与每日序列；仅本人数据。`/api/me/usage` 增加 `byTool`，成员请求接口支持 `tool` 筛选。
* 工作台新增“我连接的工具”：每款工具一张卡片（指标、模型、趋势线、连接与设备表、撤销连接、查看请求明细、连接方式），未连接工具数量与工具中心入口；我的使用量支持 `?tool=` 筛选与“按工具”表。
* 测试：`tools.test` 新增成员工具用量用例（含不泄露 Key、只含本人数据）；修复上一阶段“结算”测试一次并发 20 个流超过成员并发上限、残留并发槽导致后续测试偶发 429 的问题（改为分批并等待并发槽释放，连续 6 次稳定）；E2E 新增工作台工具卡片与跳转到按工具筛选的请求明细。

### 当前测试结果
`server` 117 pass / 0 fail（另有 14 项真实工具实验需 `SAORSA_LAB=1`，本次全部通过）；`launcher` 18 pass；`admin-web` Playwright 14 pass；`bun run typecheck`、`oxlint`（0/0）、仓库根 `bun run check` 通过；`packages/` 改动为 0。

### 仍未完成 / 未验证（如实）
* 真实 Provider 调用（OpenAI Responses、Gemini、Anthropic、各 OpenAI 兼容厂商）全部未验证——需要你在管理后台录入真实 Key 后运行 `scripts/verify-provider.ts`。
* IDE 插件形态与 Cursor、TRAE、Qoder、JetBrains AI Assistant 未实测；Copilot 只验证了 CLI。
* Windows 版 Launcher 未在 Windows 上运行；macOS Intel 仅 Rosetta 下 `--version`；Launcher 尚未代码签名与公证、无自动更新。
* 工具档案中的厂商事实与限制文字为英文（来源为英文官方文档），界面其余部分为中文。
* 本阶段改动尚未提交（等待你的确认）。

## 阶段 9：单设备登录与 Key 独占分配（已提交 `3edff57ccc`）

* 单设备登录（`singleDeviceLogin`，默认开）：网页与 OpenCode 分通道，新登录撤销同通道旧会话；旧网页经 SSE 立即退出并在登录页提示；旧 OpenCode 收到“账号已在其他设备登录”的 401 / 占位模型。
* Key 独占（`keyAssignment = exclusive`，默认；`keyLeaseIdleMinutes` 默认 30）：`server/src/keys.ts` + 迁移 `0003_key_leases.sql`。网关首次调用自动占用空闲 Key（先选先得），无空闲时 429 `no_free_key` 并列出有空闲的模型；失效 Key 只换到空闲 Key。工作台“我的 Key”下拉显示实时空闲数、0 不可选、可释放；管理员 Key 表格显示占用成员并可释放；`nexcode_status` 显示空闲数。
* 测试：`test/keys.test.ts` 8 项（含 4 名成员并发抢 2 个 Key）；E2E 新增 Key 选择与释放步骤。其他测试套件显式使用共享模式与多设备登录。

## 阶段 8：更名 NexCode（已提交 `fddfb95615`）

* 新 Logo（六边形 “N” 标识）与 favicon；强调色改为与 Logo 一致的翠绿色（深/浅主题）；控制台、登录页、服务端消息、文档统一为 NexCode。
* 客户端可见 id 集中在 `server/src/brand.ts`：`nexcode` / `nexcode-anthropic` 供应商、`nexcode` MCP（`nexcode_status`、`nexcode_usage`）、`NEXCODE_TOKEN`；响应头 `x-nexcode-request-id`；CSV 文件名 `nexcode-*`。
* 环境变量 `NEXCODE_*`（`TEAMOS_*` 继续兼容）；Compose/Dockerfile/.env.example 改用新名。内部 id（Redis 键、Cookie、CSRF 头、`tos_` 前缀、数据库与卷名、包名）不变。
* 影响：已登录 OpenCode 的成员需重新运行一次 `opencode auth login`。

## 阶段 7：官方客户端接入（只升级管理端）

* 新增 `/.well-known/opencode`、`/cli/login`、`/cli/login/poll`、`/api/opencode/config`（`server/src/routes/opencode.ts`）：官方 OpenCode 1.x 通过 `opencode auth login <NexCode>` 接入，每次启动从 NexCode 拉取供应商、模型、价格、限制与 MCP。
* 撤销对 OpenCode 核心的唯一改动（`OPENCODE_CONSOLE_URL`），本仓库相对上游 `dev` 的 `packages/` 改动为 0；移除临时启动脚本。
* 1.x 会话令牌滑动续期；令牌失效时下发“请重新登录”占位模型；可选最低 OpenCode 版本（426 提示升级）；成员详情显示客户端版本；兼容旧版会话头。
* 验证：`test/opencode.test.ts` 9 项通过；官方 1.17.0 与 1.19.3 实测通过（见 acceptance C1）。
* Windows：`opencode auth login <origin>/windows` 的清单改用 PowerShell 登录命令（`-EncodedCommand`），已在 macOS 上用 PowerShell 7.6.7 实跑完整设备授权流程；Windows PowerShell 5.1 与真实 Windows 上的 OpenCode 尚未实测。
* 限制：macOS/Linux 登录命令需要 `sh` + `curl`；1.x 的模型/价格变更在 OpenCode 重启后生效。

## 阶段 6：网关稳定性、安全性与兼容性（2026-10-17，未提交，待确认）

### 已完成
* 调用链审查（OpenAI 与 Anthropic）：请求/响应/流式、工具与连续工具调用、中断、取消、超时、Token 与缓存计量、精确/估算标记、归属与防重复/遗漏计费。
* 完整限流系统（`server/src/ratelimit.ts` + `migrations/0002_rate_limits.sql`）：成员/项目组/模型/供应商 RPM，成员/项目组/模型 TPM，成员/项目组/模型/供应商并发；Redis Lua 原子执行；租约型并发信号量；后台可配置；网关状态页显示近 1 小时拒绝次数。
* 标准化错误：所有网关错误携带 `x-should-retry`，限流带 `retry-after`；上游 4xx 透传状态与错误码；上游账号额度耗尽不重试。
* 超时：可配置的上游响应头超时与流空闲超时（默认 300s）。
* 安全加固：设备码/令牌轮询/初始化按 IP 限流；请求体 24MB 上限在读入前生效；上游错误文本脱敏；客户端标识字符清洗；AI 审计模型只能引用纳管模型（消除 SSRF 与未审批外发）。
* 测试：新增 `limits`（20）、`relevance`（7）服务端测试，Playwright 管理后台 E2E（11）；原有 54 项全部保持通过。
* 真实 Provider 验证脚本 `scripts/verify-provider.ts`（设备码授权、真实调用、账本对比、报告）与 `docs/deployment.md` §6–8。

### 本阶段发现并修复的缺陷
1. 上游 400（如上下文超长）被包装成 502 → OpenCode 无谓重试且无法触发自动压缩。现透传状态与错误码。
2. 网关自身的永久性错误（未定价模型、无可用 Key 等）返回 5xx 且未标记不可重试 → OpenCode 会重试 10 次。现统一带 `x-should-retry: false`。
3. 并发计数使用 INCR/EXPIRE：流超过 15 分钟 TTL 后计数会变负、进程崩溃会泄漏槽位。现为租约信号量。
4. 流空闲超时触发时，`reader.cancel()` 先把挂起的读取解析为“结束”，停滞的流被记为成功。现先拒绝后取消，记为失败 + 估算。
5. 上游已接受（200）但在首个内容块前中断时曾记为“不计费”（与时序相关）。现按输入估算计费。（上一提交已修复，本阶段测试覆盖）
6. 管理前端：首次部署访问 `/` 被 401 处理器硬跳转到登录页，无法进入初始化页（E2E 发现）。现静默会话探测不再跳转。
7. 微小金额显示为 `$0.0000`。现小额保留 6 位小数。
8. 上游返回的错误文本可能回显用户内容中的密钥并被存储/展示。现统一脱敏。

### 验证结果
* `cd server && bun run test` → 81 pass / 0 fail
* `cd admin-web && bun run test:e2e` → 11 pass / 0 fail（本机 Chrome，真实后端）
* 原生 OpenCode CLI：两种协议的两轮连续工具调用；预算耗尽提示并停止；RPM=1 下按 retry-after 自动重试完成
* 类型检查、Lint、`bun run check`：见文末最终验证

### 未验证 / 剩余风险
* **真实 Provider 未验证（BLOCKED）**：无真实 Key。真实流式、真实工具调用、真实缓存计量与供应商账单对账均待执行 `scripts/verify-provider.ts`。
* TPM 准入只计输入估算，输出在结算时补记：同一分钟内的突发长输出可能短暂超出 TPM（设计取舍，预算系统仍保证费用上限）。
* 限流窗口依赖网关节点时钟基本同步（NTP）。
* 审计分类模型调用为组织开销，不记入成员账本，也未单独计量。
* 观测到原生 OpenCode 本地 serve 进程在本机高负载下偶发启动停滞（2/5 次，发生在任何网络请求之前，与 NexCode 无关），重试即恢复。
* 绕过风险不变：监控仅覆盖经网关的受管流量（见 deployment.md §5）。

## 改动清单

* 新增 ``（独立于上游 workspace）：`server/`、`admin-web/`、`scripts/`、`docs/`、`Dockerfile`、`docker-compose.yml`、`.env.example`
* 上游源码改动：无（阶段 7 已撤销早期对 `packages/core/src/plugin/provider/opencode.ts` 的 1 行改动）

## 测试结果

* `cd server && bun run test` → 81 pass / 0 fail（阶段 6 后；含 Anthropic 10、限流与安全 20、相关性 7）
* `cd server && bunx tsc --noEmit`、`cd admin-web && bunx vue-tsc --noEmit` → 0 错误
* `bunx oxlint ...` → 0 warning / 0 error
* 仓库根 `bun run check` → typecheck 35/35，lint 0 error（1307 条既有上游 warning）
* `packages/core` `test/plugin/provider-opencode.test.ts` → 40 pass
* 手工：原生 OpenCode CLI 登录/模型列表/`run`/MCP 连接；浏览器检查总览、用量、模型与 Key、风险页面，实时刷新
* Docker：`docker compose up -d --build` → 三个服务健康，初始化与登录成功，已 `down -v` 清理

## 未完成 / 遗留问题（如实记录）

1. **真实供应商调用未验证**：环境中没有真实 API Key，所有调用使用标注为 TEST 的 mock 上游。按 `docs/deployment.md` §7 运行 `scripts/verify-provider.ts` 并用原生 OpenCode 复测验收 06/07、P1。
2. **Anthropic Messages 协议已实现，但仅用 mock 验证**：`/gateway/anthropic/v1/messages` + 远程配置下发原生 Anthropic 包；mock 与原生 OpenCode（含工具调用往返）均通过。真实 Claude API（含真实缓存/思考 Token 口径、`anthropic-beta` 特性）**需用真实 Key 复测**。
3. ~~限流维度不全~~：阶段 6 已实现成员/项目组/模型/供应商的 RPM、TPM、并发。
4. ~~相关性审计模型无测试~~：阶段 6 已补 `test/relevance.test.ts`（mock 分类器；真实分类模型效果未评估）。
5. **OpenCode Desktop/Web 客户端**：使用同一组织连接协议，理论可用，未验证。
6. ~~前端无 E2E~~：阶段 6 已补 Playwright 管理后台旅程（11 项）；成员端页面只覆盖工作台、改密、通知与越权。
7. **全新机器部署**：仅在本机验证。
8. 预算预留按最坏情况计算，额度临近时可能拒绝实际很便宜的请求（设计取舍，可通过设置模型 `default_max_output` 或单次请求上限调节）。
9. OpenCode 界面中组织连接名称显示为 “OpenCode Console”（上游内置名称）。

## 下一步

1. 在后台录入真实供应商 Key（OpenAI 兼容一个、Anthropic 一个；见 `docs/deployment.md` §3），运行 `scripts/verify-provider.ts`，再用原生 OpenCode 完成带工具调用的真实会话，并与供应商账单核对 Token/缓存/费用口径。
2. 在一台全新机器上按部署文档完成 Docker Compose 部署验证。
3. 结合企业网络完成出口策略（`docs/deployment.md` §5）。
4. 可选：TPM 对输出的准入预占、审计分类调用的独立计量、Desktop/Web 客户端验证。

## 本轮修复的缺陷

* Anthropic `message_start` 的初步用量曾使中断/取消的流被记为“精确、1 个输出 Token”→ 现区分最终/初步用量，未收到最终用量时按已流出内容估算并标记估算。
* 上游已返回 200 但在首个内容块前中断时，请求曾被记为“不计费”（与时序相关）→ 现在按输入估算计费，待对账。

## 本地运行备忘

```bash
cd enterprise && sh scripts/dev-services.sh start            # PG 55432 / Redis 56379（数据在 .data/）
(cd server && bun src/mock-upstream.ts &)                     # 仅测试：mock 上游 :18080
(cd server && bun --env-file=../.env src/index.ts)            # http://127.0.0.1:8787
sh scripts/dev-services.sh stop
```
