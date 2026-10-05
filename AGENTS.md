# Copilot Provider Scaffold — AGENTS.md

> **所有更改必须通过 `npm run compile` / `npx tsc --noEmit` 编译检查无错误通过。**  
> **每次更改后，必须同步更新本文档 (`AGENTS.md`) 以反映代码变更。**

---

## 目录

1. [项目详细介绍](#1-项目详细介绍)
2. [详细逻辑架构](#2-详细逻辑架构)
3. [程序文件索引](#3-程序文件索引)
4. [移植对接点](#4-移植对接点)
5. [函数定义大全](#5-函数定义大全)
6. [编译与构建](#6-编译与构建)
7. [开发规范](#7-开发规范)

---

## 1. 项目详细介绍

### 1.1 概述

**Copilot Provider Scaffold** 是一个 **VS Code 扩展脚手架**，用于把**任意 OpenAI 兼容平台**接入 GitHub Copilot Chat 作为语言模型提供商。它从 [sense-audio-copilot](https://github.com/luotianyiismywife/sense-audio-copilot) 抽出：剥离所有平台专属内容（URL、凭据、模型定义、字段映射），只保留可复用的骨架。

> ⚠️ **本仓库不是开箱即用的插件**。它不含任何平台凭据/端点/模型定义，必须先按 [`PLATFORM_PORTING.md`](../PLATFORM_PORTING.md) 填入自己平台的信息。

**设计目标**：典型移植**只需改 3 处**——
1. `src/platform/platformConfig.ts`（URL / 头 / 兜底值）
2. `package.json`（vendor id / 命令前缀 / 包名 / publisher）+ `src/core/localize.ts` + `package.nls*.json`（文案）
3. `src/balance/accountInfo.ts` 的 `queryAccountInfo()`（账号信息端点 + 字段映射）

其余全部（三协议适配器、key 轮换、分词器、视觉代理、状态栏、云同步、Git 提交）与平台无关，直接复用。

### 1.2 核心能力

| 能力 | 说明 |
|------|------|
| **Chat 模型提供商** | 实现 `LanguageModelChatProvider` 接口，向 VS Code 注册为厂商（vendor 由 `package.json` 声明，见移植指南 §1.2） |
| **多 API Key 轮询** | 支持多个 API Key（SecretStorage 加密存储 `<prefix>.apiKeys`），三种模式：`sticky`（默认，固定使用一个 key，仅失效时切下一个并钉住——前缀缓存命中率最高，切换后不自动切回）/ `rotation`（轮询使用、跳过不可用 key）/ `single`（仅用当前 key；`<prefix>.singleKeyFallback`（默认 `switch`）下**仅在余额不足（402）时**自动切换到下一个可用 key 并经 `setActiveKeyByValue` 设为当前使用 + 右下角弹窗提示——401 无效 Key / 429 限流 / 503 繁忙等其他错误不切换、走 single 专属报错文案；`error` 下任何错误都直接报错不切换）。**被动检测**：按请求错误（402 余额不足 / 401 无效 Key / 429 限流 / 503 服务端繁忙，状态码与文本 patterns 均可配置）判定 key 失效并切换——**402/401 持久化 `available=false`（确定性），429/503 仅内存冷却不持久化（瞬态，冷却到期自动恢复）**。**手动检测**：`<prefix>.manageApiKeys` 命令 QuickPick 管理（增删/设为当前/绑定 cookie/重置失效/检测可用性——最小真实聊天请求 `say ok`，实测余额不足时 402 拦截不耗 token）。**UI 增强**：表单式批量导入（三元组 key/cookie/备注）、检测二级界面、编辑 API Key（三字段 value/cookie/label，冲突校验）、**轮询模式下隐藏"设为当前使用"**、批量导入时已存在 key 自动更新 cookie 不重复添加、**所有 key 管理界面均显示账号余额**（登录 token 经 `getAccountInfoCached` TTL 缓存查询账号信息端点，余额按**账号**粒度、所有 key 共享）。**全部 key 用尽时**：轮换循环跟踪每个 key 的失败原因，报错列出脱敏 key + 原因（如 `sk_****abcd: 服务端繁忙 (503)`），并区分"瞬态失败请稍后重试"（429/503）与"确定性失败请检测"（402/401）。**瞬态自动重试**：全部 key 均因瞬态错误（默认 429/500/503，状态码可配置 `<prefix>.transientRetryStatusCodes`，与触发轮换的状态码解耦）失败时，按 `<prefix>.transientRetryTimes`（默认 3）自动重试整轮——指数退避等待（2s/4s/8s，上限 8s）且**重试前清空瞬态冷却**，重试次数用尽后才报错。**平台侧错误不换 key**：500 Internal Server Error 是平台问题而非 key 问题——它命中瞬态重试但**不**命中轮换状态码，因此**不标记 key、不换 key**，仅退避后重试同一个 key。旧版单 key `<prefix>.apiKey` 自动迁移。实现见 `src/keys/` |
| **云同步（GitHub Gist）** | key/cookie/备注 三元组跨机器云同步：使用 VS Code 内置的 GitHub 登录（`vscode.authentication.getSession("github", ["gist"])`，无需 PAT）获取 token，将三元组存储到一个**私密 Gist**（`public: false`）。**手动推送**（`<prefix>.syncPush`）/ **手动拉取**（`<prefix>.syncPull`）/ **启动自动拉取**（`<prefix>.cloudSyncAutoPull`，默认开启，未登录时静默跳过）。**合并策略（拉取）**：云端为源——按 key 值对齐，云端条目覆盖本地 cookie/label；**可用性状态为本地数据不同步**。实现集中在 `src/cloud/cloudSync.ts` |
| **多模型支持** | 内置模型定义（`src/models/models.ts` 的 `BUILT_IN_MODELS`，**移植时替换为你平台的模型**），统一通过推理强度选择器切换思考模式。支持自动模型发现：开启后从 API 获取模型列表，自动过滤不可用模型并发现新增模型 |
| **自动模型发现** | 通过 `<prefix>.enableAutoModelDiscovery` 配置（默认开启）。启动时从 `/v1/models` 获取当前可用模型 ID 列表及能力标记，过滤内置模型列表（不可用模型自动隐藏）。新增模型元数据以 **`/v1/models` 完整元数据为主源**，models.dev 仅提供友好名称与回退规格；两源均未知输出上限时不发送 `max_completion_tokens`（交由服务端默认值）。`thinkingMode` 从 `supports_reasoning` 推断。API 不可用时静默回退到全量内置列表。内存缓存（5 分钟 TTL）。**按 API 模式过滤**：`anthropic` 仅显示 `supports_anthropic=true` 的模型，`responses` 仅显示 `supports_responses=true` 的模型。**动态刷新**：通过 `onDidChangeLanguageModelChatInformation` 事件（VS Code 1.125+），切换 `apiMode` / `enableAutoModelDiscovery` 设置时自动刷新选择器，**无需 reload 窗口** |
| **启动模型同步** | 通过 `<prefix>.syncModelsOnStartup` 配置（默认开启）。每次 VS Code 打开时自动检查 API 是否有新模型，**每日最多同步一次**（`globalState` 记录上次同步日期）。同步结果以**一行日志**输出到输出通道，**不写任何文件** |
| **三协议 API 模式** | 同时支持 **OpenAI 兼容格式** (`/chat/completions`)、**Anthropic 格式** (`/v1/messages`) 和 **Responses API 格式** (`/v1/responses`)。可通过设置 `<prefix>.apiMode`（默认 `auto`）手动切换。启动时自动读取 `/v1/models` 的 `supports_responses` / `supports_anthropic` 字段并**缓存动态标记**（不硬编码模型 ID）。**auto 模式优先级**：`enableResponsesApi`（默认关闭）→ `enableAnthropicApi`（默认关闭）→ 兜底 OpenAI |
| **流式推理** | 支持 SSE (Server-Sent Events) 流式响应，实时输出文本和工具调用 |
| **Thinking/推理** | 支持模型的推理过程展示 ("thinking" 状态)，包括 XML think 块解析 |
| **工具调用 (Tool Calling)** | 支持 VS Code 的 LanguageModelToolCallPart 机制 |
| **图片代理 (Tool-based)** | 为不支持视觉的模型注入 `ask_image` 工具，模型可自主选择调用视觉模型回答关于图片的具体问题，支持多轮 API 请求完成"调用工具→提问→获取答案→继续回答"的完整流程。视觉模型 ID、查询提示词和思考模式均可通过设置配置。**跨轮视觉历史持久化**：每轮视觉代理完成后输出私有 MIME（`application/vnd.opencodego.vision-tool-history+json`）的 `LanguageModelDataPart`，VS Code 自动带入下一轮对话；下次请求 `convertMessages` 识别该 DataPart 并重建标准 tool call + tool result 消息 |
| **上下文窗口声明** | `maxInputTokens` 按真实上下文窗口的**可配置比例**声明（默认 `1.0`，可通过 `<prefix>.maxInputTokensRatio` 调整，范围 0.1–1.0，**建议 0.8**）。VS Code agent 模式的自动压缩在比例 0.8 时于真实上下文的约 **72%** 处触发。`context_length` / `max_completion_tokens` 保持真实值不变（用于 API 请求体） |
| **Token 计数** | 使用 `o200k_base` tiktoken 分词器精确统计 token 用量 |
| **原生 Token 指示器** | 始终启用，向 Copilot Chat 原生 Token 指示器报告 token 用量。通过发送 MIME 类型为 `usage` 的 `LanguageModelDataPart` 实现。依赖 VS Code/Copilot Chat 1.116+ |
| **高级 Token 指示器** | 可通过 `<prefix>.enableThirdPartyTokenIndicator` 配置（**默认关闭**）控制 VS Code 状态栏中的高级 Token 计数器。**状态栏可见性由 `isStatusBarEnabled()` 决定 = 高级 Token 指示器 OR 套餐用量显示**。状态栏**仅在用户实际使用本插件提供的模型时显示**：启动时隐藏，发起请求时显示，停止使用（空闲 60 秒）后自动隐藏 |
| **套餐用量与余额显示** | 状态栏主文本显示**套餐用量**：额度内显示 `$(pulse) 5H 65%`（5 小时限流窗口），额度耗尽显示 `$(pulse) 余额 ¥358.78`；悬停提示展示 5h/周/月三窗口 + 5h 重置倒计时 + 余额 + 计费模式说明。**两套计费规则严格区分**：① **周期额度**（5h/周）是**限流窗口**，耗尽后等下一周期自动恢复、**不消耗余额**；② **套餐积分**（月度）才是**订阅额度**，耗尽后走超额策略——`enableExtraUsage=true` 则按量计费，否则**降级 Free 版**。三态 `billingMode`：`plan`/`extra`/`free`。数据源为账号信息端点，TTL 缓存 + **失败保留旧快照**（静默降级）。后台轮询（`<prefix>.usageRefreshInterval` 默认 5 分钟）+ 点击状态栏/`<prefix>.checkUsage` 命令强制刷新。**⚠️ 单位陷阱**：代金券积分 `1 元 = 1,000,000 积分`（`POINTS_PER_CNY`），与套餐积分**不是同一单位**。实现见 `src/balance/planUsage.ts`，设计/移植指南见 `docs/plan-usage-design.md`。**同时支持「仅余额」与「余额 + 用量窗口」两种数据格式**（`usageInfos` 为空 → 只显示余额行） |
| **Git 提交消息生成** | 一键生成 Conventional Commit 格式的 Git 提交消息，支持 `auto` 语言模式自动从历史提交检测语言 |
| **多仓库支持** | 支持多根工作区 (multi-root) 中多个 Git 仓库的提交消息生成 |
| **模型预设** | 支持通过命令面板快速切换 temperature/top_p 预设（🎯 Precise/⚖️ Balanced/🔥 Creative），也支持手动自定义输入 |
| **国际化** | 内置简体中文 (zh-cn) 中英文双语界面 |
| **重试机制** | **两层重试，职责分离**：① **HTTP 层**（`executeWithRetry`，`<prefix>.retry.*`）——同一请求退避重试，默认 2 次，仅覆盖**网关错误**（502/504）与网络错误；② **整轮层**（`tryTransientRetryRound`，`<prefix>.transientRetry*`）——重跑整个 key 轮换循环，默认 3 次，覆盖平台错误（429/500/503）。**两层刻意不重叠** |
| **请求延迟** | 可配置的请求间隔延迟，避免触发 API 限流 |
| **超时控制** | 可配置的请求超时时间（默认 10 分钟） |
| **立即取消** | 取消请求时通过 `reader.cancel()` 立即中断流式读取 |
| **视觉代理配置** | 支持通过设置 `<prefix>.visionProxyModel`、`<prefix>.visionProxyThinking` 配置图片代理所使用的视觉模型和思考模式。**视觉模型仅从本供应商查找**（`findVisionModel` 多级回退匹配裸 ID/完整 ID）。**视觉代理模型动态选择**：`<prefix>.setVisionProxyModel` 命令从 `/v1/models` 动态加载视觉模型列表（视觉能力经 models.dev 判定），QuickPick 选择代替手填；API 不可用时回退手填 |
| **安装欢迎页 (Walkthrough)** | 引导向导（3 个步骤：设置 API Key、显示模型、高级设置），**仅可手动打开**（命令面板 → Welcome: Open Walkthrough）。**不自动弹出** |

> **注**：上表中的 `<prefix>` 指命令/设置前缀（默认 `senseaudio`，移植时全局替换，见 [`PLATFORM_PORTING.md`](../PLATFORM_PORTING.md) §1.2）。

### 1.3 模型清单

> ⚠️ **本脚手架的内置模型清单（`src/models/models.ts` 的 `BUILT_IN_MODELS`）是 SenseAudio 平台的示例数据，移植时必须替换为你平台的模型。**

内置模型定义的结构（`BuiltInModelDef`）：

| 字段 | 说明 |
|------|------|
| `baseId` | API 请求中使用的模型 ID |
| `displayName` | 用户友好的显示名称 |
| `vision` | 是否支持图片输入（所有模型 `imageInput` 能力均声明为 `true`，非视觉模型通过 `ask_image` 代理处理） |
| `thinkingMode` | `switchable`（可开关思考）/ `always`（始终思考）/ `adaptive`（仅禁用/自动） |
| `contextLength` / `maxTokens` | 上下文窗口 / 最大输出 |
| `apiMode` | 默认协议（`openai` / `anthropic` / `responses`） |

> **自动模型发现**（默认开启）会从 API 获取当前可用模型列表，自动隐藏不在列表中的内置模型，并从 models.dev 自动添加 API 返回的新模型。实际显示情况取决于 API 可用性。

> **规格来源**：若平台的 `/v1/models` 不返回规格字段（`context_length` / `max_completion_tokens` / `supports_*`），需从官方文档或 models.dev 补齐。`thinkingMode` 从 `supports_reasoning` 推断。

> **思考强度档位**：官方 API 若不返回每模型支持的档位，建议统一只提供 `禁用思考` / `思考` 两档，不暴露具体强度（避免对不支持的模型发送非法值）。

> 所有模型在模型选择器中均显示**一个条目**，通过**推理强度选择器**（中文标签）切换思考模式。
> - `thinkingMode="switchable"`：用户可选择`禁用思考`或启用思考
> - `thinkingMode="adaptive"`：仅`禁用思考`和`自动`两档
> - `thinkingMode="always"`：推理始终启用，不显示`禁用思考`选项
>
> **关于图像输入：** 所有模型（包括非视觉模型）的 `imageInput` 能力均声明为 `true`，以确保 VS Code 始终传递图片数据。非视觉模型通过内部的 `ask_image` 工具代理机制处理图片。

---

## 2. 详细逻辑架构

### 2.1 总体数据流

```
┌─────────────────────────────────────────────────────────────────────┐
│                        VS Code Copilot Chat                         │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  用户发送消息 → LanguageModelChatProvider                     │  │
│  │                    ↓                                          │  │
│  │  ChatModelProvider (provider/provider.ts)                     │  │
│  │   1. 获取模型配置 (getBuiltInModelConfig)                     │  │
│  │   2. 获取 API Key (SecretStorage)                             │  │
│  │   3. 计算 Token 用量 (provideToken → statusBar)               │  │
│  │   3b. 可选: 向 Copilot Chat 原生 Token 指示器报告用量          │  │
│  │   4. 应用请求延迟 (delay)                                     │  │
│  │   5. 构建请求 → API 路由选择                                  │  │
│  │      ├─ apiMode="openai"     → OpenaiApi                    │  │
│  │      ├─ apiMode="anthropic"  → AnthropicApi                 │  │
│  │      └─ apiMode="responses"  → ResponsesApi                 │  │
│  │   6. 发送 HTTP 请求 (fetch with undici + 超时控制)             │  │
│  │   7. 流式解析响应 → Progress<LanguageModelResponsePart2>      │  │
│  │   7b. 零正文预算耗尽检测                                      │  │
│  │      ├─ LanguageModelTextPart     (文本)                      │  │
│  │      ├─ LanguageModelThinkingPart (推理过程)                  │  │
│  │      └─ LanguageModelToolCallPart (工具调用)                  │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                        Git 提交消息生成                              │
│  SCM 标题栏按钮 → generateCommitMsg()                              │
│    → 获取 Git Diff (gitUtils.ts)                                   │
│    → 获取最近提交风格参考                                          │
│    → 构建 prompt → 调用 API (OpenaiApi/AnthropicApi/ResponsesApi)  │
│    → 流式输出到 SCM InputBox                                       │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 扩展激活流程

```
activate(context)
  ├── logger.init()                         ← 创建 LogOutputChannel
  ├── TokenizerManager.initialize()         ← 加载 o200k_base.tiktoken
  ├── initStatusBar()                       ← 创建状态栏条目（默认隐藏）
  ├── new ChatModelProvider()               ← 创建 Provider 实例
  ├── vscode.lm.registerLanguageModelChatProvider(<vendor>, provider)
  ├── registerCommands(context, provider)   ← 委托 src/commands/registerCommands.ts
  │   ├── onDidChangeConfiguration 监听       ← apiMode / enableAutoModelDiscovery 变化时刷新模型列表
  │   └── 注册全部命令（setApiKey / manageApiKeys / setVisionProxyModel /
  │       getApiKey / openSettings / generateGitCommitMessage /
  │       abortGitCommitMessage / setModelPreset / syncPush / syncPull / checkUsage）
  ├── syncModelsOnStartup(context)          ← 启动模型同步（每日最多一次）
  ├── autoPullOnStartup(context)            ← 启动云同步自动拉取（静默）
  └── 注册 dispose 清理
```

> `initStatusBar(context, getLoginToken)` 同时启动**套餐用量后台轮询**（`startUsagePolling`），
> 状态栏主文本显示 5h 窗口用量、悬停提示显示三窗口 + 余额（见 5.15）。

### 2.3 聊天请求处理流程

```
provideLanguageModelChatResponse(model, messages, options, progress, token)
  │
  ├── 1. 解析模型 ID → getBuiltInModelConfig(model.id)
  │       内置模型查找失败时回退到 getAutoDiscoveredModelConfig(model.id)
  │
  ├── 2. 应用用户配置的 reasoningEffort（applyReasoningEffort）
  │       ├── "disabled" → 关闭思考（always 模型除外）
  │       ├── "adaptive" → 开启思考，自动模式
  │       ├── "enabled" → 开启思考，使用默认推理力度
  │       └── "high"/"max" → 开启思考，指定推理力度
  │
  ├── 2b. 注入 temperature/top_p（applyTemperature）
  │
  ├── 2c. 注入 vision 配置（modelConfig.vision）
  │
  ├── 3. 确定 API 模式（resolveApiMode）
  │       ├── 用户设置 openai/anthropic/responses → 强制
  │       └── auto → enableResponsesApi / enableAnthropicApi 能力探测 → 兜底 openai
  │
  ├── 4-6. 记录日志 / 更新状态栏 / 应用延迟
  │
  ├── 7. 确保至少一个 API Key 存在（无 key 时静默抛错，不弹输入框）
  │
  ├── 8. 创建请求超时 AbortController + 连接 VS Code 取消令牌
  │
  ├── 9. 创建 undici fetch（自定义 bodyTimeout）
  │
  ├── 9c. **多 Key 轮换循环**（runKeyRotationLoop，外层 while(true)）:
  │       ├── pickNextApiKey(secrets, apiKeyMode)
  │       │   ├── sticky → 环形扫描第一个可用 key，游标钉住不前移
  │       │   ├── rotation → 环形扫描第一个可用 key，游标前移
  │       │   ├── single → active key；不可用且 fallback=switch 且原因为 balance → 降级 rotation
  │       │   └── 全部不可用 → 报错列出脱敏 key+原因
  │       ├── 用当前 key 构造 requestHeaders → executeApiRequest()
  │       ├── 成功 → break 循环；曾不可用 → 自愈置可用
  │       └── 失败: isKeyRotationError(err)
  │           ├── isTransientRetryError(err) → reason 规范化为瞬态（仅内存冷却）
  │           ├── 402/401 → markApiKeyExhausted(持久化) + continue 换 key
  │           ├── 429/503 → markApiKeyExhausted(仅内存冷却) + continue 换 key
  │           ├── 取消/超时/其他错误 → 抛给外层 catch，不轮换
  │           ├── 500 等平台侧瞬态错误 → 不标记 key、不换 key，退避后重试同一 key
  │           └── failedKeys.size >= keys.length → 报错；瞬态且未达上限 → 清冷却 + 退避 + 重试整轮
  │
  ├── 10. 根据 apiMode 路由（executeApiRequest）:
  │     ├── OpenAI: convertMessages → prepareRequestBody → POST /chat/completions
  │     │          → executeWithRetry → processStreamingResponse（SSE 解析）
  │     ├── Anthropic: convertMessages → prepareRequestBody → POST /v1/messages
  │     │          → executeWithRetry → processStreamingResponse
  │     └── Responses: convertMessages → prepareRequestBody → POST /v1/responses
  │                → executeWithRetry → processStreamingResponse
  │
  ├── 11. 图片代理拦截处理（handleInterceptedToolCall，最多 visionMaxRounds 轮）
  │       ├── 发出 thinking 块: "正在根据图片提问：[问题]" + 视觉模型流式输出
  │       ├── 调用 callVisionModel() 获取描述
  │       ├── 输出跨轮视觉历史 DataPart（createVisionToolHistoryPart）
  │       ├── 构建 assistant tool_call + tool result 消息并再次请求
  │       └── 若模型再次调用 ask_image 则继续下一轮
  │
  └── 12. 错误处理 + finally 清理定时器 / 记录请求结束日志
```

### 2.4 Thinking/推理内容处理

```
推理内容来源 (OpenAI 模式):
  ├── choice.thinking (对象/字符串)
  ├── delta.reasoning_content (字符串)
  ├── delta.reasoning (对象)
  ├── delta.thinking (对象)
  └── reasoning_details[] (OpenRouter 格式)

处理机制:
  1. bufferThinkingContent(text) → 积累到 _thinkingBuffer
  2. 每 100ms 定时刷新 → LanguageModelThinkingPart
  3. XML think 块 ( thinking...</think>) → processXmlThinkBlocks()
  4. 文本内容出现时 → reportEndThinking()

回传机制 (OpenAI 模式 convertMessages):
  - includeReasoningInRequest=true 时，assistant 消息**始终**设置 reasoning_content
    （有真实推理内容用内容，否则空字符串兜底）——DeepSeek thinking 模式要求每个
    assistant 消息必须携带该字段
```

### 2.5 工具调用处理

```
工具调用流 (OpenAI 模式):
  delta.tool_calls[]
    ├── index: 工具调用索引
    ├── id: 调用 ID
    ├── function.name: 函数名
    └── function.arguments: JSON 参数 (可能分片)

处理机制:
  1. _toolCallBuffers Map<index, {id, name, args}>
  2. stream 分片拼接 args
  3. tryEmitBufferedToolCall() → 参数可解析 JSON 时立即发射
  4. flushToolCallBuffers() → finish_reason 时强制发射剩余
  5. adjustReadFileParameters() → 自动扩增 read_file 行数
  ask_image 拦截: 不在 tryEmit/flush 中发出，改为设置 interceptedToolCall
```

### 2.6 图片代理（ask_image Tool）流程

```
非视觉模型收到含图片的消息:
  │
  ├── 1. convertMessages()
  │      模型 vision=false，有 image → 替换为文本引用
  │      原图数据存入实例的 _localImages 数组
  │      记录 _hasImages = true，保存 _originalApiMessages
  │
  ├── 2. prepareRequestBody()
  │      有 _localImages → 注入 ask_image 工具定义到 tools 列表
  │      设置 tool_choice = "auto"
  │
  ├── 3. 第一次 API 请求（含 ask_image + VS Code 原生工具）
  │
  ├── 4. processDelta() / processAnthropicChunk() / processResponsesEvent() 拦截
  │      ask_image 和 ask_with_multi_image 被缓存到 interceptedToolCall
  │
  └── 5. handleInterceptedToolCall() 循环（多轮追问，最多 visionMaxRounds 次）
         ├── 发出 thinking 块 + 视觉模型流式输出
         ├── 输出跨轮视觉历史 DataPart（VS Code 自动带入下一轮对话）
         ├── 构建 assistant tool_call + tool result 消息并再次请求
         └── 若模型再次调用 ask_image → 继续循环

跨轮恢复（下一轮请求的 convertMessages）:
  ├── OpenAI 模式: parseVisionToolHistoryPart → toOpenAIVisionToolMessages
  └── Anthropic 模式: parseVisionToolHistoryPart → toAnthropicVisionToolMessages
```

### 2.7 Git 提交消息生成流程

```
generateCommitMsg(secrets, scm?)
  ├── 检测 Git 扩展和仓库
  ├── 获取 Git Diff (gitUtils.getGitDiff)
  ├── 多仓库处理（0/1/多仓库分别处理）
  ├── 构建 Prompt（系统提示词 + 最近提交风格 + 语言检测 + 用户输入 + diff）
  ├── 调用 API（多 key 轮换循环）
  │   ├── ensureApiKeyEntry → pickNextApiKey
  │   ├── OpenaiApi/AnthropicApi/ResponsesApi.createMessage()
  │   ├── 流式输出到 SCM InputBox
  │   └── 轮换错误 → 换 key 重试
  └── 清理: 移除 ``` 标记和  thinking 标签
```

---

## 3. 程序文件索引

### 3.1 目录结构

> `src/` 按职责分类到子目录（`api/` `provider/` `keys/` `balance/` `models/` `commands/` `core/` `ui/` `cloud/` `platform/` `typings/`）。
> 三协议适配器重复的 SSE 解析与取消回调上提到 `api/sse.ts`；HTTP 样板在 `api/httpClient.ts`。
> `scripts/` 按用途分为 `build/`（构建）与 `dev/`（调试），测试脚本统一在 `test/`。

```
src/
├── extension.ts                          # 扩展入口（仅编排：初始化 + 注册 Provider + 委托命令注册 + 启动任务）
├── platform/
│   └── platformConfig.ts                 # ★ 平台配置单一事实来源（移植第一站）
├── api/                                  # 协议适配层
│   ├── commonApi.ts                      # API 抽象基类（图片存储、工具调用拦截、thinking 缓冲、共享辅助）
│   ├── sse.ts                            # 共享 SSE 流解析（iterateSseEvents / consumeSseStream）
│   ├── httpClient.ts                     # 共享 HTTP 请求样板（postJson）
│   ├── openai/
│   │   ├── openaiApi.ts                  # OpenAI 兼容 API 实现
│   │   └── openaiTypes.ts                # OpenAI 类型定义
│   ├── anthropic/
│   │   ├── anthropicApi.ts               # Anthropic API 实现
│   │   └── anthropicTypes.ts             # Anthropic 类型定义
│   └── responses/
│       ├── responsesApi.ts               # Responses API 实现 (POST /v1/responses)
│       └── responsesTypes.ts             # Responses 类型定义
├── provider/                             # Chat Provider 实现
│   ├── provider.ts                       # ChatModelProvider（VS Code 接口 + 请求编排）
│   ├── requestOptions.ts                 # 推理强度 / temperature / apiMode 决策
│   ├── rotation.ts                       # 多 key 轮换循环（瞬态整轮重试）
│   ├── apiDispatch.ts                    # 三协议分发与流式处理
│   ├── visionRounds.ts                   # ask_image 图片代理多轮（含三协议轮次构建）
│   └── errors.ts                         # 错误文案、瞬态重试、原生 token 指示器、零正文检测
├── keys/                                 # 多 API Key 管理
│   ├── keyManager.ts                     # barrel（统一导出，保持既有导入路径）
│   ├── types.ts                          # ApiKeyEntry / ApiKeyStore / ApiKeyMode / SingleKeyFallback
│   ├── config.ts                         # 模式、状态码、patterns、冷却与重试次数配置
│   ├── state.ts                          # 模块级可变状态（store 缓存、轮询游标、瞬态冷却表）
│   ├── store.ts                          # SecretStorage 读写、旧版单 key 迁移、增删改
│   ├── selection.ts                      # 主 key 获取、轮询/粘性选择、single fallback 判定
│   ├── health.ts                         # 瞬态冷却、轮换错误判定、失效原因、状态更新
│   ├── availability.ts                   # key 可用性手动检测（最小真实聊天请求）
│   └── mask.ts                           # 脱敏显示辅助
├── balance/                              # 余额 / 账号（★ 移植对接点）
│   ├── balanceCheck.ts                   # barrel（统一导出）
│   ├── config.ts                         # 阈值 / TTL 配置与通用工具（toNumber）
│   ├── accountInfo.ts                    # ★ 平台账号信息查询（queryAccountInfo）+ 到期日格式化 + POINTS_PER_CNY
│   └── planUsage.ts                      # 套餐用量快照（5h/周/月窗口 + 余额 + 计费模式）
├── models/                               # 模型定义与发现
│   ├── models.ts                         # 内置模型定义清单（★ 移植时替换）
│   ├── modelsDev.ts                      # models.dev 元数据拉取与查询
│   ├── apiModelList.ts                   # API 模型列表获取（/v1/models）
│   ├── visionModels.ts                   # 视觉能力判定（models.dev + 硬编码兜底）
│   ├── modelSync.ts                      # 启动模型同步（每日一次，一行日志）
│   └── provideModel.ts                   # 模型信息提供函数（含自动发现）
├── commands/                             # 命令与 QuickPick UI
│   ├── registerCommands.ts               # 全部命令注册 + 配置变更监听
│   ├── apiKeyManagerUi.ts                # manageApiKeys 主入口
│   ├── apiKeyDisplay.ts                  # key 展示辅助（余额格式化 / 详情行 / QuickPick 项）
│   ├── apiKeyFlows.ts                    # key 管理交互流程（增删改/导入/检测/cookie）
│   ├── checkUsageCommand.ts              # 套餐用量查询命令
│   ├── visionProxyCommand.ts             # 视觉代理模型选择
│   └── modelPresetCommand.ts             # 模型温度预设选择
├── core/                                 # 基础设施
│   ├── logger.ts                         # 日志系统
│   ├── localize.ts                       # 国际化/本地化（★ 移植时替换文案）
│   ├── types.ts                          # TypeScript 类型定义
│   ├── utils.ts                          # 通用工具函数
│   └── versionManager.ts                 # 版本信息管理
├── ui/
│   └── statusBar.ts                      # 状态栏管理（套餐用量 + Token 指示器）
├── cloud/
│   └── cloudSync.ts                      # 云同步（GitHub Gist）
├── gitCommit/
│   ├── commitMessageGenerator.ts         # Git 提交消息生成
│   └── gitUtils.ts                       # Git 工具函数
├── tokenizer/
│   ├── tokenizerManager.ts               # Tokenizer 管理 (o200k_base)
│   ├── provideToken.ts                   # Token 计数函数
│   └── imageUtils.ts                     # 图片尺寸解析
├── vision/
│   ├── types.ts                          # Vision proxy 类型定义
│   ├── historyCodec.ts                   # 跨轮视觉历史编解码
│   ├── historyPart.ts                    # 跨轮视觉历史 DataPart 创建/解析
│   └── imageProxy.ts                     # 图片代理核心 (ask_image)
└── typings/                              # VS Code proposed API 类型声明（仅编译期）
    ├── vscode.proposed.chatProvider.d.ts
    ├── vscode.proposed.languageModelDataPart.d.ts
    └── vscode.proposed.languageModelThinkingPart.d.ts

resources/
└── walkthrough/                          # 安装欢迎页 (Walkthrough) 文档（★ 移植时替换文案）

scripts/
├── build/                                # 构建相关
│   ├── clean.mjs                         # 清理 out/（compile 前置）
│   ├── build-info.mjs                    # 编译元信息生成
│   ├── package-vsix.mjs                  # VSIX 打包（npm run build）
│   └── copy-tokenizer.js                 # 拷贝/下载 tokenizer 资源（postinstall）
└── dev/                                  # 开发调试
    ├── check-new-models.mjs              # 检查 API 新模型
    ├── check-settings.mjs                # 设置项一致性核对（挂到 compile）
    └── audit-all.mjs                     # 完整审计（npm run audit，7 项检查）

.vscode/                                  # 调试配置（F5 启动扩展宿主）
docs/
├── multi-api-key-design.md               # 多 Key 轮换与失效切换设计
├── plan-usage-design.md                  # 套餐用量与余额显示设计
└── vscode-dev-notes.md                   # VS Code 开发经验（浏览器自动化 / MCP / 市场上传）
test/                                     # 测试脚本（运行前需 npm run compile）
.copilot/
├── api-reference.md                      # 平台 API 实测参考（移植时按此方法探测新平台）
└── build-log.md                          # 编译日志（自动生成，gitignore）
```

### 3.2 文件详细说明

| 文件 | 职责 |
|------|------|
| `extension.ts` | 扩展激活/停用。**仅编排**：初始化日志/分词器/状态栏、注册 Provider、委托 `registerCommands()`、触发启动任务 |
| `platform/platformConfig.ts` | ★ **平台配置单一事实来源**：API 根地址、平台 URL、必需头、兜底值、登录 token 来源提示 |
| `api/commonApi.ts` | `CommonApi<TMessage,TRequestBody>` 抽象基类（图片存储、工具调用拦截、thinking 缓冲、流式状态重置）；三协议共享辅助（`collectLocalImages` / `applyTemperature` / `mergeExtraParams` / `runSseStream`） |
| `api/sse.ts` | 共享 SSE 流解析（`iterateSseEvents` 异步生成器 + `consumeSseStream` 回调式消费） |
| `api/httpClient.ts` | 共享 HTTP 请求样板（`postJson`） |
| `api/openai/openaiApi.ts` | OpenAI 格式 API 实现（消息转换/请求构建/流式处理/图片代理/跨轮视觉历史重建） |
| `api/anthropic/anthropicApi.ts` | Anthropic 格式 API 实现（含**连续工具结果合并**） |
| `api/responses/responsesApi.ts` | Responses API 格式实现（含文本化/结构化工具回填） |
| `provider/provider.ts` | `ChatModelProvider`：VS Code 接口实现 + 请求编排 |
| `provider/requestOptions.ts` | 请求参数决策：`applyReasoningEffort` / `applyTemperature` / `resolveApiMode` |
| `provider/rotation.ts` | `runKeyRotationLoop()`：多 key 轮换循环 |
| `provider/apiDispatch.ts` | `executeApiRequest()`：三协议分发、请求体构建、流式处理、零正文检测 |
| `provider/visionRounds.ts` | `handleInterceptedToolCall()`：ask_image 图片代理多轮 |
| `provider/errors.ts` | `REASON_TEXT` / `buildAllKeysUnavailableDetail` / `tryTransientRetryRound` / `checkZeroAnswerBudgetExhausted` / `reportNativeUsage` / `getRequestedReasoningEffort` |
| `keys/keyManager.ts` | barrel：统一导出 `keys/` 下全部 API |
| `keys/store.ts` | SecretStorage 读写与旧版单 key 迁移、增删改 |
| `keys/selection.ts` | `getPrimaryApiKey` / `pickNextApiKey` / `shouldSingleKeyFallbackSwitch` / `setActiveKeyByValue` |
| `keys/health.ts` | 瞬态冷却、轮换错误判定、失效原因、状态更新 |
| `keys/availability.ts` | `testKeyAvailability`（最小真实聊天请求） |
| `balance/balanceCheck.ts` | barrel：统一导出 `balance/` 下全部 API |
| `balance/config.ts` | 余额阈值 / TTL 配置读取 + `toNumber` |
| `balance/accountInfo.ts` | ★ 平台账号信息：`queryAccountInfo`（**移植对接点**）、`getAccountInfoWithStatus`、`getAccountInfoCached`、`formatExpiryDate`、`POINTS_PER_CNY` |
| `balance/planUsage.ts` | 套餐用量快照：`buildSnapshot`（归一化 + 三态 `billingMode`）、`classifyWindow`、`getWindowPercent`、`isPlanExhausted`、全套格式化函数 |
| `models/models.ts` | 内置模型定义清单（★ 移植时替换）+ 模型配置查询 |
| `models/apiModelList.ts` | API 模型列表获取（`/v1/models`），5 分钟缓存，静默降级 |
| `models/visionModels.ts` | 视觉能力判定（API 标记 → models.dev → 硬编码兜底） |
| `models/modelSync.ts` | 启动模型同步（每日一次，一行日志，不写文件） |
| `models/provideModel.ts` | 模型信息提供函数（含自动发现 + 按 apiMode 过滤） |
| `commands/registerCommands.ts` | 注册全部命令 + `onDidChangeConfiguration` 监听 |
| `commands/apiKeyManagerUi.ts` | `showApiKeyManager()` 主入口 |
| `commands/apiKeyDisplay.ts` | key 展示辅助（纯函数） |
| `commands/apiKeyFlows.ts` | key 管理交互流程 |
| `commands/checkUsageCommand.ts` | 套餐用量查询命令 |
| `commands/visionProxyCommand.ts` | 视觉代理模型选择命令 |
| `commands/modelPresetCommand.ts` | 模型温度预设选择命令 |
| `core/logger.ts` | 日志输出 (LogOutputChannel) |
| `core/localize.ts` | 中英文国际化（★ 移植时替换文案） |
| `core/types.ts` | `SenseAudioModelItem` 等类型定义 |
| `core/utils.ts` | 工具函数（重试、角色映射、工具转换等） |
| `core/versionManager.ts` | 扩展版本信息 |
| `ui/statusBar.ts` | 状态栏创建、更新、套餐用量渲染、后台轮询 |
| `cloud/cloudSync.ts` | 云同步（GitHub Gist）：`pushToCloud` / `pullFromCloud` / `autoPullOnStartup` |
| `gitCommit/commitMessageGenerator.ts` | Git 提交消息生成逻辑（多 key 轮换循环） |
| `gitCommit/gitUtils.ts` | Git 命令封装 |
| `tokenizer/tokenizerManager.ts` | o200k_base 分词器管理 (含 LRU 缓存) |
| `tokenizer/provideToken.ts` | Token 用量计算 |
| `tokenizer/imageUtils.ts` | 图片尺寸解析 (PNG/GIF/JPEG/WebP) |
| `vision/types.ts` | Vision proxy 类型定义 + 非视觉图片引用工厂 |
| `vision/historyCodec.ts` | 跨轮视觉历史编解码 |
| `vision/historyPart.ts` | 跨轮视觉历史 DataPart 创建/解析 |
| `vision/imageProxy.ts` | 图片代理核心：调用视觉模型描述图片 |
| `scripts/build/clean.mjs` | 清理 `out/`（compile 前置，防止陈旧产物进 VSIX） |
| `scripts/build/build-info.mjs` | 编译元信息生成（版本号 + 编译时间 + 时区） |
| `scripts/build/package-vsix.mjs` | VSIX 打包（输出名固定 `<name>-<version>.vsix`） |
| `scripts/dev/check-settings.mjs` | 设置项一致性核对（挂到 compile） |
| `scripts/dev/audit-all.mjs` | 完整审计（7 项检查） |

---

## 4. 移植对接点

> ★ **本节是脚手架的核心**。移植到新平台时，按此清单逐项替换。完整步骤见 [`PLATFORM_PORTING.md`](../PLATFORM_PORTING.md)。

### 4.1 必改项（平台身份）

| 位置 | 改什么 |
|------|--------|
| `src/platform/platformConfig.ts` | `API_BASE_URL` / `PLATFORM_*_URL` / `PLATFORM_HEADERS` / `FALLBACK_TEST_MODEL_ID` / `LOGIN_TOKEN_SOURCE_HINT` |
| `package.json` | `name` / `publisher` / `displayName` / `description` / `repository` / `contributes.languageModelChatProviders[0].vendor` / 命令前缀 / 设置键前缀 / `keywords` |
| `src/core/localize.ts` + `package.nls*.json` | 把平台名与文案换成新平台 |
| `src/models/models.ts` | `BUILT_IN_MODELS` 替换为新平台的模型定义 |
| `resources/walkthrough/*.md` | 欢迎页文案 |

### 4.2 平台行为对接点（balance 模块）

| 位置 | 改什么 |
|------|--------|
| `src/balance/accountInfo.ts` → `queryAccountInfo()` | 账号信息端点 + 响应字段映射（填充 `AccountInfo`） |
| `src/balance/accountInfo.ts` → `POINTS_PER_CNY` | 代金券积分换算比例（各平台不同，务必实测） |
| `src/balance/planUsage.ts` → `buildSnapshot()` | **已是通用逻辑**；仅当平台窗口 key 命名不同时才需调整 `classifyWindow` |

> **两种数据格式均支持**：`usageInfos` 为空 → 状态栏只显示余额行；有窗口 → 归一化 5h/周/月。
> 若新平台无账号/余额概念，让 `queryAccountInfo()` 抛错即可——UI 显示"余额未知"，其余功能不受影响。

### 4.3 平台行为差异排查清单

移植后按此清单逐项实测（参考 `.copilot/api-reference.md` 的实测方法）：

- [ ] `GET /v1/models` 返回结构：是否有 `mode`/`protocols`/`supports_*` 字段？非 llm 模型是否需要过滤？
- [ ] 三协议支持情况：`/v1/chat/completions`、`/v1/messages`、`/v1/responses`——不支持的协议在 `resolveApiMode` 里锁死为 `openai`
- [ ] `thinking` / `reasoning_effort` 参数的合法取值（各平台差异极大，400 就是对拍点）
- [ ] 流式 SSE 事件格式是否标准（`data: {...}` / `[DONE]`）
- [ ] 余额/套餐端点：响应结构、积分单位（**1 元 = 多少积分**，各平台不同，别混用）
- [ ] 限流特征：429/402/401 的语义与返回体（`src/keys/config.ts` 的错误 patterns）
- [ ] 是否支持 prompt cache（影响 README 的额度说明）

### 4.4 可裁剪模块

| 模块 | 何时删 |
|------|--------|
| `src/balance/` + `src/commands/checkUsageCommand.ts` + 状态栏用量 | 新平台无用户中心/套餐概念 |
| `src/cloud/cloudSync.ts` | 不需要 GitHub Gist 云同步 |
| `src/vision/` | 不需要图片代理（ask_image） |
| `src/gitCommit/` | 不需要提交消息生成 |

删除后同步清理：`extension.ts` 的初始化调用、`registerCommands.ts` 的命令注册、`package.json` 的 contributes（`npm run audit` 会帮你查漂移）。

### 4.5 保持不变的通用层（移植核心价值）

以下模块与平台无关，**直接复用**：

- `src/api/` — 三协议适配器 + 共享 SSE 解析 + HTTP 样板
- `src/provider/` — Chat Provider 编排、key 轮换循环、瞬态重试
- `src/keys/` — 多 key 管理（增删改/批量导入/冷却/轮换）
- `src/tokenizer/` — o200k_base token 计数
- `src/core/` — 日志 / l10n / 工具函数
- `scripts/` — 构建 / 审计 / 打包 VSIX

---

## 5. 函数定义大全

> 本节列出各模块的公开 API。平台专属的对接函数已在签名处标注 **★ 移植对接点**。

### 5.1 `src/extension.ts`

#### `activate(context: vscode.ExtensionContext): void`
扩展激活入口。**仅编排**：初始化日志、分词器、状态栏；注册 `LanguageModelChatProvider`；委托 `registerCommands(context, provider)` 注册全部命令；触发启动任务（`syncModelsOnStartup` / `autoPullOnStartup`）。**不弹任何引导界面**。

#### `deactivate(): void`

### 5.2 `src/platform/platformConfig.ts` ★

平台配置单一事实来源。导出常量：

| 常量 | 用途 |
|------|------|
| `API_BASE_URL` | OpenAI 兼容 API 根地址（以 `/` 结尾） |
| `PLATFORM_API_KEY_URL` | 获取 API Key 页面（"获取密钥"命令跳转目标） |
| `PLATFORM_USER_SELF_URL` | 用户中心账号信息端点（套餐用量 / 余额查询） |
| `PLATFORM_HEADERS` | 用户中心接口必需固定头 |
| `FALLBACK_TEST_MODEL_ID` | 模型列表不可用时的兜底测试模型 ID |
| `LOGIN_TOKEN_SOURCE_HINT` | 登录 token 来源提示文案 |

### 5.3 `src/balance/` 模块 ★

> `balance/balanceCheck.ts` 为 barrel，统一导出以下模块的全部 API。

#### `balance/config.ts`
`getMinBalanceCny` / `getBalanceCheckIntervalSec` / `toNumber`。

#### `balance/accountInfo.ts` ★
- `queryAccountInfo(loginToken)` ★ **移植对接点**：GET 账号信息端点，Bearer 登录 token + `PLATFORM_HEADERS`，解析为 `AccountInfo`
- `getAccountInfoWithStatus(loginToken, ttlSec, force?)`：带状态返回（`ok`/`unauthorized`/`error`）
- `getAccountInfoCached(loginToken, ttlSec)`：TTL 缓存
- `formatExpiryDate(epochSec)`：代金券到期日 → `YYYY-MM-DD`
- `POINTS_PER_CNY` ★：积分换算比例
- 类型：`AccountInfo` / `AccountInfoFetchStatus` / `PlanUsageWindow`

#### `balance/planUsage.ts`
- `buildSnapshot(info, now?)`：归一化为 `PlanUsageSnapshot`（含 `quotaWindow` / `rateLimitWindows` / `balance` / 三态 `billingMode`）
- `getPlanUsageCached(loginToken, force?)`：TTL 缓存 + 失败保留旧快照 + 换 token 失效
- `getPlanUsageSnapshot()` / `getPlanUsageFetchStatus()`
- `classifyWindow(key, desc)`：宽容匹配窗口类型（`rolling`/`weekly`/`monthly`/`other`）
- `getWindowLabel` / `getWindowPercent` / `isWindowExhausted` / `isPlanExhausted` / `getPrimaryWindow`
- `formatResetDuration` / `formatUsageSummary` / `formatWindowLine` / `formatBillingModeLine` / `formatBalanceSummary`
- 类型：`BalanceSnapshot` / `PlanUsageSnapshot` / `PlanUsageFetchStatus` / `PlanBillingMode` / `UsageWindowKind`

### 5.4 `src/keys/` 模块

> `keys/keyManager.ts` 为 barrel，统一导出以下模块的全部 API。

- `keys/config.ts`：`getApiKeyMode` / `getRotationCursorIndex` / `getSingleKeyFallback` / `getRotationStatusCodes` / `getRotationErrorPatterns` / `getTransientRetryStatusCodes` / `getExhaustedCooldownMin` / `getTransientRetryTimes`
- `keys/store.ts`：`getApiKeyStore` / `saveApiKeyStore` / `invalidateApiKeyStoreCache` / `addApiKey` / `addApiKeys` / `removeApiKey` / `setActiveKey` / `setKeyCookie` / `updateApiKey`
- `keys/selection.ts`：`getPrimaryApiKey` / `pickNextApiKey` / `shouldSingleKeyFallbackSwitch` / `setActiveKeyByValue`
- `keys/health.ts`：`getTransientExhaustedInfo` / `isApiKeyEligible` / `hasTransientExhaustedKey` / `isKeyRotationError` / `isTransientRetryError` / `isTransientExhaustedReason` / `getKeyRotationReason` / `getKeyUnavailableReason` / `markApiKeyExhausted` / `markApiKeyAvailable` / `updateKeyAvailability` / `resetExhaustedKeys` / `getKeyDisplayStatus`
- `keys/availability.ts`：`testKeyAvailability`（最小真实聊天请求）
- `keys/mask.ts`：`maskApiKey` / `maskCookie`

### 5.5 `src/provider/` 模块

- `provider.ts`：`ChatModelProvider`（`provideLanguageModelChatInformation` / `provideTokenCount` / `provideLanguageModelChatResponse` / `notifyModelListChanged`）
- `requestOptions.ts`：`applyReasoningEffort` / `applyTemperature` / `resolveApiMode`
- `rotation.ts`：`runKeyRotationLoop(params)`
- `apiDispatch.ts`：`executeApiRequest(params)`
- `visionRounds.ts`：`handleInterceptedToolCall(params)`
- `errors.ts`：`REASON_TEXT` / `checkZeroAnswerBudgetExhausted` / `buildAllKeysUnavailableDetail` / `tryTransientRetryRound` / `reportNativeUsage` / `getRequestedReasoningEffort`

### 5.6 `src/api/` 模块

- `commonApi.ts`：`CommonApi<TMessage,TRequestBody>` 抽象基类（`convertMessages` / `prepareRequestBody` / `processStreamingResponse` / `tryEmitBufferedToolCall` / `flushToolCallBuffers` / `collectLocalImages` / `applyTemperature` / `mergeExtraParams` / `runSseStream` / `prepareHeaders`）
- `sse.ts`：`iterateSseEvents` / `consumeSseStream`
- `httpClient.ts`：`postJson`
- `openai/openaiApi.ts`：`OpenaiApi`（`convertMessages` / `prepareRequestBody` / `processStreamingResponse` / `createMessage`）
- `anthropic/anthropicApi.ts`：`AnthropicApi`（同上 + 连续工具结果合并）
- `responses/responsesApi.ts`：`ResponsesApi`（同上 + 结构化工具回填）

### 5.7 `src/models/` 模块

- `models.ts` ★：`BUILT_IN_MODELS`（移植时替换）/ `getBuiltInModelInfos` / `getBuiltInModelIds` / `getMaxInputTokensRatio` / `getBuiltInModelConfig`
- `apiModelList.ts`：`getApiModelIds` / `getApiModelMetadataList` / `getResponsesSupportedModelIds` / `getAnthropicSupportedModelIds` / `isApiFetchSuccessful`
- `modelsDev.ts`：`ensureModelsDevLoaded` / `lookupModelDevEntry`
- `visionModels.ts`：`resolveVisionCapability` / `getVisionSupportedModelIds`
- `modelSync.ts`：`syncModelsOnStartup`
- `provideModel.ts`：`prepareLanguageModelChatInformation` / `getResponsesModelIds` / `getAnthropicModelIds` / `getAutoDiscoveredModelConfig`

### 5.8 `src/commands/` 模块

- `registerCommands.ts`：`registerCommands(context, provider)`
- `apiKeyManagerUi.ts`：`showApiKeyManager(context)`
- `apiKeyDisplay.ts`：`formatBalanceDetailText` / `fetchAccountInfo` / `buildKeyDetailLine` / `buildKeyQuickPickItems`
- `apiKeyFlows.ts`：`KeyManagerContext` / `queryBalanceFlow` / `addKeyFlow` / `parseBatchImport` / `batchImportFlow` / `deleteKeysFlow` / `pickKey` / `checkAvailabilityFlow` / `checkAllAvailabilityFlow` / `showCheckMenu` / `bindCookieFlow` / `editKeyFlow`
- `checkUsageCommand.ts`：`checkUsageCommand(context)`
- `visionProxyCommand.ts`：`setVisionProxyModelCommand(context)`
- `modelPresetCommand.ts`：`setModelPresetCommand()`

### 5.9 `src/core/` 模块

- `logger.ts`：`Logger` 类（`init` / `debug` / `info` / `warn` / `error` / `sanitizeHeaders` / `dispose`）+ `logger` 单例
- `localize.ts` ★：`l10n(key)` / `l10nFormat(template, ...args)`
- `types.ts`：`SenseAudioModelItem` / `ModelPreset` / `RetryConfig` 等
- `utils.ts`：`mapRole` / `convertToolsToOpenAI` / `createRetryConfig` / `executeWithRetry` / `isRetryableError` / `isImageMimeType` / `createDataUrl` / `arrayBufferToBase64` / `isToolResultPart` / `tryParseJSONObject` / `storeDataUriImages` / `replaceDataUriImages`
- `versionManager.ts`：`VersionManager`（`getVersion` / `getUserAgent` / `getClientInfo`）

### 5.10 `src/ui/statusBar.ts`

- `initStatusBar(context, getLoginToken?)` / `showTokenStatusBar` / `scheduleStatusBarHide` / `refreshPlanUsageNow`
- `formatTokenCount` / `createProgressBar` / `updateContextStatusBar` / `updateStatusBarWithApiPrompt`
- `resetCumulativeCounters` / `recordUsage` / `updateCumulativeTooltip`

### 5.11 `src/cloud/cloudSync.ts`

- `pushToCloud(context)` / `pullFromCloud(context, silent?)` / `autoPullOnStartup(context)`

### 5.12 `src/gitCommit/` 模块

- `commitMessageGenerator.ts`：`generateCommitMsg` / `abortCommitGeneration` / `extractCommitMessage` / `removeThinkTags`
- `gitUtils.ts`：`getGitDiff` / `getRecentCommits` / `limitDiffLines` 等

### 5.13 `src/tokenizer/` 模块

- `tokenizerManager.ts`：`TokenizerManager`（`initialize` / `getInstance` / `getTokenizer` / `countTokens`）+ `tokenizerManager` 单例
- `provideToken.ts`：`countMessageTokens` / `textTokenLength` / `countToolTokens` / `calculateImageTokenCost` / `calculateNonImageBinaryTokens`
- `imageUtils.ts`：`getImageDimensions` / `getMimeType` / `getPngDimensions` / `getGifDimensions` / `getJpegDimensions` / `getWebPDimensions`

### 5.14 `src/vision/` 模块

- `types.ts`：`StoredImage` / `InterceptedToolCall` / `ASK_IMAGE_TOOL_DEF` / `ASK_WITH_MULTI_IMAGE_TOOL_DEF` / `buildUserImageReference` / `buildToolImageReference`
- `historyCodec.ts`：`VISION_TOOL_HISTORY_MIME` / `serializeVisionToolHistory` / `deserializeVisionToolHistory` / `toOpenAIVisionToolMessages` / `toAnthropicVisionToolMessages`
- `historyPart.ts`：`createVisionToolHistoryPart` / `parseVisionToolHistoryPart`
- `imageProxy.ts`：`findVisionModel` / `callVisionModel` / `callVisionModelMulti`

---

## 6. 编译与构建

### 6.1 编译命令

```bash
# TypeScript 编译（清理 out/ + tsc + 生成编译元信息 + 设置项一致性核对）
npm run compile
# 等效于: node scripts/build/clean.mjs && tsc -p ./ && node scripts/build/build-info.mjs && node scripts/dev/check-settings.mjs

# 完整审计（设置漂移 / 未使用导出 / 未使用 l10n / nls 一致性 / 命令声明 / 文档路径 / 测试路径）
npm run audit

# ESLint 检查
npm run lint

# 仅类型检查（无输出）
npx tsc --noEmit

# 持续监视模式
npm run watch

# 离线测试（无需 API Key；先自动 compile）
npm test
npm run test:offline

# 打包 VSIX
npm run build
# 输出名固定为 <name>-<version>.vsix
```

> `npm run compile` 先运行 `scripts/build/clean.mjs` **清空 `out/`**（`tsc` 不清理 `outDir`，源文件删除/移动后旧 `.js` 会残留并被 `vsce package` 打进 VSIX），再 `tsc` 编译，最后自动运行 `build-info.mjs`（生成编译元信息）与 `check-settings.mjs`（设置项一致性核对，有漂移则编译失败）。

> **调试**：`.vscode/launch.json` 提供 `Run Extension`（F5，`preLaunchTask: npm: compile`）与 `Run Extension (no compile)` 两个配置。

### 6.2 编译配置 (tsconfig.json)

| 选项 | 值 |
|------|-----|
| `module` | `Node16` |
| `target` | `ES2024` |
| `lib` | `["ES2024", "dom"]` |
| `strict` | `true` |
| `outDir` | `out` |
| `rootDir` | `src` |
| `exclude` | `["scripts", "node_modules", "out"]` |

### 6.3 依赖

| 依赖 | 用途 |
|------|------|
| `@microsoft/tiktokenizer` | o200k_base 分词器 |
| `@types/node` / `@types/vscode` | 类型定义 |
| `eslint` / `typescript-eslint` / `@eslint/js` | 代码检查 |
| `typescript` | TypeScript 编译器 |

---

## 7. 开发规范

### 7.1 **编译检查铁律**

> **所有代码更改必须通过以下编译检查，确保无错误：**
> ```bash
> npm run compile
> # 或
> npx tsc --noEmit
> ```
> 任何编译错误（包括类型错误）必须在提交前修复。

### 7.2 **编译产物清洁铁律**

> **`npm run compile` 必须先清空 `out/`。**
> `tsc` 不会清理 `outDir`：源文件被删除/移动后，旧的 `.js` 会残留在 `out/` 并被 `vsce package` 打进 VSIX。
> `scripts/build/clean.mjs` 作为 `compile` 的前置步骤解决此问题。**禁止**手动删除 `out/` 后跳过 `clean` 步骤打包。

### 7.3 **编译产物元信息铁律**

> **每次编译产物必须包含版本号和编译时间（标注时区）。**
> `npm run compile` 会在 `tsc` 编译后自动运行 `scripts/build/build-info.mjs`，生成：
> - `out/build-info.json` —— 随扩展打包的编译元信息
> - `.copilot/build-log.md` —— 开发者侧编译日志
>
> **时区标注规则**：时间必须同时标注 IANA 时区 ID 和 UTC 偏移。
> 禁止手动编辑 `out/build-info.json` 和 `.copilot/build-log.md`（由脚本自动生成）。

### 7.4 **AGENTS.md 同步更新铁律**

> **每次代码更改后，必须同步更新 `AGENTS.md`，包括但不限于：**
> - 新增/修改/删除函数、类、接口 → 更新第 5 节（函数定义大全）
> - 新增/删除/重命名文件 → 更新第 3 节（程序文件索引）
> - 新增/修改/删除模型定义 → 更新第 1.3 节（模型清单）
> - 修改核心逻辑流程 → 更新第 2 节（详细逻辑架构）
> - 修改移植对接点 → 更新第 4 节（移植对接点）
> - 修改编译配置、依赖、构建命令 → 更新第 6 节（编译与构建）
> - 修改开发规范 → 更新第 7 节（开发规范）
>
> 任何提交中若包含代码变更但未同步更新本文档，视为不合规。

### 7.5 PR 内容规范

> **当用户要求生成 PR (Pull Request) 内容时，必须遵循以下模板风格。**

#### PR Title 格式

使用 Conventional Commit 风格：
```
<type>: <brief description>
```

type 取值：`feat` | `fix` | `refactor` | `docs` | `chore` | `improve` 等。

#### PR Body 模板

```markdown
### Changes

**1. <功能/改动标题>**
- <具体变更点 1>
- <具体变更点 2>

### Files Changed

| File | Change |
|------|--------|
| `<file path>` | <一句话说明改了什么> |
```

#### 撰写规范

- Title 首字母小写，用英文撰写
- Body 使用英文，用 **粗体标题** 组织 major change areas
- Changes 部分用项目符号列出每个功能点的具体变更，每点以句号结尾
- Files Changed 表格只列关键文件，说明简洁
- 不包含"如何测试"、"如何回滚"等运维内容，除非用户特别要求
- **从整体上审视**：按功能/模块组织内容，而非按 commit 罗列

### 7.6 更新日志内容规范

> **当用户要求生成基于 Git tag 的更新日志（Changelog）时，必须遵循以下格式风格。**

```markdown
### <功能/改动类别标题>

- **<具体功能/改动点标题>**：<详细描述，说明改了什么、为什么、影响范围等>
- <无标题的简单变更点直接用一句话描述>
```

#### 撰写规范

- 以 `###` 三级标题组织 major change areas，标题用中文
- 需要强调的变更点使用 `**<标题>**：<描述>` 格式
- 用中文撰写，风格专业、精炼
- 不包含 `Files Changed` 表格或技术实现细节
- **按功能类别而非按 commit 时间组织**

### 7.7 代码风格

- 使用 TypeScript 严格模式 (`strict: true`)
- 遵循 ES2024 标准
- 使用 ESModule 模块系统 (`import`/`export`)
- 所有新的 API 函数需有 JSDoc 注释
- 导出的函数和类必须显式标注类型
- 使用 `satisfies` 操作符确保类型安全

### 7.8 命名约定

| 类别 | 约定 | 示例 |
|------|------|------|
| 类 | PascalCase | `ChatModelProvider` |
| 接口 | PascalCase | `BuiltInModelDef`, `SenseAudioModelItem` |
| 类型 | PascalCase | `OpenAIChatRole`, `ParsedModelId` |
| 函数 | camelCase | `getBuiltInModelConfig`, `countMessageTokens` |
| 变量 | camelCase | `requestTimeoutMs`, `apiKey` |
| 常量 | UPPER_SNAKE_CASE | `BASE_TOKENS_PER_MESSAGE`, `DEFAULT_CONTEXT_LENGTH` |
| 私有属性 | `_` 前缀 | `_lastRequestTime`, `_toolCallBuffers` |
| 文件 | camelCase | `provider.ts`, `commitMessageGenerator.ts` |

### 7.9 VS Code API 使用约束

- `LanguageModelChatProvider` — 必须实现 `provideLanguageModelChatResponse()` 和 `provideLanguageModelChatInformation()`；可选实现 `onDidChangeLanguageModelChatInformation` 事件（VS Code 1.125+）用于模型列表动态刷新
- `LanguageModelResponsePart` — 使用 `LanguageModelTextPart`、`LanguageModelThinkingPart`、`LanguageModelToolCallPart`、`LanguageModelDataPart`
- `LanguageModelChatInformation.maxOutputTokens` — 必须填入模型真实输出上限，不能为 0
- `SecretStorage` — 用于安全存储 API Key
- `LogOutputChannel` — 用于结构化日志输出
- `Progress<LanguageModelResponsePart>` — 用于流式报告响应块

### 7.10 不依赖 VS Code Proposed API

- 本扩展不使用任何 `enabledApiProposals`，所有使用的 VS Code API 均为稳定版本（VS Code 1.116+）
- `typings/` 下的类型声明文件仅用于编译期类型补全，不影响运行时行为

### 7.11 错误处理策略

- 网络请求使用 `executeWithRetry()`（HTTP 层，默认 2 次，仅网关错误 502/504 + 网络错误）；平台错误（429/500/503）由整轮层 `tryTransientRetryRound` 处理（默认 3 次）
- 请求超时 → 友好的本地化错误消息
- 流式解析错误 → 记录日志，继续处理（不中断流）
- 所有未捕获错误由 `provider.ts` 的 `catch` 块统一处理

### 7.12 日志规范

所有日志使用 `logger` 单例，标签格式为 `category.subcategory`：
- `request.start/end` — 请求开始/结束
- `request.error/timeout/delay` — 请求错误/超时/延迟
- `models.loaded` — 模型加载
- `commit.start/end/error` — 提交消息生成
- `openai.stream.*` / `anthropic.stream.*` — 流式处理
- `apiKey.missing` — API Key 缺失
