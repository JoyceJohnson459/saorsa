# Saorsa

**AI Development Under Control · 让 AI 编程，更可控、更安全、更高效**

统一 AI 编程工具入口、企业模型网关、用量计费与治理平台。成员登录 Saorsa，从固定支持的 12 款工具（OpenCode、Claude Code、Codex CLI、Gemini CLI、Cline、Kilo Code、Qwen Code、TRAE、Qoder、JetBrains AI Assistant、GitHub Copilot、Cursor）中选择授权的工具；管理员集中配置模型、API Key、权限、预算与风险策略；请求经企业网关后统计真实用量与费用。

只有 Admin 与 Member 两种账户；项目组只用于成员归属、模型与工具授权、费用归集、预算与审计。**不包含任何项目协作功能**（共享仓库、代码同步、任务看板、PR/Issue、多 Agent 协作）。Saorsa 不是新的大模型，也不把第三方工具改造成同一种工具；无法经过网关的第三方能力会被明确标注。

* 使用指南（管理员与成员）：[docs/user-guide.md](docs/user-guide.md)
* 工具兼容矩阵（12 款工具逐一实测状态）：[docs/tool-compatibility-matrix.md](docs/tool-compatibility-matrix.md)
* Saorsa Launcher：[docs/launcher.md](docs/launcher.md)
* 安全说明：[docs/security.md](docs/security.md)
* 架构：[docs/architecture.md](docs/architecture.md) · 部署：[docs/deployment.md](docs/deployment.md) · 决策：[docs/decisions.md](docs/decisions.md) · 验收：[docs/acceptance.md](docs/acceptance.md)
* 进度与遗留问题：[IMPLEMENTATION_PROGRESS.md](IMPLEMENTATION_PROGRESS.md) · API 清单：运行后访问 `/api/openapi.json`

```
saorsa/
  catalog/      12 款工具的档案（服务端与 Launcher 共用，经审查的代码）
  server/       Bun + Hono API、四协议 AI 网关、迁移、测试、mock 上游（仅测试）
  admin-web/    Vue 3 + Element Plus 管理员与成员控制台（Saorsa 设计体系）
  launcher/     Saorsa Launcher（Bun 编译的单文件 CLI：macOS arm64/x64、Windows x64）
  scripts/      本地 PG/Redis、演示数据、真实 Provider 验证脚本
  docs/
```

> 监控覆盖范围仅限经 Saorsa 网关的受管调用，防绕过需结合托管客户端、出口网络策略与终端管理（见 [docs/security.md](docs/security.md)）。

## License

[MIT](LICENSE)
