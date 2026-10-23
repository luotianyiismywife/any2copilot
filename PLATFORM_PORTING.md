# 平台移植指南（脚手架用法）

本仓库是从 [sense-audio-copilot](https://github.com/luotianyiismywife/sense-audio-copilot) 抽出的
**通用脚手架**：把任意三协议兼容（OpenAI / Anthropic / Responses）平台接入 GitHub Copilot Chat 的 VS Code 扩展模板。
做新平台时按本清单逐项替换即可。

> 脚手架自带**中性身份**（`name: any2copilot` / `displayName: Copilot Provider Scaffold`），
> 命令/设置前缀与 vendor 均为 `any2copilot`。移植时按 §1 替换。
>
> **一键批量替换**：`npm run port -- --vendor <id> --name <pkg> --display "<名>" --api-base <url> --home <url> --user-self <url>`
> （详见 [`docs/neutralization.md`](docs/neutralization.md)）。

---

## 0. 移植路线图（先看这里）

```
① 跑通编译基线          npm install && npm run compile && npm run audit
        ↓
② 批量替换平台身份      npm run port -- --vendor ... --dry-run → 正式执行
        ↓
③ 填平台配置            src/platform/platformConfig.ts（URL / 头 / 兜底值）
        ↓
④ 填模型清单            src/models/models.ts 的 BUILT_IN_MODELS
        ↓
⑤ 对接账号信息          src/balance/accountInfo.ts 的 queryAccountInfo()
        ↓
⑥ 调错误分类            package.json 的 errorRules 默认值（getErrorRules 只从 package.json 读取）
        ↓
⑦ 实测平台特性          .copilot/platform-quirks.md（按清单逐项探测）
        ↓
⑧ 验证                  npm run compile && npm run audit && npm run lint && npm run test:offline
        ↓
⑨ F5 启动扩展宿主实测   设置 Key → 选模型 → 发消息 → 图片 → 工具调用 → 多 Key 轮换
```

> **典型移植只需改 3 处**：`platformConfig.ts`（URL/头/兜底值）、`package.json`（身份）+ `localize.ts`/`package.nls*.json`（文案）、`accountInfo.ts` 的 `queryAccountInfo()`（账号信息端点）。
> 其余（三协议适配器、key 轮换、分词器、视觉代理、状态栏、云同步、Git 提交）与平台无关，直接复用。

---

## 1. 必改项（平台身份）

### 1.1 `src/platform/platformConfig.ts` — 平台配置单一事实来源

所有平台地址 / 固定头 / 兜底值集中在此，**移植第一站**：

| 常量 | 用途 | 改什么 |
|------|------|--------|
| `API_BASE_URL` | OpenAI 兼容 API 根地址（聊天/模型列表/余额检测共用） | 换成新平台 `/v1` 地址（**以 `/` 结尾**） |
| `PLATFORM_USER_SELF_URL` | 用户中心账号信息端点（套餐用量/余额） | 换新平台端点；无此能力可删（见 §4） |
| `PLATFORM_HEADERS` | 用户中心接口必需固定头 | 按新平台域校验调整；无校验则置 `{}` |
| `FALLBACK_TEST_MODEL_ID` | 模型列表不可用时的兜底测试模型 | 换新平台的模型 ID |
| `LOGIN_TOKEN_SOURCE_HINT` | 登录 token 来源提示文案 | 按新平台 localStorage 结构改写 |

### 1.2 `package.json` — VS Code 静态声明（无法运行时改，全局替换）

脚手架自带**中性身份**（`name: any2copilot` / `displayName: Copilot Provider Scaffold`），
移植时改成你平台的：

- `name` / `publisher` / `displayName` / `description` / `repository` / `keywords`
- `contributes.languageModelChatProviders[0].vendor`（当前值 `any2copilot` → 新平台名）
- **命令前缀**：全部 `any2copilot.` → 新前缀（`src/` 全局替换 + package.json）
- `contributes.configuration.properties` 的设置键前缀（同上）

> 扩展 ID（`<publisher>.<name>`）在运行时由 `context.extension.id` 动态获取
> （`VersionManager.initialize` / `registerCommands`），**无需硬编码**。

### 1.3 `src/core/localize.ts` + `package.nls*.json` — 文案

脚手架文案已中性化（"Copilot Provider Scaffold"）。移植时把平台名/文案换成你平台的
（zhCN 表 + 两个 nls 文件 + `resources/walkthrough/*.md`）。

### 1.4 示例模型 ID（保留为可运行示例，移植时替换）

脚手架使用中性占位（`any2copilot` / `example.com` / `example-model`），以下位置含示例值，移植时替换：

| 位置 | 内容 |
|------|------|
| `src/models/models.ts` → `BUILT_IN_MODELS` | 内置模型清单（示例数据） |
| `src/models/visionModels.ts` → `HARDCODED_VISION` | 平台自研模型的视觉能力兜底（示例为空对象） |
| `package.json` → `any2copilot.commitModel` 默认值 | 提交消息生成默认模型 |
| `package.json` → `any2copilot.visionProxyModel` 默认值 | 视觉代理默认模型 |
| `src/provider/visionRounds.ts` | 视觉代理默认模型（代码内兜底） |
| `src/platform/platformConfig.ts` → `FALLBACK_TEST_MODEL_ID` | key 可用性检测兜底模型 |

---

## 2. 平台行为差异排查清单

移植后按此清单逐项实测（**详细探测方法与已知坑见 [`.copilot/platform-quirks.md`](.copilot/platform-quirks.md)**）：

### 2.1 模型列表与协议

- [ ] `GET /v1/models` 返回结构：是否有 `mode`/`protocols`/`supports_*` 字段？
      非 llm 模型（tts/stt/image）是否需要过滤（见 `src/models/apiModelList.ts`）？
- [ ] 三协议支持情况：`/v1/chat/completions`、`/v1/messages`、`/v1/responses`
      ——不支持的协议在 `resolveApiMode`（`src/provider/requestOptions.ts`）里锁死为 `openai`
- [ ] `thinking` / `reasoning_effort` 参数的合法取值（各平台差异极大，400 就是对拍点）
- [ ] 流式 SSE 事件格式是否标准（`data: {...}` / `[DONE]` 哨兵是否存在）

### 2.2 计费与账号

- [ ] 余额/套餐端点：响应结构、积分单位（**1 元 = 多少积分**，各平台不同，别混用）
- [ ] 两套计费规则是否区分：周期额度（限流窗口，不扣余额）vs 套餐积分（订阅额度，耗尽走超额策略）
- [ ] 是否支持 prompt cache（影响 README 的额度说明）

### 2.3 错误语义

- [ ] 限流特征：429/402/401 的语义与返回体（`package.json` 的 `errorRules` 默认值）
- [ ] 错误体是否带 `error.code`（决定 `code` 精确匹配能否生效）
- [ ] 封号/冻结的返回特征（`code=billing` 之类）
- [ ] 平台侧错误（500 / 上游流中断）是否与 key 无关

### 2.4 视觉与工具调用

- [ ] 是否支持图片输入（`image_url` / `image` content part）
- [ ] 工具调用流式分片格式（`tool_calls[].index` / `id` / `function.arguments` 分片方式）
- [ ] 并行工具调用的 `index` 是否稳定

---

## 3. 可裁剪模块

| 模块 | 何时删 |
|------|--------|
| `src/balance/` + `src/commands/checkUsageCommand.ts` + 状态栏用量 | 新平台无用户中心/套餐概念 |
| `src/cloud/cloudSync.ts` | 不需要 GitHub Gist 云同步 |
| `src/vision/` | 不需要图片代理（ask_image） |
| `src/gitCommit/` | 不需要提交消息生成 |

删除后同步清理：`extension.ts` 的初始化调用、`registerCommands.ts` 的命令注册、
package.json 的 contributes、`scripts/dev/audit-all.mjs` 会帮你查漂移（`npm run audit`）。

> **无账号/余额概念时**：让 `queryAccountInfo()` 抛错即可——UI 显示"余额未知"，其余功能不受影响。
> 状态栏会显示 `$(pulse) --`，不影响聊天。

---

## 4. 保持不变的通用层（移植核心价值）

以下模块与平台无关，**直接复用**：

- `src/api/` — 三协议适配器 + 共享 SSE 解析 + HTTP 样板
- `src/provider/` — Chat Provider 编排、key 轮换循环、瞬态重试
- `src/keys/` — 多 key 管理（增删改/批量导入/冷却/轮换）
- `src/tokenizer/` — o200k_base token 计数
- `src/core/` — 日志 / l10n / 工具函数
- `scripts/` — 构建 / 审计 / 打包 VSIX

---

## 5. 验证流程

```bash
npm install
npm run compile   # 编译 + 设置项一致性检查
npm run audit     # 7 项审计（设置漂移/未使用导出/命令声明等）
npm run lint      # ESLint
npm run test:offline  # 离线测试（无需 API Key）
npm run build     # 打包 VSIX
```

F5 启动扩展宿主 → 设置 API Key → 模型选择器选模型 → 发一条消息 →
再跑一遍 §2 清单。

### 5.1 手工验收清单

- [ ] 模型选择器显示你平台的模型（自动发现生效）
- [ ] 普通对话流式输出正常
- [ ] 思考/推理内容正常展示（若平台支持）
- [ ] 工具调用正常（含并行调用）
- [ ] 图片输入正常（视觉模型直传 / 非视觉模型走 `ask_image` 代理）
- [ ] 多 Key 轮换：故意填一个无效 key，确认自动切换
- [ ] 状态栏显示套餐用量/余额（若平台支持）
- [ ] Git 提交消息生成正常（若保留该模块）
- [ ] 云同步推送/拉取正常（若保留该模块）

---

## 6. 相关文档

| 文档 | 内容 |
|------|------|
| [`docs/neutralization.md`](docs/neutralization.md) | 中性化占位符总表 + 批量替换脚本 |
| [`.copilot/platform-quirks.md`](.copilot/platform-quirks.md) | **平台特性探测与已知坑**（移植时必读） |
| [`docs/multi-api-key-design.md`](docs/multi-api-key-design.md) | 多 Key 轮换与失效切换设计 |
| [`docs/retry-and-key-rotation.md`](docs/retry-and-key-rotation.md) | 重试与 Key 轮换配置指南 |
| [`docs/plan-usage-design.md`](docs/plan-usage-design.md) | 套餐用量与余额显示设计 |
