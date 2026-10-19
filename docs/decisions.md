# 工程决策记录（NexCode）

| # | 决策 | 原因 / 取舍 |
|---|---|---|
| D1 | 复用 OpenCode 内置“Console 组织连接”协议接入客户端，而不是新写客户端插件或改模型调用链 | 该协议已提供设备码登录、可配置服务器、组织作用域、远程 provider/策略/MCP 下发；原生客户端零改动即可接入，与上游冲突最小。项目组映射为“组织”，所选组织即计费项目组 |
| D2 | ~~核心改 1 行：`OPENCODE_CONSOLE_URL`~~（已由 D23 取代并撤销） | 官方客户端通过 well-known 接入后不再需要任何核心改动 |
| D3 | `` 独立于上游 Bun workspace（自有 `package.json`/`bun.lock`） | 不修改根 `package.json`/`bun.lock`，避免与上游合并冲突 |
| D4 | 服务端：Bun + Hono + zod；PostgreSQL 用 Bun.SQL + 版本化 SQL 迁移（未引入 Prisma/Drizzle） | 预算并发控制需要精确的 `FOR UPDATE`/事务语义，直接 SQL 最清晰；迁移有序号、校验和、advisory lock，满足严格版本管理；减少依赖（仅 hono、zod）。Bun 内置 Argon2id、Redis 客户端 |
| D5 | API 与网关同进程 | 单机即可启动；无状态，可多副本；如需拆分只需按路由前缀在反向代理分流 |
| D6 | 管理前端用 Vue 3 + Element Plus + ECharts | 需求指定的团队栈；与 OpenCode 自带 Solid UI 完全隔离 |
| D7 | 金额用 BIGINT 微单位；价格为每百万 Token 的微单位；逐行四舍五入 | 无浮点累计；价格追加式版本，请求开始时冻结 |
| D8 | 计费以上游 usage 为准；缺失时写入 `estimated=true` 的估算并标记 `billing_status=estimated`；进程中断的请求标记 `unknown` 并释放预留 | 不捏造精确值；不因客户端断开重复计费 |
| D9 | 预算采用“预留-结算”：按最坏情况预留（网关强制 `max_tokens`），结算时释放 | 并发不会无界超额；代价是额度临近时可能拒绝实际花费很小的请求（见 known-issues） |
| D10 | 上游 5xx/网络错误同 Key 退避重试；401/403/429 冷却该 Key 并切换；不做跨模型回退 | 避免自动升级到更贵模型产生未知费用；重试记录为同一请求的 attempts，不重复计费 |
| D11 | 仅确定性规则（敏感凭据）可阻断；关键词/AI 相关性只能生成“信息提示” | 符合“AI 分类不得直接认定违规”；`audit_model` 模式需显式 `allow_audit_model=true` |
| D12 | 不保存对话全文（`retainFullContent` 固定 false） | 最小化采集；风险证据只存脱敏片段 + 哈希指纹，并有保留期清理 |
| D13 | 成员可在 Web 端切换某个客户端会话的计费项目组（下一次调用生效），每次切换留痕并参与“频繁切换”检测 | 满足“允许手动切换并留下事件记录”；OpenCode 中的 provider 名称包含项目编号，约 1 分钟随配置刷新 |
| D14 | 个人用量在 OpenCode 内通过 NexCode 下发的 MCP 工具（`nexcode_status`、`nexcode_usage`）展示 | 无需改 TUI；数据只含调用者本人 |
| D15 | 默认时区 Asia/Shanghai（初始化时可改） | 预算日/月切分与报表聚合按组织时区 |
| D16 | Mock 上游（`server/src/mock-upstream.ts`）仅用于自动化测试/本地演示，名称与数据均显式标注 TEST；生产配置禁止私网上游 | 当前环境无真实模型 Key；不伪造真实调用成功 |
| D19 | 限流全部用 Redis Lua 原子脚本：请求/Token 用滑动窗口计数，并发用带租约的有序集合信号量 | 多副本下无竞态超发；进程崩溃不会永久占用并发槽（旧实现的 INCR/EXPIRE 计数在长流超过 TTL 时会变负）。代价：依赖各网关节点时钟基本同步（NTP） |
| D20 | TPM 准入只按输入估算计入，输出在结算时补记 | 若按 `max_tokens` 预占，代理型长输出请求会大量误拒；预算系统已负责“最坏情况”费用上限 |
| D21 | 网关所有错误携带 `x-should-retry`，上游 4xx 透传状态与错误码 | 与 OpenCode 重试/上下文溢出识别逻辑一致：可恢复的才重试，预算/权限/配置错误立即停止并显示原因 |
| D22 | AI 相关性审计模型改为引用纳管模型别名（`model_alias`），不再接受任意 endpoint | 消除管理员配置导致的 SSRF/数据外发到未审批地址的风险；审计调用属于组织开销，不记入成员账本 |
| D17 | Anthropic 协议走独立端点 `/gateway/anthropic/v1/messages`，远程配置下发 OpenCode 原生 `@opencode/ai/providers/anthropic` 包（provider `nexcode-anthropic`），不做 OpenAI↔Anthropic 协议转换 | 原生包保留提示缓存、思考、工具调用等语义；网关只做字节透传 + usage 解析，避免脆弱的协议互转。两个端点共享同一治理流水线（`protocols.ts` 适配器） |
| D18 | 流式用量区分“最终/初步”；接受请求（HTTP 200）后若无任何用量，按输入估算计费而不是记为不计费 | Anthropic `message_start` 只有初步输出数，曾导致中断流被误记为精确；上游已处理提示词即可能已收费，宁可标记估算待对账 |
| D23 | 以官方 OpenCode 1.x 的 `/.well-known/opencode` + `remote_config` 作为主要接入方式，并撤销对 OpenCode 核心的唯一一处修改 | 当前稳定版是 1.x（2.x 未发布）；该机制每次启动下发配置，满足“只升级管理端、成员自行更新客户端”。登录命令为 `sh`+`curl`；Windows 改用 `<origin>/windows` 的 PowerShell 登录命令（OpenCode 不经 shell 直接启动该命令，Windows 无 `sh`） |
| D24 | 1.x 会话令牌无刷新流程，改为随使用滑动续期（默认 30 天无使用过期），仍按设备、绑定项目组、哈希存储并可即时撤销 | 1.x well-known 登录只保存一个令牌；短期令牌会迫使成员频繁重新登录 |
| D25 | 令牌失效时 `remote_config` 仍返回 200，只含“请重新登录”占位模型 | 1.x 拉取远程配置失败会阻止 OpenCode 启动；占位模型让调用到达网关并返回带登录命令的 401 |
| D26 | 可选“最低 OpenCode 版本”，按 User-Agent 返回 426 + `x-should-retry: false`；开发版/未知 UA 不拦截 | 成员自行升级时管理员仍能设定兼容下限；成员详情显示各设备客户端版本 |
| D27 | 产品更名为 NexCode：对外可见的名称、供应商 id（`nexcode`、`nexcode-anthropic`）、MCP 名与工具、令牌变量 `NEXCODE_TOKEN`、响应头 `x-nexcode-request-id`、环境变量 `NEXCODE_*` 全部更新；Redis 键、Cookie、CSRF 头、`tos_` 令牌前缀、数据库/Compose 卷名与包名保持原 id | 对外一次性改名，已登录成员只需重新登录一次；内部 id 不变以免迁移数据或使现有 Web 会话、令牌失效。`TEAMOS_*` 环境变量作为旧名继续接受 |
| D28 | 单设备登录（默认开启），网页与 OpenCode 两个通道分别生效：新登录撤销同通道的其他会话（`revoke_reason = 'replaced'`），在线控制台通过 SSE 立即退出，网关/远程配置返回“账号已在其他设备登录” | 满足“B 登录后 A 自动登出”；分通道是因为成员在浏览器中授权 OpenCode 登录时，网页会话不能被它自己创建的客户端会话踢掉 |
| D29 | Key 独占分配（默认开启，可改为共享）：`credential_leases` 以 Key 为主键、以成员为唯一键，保证一 Key 一人、一人一 Key；成员首次调用某供应商的模型时先选先得，换供应商仅在对方有空闲 Key 时切换；空闲超时（默认 30 分钟，进行中的请求不计空闲）、无 OpenCode 登录、账号停用、Key 停用/撤销时自动释放；被分配的 Key 失效时只会换到其他空闲 Key，绝不借用他人的 Key | 满足“加了 n 个 Key 就只有 n 人能同时用”。数字显示与下拉选择放在网页工作台（实时、0 不可选），因为 OpenCode 1.x 的模型列表只在启动时下发，无法实时显示数量或禁用选项；OpenCode 内通过错误提示和 `nexcode_status` 告知可用数量。代价：同一成员同时使用两个供应商的模型时会在两者间切换 Key |
| D30 | 产品对外品牌统一为 Saorsa；OpenCode 供应商 id 改为 `saorsa` / `saorsa-anthropic`，但令牌变量名保持 `NEXCODE_TOKEN` | 供应商 id 每次启动由服务端下发，改名无需成员操作；令牌变量名由 OpenCode 在登录时保存，改名会迫使所有成员重新登录。Redis 键、Cookie、CSRF 头、`tos_` 前缀、数据库与包名保持原内部 id |
| D31 | 12 款工具的档案写成经审查的代码（`catalog/tools.ts`），服务端与 Launcher 共用；运行时只有授权、会话与上报进数据库 | 安装命令与启动配方不能来自服务器或数据库，否则服务端被攻破即可让 Launcher 执行任意命令；同一份目录也避免两端不一致 |
| D32 | 工具状态只来自证据：部署内的 Launcher 上报与网关请求，以及本仓库实验记录（单独标注 mock 上游） | 满足“出现在工具中心不等于完成集成”；实验记录不冒充生产状态 |
| D33 | 新增 OpenAI Responses 与 Gemini 原生两个透传适配器，不做 Chat↔Responses、Chat↔Gemini 转换 | 转换会丢失工具调用、推理与缓存语义，也无法诚实宣称原生协议已支持；代价是 Codex 只能用支持 Responses 的上游、Gemini CLI 只能用 Gemini API |
| D34 | 每个客户端会话绑定一个工具；工具授权在项目组级（`project_tools`），模型可再限定工具（`allowed_tools`） | 网关据此做工具授权与归属，不信任客户端请求头；项目组级授权与已有的模型授权方式一致 |
| D35 | 单设备登录按通道计算：网页、Launcher（含其子令牌）、各工具分别计算 | 同一台机器同时使用多个工具时不互相顶替，同时仍满足“B 设备登录后 A 设备退出” |
| D36 | Launcher 用 Bun 编译的单文件 CLI，而不是 Tauri/Electron | 复用仓库 TypeScript 代码与工具目录；一台 Mac 即可交叉编译 macOS arm64/x64 与 Windows x64；不引入新框架。代价：无图形界面、单文件约 60–85MB、签名与公证尚未完成 |
| D37 | Launcher 每次启动向服务端申请短期（默认 12 小时、不续期）子令牌，只放进子进程环境；能用环境变量/参数配置的工具不写任何文件（Codex 用 `-c` 内联 provider），唯一修改的是 Gemini CLI 的一项认证设置并可还原 | 满足“不把 Key 写入普通明文配置”“只管理 Saorsa 创建的配置”；Gemini CLI 拒绝非 root 所有的系统设置文件，只能改成员自己的 settings.json |
| D38 | IDE 类工具（Cline、Kilo、Cursor、TRAE、Qoder、JetBrains、VS Code Copilot Chat）由成员在工具自身设置中填写工具 Key；Launcher 不改 IDE 内部存储，IDE 类软件不自动安装、只打开官方下载页 | IDE 把密钥存在各自的加密存储中，外部改写既不受支持也有风险；这些工具多数还需要厂商账户，不能由 Saorsa 代为登录 |
