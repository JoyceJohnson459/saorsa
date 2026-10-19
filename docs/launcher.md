# Saorsa Launcher

经成员授权、运行在成员本机的轻量命令行程序。网站不能（也不应该）直接在成员电脑上安装软件或启动命令，这些动作都由 Launcher 在成员确认后完成。

## 技术选型

| 方案 | 结论 |
|---|---|
| **Bun 编译的单文件 CLI（采用）** | 仓库本就是 Bun + TypeScript，直接复用 12 款工具的目录（`catalog/tools.ts`）与服务端协议；`bun build --compile` 在这台 Mac 上就能交叉编译 macOS arm64 / x64 与 Windows x64；无需新的运行时或 UI 框架 |
| Tauri（Rust + WebView） | 本机有 Rust 工具链，但会新增一整套 Rust/前端构建、签名与更新链路；图形界面不是本阶段必需 |
| Electron | 体积与攻击面过大，不符合“轻量” |

代价：没有图形界面（命令行交互）；单文件约 60–85 MB（内含 Bun 运行时）；尚未做代码签名与公证（见“未完成”）。

## 命令

```text
saorsa login --server <URL> [--label <设备名>]   浏览器设备码登录（与 OpenCode 相同的授权页）
saorsa logout                                    退出：服务端撤销 Launcher 会话（其签发的工具令牌同时失效），删除本机凭据
saorsa status                                    账户、项目组与授权工具
saorsa tools                                     检测 12 款工具并上报安装状态
saorsa install|update|uninstall <工具> [--yes]   从官方来源安装 / 更新 / 卸载
saorsa configure <工具> [--yes] [--key --project <项目组>]
saorsa restore <工具>                            撤销 Launcher 对该工具配置的修改
saorsa launch <工具> [--dir <目录>] [--project <项目组>] [--model <模型>] [--yes] [-- 工具参数]
saorsa doctor                                    诊断：服务器、登录、凭据存储、网关凭证、工具检测
saorsa guide <工具> [--model <模型>]             在终端显示该工具的详细连接方式（不显示 Key）
```

构建：`cd launcher && bun run build` → `dist/saorsa-macos-arm64`、`dist/saorsa-macos-x64`、`dist/saorsa-windows-x64.exe`。

## 安全设计

* **不执行服务器下发的命令**：安装命令、配置模板、启动配方全部编译在 Launcher 里（来自经审查的 `catalog/tools.ts`）。服务器只返回工具 id、项目组与模型别名；不存在把服务器字符串交给 shell 的路径，所有子进程都以参数数组启动。
* **每个动作先征得同意**：安装、卸载、改配置、启动前列出来源、命令与影响，需输入 `y`；脚本可用 `--yes` 预先同意；非交互终端且未带 `--yes` 时拒绝执行。
* **安装只走官方来源**：npm 包（`registry.npmjs.org`，npm 按 sha512 integrity 校验，安装前显示版本与 integrity）、VS Code Marketplace 扩展（由 VS Code 校验签名）；IDE 与 JetBrains 插件**只打开官方下载页**，不假装安装成功。
* **凭据**：Launcher 会话令牌存放在 macOS Keychain / Windows DPAPI（当前用户）/ Linux Secret Service，通过 stdin 传入，不出现在进程列表；无凭据存储时退回 0600 文件并明确提示。启动工具时向服务器申请**短期（默认 12 小时，不续期）、绑定单个工具与项目组**的子令牌，只放进子进程环境变量，不写入任何配置文件。
* **不泄露个人 Key**：启动配方会从子进程环境中移除 `ANTHROPIC_API_KEY`、`GOOGLE_API_KEY` 等变量，避免个人 Key 被发到 Saorsa 或被工具优先使用。
* **只改自己负责的那一项**：唯一会修改的成员文件是 Gemini CLI 的 `~/.gemini/settings.json`（`security.auth.selectedType`），修改前备份到 Launcher 目录，`saorsa restore gemini-cli` 只把这一项还原，且只在它仍是 Launcher 写入的值时还原。Codex 的 provider 通过 `-c` 参数内联传入，不改 `~/.codex/config.toml`。
* **日志**：`~/.saorsa/logs/launcher.log`（Windows：`%APPDATA%\Saorsa\logs`），写入前脱敏 Saorsa 令牌、常见供应商 Key 与认证头。
* **不上传源码**：上报内容只有工具 id、是否安装、版本、是否已配置、错误摘要、操作系统与架构；不上传路径、文件名或文件内容。
* **卸载 Launcher**：删除可执行文件与 `~/.saorsa` 即可；Launcher 从不删除成员的个人配置、代码或工具。

## 单设备登录

Launcher 会话按设备计：在设备 B 登录 Launcher 会撤销设备 A 的 Launcher 会话以及它签发的所有工具令牌（父子会话级联）。不同工具在同一台机器上各自独立，不互相顶替。

## 已验证

* `launcher/test/unit.test.ts`（10 项）、`launcher/test/e2e.test.ts`（8 项，真实服务端）：登录、凭据只在凭据存储中、检测与上报、启动时环境注入与个人 Key 移除、无 `--yes` 拒绝、IDE 只给官方下载页、Gemini 配置/还原、另一设备登录后令牌失效、退出。
* `server/test/lab.test.ts`：Launcher 启动真实的 Claude Code、Codex、Gemini CLI、Qwen Code、Copilot CLI，完成工具调用往返并精确计费。
* 编译后的 macOS arm64 二进制：在临时 npm 前缀中完成 `install / update / uninstall qwen-code`，并在临时钥匙串中完成 Keychain 读写删除（未触碰登录钥匙串）。

## 未完成 / 未验证

* Windows 版未在 Windows 上运行；macOS Intel 版仅在 Rosetta 下验证 `--version`。
* 未做 Apple 代码签名与公证、Windows Authenticode 签名；分发时需要先完成签名，否则系统会拦截。
* 未实现 Launcher 自动更新；更新方式为下载新版本替换可执行文件。
* JetBrains AI Assistant 插件只能检测其插件目录，未找到时报告“无法确定”。
