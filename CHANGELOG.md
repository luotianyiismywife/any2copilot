# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与
[语义化版本](https://semver.org/lang/zh-CN/)。

> **脚手架说明**：本仓库是脚手架模板，版本号从 `1.0.0` 起。移植到具体平台后，
> 按你平台的发布节奏维护本文件。

## [Unreleased]

### 新增

- **离线测试**：`test-keys.mjs`（Key 选择与状态，18 项断言）、`test-rotation.mjs`（轮换循环，7 项断言）、`test-banned-rotation.mjs`（封号错误检测，9 项断言，直接导入编译产物）。
- **封号 patterns 可配置**：新增设置 `apiKeyBannedErrorPatterns`（默认 `["计费账户已被冻结", "\"code\":\"billing\"", "ref_code:400901"]`），命中即判定为封号（`reason="banned"`，持久化失效），与普通换 key 区分。

### 变更

- `@types/vscode` 精确 pin 到 `1.116.0`（与 `engines.vscode` 最低版本一致）。
- 升级 `@types/node` 22 → 26、`eslint` 9 → 10、`@eslint/js` 9 → 10、`typescript-eslint` 8.60 → 8.71。
- 修复 eslint 10 新规则报出的 5 处问题（`no-useless-assignment` × 2、`preserve-caught-error` × 3）。
- 修复 2 个高危依赖漏洞（`brace-expansion` / `js-yaml`）。
- 封号 patterns 从 `src/keys/health.ts` 硬编码改为经 `getBannedErrorPatterns()` 读取设置；`getRotationErrorPatterns()` 默认值移除封号相关文案（改由 `apiKeyBannedErrorPatterns` 承担）。
- 删除无断言的 `test-banned-detect.mjs`（其覆盖已并入 `test-banned-rotation.mjs`）。

## [1.0.0] - 2026-10-07

### 新增

- **通用脚手架**：从 [sense-audio-copilot](https://github.com/luotianyiismywife/sense-audio-copilot)
  抽出，剥离平台专属内容，保留可复用骨架。
- **平台配置单一事实来源**（`src/platform/platformConfig.ts`）：API 根地址、平台 URL、
  必需头、兜底值集中一处。
- **三协议适配器**：OpenAI 兼容（`/chat/completions`）、Anthropic（`/v1/messages`）、
  Responses（`/v1/responses`），可按模型切换或经设置强制。
- **多 API Key 管理**：SecretStorage 加密存储，三种模式（`sticky` / `rotation` / `single`），
  被动失效检测 + 轮换、瞬态整轮重试、手动可用性检测。
- **云同步（GitHub Gist）**：经 VS Code 内置 GitHub 登录跨机器同步 key/cookie/备注 三元组。
- **自动模型发现**：从 `/v1/models` 拉取实时模型列表，隐藏不可用模型、发现新模型。
- **流式 + 思考**：SSE 流式、推理/思考内容、XML ` thinking` 块解析。
- **工具调用**：VS Code `LanguageModelToolCallPart` 支持。
- **视觉代理（`ask_image`）**：纯文本模型可向视觉模型提问图片，含跨轮历史持久化。
- **Token 计数**：`o200k_base` tiktoken，原生 + 可选高级状态栏指示器。
- **套餐用量与余额**：状态栏套餐用量显示（5h/周/月窗口 + 余额），同时支持
  「仅余额」与「余额 + 用量窗口」两种数据格式。
- **Git 提交消息生成**：从 SCM 面板生成 Conventional Commit。
- **国际化**：简体中文 + 英文。

### 文档

- `PLATFORM_PORTING.md` — 分步移植指南。
- `docs/neutralization.md` — 中性化占位符与批量移植（`npm run port`）。
- `docs/retry-and-key-rotation.md` — 重试与 Key 轮换配置指南。
- `docs/multi-api-key-design.md` — 多 Key 轮换与失效切换设计。
- `docs/plan-usage-design.md` — 套餐用量与余额显示设计。
- `AGENTS.md` — 项目架构与开发规范。

### 工具

- `npm run compile` — 清理 `out/` + tsc + 编译元信息 + 设置项一致性核对。
- `npm run audit` — 7 项完整审计。
- `npm run port` — 一键批量移植（中性占位符 → 平台值）。
- `npm run test:offline` — 离线测试（无需 API Key）。
- `npm run build` — 打包 VSIX。

[Unreleased]: https://github.com/luotianyiismywife/any2copilot/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/luotianyiismywife/any2copilot/releases/tag/v1.0.0
