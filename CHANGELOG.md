# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与
[语义化版本](https://semver.org/lang/zh-CN/)。

> **脚手架说明**：本仓库是脚手架模板，版本号从 `1.0.0` 起。移植到具体平台后，
> 按你平台的发布节奏维护本文件。

## [Unreleased]

### 新增

- **归一化模型注册表（单一事实来源）**：新增 `src/models/registry.ts`——合并 `/v1/models` + models.dev 为统一 `ModelInfo`，内置清单降级为**纯离线兜底**（仅 API 获取失败时整份接管，不再是叠加层）；新增 `src/models/chatInfo.ts`（`ModelInfo` → VS Code 条目 / 请求体配置适配器）与 `src/models/index.ts`（barrel）。`provider/`、`commands/`、`gitCommit/` 统一从 `"../models"` 取模型信息，消除 `models.ts` / `provideModel.ts` 各写一份的思考档位枚举、上下文比例与输出上限兜底逻辑。
- **视觉代理模型选择器**：重新引入 `selectVisionProxyModel` 命令（`src/commands/visionProxyCommand.ts`）——从 `/v1/models` 实时加载模型列表、经 models.dev 判定视觉能力后 QuickPick 选择，写入已定义的最具体设置作用域（workspace folder / workspace / global），避免手写模型 ID 与"写了 Global 被覆盖"。
- **视觉模型自动选择**：`visionProxyModel` 留空（默认）时运行时自动挑选第一个非主模型的视觉模型（与选择器命令同源 `getVisionModelInfos()`）；配置过期/指向非视觉模型时自动回退到注册表挑选，设置项从"必填"变为"可选覆盖"。
- **思考档位解析器（平台无关）**：`src/models/apiModelList.ts` 新增 `parseReasoningEfforts` / `parseDefaultReasoningEffort` / `REASONING_EFFORT_ORDER`——容忍**数组**、**逗号/空格/竖线/斜杠分隔字符串**、**`{supported|efforts|values|enum|options|levels|list}` 对象**三种字段形状，统一归一化为**小写、去重、强度升序**（`none` → `minimal` → `low` → `medium` → `high` → `xhigh` → `max`），并过滤 `auto`/`adaptive`/`enabled`/`disabled` 这类"开关形态"值（它们属于 `thinkingMode` 语义，不是档位）。单值字符串**不**当作列表（避免把默认档位误判成唯一可选档位）。
- **档位四级回退**：`src/models/registry.ts` 新增 `resolveReasoningEfforts(modelId, apiMeta, devEntry)`——按 **`/v1/models` → models.dev → 内置清单 → 代码默认值** 逐级回退，`ModelInfo.reasoningEffortsSource` 记录来源（`api`/`modelsdev`/`builtin`/`default`）。默认档位同样四级回退，并**强制 ∈ 支持列表**（不在列表里则忽略，回退 `high` 或列表末项）。启动日志新增 `effortsFromApi` / `effortsFromBuiltin` 计数，便于判断平台是否返回档位。
- **视觉代理复用对话请求链路**：`src/vision/imageProxy.ts` 不再走 `vscode.lm.selectChatModels` + `sendRequest()`（嵌套重入），改为直接调用 `executeApiRequest`——与对话同一条请求链路，端点由 `apiMode` 决定，`reasoning_effort` 由 `<prefix>.visionProxyThinking` 决定（经 `reasoningEffortOverride` 传入，**不经过** `applyReasoningEffort`，主对话请求不受影响）。删除 `PROVIDER_VENDOR` / `findVisionModel` / `buildVisionOptions` / `sendToVisionModel`，新增 `VisionProxyContext` / `resolveVisionReasoningEffort` / `sendVisionRequest`。后续视频/音乐等代理只需构造自己的 `um` + `messages` 即可复用整条链路。
- **视觉代理空答案不再静默**：`sendVisionRequest` 在 `content` 为空时抛错（`vision.empty-answer`）；`visionRounds` 把失败原因写进 tool result（`[Image query failed: …]`，原为笼统的 `[Image query unavailable]`），空描述兜底为 `[Image query returned no text from <model>]`——**绝不把空串当成功答案**，否则主模型只会说"工具没有返回内容"，用户无从排查。
- **思考档位探测脚本**：新增 `scripts/dev/probe-reasoning-efforts.mjs`——对每个 chat 模型 × 每个档位发最小请求（看 200/400），输出支持矩阵与 `models.ts` 更新建议。API 根地址从 `src/platform/platformConfig.ts` 读取（不硬编码），chat 模型过滤兼容 `architecture.output_modalities` 与 `mode` 两种风格。

### 变更

- **`visionProxyThinking` 从布尔开关改为自由字符串档位**：`package.json` 类型 `boolean`(false) → `string`("")，**留空 = 模型默认**（不发送 `reasoning_effort`）。设置 UI 不再显示写死的枚举（VS Code 静态配置无法按模型动态枚举）；档位选择挪到 `选择视觉代理模型` 命令——选完视觉模型后从该模型 `supportedReasoningEfforts` 动态加载档位列表供选择。**兼容旧版布尔残留**：`typeof configured === "string"` 判断，布尔值按"留空 = 模型默认"处理（修复 `configured.trim is not a function` 崩溃）。
- **`xhigh` / `minimal` 档位本地化**：`chatInfo.ts` 的 `effortLabel` / `effortDescription` 此前只映射 `disabled/adaptive/enabled/low/medium/high/max`，`xhigh` 与 `minimal` 落到 default 分支显示为未本地化的 "Xhigh" / "Minimal"。现补上标签（超高 / 最小）与描述（极深入的思考，响应很慢 / 最少思考，响应最快），`localize.ts` 同步补字典项。
- **`supports_reasoning` / `supports_tools` 解析修正**：`/v1/models` 映射改为**显式布尔优先**，否则从 OpenRouter 风格 `providers[0].reasoning` / `supported_parameters`（含 `reasoning_effort`）推导——原实现只读显式字段，平台不返回该字段时永远判定为不支持思考。
- **`visionRounds` 三协议轮次统一委托 `executeApiRequest`**：`runAnthropicRound` / `runResponsesRound` / `runOpenAIRound` 不再各自拼 body + fetch（约 250 行重复的 temperature / top_p / max_tokens / system / reasoning_effort / tools / tool_choice 逻辑），改为构造 assistant tool_call + tool result 消息后调用 `executeApiRequest`，通过三个新可选参数控制：`apiInstance`（复用外层 api 实例，保留 `_hasImages` / `_systemContent` / `capturedReasoningContent`）、`apiMessagesOverride`（跳过 `convertMessages`，原样重放已转换消息 + 追加 tool 轮）、`skipVisionRounds`（防内层递归）。现在主对话 / 视觉代理 / 主模型续跑**三条链路共用一份请求拼装逻辑**。
- **`apiDispatch.executeApiRequest` 新增四个可选参数**：`reasoningEffortOverride`（代理请求思考档位覆盖，`"auto"` = 不发送）/ `apiInstance` / `apiMessagesOverride` / `skipVisionRounds`；**三协议分支（openai / anthropic / responses）全部支持**。
- **离线测试**：新增 `test-reasoning-efforts.mjs`（34 项断言）——`parseReasoningEfforts` 的数组/分隔字符串/对象/单值/去重/升序/开关值过滤，`resolveReasoningEfforts` 的四级回退与默认档位合法性。
- **联网测试**：新增 `test-three-path.mjs`——主对话 / 视觉代理 / 主模型续跑三链路冲突断言（`reasoningEffortOverride` 不污染主对话 `um`、`apiInstance` 保留 `_hasImages`、`apiMessagesOverride` 不重复 `convertMessages`）；模型 ID 与 base URL 从源码/环境变量读取，不写死。

### 变更

- **视觉能力判定修正**：models.dev 查找改为**大小写不敏感**（目录键全小写，平台 ID 常带大写——原实现永远命中不了，补充层形同虚设）并**删除模糊后缀匹配**（错误命中会把纯文本模型标成视觉模型，平台 400 硬拒；miss 只走 ask_image 代理仍能工作，代价不对称）；`modalities.input`（精确信号）优先于 `attachment`（仅表示"接受文件上传"，可能仅 PDF）。移除 `HARDCODED_VISION` 表——视觉能力统一在 `BUILT_IN_MODELS` 的 `vision` 字段声明。
- **sticky 模式手动钉住 key**：`sticky` 模式改用持久化的 `activeIndex`（而非内存游标）钉住当前 key，并支持在「管理 API Keys」界面手动「设为当前使用」指定钉住的 key。「设为当前使用」在 `single`/`sticky` 模式显示，仅 `rotation` 模式隐藏。
- **瞬态重试耗尽友好错误**：`retrySameKey` 规则（如 500 / 上游流中断）重试次数用尽时抛出 `TransientRetryExhaustedError`——友好文案 + 原始错误后缀，替代过于原始的 500/429 报错。
- **云同步自动推送**：新增设置 `cloudSyncAutoPush`（默认关闭）——key 管理操作后去抖 2.5s 静默推送本地变更到云端 Gist；本地与云端一致时短路不写 Gist。新增纯函数模块 `src/cloud/syncPayload.ts`（`syncPayloadHasChanged`）供去重逻辑与离线测试共用。
- **云同步时间戳口径统一**：push 记录服务端 `updated_at`（与 pull 侧一致），消除客户端时钟偏差导致的 push 后必然多拉一次。新增跨窗口锁 `cloudSyncLockUntil` 防止两窗口同时写 Gist。
- **离线测试**：`test-keys.mjs`（Key 选择与状态，18 项断言）、`test-rotation.mjs`（轮换循环，7 项断言）、`test-banned-rotation.mjs`（封号错误检测，9 项断言，直接导入编译产物）、`test-cloud-sync-auto-push.mjs`（payload 去重，16 项断言）、`test-cloud-sync-flow.mjs`（push/pull 集成，22 项断言）。
- **联网测试**：`test-cloud-sync-e2e.mjs`（真实 GitHub Gist 端到端，16 项断言，`npm run test:e2e`；无凭据时 SKIP 退出 0）。
- **错误分类规则统一（errorRules 四元组）**：新增设置 `errorRules`（四元组：code + message + statusCode + action），**只配置这一处**即可覆盖所有错误分类——`code`（错误体 error.code 精确匹配，主要字段）优先于 `statusCode`（HTTP 兜底），`action` 与 key 状态一一对应（`retrySameKey` 不换 key / `rotateCooldown` 冷却 / `rotatePersist` 持久化失效）。封号判定改为 `code=billing` 规则（`rotatePersist`），替代此前的 `apiKeyBannedErrorPatterns` 文本匹配。

### 变更

- **状态栏设置精简**：合并 `showUsageInStatusBar` / `showUsageInTooltip` 为单一设置 `showUsage`（默认开启）——关闭即隐藏整个状态栏（`isStatusBarEnabled()` = `showUsage`）。状态栏项重命名为「剩余用量」（Remaining Usage）。
- **移除死设置**：删除 `enableThirdPartyTokenIndicator`（及其累计 token 计数器 `recordUsage` / `resetCumulativeCounters` / `updateCumulativeTooltip` / `updateStatusBarWithApiPrompt` / `formatTokenCount` / `createProgressBar`）与 `retry.statusCodes`（HTTP 层重试按设计固定为网关错误 502/504 + 网络错误）。
- **状态栏主文本**：额度内显示 5 小时窗口已用百分比，月度额度耗尽显示余额；移除 token 计数回退。悬停提示移除累计 Token 行，仅保留套餐用量 + 余额。
- **精简命令面板**：移除 5 个与设置或其他命令重复的命令——`setApiKey`（旧版单 key 流程）、`getApiKey`（官网链接，改由欢迎页提供）、`setModelPreset`（改用 `modelPreset` 设置）、`setVisionProxyModel`（改用 `visionProxyModel` 设置）、`checkUsage`（命令面板隐藏，仅保留状态栏点击）。provider 的 `managementCommand` 重定向到 `manageApiKeys`（齿轮图标）。
- 删除 `src/commands/modelPresetCommand.ts` / `src/commands/visionProxyCommand.ts` 与已无引用的 `getVisionSupportedModelIds` / `PLATFORM_API_KEY_URL`。
- 清理上述命令遗留的死 l10n 键；静默启动自动拉取不再弹通知（移除 `Cloud sync: pulled {0} keys from Gist on startup`）。
- `@types/vscode` 精确 pin 到 `1.116.0`（与 `engines.vscode` 最低版本一致）。
- 升级 `@types/node` 22 → 26、`eslint` 9 → 10、`@eslint/js` 9 → 10、`typescript-eslint` 8.60 → 8.71。
- 修复 eslint 10 新规则报出的 5 处问题（`no-useless-assignment` × 2、`preserve-caught-error` × 3）。
- 修复 2 个高危依赖漏洞（`brace-expansion` / `js-yaml`）。
- 删除无断言的 `test-banned-detect.mjs`（其覆盖已并入 `test-banned-rotation.mjs`）。
- **对齐 sense-audio-copilot `f90c240`（v1.7.0 之后）**：
  - **sticky 模式重构**：sticky 改用持久化 `activeIndex`（而非内存游标 `rotationIndex`）钉住 key；「设为当前使用」在 single/sticky 模式显示（rotation 隐藏）。删除 `getRotationCursorIndex`。
  - **状态栏重构**：删除高级 Token 指示器（`enableThirdPartyTokenIndicator`）及其累计计数器；`showUsageInStatusBar`/`showUsageInTooltip` 合并为单一 `showUsage`（关闭则隐藏状态栏）；主文本改为 5h 窗口已用百分比或余额；状态栏重命名为「剩余用量」（Remaining Usage）；常态化显示。
  - **HTTP 层重试**：删除 `retry.statusCodes` 设置，HTTP 层重试仅限网关错误（502/504）与网络错误。
  - **错误处理**：新增 `TransientRetryExhaustedError`（瞬态错误同 key 重试耗尽后的友好错误）；全部 key 不可用报错提示「重置失效状态」。
- **对齐 sense-audio-copilot 死代码清理**：
  - **`errorRules` 单一事实来源**：删除 `src/keys/config.ts` 的代码内 `DEFAULT_ERROR_RULES` 副本，`getErrorRules` 只从 `package.json` 读取（避免两处默认值漂移）。
  - **删除死函数**：删除 `isKeyRotationError` / `isTransientRetryError` / `getKeyRotationReason`（errorRules 重构后 `matchErrorRule` 已取代，无调用点）。
  - **`getKeyUnavailableReason` 返回可读文案**：改为 `l10n("Unavailable")` / `l10n("Not checked")`（原返回机器码）；`buildAllKeysUnavailableDetail` 直接用其可读文案，删除 `REASON_TEXT` 映射表及 5 个未使用 l10n 键。
  - **`storeMatchesRaw` 补 `label` 比较**：`storeEqualsRaw` 改名 `storeMatchesRaw`，语义比较补上 `label` 字段（修复 label 变化时缓存语义比较误判）。
  - **`pickAccountCredential` 去掉 `?? store.keys[0]` 回退**：对齐 senseaudio，直接取 `activeIndex` 的 key。
  - **测试对齐**：`test-transient-retry.mjs` / `test-banned-rotation.mjs` / `test-rotation.mjs` 的 shim 提供 `DEFAULT_ERROR_RULES` fallback；测试内用 `matchErrorRule` 派生语义断言；删除 `REASON_TEXT` 断言。
- **对齐 sense-audio-copilot 非平台特性**（2026-10-23 复核）：
  - **`checkUsageCommand` 恢复余额显示**：成功弹窗恢复 `Plan usage: {usage} · Balance: {balance}` 组合（此前只显示窗口百分比，丢失余额）；新增 `Plan usage: {0} · Balance: {1}` / `Balance: {0}` 两个 l10n 键；删除多余的 `void l10nFormat;` 保留引用。
  - **`repairJsonText` 恢复完整容错逻辑**：单引号改回成对替换（`'([^'\\]*)'` → `"$1"`，避免破坏字符串内 `it's`）；括号平衡改回栈式按序闭合；恢复「剥离末尾残缺片段」（`out.replace(/,\s*"[^"]*"?\s*:?\s*$/, "")`）——覆盖流截断（`finish_reason=length`）时 JSON 写到一半的场景。
  - **清理 `test/README.md` 残留引用**：删除已移除的 `test-banned-detect.mjs` 运行命令（其覆盖已并入 `test-banned-rotation.mjs`）。

### 文档

- **重写 `docs/retry-and-key-rotation.md`**：全面对齐当前代码（`errorRules` 四元组 + 两层重试），清除 errorRules 重构前的过时设置（`apiKeyRotationStatusCodes` / `apiKeyRotationErrorPatterns` / `apiKeyBannedErrorPatterns` / `transientRetryStatusCodes`）与已删除函数（`getRotationStatusCodes()` 等）。
- **更新 `docs/multi-api-key-design.md`**：sticky 模式改为持久化 `activeIndex`；`cookie` → `credential`；函数表对齐 `matchErrorRule` / `markApiKeyExhausted(action)` 等当前 API。
- **重写 `PLATFORM_PORTING.md`**：新增移植路线图（9 步）、分组排查清单（模型列表/计费/错误语义/视觉工具）、手工验收清单、相关文档索引。
- **新增 `.copilot/platform-quirks.md`**：平台特性探测与已知坑（模型列表/思考参数/SSE/工具调用/图片/错误语义/认证 7 类坑 + 探测方法 + 必做清单）。

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
