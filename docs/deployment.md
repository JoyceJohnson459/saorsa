# Saorsa 部署与使用说明

## 1. 本地开发（无需 Docker）

依赖：Bun 1.4.2、PostgreSQL 16、Redis 7+（macOS 可用 Homebrew 安装，无需作为系统服务运行）。

```bash
cd enterprise
bun install
sh scripts/dev-services.sh start          # 在 .data 启动 PG(55432)/Redis(56379)
cp .env.example .env                      # 按文件末尾“本地开发”段填写；生成密钥：
bun server/src/cli.ts gen-master-key      # → SAORSA_MASTER_KEYS=1:<输出>
bun server/src/cli.ts gen-bootstrap-token # → SAORSA_BOOTSTRAP_TOKEN=<输出>
bun run build                             # 构建管理前端
(cd server && bun --env-file=../.env src/index.ts)
```

打开 `http://127.0.0.1:8787` → 自动进入初始化页（需要 bootstrap token）。

可选演示数据（仅开发环境）：另开终端 `cd server && bun src/mock-upstream.ts` 启动**测试用 mock 上游**，然后 `bun --env-file=.env scripts/dev-setup.ts`，随机密码写入 `.data/dev-credentials.json`（已 git-ignore）。

测试：`cd server && bun test`（使用 `teamos_test` 库与 Redis db 1，每次重建 schema）。

## 2. Docker Compose（单机生产）

```bash
cd enterprise
cp .env.example .env    # 填写 SAORSA_PUBLIC_URL、POSTGRES_PASSWORD、REDIS_PASSWORD、SAORSA_MASTER_KEYS、SAORSA_BOOTSTRAP_TOKEN
docker compose up -d --build
```

* 只在 `127.0.0.1:${SAORSA_HTTP_PORT}` 暴露 Saorsa；PostgreSQL/Redis 不对外发布。
* 在前面放 HTTPS 反向代理（Caddy/Nginx），并保持 `SAORSA_TRUST_PROXY=true`、`SAORSA_COOKIE_SECURE=true`。反向代理需关闭对 `/gateway/` 与 `/api/*/events` 的响应缓冲（SSE/流式）。
* 容器以非 root、只读根文件系统、`cap_drop: ALL` 运行；数据在 `postgres-data`、`redis-data` 卷，请纳入备份（主密钥**不要**与数据库备份放在一起）。
* 初始化完成后从 `.env` 删除 `SAORSA_BOOTSTRAP_TOKEN` 并重启。

## 3. 录入真实模型 Key（不要在聊天或代码中粘贴 Key）

1. 管理后台 → 模型与 Key → 添加供应商：例如 `DeepSeek`，协议 OpenAI Chat 兼容，Base URL `https://api.deepseek.com/v1`；Claude 选择 Anthropic Messages 协议，Base URL `https://api.anthropic.com/v1`（必须 HTTPS 且在允许列表；其他主机加入 `SAORSA_UPSTREAM_HOST_ALLOWLIST`）。
2. “添加 Key”中粘贴 Key：服务端立即 AES-256-GCM 加密，界面仅显示遮罩。点“健康检查”验证。
3. 添加模型：上游模型 ID（如 `deepseek-chat`）、别名、上下文/输出上限、**按供应商官网价格填写每百万 Token 单价**。
4. 项目组详情 → 模型授权 → 勾选并保存；客户端约 1 分钟内同步。

主密钥轮换：在 `SAORSA_MASTER_KEYS` 追加 `2:<新key>`，设置 `SAORSA_MASTER_KEY_ACTIVE=2` 并重启，然后调用 `POST /api/admin/credentials/reencrypt`，确认后再移除旧版本。

## 4. 成员接入 OpenCode（官方客户端，无需定制）

成员安装**官方 OpenCode**（`brew install opencode` 或 `npm install -g opencode-ai`），并自行更新（`opencode upgrade`）。只需运行一次：

```bash
opencode auth login https://saorsa.tech
```

工作原理（OpenCode 1.x 原生的组织配置机制，已用官方 1.17.0 与 1.19.3 实测）：

1. OpenCode 读取 `https://saorsa.tech/.well-known/opencode`，执行其中的登录命令（`sh` + `curl`）。命令打开浏览器授权页，成员选择计费项目组并确认告知后，命令把 Saorsa 令牌输出给 OpenCode 保存。
2. OpenCode **每次启动**都会重新读取该文件和 `remote_config`（`/api/opencode/config`），用保存的令牌替换 `{env:NEXCODE_TOKEN}`，得到 Saorsa 下发的供应商、模型、价格、`enabled_providers` 限制和用量 MCP。

因此**只需升级 Saorsa 服务端**：新增模型、调价、授权变更、限流与策略在成员下次启动 OpenCode 时自动生效。系统设置中可选填“最低 OpenCode 版本”，低于该版本的客户端调用时会被提示运行 `opencode upgrade`；成员详情页可查看每台设备的客户端版本。

注意事项：

