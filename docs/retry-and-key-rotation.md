# 重试与 Key 轮换配置指南

> 适用范围：聊天请求、Git 提交消息生成
> 相关代码：`src/provider/rotation.ts`、`src/provider/errors.ts`、`src/keys/config.ts`、`src/keys/health.ts`、`src/core/utils.ts`

本文档说明**请求失败后会发生什么**——是重试同一个 key、换一个 key、还是重跑整轮——以及如何通过设置调整这些行为。

---

## 1. 核心概念：两层重试 + 换 key 判定

请求失败后，扩展按**三个层次**处理，职责严格分离：

```
请求失败
  │
  ├─ ① HTTP 层重试（executeWithRetry，<prefix>.retry.*）
  │     同一请求退避重试，默认 2 次
  │     仅覆盖：网关错误（502/504）+ 网络错误
  │     ⚠️ 不覆盖 429/500/503（交给整轮层，避免两层相乘）
  │
  ├─ ② 换 key 判定（matchErrorRule，<prefix>.errorRules 四元组）
  │     命中 action=rotateCooldown / rotatePersist → 标记该 key 失效 + 换下一个 key
  │     命中 action=retrySameKey → 不换 key，退避后重试同一个 key
  │
  └─ ③ 整轮层重试（tryTransientRetryRound，<prefix>.transientRetryTimes）
        全部 key 均瞬态失败（rotateCooldown）→ 清冷却 + 退避 + 重跑整轮
        平台侧错误（retrySameKey，如 500）→ 不换 key，退避后重试同一个 key
        默认 3 次
```

### 1.1 关键区分：换 key vs 不换 key

错误分类**只配置 `<prefix>.errorRules` 一处**（四元组：`code` + `message` + `statusCode` + `action`）。按数组顺序匹配，首个命中即生效：

- `code`：错误响应体的 `error.code` 字段（精确匹配，**主要匹配字段**）
- `statusCode`：HTTP 状态码兜底（匹配错误消息中的 `[code]` / `status code` 形式）
- `message`：仅作可读性说明，**不参与匹配**
- `action`：处置动作，与 key 状态一一对应

| `action` | 含义 | 是否换 key | key 状态 |
|----------|------|:---:|------|
| `retrySameKey` | 平台/客户端侧瞬态问题（如 500、`upstream_stream_error`） | ❌ | 状态不变，退避后重试同一个 key |
| `rotateCooldown` | 瞬态限流/繁忙（429/503） | ✅ | 冷却中（仅内存冷却，到期自动恢复） |
| `rotatePersist` | 确定性失败（余额不足/无效 key/封号） | ✅ | 不可用（持久化 `available=false`） |

**默认规则**（`package.json` 的 `errorRules` 默认值，基于实测）：

| 规则 | 匹配 | action |
|------|------|--------|
| 封号 | `code=billing`（400） | `rotatePersist` |
| 上游流中断 | `code=upstream_stream_error`（400） | `retrySameKey` |
| 余额不足 | `code=INSUFFICIENT_BALANCE`（402） | `rotatePersist` |
| 无效 key | `statusCode=401` | `rotatePersist` |
| 余额不足 | `statusCode=402` | `rotatePersist` |
| 限流 | `statusCode=429` | `rotateCooldown` |
| 服务端繁忙 | `statusCode=503` | `rotateCooldown` |
| 上游中断复用 400 | `statusCode=400` | `retrySameKey` |
| 内部错误 | `statusCode=500` | `retrySameKey` |

> **为什么 500 不换 key**：500 Internal Server Error 是**平台问题**，不是 key 问题。换 key 无意义（所有 key 都会遇到同样的平台故障），只会白白消耗其他 key 的配额。正确做法是退避等待后重试同一个 key。

> **为什么 429/503 既换 key 又重试**：命中 `rotateCooldown` → 标记当前 key 冷却并换下一个；若**所有** key 都因 429/503 失败 → 触发整轮重试（清冷却 + 退避 + 重跑）。

### 1.2 两个独立的重试计数器

轮换循环维护**两个互不干扰**的计数器，避免一种重试消耗另一种的配额：

| 计数器 | 触发场景 | 配置 |
|--------|----------|------|
| `wholeRoundRetryCount` | 全部 key 瞬态失败 / 无可用 key | `<prefix>.transientRetryTimes` |
| `sameKeyRetryCount` | 500 等平台侧错误（同 key 重试） | `<prefix>.transientRetryTimes` |

> 一次 500 重试**不会**消耗 429/503 的整轮重试配额，反之亦然。

