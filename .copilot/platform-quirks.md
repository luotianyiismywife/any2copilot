# 平台特性探测与已知坑（移植必读）

> **本文档是脚手架的一部分**，不是某个平台的实测记录。
> 它列出**移植到新平台时必须探测的行为点**、**常见平台小 bug**、以及**探测方法**。
>
> 参考实测样本：[`api-reference.md`](api-reference.md)（SenseAudio 平台的完整实测，含具体数值）。
> 移植清单：[`../PLATFORM_PORTING.md`](../PLATFORM_PORTING.md) §2。

---

## 0. 探测总原则

1. **不要信官方文档**——文档常滞后或与实际不符，**以实测为准**。
2. **交错对照实验**——怀疑某参数有问题时，同一时刻、同一模型、间隔 0.5s 连发"正常参数"与"可疑参数"，排除"平台繁忙"的干扰。
3. **重复多次**——单次失败可能是瞬时故障，**至少 6-8 次**才能判定为确定性缺陷。
4. **看原始响应体**——不要只看 HTTP 状态码，`error.code` / `ref_code` 才是分类依据。
5. **记录到本文档**——每发现一个坑，补一条到 §2。

---

## 1. 探测脚本

| 脚本 | 用途 |
|------|------|
| `test/api-tests.mjs` | 三协议全量对照测试（需真实 API Key） |
| `test/test-responses-recheck.mjs` | Responses 协议行为复测 |
| `scripts/dev/check-new-models.mjs` | 检查 `/v1/models` 新增模型 |

```bash
# 设置环境变量后运行（前缀见 docs/neutralization.md）
$env:PROVIDER_API_KEY="sk-..."
node test/api-tests.mjs
```

---

## 2. 已知坑清单（按类别）

### 2.1 模型列表 `/v1/models`

| 坑 | 表现 | 应对 |
|----|------|------|
| **不返回规格字段** | 无 `context_length` / `max_completion_tokens` / `supports_vision` / `supports_reasoning` | 从官方文档或 models.dev 补齐；两源均未知时**不发送** `max_completion_tokens`（交服务端默认） |
| **混入非对话模型** | `mode` 为 `stt` / `tts` / `image` / `video` / `music` / `voice_clone` 等 | 只保留 `mode === "llm"`（见 `src/models/apiModelList.ts`） |
| **不校验余额** | 余额 < 0 仍返回 200 | **不能**作为 key 可用性判据；用最小真实聊天请求检测 |
| **协议能力靠 `protocols` 数组** | 无 `supports_responses` / `supports_anthropic` 布尔字段 | 从 `protocols` 数组推导（`["chat_completions","responses","messages"]`） |
| **模型退役后兜底 ID 失效** | `FALLBACK_TEST_MODEL_ID` 指向已下线模型 | 优先用 `/v1/models` 实时列表；兜底值仅作最后手段 |

### 2.2 思考 / 推理参数（400 高发区）

| 坑 | 表现 | 应对 |
|----|------|------|
| **`reasoning_effort` 取值不标准** | `disabled` → 400；正确值是 `none` | 按平台实测值映射（见 `src/provider/requestOptions.ts`） |
| **`thinking` 只接受字符串语义** | `{type:"adaptive"}` 被拒，需 `{type:"auto"}` | 按平台实测值映射 |
| **thinking + temperature 组合 400** | 部分平台强制思考时拒绝 temperature/top_p | 强制思考时跳过 temperature/top_p（符合 Anthropic 标准，无害） |
| **思考内容字段名各异** | `reasoning_content` / `reasoning` / `thinking` / `reasoning_details[]` | 插件已兼容多种（见 `src/api/openai/openaiApi.ts`） |
| **DeepSeek thinking 模式要求回传** | 每个 assistant 消息必须带 `reasoning_content`（可为空串） | `includeReasoningInRequest=true` 时始终设置该字段 |

### 2.3 流式 SSE

| 坑 | 表现 | 应对 |
|----|------|------|
| **无 `[DONE]` 哨兵** | 流自然结束，无 `data: [DONE]` | `consumeSseStream` 在流结束时也触发 `onDone` 刷新缓冲（否则工具调用被丢弃） |
| **工具调用首分片空参数** | 首分片带 `id`+`name`+`arguments:""`，后续分片只带 `index` | `tryEmitBufferedToolCall` 用**严格 JSON 解析**，空/部分参数不提前发射（见 issue #1） |
| **并行工具调用 `index` 不稳定** | 多个 tool_call 的 `index` 交错或重复 | 按 `key`（id / index / auto）分桶 + `_indexToId` 映射回 id 桶 |
| **参数分片拼接后非法 JSON** | 单个 tool call 参数被截断/损坏 | `flushToolCallBuffers` 宽容处理：先尝试 `splitToolCallArguments` 拆分，仍失败则**丢弃该 tool call + 记日志**（不抛错，避免整轮失败） |
| **Responses 推理事件类型因模型而异** | `response.reasoning_summary_text.delta` / `response.reasoning_text.delta` / `response.reasoning_part.added` 等 | 插件兼容多种事件类型 |

### 2.4 工具调用

| 坑 | 表现 | 应对 |
|----|------|------|
| **命名 `tool_choice` 500** | `{type:"function",function:{name}}`（OpenAI）/ `{type:"tool",name}`（Anthropic）/ `{type:"function",name}`（Responses）→ 500 | 插件**从不发送**命名形式；具名归入 `auto` |
| **Responses 工具格式是扁平的** | `{type:"function",name,description,parameters}`（非嵌套） | 这是 Responses 标准，**不是平台问题** |
| **Responses 工具历史需顶层 item** | `{type:"function_call",call_id,name,arguments}` + `{type:"function_call_output",call_id,output}` | 塞进 `assistant.content` 数组是**错误写法**，会失败 |
| **Anthropic 连续工具结果需合并** | 多个 `tool_result` 连续出现 | 合并到同一条 user 消息（见 `anthropicApi.ts`） |
| **Anthropic 图片索引错位** | 延迟分配 index 导致与 `collectLocalImages` 不一致 | 按 part 顺序**内联分配** index |
| **Anthropic thinking 块位置** | thinking 块必须在 assistant 消息首位 | `unshift` 到首位并去掉伪造占位符 |