* macOS/Linux 的登录命令依赖 `sh` 与 `curl`；Windows 成员运行 `opencode auth login https://saorsa.tech/windows`，登录命令改由系统自带的 PowerShell 执行（不需要 WSL 或 Git Bash）。
* 令牌按设备会话签发，连续 30 天（`SAORSA_CLIENT_SESSION_TTL_DAYS`）未使用才过期；修改密码、禁用、强制下线或移出项目组立即失效。失效后 OpenCode 仍能启动，并显示“请重新登录”的占位模型。
* **单设备登录与 Key 独占**（默认开启，系统设置中可关闭）：同一账号在新设备登录后旧设备自动退出；每个上游 Key 同一时间只分配给一位成员，n 个 Key 即 n 人同时工作。升级后首次启动会自动执行迁移 `0003_key_leases.sql`。
* **从早期命名（TeamOS / NexCode）升级**：对外品牌为 Saorsa，OpenCode 中的供应商 id 为 `saorsa` / `saorsa-anthropic`（每次启动由服务端下发，无需操作）。令牌变量名保持 `NEXCODE_TOKEN` 不变，因此 NexCode 阶段已登录的成员**无需重新登录**；TeamOS 阶段登录的成员（变量名 `TEAMOS_TOKEN`）需重新运行一次 `opencode auth login <地址>`。本地配置里写死的 `teamos/…`、`nexcode/…` 模型名需改为 `saorsa/…`。服务端环境变量使用 `SAORSA_*`，`NEXCODE_*` 与 `TEAMOS_*` 仍被接受（同时设置时 `SAORSA_*` 优先）；Compose 项目、数据库与数据卷名保持 `teamos`，已有数据无需迁移。
* 将来的 OpenCode 2.x 也可通过其内置的组织连接接入（`opencode auth login opencode --answer server=<Saorsa 地址>`），服务端两种协议同时提供。

## 5. 受控部署方案（防绕过）

Saorsa 本身只能统计经网关的流量，**无法单独阻止**成员使用未纳管客户端或个人 Key。可执行的组合方案：

1. **托管客户端配置**：通过 MDM 预装官方 OpenCode 并引导成员执行 `opencode auth login <Saorsa>`；开启“受管客户端仅允许企业模型”（默认开启，下发 `enabled_providers` / `provider.use` 限制），必要时设置“最低 OpenCode 版本”。
2. **出口网络策略**：在企业防火墙/代理上仅允许 Saorsa 服务器访问上游供应商域名（`api.openai.com`、`api.deepseek.com` 等），开发终端直连这些域名一律阻断。这是真正的强制点。
3. **供应商侧**：企业供应商账号只签发给 Saorsa 使用的 Key，不向个人分发；定期轮换。
4. **终端管理**：MDM 限制安装未签名的 OpenCode 构建（可选）。
5. **云端/托管工作区**（可选，非本期范围）：完全托管的开发环境才能保证全部流量受控。

未落实第 2 项时，产品界面与报表均标注“仅统计受管调用”。

## 6. 限流与超时配置

| 维度 | 配置位置 | 默认 |
|---|---|---|
| 成员 RPM / 并发 / TPM | 系统设置 → 企业策略 | 120 / 6 / 2,000,000 |
| 项目组 RPM / TPM | 企业默认（系统设置）+ 项目组详情“编辑”覆盖 | 1,200 / 20,000,000 |
| 项目组并发 | 项目组“编辑” | 不限 |
| 模型 并发 / RPM / TPM | 模型与 Key → 模型目录“并发 / RPM / TPM 上限” | 不限 |
| 供应商 并发 / RPM | 模型与 Key → 供应商卡片 | 不限（建议按上游账号的速率上限设置） |
| 上游响应头超时 / 流空闲超时 | `SAORSA_UPSTREAM_HEADER_TIMEOUT_SECONDS` / `SAORSA_UPSTREAM_IDLE_TIMEOUT_SECONDS` | 300s / 300s |

被限流的请求返回 429 + `retry-after`，OpenCode 会自动等待并重试；预算不足返回 402，OpenCode 直接显示原因并停止。近 1 小时各维度的拒绝次数见“系统设置 → 网关状态”。

## 7. 真实 Provider 验证流程

前提：已按 §3 在后台录入真实 Key、添加模型（填写官方价格）并授权给某项目组。**不要**把 Key 写入脚本、命令行参数、环境变量文件或聊天。

```bash
cd enterprise
bun scripts/verify-provider.ts --origin https://saorsa.tech --model <OpenAI兼容模型别名>
bun scripts/verify-provider.ts --origin https://saorsa.tech --model <Anthropic模型别名>
```

脚本打印设备码链接，用**成员**账号在浏览器中授权并选择计费项目组（与 OpenCode 登录方式相同，脚本不接触密码或 Key）。随后发起真实计费调用（预计几美分）：非流式、流式、流式中途取消、强制工具调用往返、相同长前缀两次（缓存命中），并把 Saorsa 账本与供应商在响应中回报的用量逐项比对。报告写入 `.data/provider-verification-*.json`（已 git-ignore），其中包含 `upstream_request_id` 与时间，用于在供应商控制台核对账单。

