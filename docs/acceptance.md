# 验收清单

## Saorsa 最终验收链路（2026-10-18）

证据：`server` 116 项测试 + 14 项真实工具实验（`SAORSA_LAB=1`）、`launcher` 18 项、`admin-web` Playwright 14 项（真实后端）、Docker Compose 实机构建与启动。除特别说明外，上游均为标注 TEST 的 mock，**不代表真实模型或真实供应商**。

| # | 环节 | 结果 | 证据 |
|---|---|---|---|
| 1 | Admin 登录 Saorsa | PASS | E2E “first-run setup …”；登录页 Saorsa 品牌截图核对 |
| 2 | Admin 创建成员与项目组 | PASS | E2E 2–3；`flow.test` 02 |
| 3 | Admin 配置 Provider Key、模型、价格、能力 | PASS | E2E 4–5；`tools.test` 中四种协议的供应商与模型；能力字段（工具/流式/图片/结构化输出）与 `allowed_tools` |
| 4 | Admin 授权成员可用的工具与模型 | PASS | E2E “admin sees exactly the 12 supported tools and authorizes Claude Code”；`tools.test` 工具授权与模型限定工具 |
| 5 | Member 登录 Saorsa | PASS | E2E 6（必须先改临时密码） |
| 6 | Member 在固定 12 款工具中心选择工具 | PASS | E2E “the member creates a Claude Code key in the tool center …”；未授权工具显示“未授权” |
| 7 | Launcher 检查环境、官方渠道安装/配置或指引手动安装 | PASS（macOS arm64） | `launcher/test/e2e.test.ts`；编译版在临时 npm 前缀完成 qwen-code 安装/更新/卸载；IDE 类只打开官方下载页。Windows 未实测 |
| 8 | Member 选择有效项目组与授权模型 | PASS | Launcher `chooseTarget` 单测；`--project/--model` 不可用时给出可选项 |
| 9 | 工具经 Saorsa Gateway 发起受管调用 | PASS（8 款 CLI，mock 上游） | `lab.test`：OpenCode、Claude Code、Codex、Gemini CLI、Qwen Code、Copilot CLI、Cline CLI、Kilo CLI；其中 5 款再经 Launcher 启动 |
| 10 | Gateway 正确处理协议与 Tool Use | PASS（mock 上游） | 四种协议的流式/非流式/工具调用往返/中断/取消/上游错误测试（`tools.test`、`anthropic.test`、`flow.test`）；真实 CLI 各完成一次工具调用往返 |
| 11 | 记录请求、usage、费用、工具、成员与项目组 | PASS | `gateway_requests.tool_id/tool_version`；每个实验请求精确计费并归属到正确的工具与成员 |
| 12 | 后台显示真实用量、费用、预算与风险 | PASS | E2E 11–13；工具中心的“网关可用/用量已核实”来自真实请求 |
| 13 | 无法托管的能力明确显示限制 | PASS | 工具中心“部分托管 / 需官方账户 / 已知限制 / 官方来源”；`docs/tool-compatibility-matrix.md` |

### 12 款工具逐一状态

见 `docs/tool-compatibility-matrix.md`。摘要：OpenCode、Claude Code、Codex CLI、Gemini CLI、Qwen Code 已在实验中完整验证；GitHub Copilot 仅 CLI（BYOK）验证；Cline、Kilo Code 仅官方 CLI 验证（VS Code 插件未验证）；TRAE、Qoder、JetBrains AI Assistant、Cursor 未验证（需图形界面与厂商账户）。

### 部署

Docker Compose（独立项目名、临时密钥）实机构建并启动：PostgreSQL、Redis 健康，Saorsa 容器 healthy，4 个迁移全部应用，`/healthz`、`/.well-known/opencode`、控制台标题、初始化与管理员登录、12 款工具中心、Launcher 登录端点均正常；验证后已删除该项目及其数据卷。TLS 反向代理、saorsa.tech DNS 与生产部署未执行（需授权）。

---

## 历史验收（2026-10-17，TeamOS / NexCode 阶段）

证据来源：`server/test/flow.test.ts`（31 项集成测试，真实 PostgreSQL + Redis + 标注为 TEST 的 mock 上游）、`server/test/unit.test.ts`（13 项）、手工运行原生 OpenCode CLI（隔离 HOME）、浏览器检查管理后台、Docker Compose 实机启动。

