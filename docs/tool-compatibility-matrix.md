# Saorsa 工具兼容矩阵

更新：2026-10-18 · 来源：`catalog/tools.ts`（工具档案）、`server/test/lab.test.ts`（真实工具实验）、`launcher/test/e2e.test.ts`（Launcher 端到端）。

## 先读这三条

1. **所有“已验证”都只针对本仓库的实验环境**：macOS 27.2 arm64，Saorsa 网关后面是标记为 TEST 的 mock 上游。它证明了工具→网关→协议→工具调用往返→计费→归属这条链路，**不代表任何真实模型的效果，也不代表真实供应商已接入**。真实 Provider 调用尚未验证（没有真实 Key）。
2. 一个工具通过不代表其他工具通过；同一工具的 IDE 插件形态与 CLI 形态分别记录。
3. 生产环境中控制台“工具中心”显示的状态只来自该部署自己的证据（Launcher 上报、网关成功请求、精确计费），与本表的实验记录分开展示。

## 总览

| # | 工具 | 形态 | 网关协议 | 凭据方式 | 实验验证（mock 上游） | 部分托管 | 需官方账户 |
|---|---|---|---|---|---|---|---|
| 1 | OpenCode | CLI / 桌面 | Chat Completions、Anthropic Messages | `opencode auth login`（官方 well-known） | ✅ 1.17.0 | 是 | 否 |
| 2 | Claude Code | CLI / IDE 插件 | Anthropic Messages | Launcher 启动注入短期凭证 | ✅ 2.1.292（直接 + 经 Launcher） | 是 | 否 |
| 3 | Codex CLI | CLI / IDE 插件 | OpenAI Responses | Launcher 启动注入（`-c` 内联 provider，不写配置文件） | ✅ 0.163.0（直接 + 经 Launcher） | 是 | 否 |
| 4 | Gemini CLI | CLI | Gemini 原生 API | Launcher 启动注入 + 一次性认证方式设置 | ✅ 0.64.0（直接 + 经 Launcher） | 是 | 否 |
| 5 | Cline | IDE 插件 | Chat Completions / Anthropic | IDE 中填写 Saorsa Key | ⚠️ 仅官方 **CLI** 3.0.73 已验证；VS Code 插件未验证 | 是 | 否 |
| 6 | Kilo Code | IDE 插件 | Chat / Responses / Anthropic | IDE 中填写 Saorsa Key | ⚠️ 仅官方 **CLI** 7.8.12 已验证；VS Code 插件未验证 | 是 | 否 |
| 7 | Qwen Code | CLI | Chat Completions | Launcher 启动注入（仅环境变量） | ✅ 0.25.2（直接 + 经 Launcher） | 是 | 否 |
| 8 | TRAE | IDE | Chat Completions（自定义模型） | IDE 中填写 Saorsa Key | ❌ 未验证（需 TRAE 账户与图形界面） | 是 | 是 |
| 9 | Qoder | IDE / CLI | 不确定 | IDE/CLI 中填写 | ❌ 未验证；当前文档未确认可填写任意 Base URL | 是 | 是 |
| 10 | JetBrains AI Assistant | IDE 插件 | Chat Completions（BYOK） | IDE 中填写 Saorsa Key | ❌ 未验证（需 JetBrains 账户与图形界面） | 是 | 是 |
| 11 | GitHub Copilot | CLI / IDE 插件 | Chat Completions（BYOK） | CLI：Launcher 注入；VS Code：在“Manage Language Models”中填写 | ⚠️ 仅 **Copilot CLI** 1.0.98 BYOK 已验证；VS Code Copilot Chat 未验证 | 是 | 是（VS Code 补全/NES） |
| 12 | Cursor | IDE | Chat Completions（Override Base URL） | IDE 中填写 Saorsa Key | ❌ 未验证（需 Cursor 付费账户；请求从 Cursor 云端发出） | 是 | 是 |

## 已验证项目（逐项）

每个通过的实验都完成了：真实工具进程启动 → 认证 → 自定义端点 → 普通请求 → **流式** → **一次真实工具调用往返**（工具读取工作区文件并把内容带回，网关后的 mock 在下一轮回答中回显该内容）→ usage → 费用（按 mock 价格精确计费）→ 成员/项目组/工具归属。