### 2.5 图片 / 视觉

| 坑 | 表现 | 应对 |
|----|------|------|
| **非视觉模型发图片 → 500** | 三端点同款 500（`ref_code:500000`） | 非视觉模型走 `ask_image` 代理（`src/vision/`） |
| **PNG mime 检测错误** | 所有 PNG 返回 `unknown` | 按**解码后字节**判断签名（见 `src/tokenizer/imageUtils.ts`） |
| **视觉代理递归** | `visionProxyModel` 指向非视觉模型或与主模型相同 | `isVisionCapableModelId` 守卫，提示并返回 |

### 2.6 错误语义与计费

| 坑 | 表现 | 应对 |
|----|------|------|
| **错误体 `code` 字段名不统一** | 有的在 `error.code`，有的在顶层 `code` | `extractErrorCode` 兼容两种（见 `src/keys/health.ts`） |
| **500 是平台问题不是 key 问题** | 换 key 无意义 | `action=retrySameKey`，不换 key、退避重试同一个 key |
| **封号伪装成普通 400** | `code=billing` + `ref_code:400901` | `code` 精确匹配优先于 `statusCode`，判定 `rotatePersist` |
| **余额不足 402 不消耗 token** | 402 拦截 | 可安全用于 key 可用性检测 |
| **积分单位陷阱** | 代金券 `1 元 = 1,000,000 积分`，套餐积分是另一套单位 | 严格区分 `POINTS_PER_CNY` 与套餐积分，**绝不混用** |
| **周期额度 ≠ 订阅额度** | 5h/周是限流窗口（耗尽等恢复、不扣余额）；月度才是订阅额度 | `isPlanExhausted` 只看月度窗口 |
| **误导性错误文案** | "服务繁忙，请稍后再试" 实际是确定性缺陷 | 看 `ref_code` 与交错对照实验，别信文案 |

### 2.7 认证与端点

| 坑 | 表现 | 应对 |
|----|------|------|
| **用户中心需固定头** | 缺 `x-platform` / `x-product` → 403 `ref_code:403002` | 配置 `PLATFORM_HEADERS` |
| **登录 token 有效期** | PASETO 60 天 / 短期 token 30 分钟 | 提示用户重新复制；401 时提示 |
| **旧端点已废弃** | 旧 cookie 端点 404 | 删除相关代码，改用新端点 |
| **三域认证体系** | `api.*`（API Key）/ `platform.*`（Bearer 登录 token）/ `auth.*`（公钥换发） | 按域区分认证方式 |

---

## 3. 探测方法详解

### 3.1 端点存在性探测

```bash
# 逐个端点发最小请求，记录状态码
curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $KEY" $BASE/models
curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $KEY" $BASE/chat/completions -d '{}'
```

### 3.2 交错对照实验（判定确定性缺陷）

```js
// 同一时刻、同一模型、间隔 0.5s 连发，排除"平台繁忙"
for (const variant of ["auto", "required", "named"]) {
    const res = await fetch(url, { body: JSON.stringify({ ...base, tool_choice: variant }) });
    console.log(variant, res.status);
    await sleep(500);
}
// 重复 6-8 轮，若只有某一变体稳定失败 → 确定性缺陷
```

### 3.3 字段集探测

```js
// 收集所有条目的字段名并集，找出缺失的规格字段
const fields = new Set();
for (const m of models) Object.keys(m).forEach(k => fields.add(k));
console.log([...fields]);
```

### 3.4 流式事件类型探测

```js
// 打印所有 SSE 事件的 type 字段，找出非标准事件
for await (const evt of sseEvents) console.log(evt.type ?? evt.object);
```

---

## 4. 移植时必做的探测清单

复制此清单，逐项打勾：

```
□ GET /v1/models 返回结构（字段集、mode、protocols）
□ 三协议端点存在性（chat/completions、messages、responses）
□ thinking / reasoning_effort 合法取值（逐个试，记录 400 的）
□ SSE 是否有 [DONE] 哨兵
□ 工具调用流式分片格式（首分片是否空参数、index 是否稳定）
□ 并行工具调用 index 稳定性
□ 命名 tool_choice 是否可用（大概率 500）
□ 图片输入支持（视觉模型直传）
□ 非视觉模型发图片的返回（大概率 500）
□ 错误体结构（error.code / 顶层 code / ref_code）
□ 余额不足 / 无效 key / 封号 / 限流的返回特征
□ 账号信息端点（响应结构、积分单位）
□ 周期额度 vs 订阅额度的区分
□ 是否支持 prompt cache
□ 用户中心必需固定头
□ 登录 token 来源与有效期
```

---

## 5. 相关文档

| 文档 | 内容 |
|------|------|
| [`api-reference.md`](api-reference.md) | SenseAudio 平台完整实测样本（具体数值参考） |
| [`../PLATFORM_PORTING.md`](../PLATFORM_PORTING.md) | 分步移植指南 |
| [`../docs/retry-and-key-rotation.md`](../docs/retry-and-key-rotation.md) | 错误分类与重试配置 |
| [`../docs/plan-usage-design.md`](../docs/plan-usage-design.md) | 套餐用量与余额显示 |