再用原生 OpenCode 做一次带多轮工具调用的真实编码任务：`opencode run -m saorsa/<别名> "..."` 与 `-m saorsa-anthropic/<别名>`，在后台核对每一步的请求、Token、缓存与费用。

## 8. 自动化测试

```bash
cd server && bun run test            # 单元 + 集成（真实 PG/Redis + 标注 TEST 的 mock 上游）
cd admin-web && bun run test:e2e     # 构建前端后运行 Playwright 端到端（真实后端，teamos_e2e 库）
```

E2E 默认使用本机已安装的 Google Chrome（无需下载浏览器）；CI 中可 `bunx playwright install chromium` 后设置 `PLAYWRIGHT_CHANNEL=chromium`。

## 9. 运维要点

* 健康检查：`/healthz`（进程）、`/readyz`（PG+Redis）；后台“系统设置 → 网关状态”。
* 每分钟维护任务：关闭超过 30 分钟未完成的请求（计费标记 unknown 并释放预留）、过期设备码、按保留期清理通知/风险证据/请求明细中的标识信息。
* 日志为 JSON 行，统一脱敏（Key、Token、密码、Authorization）。

## 10. 域名与 HTTPS（目标域名 saorsa.tech）

`saorsa.tech` 只是规划中的域名：DNS、证书与生产部署都**尚未执行**，需要你授权后再做。公开地址一律通过 `SAORSA_PUBLIC_URL` 配置，本地开发继续使用 `http://127.0.0.1:8787`。

Caddy 反向代理示例（自动申请证书；注意关闭网关与 SSE 的缓冲）：

```caddyfile
saorsa.tech {
  encode zstd gzip
  @stream path /gateway/* /api/*/events /api/me/events /api/admin/events
  reverse_proxy @stream 127.0.0.1:8787 {
    flush_interval -1
    transport http {
      read_timeout 0
    }
  }
  reverse_proxy 127.0.0.1:8787
}
```

对应 `.env`：`SAORSA_PUBLIC_URL=https://saorsa.tech`、`SAORSA_TRUST_PROXY=true`、`SAORSA_COOKIE_SECURE=true`。Cursor 的自定义 Base URL 请求由 Cursor 云端发出，使用 Cursor 时网关必须可从公网访问。

## 11. 工具中心与 Saorsa Launcher

1. 管理员在 **项目组详情 → 工具授权** 勾选允许的工具（新项目组默认只有 OpenCode），在 **模型与密钥** 中为模型标注能力并可限定允许的工具。Codex 需要协议为 **OpenAI Responses** 的供应商，Gemini CLI 需要 **Gemini 原生 API** 的供应商（网关不做协议转换）。
2. 构建并打包 Launcher：`cd launcher && bun run package`，在 `dist/` 中得到三个平台的构建、各自的 `.sha256`、`.gz` 压缩副本（约为原大小一半）和 `VERSION`。把 `dist/` 中的全部文件**一起**放进服务器的下载目录并设置 `SAORSA_DOWNLOADS_DIR`（Compose 中挂载为只读卷）。成员运行 `[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; irm <地址>/install.ps1 | iex`（Windows；Windows PowerShell 5.1 默认未启用 TLS 1.2，需先启用）或 `curl -fsSL <地址>/install.sh | sh`（macOS）安装：脚本内嵌校验值，下载 `.gz`（URL 带校验值 `?v=<sha256>` 并返回 `immutable` 缓存头；若前面有 Cloudflare 等 CDN，可在边缘缓存，减少服务器出网流量），校验通过后才安装。`.gz` 与构建必须同时更新，否则校验失败。
   * 下载速度取决于服务器的**出网带宽**：小规格云主机常见 1 Mbps（约 120 KB/s，40 MB 需要 5–6 分钟）。在云控制台把公网带宽调高，或改为按流量计费并设置较高的带宽峰值，是最有效的提速方法。**正式分发前仍需完成 Apple 代码签名与公证、Windows Authenticode 签名**（尚未完成）。
3. 成员：`saorsa login --server https://saorsa.tech` → 浏览器确认 → `saorsa tools` → `saorsa install claude-code` → `saorsa launch claude-code --dir ~/my-project`。IDE 类工具：`saorsa configure cursor --key --project <项目组>` 签发工具 Key 并按提示填入 IDE 设置，或在网页 **工具中心** 生成。
4. 详细安全设计见 `docs/launcher.md`，各工具实测状态见 `docs/tool-compatibility-matrix.md`。

## 12. 真实工具实验（可复现）

```bash
# 在临时目录隔离安装官方 CLI（不影响全局环境）
npm install --prefix /tmp/saorsa-lab-tools @openai/codex @google/gemini-cli @qwen-code/qwen-code @github/copilot cline @kilocode/cli
cd server
SAORSA_LAB=1 SAORSA_LAB_BIN=/tmp/saorsa-lab-tools/node_modules/.bin bun test --timeout 300000 test/lab.test.ts
```

需要本机已安装 `claude` 与 `opencode`；缺少的工具会被跳过。实验只证明链路与计费，不代表真实模型效果。