| 工具 | 版本 | 调用方式 | 实际执行的工具 | 请求数（完成） | 版本识别 |
|---|---|---|---|---|---|
| OpenCode | 1.17.0 | 官方 `opencode auth login <saorsa>` 浏览器授权后 `opencode run` | Read | 3（含标题生成） | User-Agent `opencode/1.17.0` |
| Claude Code | 2.1.292 | `ANTHROPIC_BASE_URL=/gateway/anthropic` + `ANTHROPIC_AUTH_TOKEN` | Read | 2 | `claude-cli/2.1.292` |
| Codex CLI | 0.163.0 | `-c model_providers.saorsa={…wire_api="responses"}` | shell（只读沙箱内 `cat`） | 2 | `codex_*/0.163.0` |
| Gemini CLI | 0.64.0 | `GOOGLE_GEMINI_BASE_URL=/gateway/gemini` + `GEMINI_API_KEY`（以 `x-goog-api-key` 发送） | read_file | 2 | `GeminiCLI-tui/0.64.0` |
| Qwen Code | 0.25.2 | `OPENAI_BASE_URL/OPENAI_API_KEY/OPENAI_MODEL` + `QWEN_DEFAULT_AUTH_TYPE=openai` | read_file | 3 | `QwenCode/0.25.2` |
| Copilot CLI | 1.0.98 | `COPILOT_PROVIDER_*` + `COPILOT_MODEL`（BYOK，无需 GitHub 登录） | view | 2 | User-Agent 不含版本（仅按 Key 归属） |
| Cline CLI | 3.0.73 | `cline auth -p openai -b <saorsa>/gateway/v1` | read_files | 2 | User-Agent 不含版本 |
| Kilo CLI | 7.8.12 | `kilo.jsonc` 自定义 OpenAI 兼容 provider | Read | 3 | `Kilo-Code/7.8.12` |

经 Launcher（`saorsa launch <tool>`）再次验证：Claude Code、Codex、Gemini CLI、Qwen Code、Copilot CLI 均由 Launcher 内置的审查过的启动配方启动，使用 **Launcher 会话的子令牌**（短期、绑定工具与项目组、随 Launcher 会话撤销），每次请求均精确计费。

复现：

```bash
cd server
SAORSA_LAB=1 SAORSA_LAB_BIN=<隔离安装的 node_modules/.bin> bun test --timeout 300000 test/lab.test.ts
```

## 未验证与边界（如实）

* **VS Code 插件形态**（Cline、Kilo Code、Copilot Chat）：需要图形界面驱动 VS Code，本次未做；配置字段来自官方文档。
* **Cursor**：官方论坛反馈 Agent 模式对自定义 Base URL 发送 Responses 格式请求、BYOK 开关可能被静默关闭；Tab 补全与 Cursor 自有模型不经网关；请求从 Cursor 云端发出，网关必须可从公网访问。
* **TRAE / Qoder / JetBrains AI Assistant**：需要厂商账户登录，Saorsa 不代为登录；Qoder 当前文档只提供交互式 BYOK 向导，未确认可填写任意 Base URL。
* **Claude Code**：Anthropic 只支持经网关使用 Claude 模型；快速模式可用性检查与 WebFetch 域名安全检查会直连 api.anthropic.com（官方文档说明）。
* **Codex CLI**：只支持 Responses 协议，上游必须原生支持 Responses（网关不做 Chat↔Responses 转换）。
* **Gemini CLI**：只支持 Gemini 原生 API；Gemini CLI 只接受 root 所有的系统设置文件，因此 Launcher 需要在成员自己的 `~/.gemini/settings.json` 中设置一项（先备份，可 `saorsa restore gemini-cli` 撤销）。
* **Windows**：Launcher 已编译出 `saorsa-windows-x64.exe`，但没有在 Windows 上运行验证；DPAPI 凭据存储、`npm.cmd`/`code.cmd` 解析均未实测。macOS Intel 版仅在 Apple Silicon 的 Rosetta 下运行过 `--version`。
* **真实模型 / 真实供应商**：全部未验证。