`cd server && bun run test` → **81 pass / 0 fail**（`flow` 31、`unit` 13、`anthropic` 10、`limits` 20、`relevance` 7）；`cd admin-web && bun run test:e2e` → **11 pass / 0 fail**（Playwright，真实后端）。

| # | 场景 | 结果 | 证据 |
|---|---|---|---|
| 01 | 安全创建 ADMIN、无公开注册 | PASS | 测试 “01 bootstrap”：错误令牌 403、弱密码 422、二次初始化 409、`/api/auth/register` 404 |
| 02 | 2 个项目组、3 个成员，B 同属两组 | PASS | 测试 “02 projects and members” |
| 03 | 成员 A 不能使用项目组 B | PASS | 设备授权选择非所属项目 → 403；网关项目归属只取服务端会话（伪造 `x-opencode-project` 无效，测试 06/07） |
| 04 | Key 加密存储，任何响应/日志不泄露 | PASS | 测试 “04 provider keys”（密文不含明文、列表只返回遮罩）；测试 15 断言全部日志不含 Key；CSV 导出不含 Key |
| 05 | 成员用 OpenCode 企业模式登录、选择项目组与模型 | PASS | **原生 OpenCode CLI** 手工验证：`auth login opencode` → `/device` 授权 → `models` 仅显示 `saorsa/mock-chat`；官方 1.x 客户端通过 well-known 接入同样通过（见 C1） |
| 06 | 真实模型调用、流式显示、工具调用不被破坏 | PASS（mock）/ **BLOCKED（真实模型）** | `opencode run` 经网关流式输出 mock 回复；网关对 SSE 字节透传。当前环境无真实供应商 Key，真实模型与真实工具调用回合**未验证** |
| 07 | 记录 token/模型/用户/项目/费用，后台 5 秒内可见 | PASS（mock） | 测试 06/07（ledger 与请求一致、SSE 收到 `usage.request`）；浏览器中总览页在 OpenCode 请求后约 2 秒内从 23→25 次自动更新 |
| 08 | 切换项目后费用分别归集、不重复 | PASS | 测试 08、08b（含服务端切换会话计费项目并留痕） |
| 09 | 同一幂等键重试不重复入账 | PASS | 测试 09：409 `duplicate_request`，ledger 不变 |
| 10 | 无 usage 时显示估算 | PASS | 测试 10：`billing_status=estimated`、ledger `estimated=true` |
| 11 | 预算耗尽拒绝、并发不无界超额 | PASS | 测试 11（8 并发，`spent+reserved ≤ limit`，402 `budget_exceeded`，临时提额后恢复并留痕）；11b 软预算告警与通知 |
| 12 | 移出项目/冻结/撤销会话后不能继续调用 | PASS | 测试 12：403 `project_access_revoked`、撤销会话 401、禁用账户 401 且无法登录 |
| 13 | 成员无法获取管理接口与事件流 | PASS | 测试 13：`/api/admin/*`、`/api/admin/events` 403；网关拒绝 Cookie |
| 14 | 无效 Key、429、5xx、流中断 | PASS | 测试 14、14b：5xx 重试成功、429 两个 Key 均冷却后返回 429、坏 Key 自动切换并冷却、流中断记 failed + 估算 |
| 15 | 敏感凭据检出且只展示脱敏摘要 | PASS | 测试 15：AWS Key + PEM 私钥检出，数据库无原文；去重；阻断模式 403 且未调用上游。本测试曾发现 PEM 正文泄露进摘录的缺陷并已修复 |
| 16 | “无关使用”仅为可复核提示，含误报处理与申诉 | PASS | 测试 16：`info` 级别、可解释依据、成员申诉、管理员标记误报并通知成员；启发式规则禁止设为阻断（422） |
| 17 | 登录、过期、刷新、退出、权限拒绝、分页筛选 | PASS（部分手工） | 测试 17、17b（刷新轮换、重放撤销、锁定与解锁）；退出与分页筛选在浏览器中手工验证；access token 过期由 `access_expires_at` 校验，未单独做时间推进测试 |
| 18 | 新机器按文档启动 | PARTIAL | 本机验证 `docker compose up --build`（迁移、Redis 鉴权、只读容器、仅 127.0.0.1 暴露、初始化与登录）；**未在另一台全新机器上验证** |
| 19 | 不影响非企业模式 | PASS | 核心仅改 1 行（未设置环境变量时与上游一致）；`packages/core` Console 插件 40 项测试通过；根目录 `bun run check` 35/35 typecheck 通过、lint 0 error |
| 20 | diff 无真实密钥、无硬编码测试账户、无无关重构 | PASS | `.env`、`.data/` 已忽略；仓库中唯一的“key”字面量是标注为测试用的 mock 上游 Key；演示账户密码随机生成且只写入被忽略的文件 |
| 21 | 无仓库/任务实体与入口 | PASS | 测试 21 检查表结构与 `projects` 列；前端无相关菜单 |
| 22 | 同组成员互不可见 | PASS | 测试 22：成员带他人 user 参数仍只得到本人数据 |
| L1 | 成员/项目组 RPM、模型/供应商 RPM、成员/项目组/模型 TPM、成员/项目组/模型/供应商并发；分布式原子性 | PASS | `test/limits.test.ts`：20 并发请求在 RPM=5 下恰好放行 5 个；TPM 窗口以真实用量修正；模型/供应商并发返回 `model_busy`/`provider_busy`；崩溃遗留租约自动过期；被拒请求退还 Token |
| L2 | 标准化错误，OpenCode 正确显示额度不足与限流重试 | PASS | `limits` 测试校验 `x-should-retry`/`retry-after`/状态码；原生 OpenCode 实测：预算耗尽立即显示“Personal daily budget exhausted…”并退出；RPM=1 时自动按 retry-after 等待重试并完成多步任务（167s） |
| L3 | 上游超时、流空闲、上下文超长透传、上游账号额度耗尽 | PASS（mock） | `limits` “upstream error semantics” 组 |
| S1 | 管理接口访问控制、成员/客户端接口鉴权、CSRF、Key 不出现在任何响应与日志、归属不可篡改 | PASS | `limits` “access control sweep” 按 OpenAPI 清单遍历全部管理接口（成员 403、匿名 401）；“attribution cannot be tampered with” |
| R1 | AI 相关性审计（关键词与审计模型） | PASS（mock 分类器） | `test/relevance.test.ts`：需显式授权与纳管模型；只产生 info；发送给分类器的内容已脱敏；同会话去重；低置信度/格式异常不记；工具结果回合不评估 |
| E1 | 管理后台 E2E：账户创建、项目组、Key 管理、模型价格、授权、成员改密、设备授权、费用查询与导出、风险复核、预算、成员隔离 | PASS | `admin-web/e2e/admin-journey.spec.ts` 11 项 |
| T1 | 连续工具调用（OpenAI 与 Anthropic） | PASS（mock） | 原生 OpenCode 实测两轮 `read` 工具调用后作答，两种协议均正常 |
| C1 | 官方 OpenCode 无需定制接入（只升级管理端） | PASS（mock 上游） | `test/opencode.test.ts` 9 项（以 `sh` 实际执行登录命令、配置格式、占位符、失效重登、滑动续期、注入防护、最低版本）；实测官方 **1.17.0**（本机安装）与 **1.19.3**（npm 最新）：登录、仅显示 Saorsa 模型、OpenAI 与 Anthropic 两种协议调用精确计费、MCP 连接、网页切换项目组后下次启动生效、撤销后 OpenCode 仍可启动并提示重新登录；OpenCode 核心源码改动为 0 |
| P1 | 真实 Provider（OpenAI 兼容 + Anthropic）请求、流式、工具、缓存与账单比对 | **BLOCKED** | 本环境无真实 Key。已提供 `scripts/verify-provider.ts` 与 `deployment.md` §7 流程；脚本已在 mock 上自检（账本与回报用量一致、取消被记为估算） |
| A1 | Anthropic Messages 协议：远程配置、流式/非流式、缓存分类计费、工具调用往返、529 重试、坏 Key 切换、估算、错误格式、预算 | PASS（mock）/ **BLOCKED（真实 Claude）** | `test/anthropic.test.ts`；原生 OpenCode 手工验证：`models` 显示 `saorsa-anthropic/mock-claude`，`run` 中 mock 请求 `read` 工具、OpenCode 本地执行并回传 `tool_result`，3 次调用均精确计费归属 alice/VISION；同时回归 `saorsa/mock-chat` 正常。真实 Anthropic API 尚未用真实 Key 验证 |
