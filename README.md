<div align="center">

# Copilot Provider Scaffold

[English](#english) | [中文](#中文)

</div>

## English

> [!IMPORTANT]
> **This is a scaffold / template, not a ready-to-use extension.** It contains no platform-specific
> credentials, endpoints or model definitions. You must fill in your own platform's details before
> it can talk to any API. See [`PLATFORM_PORTING.md`](PLATFORM_PORTING.md).

A **VS Code extension scaffold** for integrating any **three-protocol-compatible platform**
(OpenAI / Anthropic / Responses) into GitHub Copilot Chat as a language-model provider. It was
extracted from [sense-audio-copilot](https://github.com/luotianyiismywife/sense-audio-copilot) by
stripping out everything platform-specific and keeping the reusable skeleton.

### What you get

| Capability | Description |
|------------|-------------|
| **Chat model provider** | Implements `LanguageModelChatProvider`, registers as a vendor in the model picker |
| **Three API protocols** | OpenAI-compatible (`/chat/completions`), Anthropic (`/v1/messages`), Responses (`/v1/responses`) — switchable per model or forced via a setting |
| **Multi API key management** | Encrypted SecretStorage store, three modes (`sticky` / `rotation` / `single`), passive failure detection + rotation, transient whole-round retry, manual availability check |
| **Cloud sync (GitHub Gist)** | Sync key/cookie/label triples across machines via VS Code's built-in GitHub sign-in (no PAT). Manual push/pull, startup auto-pull, and optional debounced auto-push after key-management actions |
| **Auto model discovery** | Fetch the live model list from `/v1/models`, hide unavailable models, discover new ones |
| **Streaming + thinking** | SSE streaming, reasoning/thinking parts, XML ` thinking` block parsing |
| **Tool calling** | VS Code `LanguageModelToolCallPart` support |
| **Vision proxy (`ask_image`)** | Text-only models can ask a vision model about images, with cross-turn history persistence |
| **Token counting** | `o200k_base` tiktoken, native + optional advanced status-bar indicator |
| **Plan usage & balance** | Status-bar plan-usage display (5h/weekly/monthly windows + balance), **supports both "balance-only" and "balance + usage windows" data shapes** |
| **Git commit messages** | Conventional-commit generation from the SCM panel |
| **i18n** | Simplified Chinese + English |

### How to use this scaffold

1. Read [`PLATFORM_PORTING.md`](PLATFORM_PORTING.md) — the step-by-step porting guide.
2. Edit **`src/platform/platformConfig.ts`** — the single source of truth for API base URL,
   platform URLs, required headers and fallback values.
3. Global-replace the platform identity in **`package.json`** (vendor id, command prefix, package
   name, publisher) and **`src/core/localize.ts`** + `package.nls*.json` (display strings).
4. Implement the two **porting hooks** in `src/balance/`:
   - `accountInfo.ts` → `queryAccountInfo()` (endpoint + field mapping)
   - `planUsage.ts` → `buildSnapshot()` is already generic; only adjust if your platform's window
     keys differ.
5. Run `npm run compile && npm run audit` and fix any drift.

> [!TIP]
> The scaffold is designed so that **only `platformConfig.ts` + `package.json` + the two balance
> hooks** need editing for a typical port. Everything else (protocol adapters, key rotation,
> tokenizer, vision proxy, status bar) is platform-agnostic.

### Project structure

```
src/
├── platform/platformConfig.ts   ← 移植第一站（URL / 头 / 兜底值）
├── api/                         ← 三协议适配器 + 共享 SSE / HTTP
├── provider/                    ← Chat Provider 编排 + key 轮换 + 视觉代理轮次
├── keys/                        ← 多 key 管理（增删改 / 轮换 / 冷却 / 检测）
├── balance/                     ← 余额 / 套餐用量（移植对接点）
├── models/                      ← 模型定义与自动发现
├── commands/                    ← 命令与 QuickPick UI
├── core/                        ← 日志 / l10n / 工具函数
├── ui/statusBar.ts              ← 状态栏（套餐用量 + Token 指示器）
├── cloud/                       ← GitHub Gist 云同步（cloudSync.ts + syncPayload.ts）
├── gitCommit/                   ← Git 提交消息生成
├── tokenizer/                   ← o200k_base token 计数
└── vision/                      ← ask_image 图片代理
```

### Build

```bash
npm install
npm run compile    # clean out/ + tsc + build-info + settings check
npm run audit      # 7-item audit (settings drift / unused exports / …)
npm run test:offline
npm run build      # packages <name>-<version>.vsix
```

### License

AGPL-3.0 License. This scaffold builds upon the architecture of
[opencode-go-copilot](https://github.com/OnesoftQwQ/opencode-go-copilot) (MIT) and
[oai-compatible-copilot](https://github.com/JohnnyZ93/oai-compatible-copilot) (MIT).

---

## 中文

> [!IMPORTANT]
> **这是一个脚手架 / 模板，不是开箱即用的插件。** 它不含任何平台专属的凭据、端点或模型定义。
> 你必须先填入自己平台的信息才能对接 API。详见 [`PLATFORM_PORTING.md`](PLATFORM_PORTING.md)。

一个把**任意三协议兼容（OpenAI / Anthropic / Responses）平台**接入 GitHub Copilot Chat 的 **VS Code 扩展脚手架**。
它从 [sense-audio-copilot](https://github.com/luotianyiismywife/sense-audio-copilot) 抽出：
剥离所有平台专属内容，只保留可复用的骨架。

### 包含的能力

| 能力 | 说明 |
|------|------|
| **Chat 模型提供商** | 实现 `LanguageModelChatProvider`，在模型选择器中注册为厂商 |
| **三协议支持** | OpenAI 兼容（`/chat/completions`）、Anthropic（`/v1/messages`）、Responses（`/v1/responses`）——可按模型切换或经设置强制 |
| **多 API Key 管理** | SecretStorage 加密存储，三种模式（`sticky` / `rotation` / `single`），被动失效检测 + 轮换、瞬态整轮重试、手动可用性检测 |
| **云同步（GitHub Gist）** | 经 VS Code 内置 GitHub 登录（无需 PAT）跨机器同步 key/cookie/备注 三元组。支持手动推送/拉取、启动自动拉取，以及可选的 key 管理操作后去抖自动推送 |
| **自动模型发现** | 从 `/v1/models` 拉取实时模型列表，隐藏不可用模型、发现新模型 |
| **流式 + 思考** | SSE 流式、推理/思考内容、XML ` thinking` 块解析 |
| **工具调用** | 支持 VS Code `LanguageModelToolCallPart` |
| **视觉代理（`ask_image`）** | 纯文本模型可向视觉模型提问图片，含跨轮历史持久化 |
| **Token 计数** | `o200k_base` tiktoken，原生 + 可选高级状态栏指示器 |
| **套餐用量与余额** | 状态栏套餐用量显示（5h/周/月窗口 + 余额），**同时支持「仅余额」与「余额 + 用量窗口」两种数据格式** |
| **Git 提交消息** | 从 SCM 面板生成 Conventional Commit |
| **国际化** | 简体中文 + 英文 |

### 如何使用本脚手架

1. 阅读 [`PLATFORM_PORTING.md`](PLATFORM_PORTING.md) —— 分步移植指南。
2. 编辑 **`src/platform/platformConfig.ts`** —— API 根地址、平台 URL、必需头、兜底值的单一事实来源。
3. 在 **`package.json`**（vendor id、命令前缀、包名、publisher）与 **`src/core/localize.ts`** +
   `package.nls*.json`（显示文案）中全局替换平台身份。
4. 实现 `src/balance/` 中的两个**移植对接点**：
   - `accountInfo.ts` → `queryAccountInfo()`（端点 + 字段映射）
   - `planUsage.ts` → `buildSnapshot()` 已是通用逻辑；仅当你的平台窗口 key 命名不同时才需调整。
5. 运行 `npm run compile && npm run audit` 并修复任何漂移。

> [!TIP]
> 脚手架的设计目标是：典型移植**只需改 `platformConfig.ts` + `package.json` + 两个 balance 对接点**。
> 其余部分（协议适配器、key 轮换、分词器、视觉代理、状态栏）均与平台无关。

### 项目结构

```
src/
├── platform/platformConfig.ts   ← 移植第一站（URL / 头 / 兜底值）
├── api/                         ← 三协议适配器 + 共享 SSE / HTTP
├── provider/                    ← Chat Provider 编排 + key 轮换 + 视觉代理轮次
├── keys/                        ← 多 key 管理（增删改 / 轮换 / 冷却 / 检测）
├── balance/                     ← 余额 / 套餐用量（移植对接点）
├── models/                      ← 模型定义与自动发现
├── commands/                    ← 命令与 QuickPick UI
├── core/                        ← 日志 / l10n / 工具函数
├── ui/statusBar.ts              ← 状态栏（套餐用量 + Token 指示器）
├── cloud/                       ← GitHub Gist 云同步（cloudSync.ts + syncPayload.ts）
├── gitCommit/                   ← Git 提交消息生成
├── tokenizer/                   ← o200k_base token 计数
└── vision/                      ← ask_image 图片代理
```

### 构建

```bash
npm install
npm run compile    # 清理 out/ + tsc + 编译元信息 + 设置项核对
npm run audit      # 7 项审计（设置漂移 / 未使用导出 / …）
npm run test:offline
npm run build      # 打包 <name>-<version>.vsix
```

### 许可

AGPL-3.0 License。本脚手架基于
[opencode-go-copilot](https://github.com/OnesoftQwQ/opencode-go-copilot)（MIT）与
[oai-compatible-copilot](https://github.com/JohnnyZ93/oai-compatible-copilot)（MIT）的架构构建。