### 1.3 瞬态重试耗尽后的友好错误

`retrySameKey` 分支重试次数用尽后，不再抛出原始的 `500 Internal Server Error {...}`（对用户过于原始），而是包装为 `TransientRetryExhaustedError`：

> The server is busy or rate-limited. Retried N time(s) automatically without success. Please try again later.
>
> Original error: ...

---

## 2. 决策流程图

```
┌─────────────────────────────────────────────────────────────────┐
│ 轮换循环（runKeyRotationLoop）                                    │
│                                                                   │
│  while (true):                                                    │
│    if 所有 key 都已失败:                                          │
│        if 存在瞬态失败 且 整轮重试未达上限:                        │
│            → 清空瞬态冷却 + 指数退避 + 重跑整轮                    │
│        else:                                                      │
│            → 报错（列出每个 key 的脱敏 ID + 失败原因）             │
│                                                                   │
│    key = 选下一个可用 key（pickNextApiKey）                       │
│    if 无可用 key:                                                 │
│        single 模式 + 余额不足 → 降级 rotation 选下一个            │
│        仍无 → 存在瞬态冷却 key 且未达上限 → 重跑整轮              │
│              否则 → 报错                                          │
│                                                                   │
│    try:                                                           │
│        执行请求（含 HTTP 层重试）                                 │
│        成功 → 自愈置可用 + 返回                                   │
│    catch err:                                                     │
│        取消/超时 → 抛出                                           │
│        视觉代理轮内失败（VisionRoundError）→ 抛出，不轮换         │
│        已输出内容（hasEmittedOutput）→ 抛出，不轮换               │
│                                                                   │
│        rule = matchErrorRule(err)          ← ② errorRules 四元组  │
│        if action=rotateCooldown/rotatePersist:                    │
│            标记 key 失效（冷却/持久化）+ continue（换下一个 key）  │
│                                                                   │
│        if action=retrySameKey:             ← ③ 不换 key，同 key    │
│            if 同 key 重试未达上限:                                │
│                强制复用同一个 key + 退避 + continue               │
│            否则 → 抛 TransientRetryExhaustedError                 │
│                                                                   │
│        其他错误（403/网络/图片敏感）→ 抛出，不重试不换 key        │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. 配置项总表

> `<prefix>` 指设置前缀（当前 `any2copilot`，移植时全局替换，见 `PLATFORM_PORTING.md` §1.2）。

### 3.1 错误分类（换 key / 不换 key 判定）

| 设置 | 默认 | 说明 |
|------|------|------|
| `<prefix>.errorRules` | 见 §1.1 默认规则表 | 错误分类规则（四元组：`code` + `message` + `statusCode` + `action`）。按数组顺序匹配，首个命中即生效：`code`（错误体 `error.code` 精确匹配，**主要匹配字段**）优先于 `statusCode`（HTTP 状态码兜底）；`message` 仅作可读性说明**不参与匹配**。`action` 与 key 状态一一对应（`retrySameKey` 状态不变 / `rotateCooldown` 冷却中 / `rotatePersist` 不可用）。**只配置这一处**即可覆盖所有错误分类 |
| `<prefix>.apiKeyMode` | `sticky` | key 使用模式：`sticky`（固定一个，失效才换）/ `rotation`（轮询）/ `single`（仅当前 key） |
| `<prefix>.singleKeyFallback` | `switch` | `single` 模式下当前 key 不可用时的行为：`switch`（仅余额不足 402 时自动切换）/ `error`（直接报错） |
| `<prefix>.apiKeyExhaustedCooldownMin` | `10` | 瞬态失效 key（429/503）的冷却时长（分钟）。0 = 立即恢复 |

### 3.2 整轮重试相关（不换 key / 全部失败后重跑）

| 设置 | 默认 | 说明 |
|------|------|------|
| `<prefix>.transientRetryTimes` | `3` | 整轮重试次数（0-10）。指数退避 2s/4s/8s（上限 8s），重试前清空瞬态冷却。0 = 禁用 |

### 3.3 HTTP 层重试相关（同一请求）

| 设置 | 默认 | 说明 |
|------|------|------|
| `<prefix>.retry.enabled` | `true` | 启用 HTTP 层重试 |
| `<prefix>.retry.maxAttempts` | `2` | 每个请求的 HTTP 层重试次数（1-10）。**建议保持较小** |
| `<prefix>.retry.intervalMs` | `1000` | 首次重试前的基础延迟（毫秒）。后续每次翻倍（指数退避，上限 60s） |

> HTTP 层重试**仅限网关错误（502/504）与网络错误**（设计如此，无 `retry.statusCodes` 配置）。平台错误（429/500/503）由整轮层处理。

---

## 4. 常见场景配置示例

### 4.1 默认配置（推荐）

```jsonc
{
  "any2copilot.errorRules": [
    { "code": "billing", "message": "计费账户已被冻结（封号）", "action": "rotatePersist" },
    { "code": "upstream_stream_error", "message": "上游模型流意外中断", "action": "retrySameKey" },
    { "code": "INSUFFICIENT_BALANCE", "message": "余额不足", "action": "rotatePersist" },
    { "statusCode": 401, "message": "无效 key", "action": "rotatePersist" },
    { "statusCode": 402, "message": "余额不足", "action": "rotatePersist" },
    { "statusCode": 429, "message": "限流", "action": "rotateCooldown" },
    { "statusCode": 503, "message": "服务端繁忙", "action": "rotateCooldown" },
    { "statusCode": 400, "message": "上游中断复用 400", "action": "retrySameKey" },
    { "statusCode": 500, "message": "内部错误", "action": "retrySameKey" }
  ],
  "any2copilot.transientRetryTimes": 3,
  "any2copilot.apiKeyExhaustedCooldownMin": 10,
  "any2copilot.retry.enabled": true,
  "any2copilot.retry.maxAttempts": 2
}
```

行为：402/401/封号 换 key 并持久化失效；429/503 换 key 并冷却；500/上游中断 不换 key、退避重试同一 key；全部 key 瞬态失败时整轮重试最多 3 次。

### 4.2 平台 500 频繁，希望更激进地重试

```jsonc
{
  "any2copilot.transientRetryTimes": 5,          // 整轮重试 5 次
  "any2copilot.retry.maxAttempts": 1             // HTTP 层不重试（避免相乘）
}
```

### 4.3 平台把 500 也当作 key 问题（罕见）

若你的平台确实用 500 表示"这个 key 有问题"，把 500 的 `action` 改为 `rotatePersist`：

```jsonc
{
  "any2copilot.errorRules": [
    // ... 其他规则 ...
    { "statusCode": 500, "message": "内部错误", "action": "rotatePersist" }
  ]
}
```

> ⚠️ 此时 500 会**换 key 并持久化失效**，不再走同 key 重试。

### 4.4 完全禁用整轮重试（快速失败）

```jsonc
{
  "any2copilot.transientRetryTimes": 0
}
```

### 4.5 禁用 HTTP 层重试

```jsonc
{
  "any2copilot.retry.enabled": false
}
```

### 4.6 自定义限流语义（平台用 403 表示限流）

```jsonc
{
  "any2copilot.errorRules": [
    // ... 其他规则 ...
    { "statusCode": 403, "message": "限流", "action": "rotateCooldown" }
  ]
}
```

---

## 5. 两层重试的相乘效应（重要）

HTTP 层重试**仅限网关错误（502/504）与网络错误**，与整轮层（`transientRetryTimes`）**刻意不重叠**——平台错误（429/500/503）不在 HTTP 层重试列表，不会相乘。

**建议**：保持 `retry.maxAttempts` 较小（默认 2）。平台错误（429/500/503）由整轮层处理更合适（可换 key）。

---

## 6. 移植说明

本模块**与平台无关**，直接复用。移植时按新平台的错误语义调整默认值：

1. **错误分类规则**：`package.json` 的 `errorRules` 默认值（`src/keys/config.ts` 的 `getErrorRules` 只从 `package.json` 读取，代码不重复）——`code` 默认值（`billing` / `upstream_stream_error` / `INSUFFICIENT_BALANCE`）是示例，按你平台的错误响应体 `error.code` 调整；`statusCode` 兜底规则（401/402/429/503/400/500）是通用 HTTP 语义，通常无需改动
2. **HTTP 层重试状态码**：`src/core/utils.ts` 的 `RETRYABLE_STATUS_CODES`（默认 `[502, 504]`）——网关错误，通常无需改动

> 排查方法见 `.copilot/api-reference.md`——用真实请求触发各类错误，记录状态码与响应体，据此调整上述默认值。

---

## 7. 相关文档

- [`multi-api-key-design.md`](multi-api-key-design.md) — 多 Key 轮换与失效切换的完整设计
- [`plan-usage-design.md`](plan-usage-design.md) — 套餐用量与余额显示
- `PLATFORM_PORTING.md` §2 — 平台行为差异排查清单（含限流特征）
