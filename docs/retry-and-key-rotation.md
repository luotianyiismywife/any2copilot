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
  ├─ ② 换 key 判定（isKeyRotationError，<prefix>.apiKeyRotation*）
  │     命中 → 标记该 key 失效 + 换下一个 key（continue 轮换循环）
  │     默认状态码 [401, 402, 429, 503] + 文本 patterns
  │     其中命中 <prefix>.apiKeyBannedErrorPatterns → reason="banned"（持久化失效）
  │
  └─ ③ 整轮层重试（tryTransientRetryRound，<prefix>.transientRetry*）
        命中瞬态状态码但**不**命中换 key 状态码 → 不换 key，退避后重试同一个 key
        全部 key 均瞬态失败 → 清冷却 + 退避 + 重跑整轮
        默认状态码 [429, 500, 503]，默认 3 次
```

### 1.1 关键区分：换 key vs 不换 key

| 错误类型 | 命中换 key 状态码？ | 命中瞬态重试状态码？ | 行为 |
|----------|:---:|:---:|------|
| **402 余额不足** | ✅ | ❌ | **换 key**（持久化 `available=false`） |
| **401 无效 Key** | ✅ | ❌ | **换 key**（持久化 `available=false`） |
| **429 限流** | ✅ | ✅ | **换 key**（仅内存冷却，冷却到期自动恢复） |
| **503 服务端繁忙** | ✅ | ✅ | **换 key**（仅内存冷却） |
| **500 内部错误** | ❌ | ✅ | **不换 key**——退避后重试**同一个 key** |
| **502/504 网关错误** | ❌ | ❌ | HTTP 层重试（同一请求） |
| **400/403 参数/权限** | ❌ | ❌ | 直接报错，不重试不换 key |

> **为什么 500 不换 key**：500 Internal Server Error 是**平台问题**，不是 key 问题。换 key 无意义（所有 key 都会遇到同样的平台故障），只会白白消耗其他 key 的配额。正确做法是退避等待后重试同一个 key。

> **为什么 429/503 既换 key 又重试**：这两个状态码同时出现在两个列表里。命中换 key 状态码 → 标记当前 key 冷却并换下一个；若**所有** key 都因 429/503 失败 → 触发整轮重试（清冷却 + 退避 + 重跑）。

### 1.2 两个独立的重试计数器

轮换循环维护**两个互不干扰**的计数器，避免一种重试消耗另一种的配额：

| 计数器 | 触发场景 | 配置 |
|--------|----------|------|
| `wholeRoundRetryCount` | 全部 key 瞬态失败 / 无可用 key | `<prefix>.transientRetryTimes` |
| `sameKeyRetryCount` | 500 等平台侧错误（同 key 重试） | `<prefix>.transientRetryTimes` |

> 一次 500 重试**不会**消耗 429/503 的整轮重试配额，反之亦然。

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
│                                                                   │
│        if isKeyRotationError(err):          ← ① 换 key            │
│            标记 key 失效（瞬态→冷却 / 确定性→持久化）             │
│            continue（换下一个 key）                               │
│                                                                   │
│        if isTransientRetryError(err):       ← ② 不换 key，同 key  │
│            if 同 key 重试未达上限:                                │
│                强制复用同一个 key + 退避 + continue               │
│            否则 → 抛出                                            │
│                                                                   │
│        其他错误（400/403/网络/图片敏感）→ 抛出，不重试不换 key    │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. 配置项总表

> `<prefix>` 指设置前缀（当前 `any2copilot`，移植时全局替换，见 `PLATFORM_PORTING.md` §1.2）。

### 3.1 换 key 相关

| 设置 | 默认 | 说明 |
|------|------|------|
| `<prefix>.apiKeyRotationStatusCodes` | `[401, 402, 429, 503]` | 触发**换 key** 的 HTTP 状态码（匹配错误消息中的 `[code]` 或 `status code`） |
| `<prefix>.apiKeyRotationErrorPatterns` | `["余额不足", "insufficient balance", "INSUFFICIENT_BALANCE", "balance", "RATE_LIMITED", "UPSTREAM_RATE_LIMITED"]` | 触发**换 key** 的错误文本 patterns（不区分大小写） |
| `<prefix>.apiKeyBannedErrorPatterns` | `["计费账户已被冻结", "\"code\":\"billing\"", "ref_code:400901"]` | 判定为**封号**的错误文本 patterns（不区分大小写）。命中即持久化失效（`reason="banned"`），与普通换 key 区分。空数组 = 禁用封号判定 |
| `<prefix>.apiKeyMode` | `sticky` | key 使用模式：`sticky`（固定一个，失效才换）/ `rotation`（轮询）/ `single`（仅当前 key） |
| `<prefix>.singleKeyFallback` | `switch` | `single` 模式下当前 key 不可用时的行为：`switch`（仅余额不足 402 时自动切换）/ `error`（直接报错） |
| `<prefix>.apiKeyExhaustedCooldownMin` | `10` | 瞬态失效 key（429/503）的冷却时长（分钟）。0 = 立即恢复 |

### 3.2 整轮重试相关（不换 key / 全部失败后重跑）

| 设置 | 默认 | 说明 |
|------|------|------|
| `<prefix>.transientRetryStatusCodes` | `[429, 500, 503]` | 视为**瞬态平台错误**的状态码，触发整轮重试。**同时**出现在 `apiKeyRotationStatusCodes` 中的（429/503）会换 key；**未**出现的（500）不换 key、仅重试同一个 key |
| `<prefix>.transientRetryTimes` | `3` | 整轮重试次数（0-10）。指数退避 2s/4s/8s（上限 8s），重试前清空瞬态冷却。0 = 禁用 |

### 3.3 HTTP 层重试相关（同一请求）

| 设置 | 默认 | 说明 |
|------|------|------|
| `<prefix>.retry.enabled` | `true` | 启用 HTTP 层重试 |
| `<prefix>.retry.maxAttempts` | `2` | 每个请求的 HTTP 层重试次数（1-10）。**建议保持较小**——对同时出现在两个列表中的状态码，它会与 `transientRetryTimes` 相乘 |
| `<prefix>.retry.intervalMs` | `1000` | 首次重试前的基础延迟（毫秒）。后续每次翻倍（指数退避，上限 60s） |
| `<prefix>.retry.statusCodes` | `[]` | **额外**在 HTTP 层重试的状态码。网关错误（502/504）与网络错误始终重试 |

---

## 4. 常见场景配置示例

### 4.1 默认配置（推荐）

```jsonc
{
  "any2copilot.apiKeyRotationStatusCodes": [401, 402, 429, 503],
  "any2copilot.transientRetryStatusCodes": [429, 500, 503],
  "any2copilot.transientRetryTimes": 3,
  "any2copilot.apiKeyExhaustedCooldownMin": 10,
  "any2copilot.retry.enabled": true,
  "any2copilot.retry.maxAttempts": 2
}
```

行为：402/401 换 key 并持久化失效；429/503 换 key 并冷却；500 不换 key、退避重试同一 key；全部 key 瞬态失败时整轮重试最多 3 次。

### 4.2 平台 500 频繁，希望更激进地重试

```jsonc
{
  "any2copilot.transientRetryTimes": 5,          // 整轮重试 5 次
  "any2copilot.retry.maxAttempts": 1             // HTTP 层不重试（避免相乘）
}
```

### 4.3 平台把 500 也当作 key 问题（罕见）

若你的平台确实用 500 表示"这个 key 有问题"，把它加入换 key 状态码：

```jsonc
{
  "any2copilot.apiKeyRotationStatusCodes": [401, 402, 429, 500, 503]
}
```

> ⚠️ 此时 500 会**同时**命中换 key 与瞬态重试——先换 key，全部 key 都 500 时才整轮重试。

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
  "any2copilot.apiKeyRotationStatusCodes": [401, 402, 403, 429, 503],
  "any2copilot.transientRetryStatusCodes": [403, 429, 500, 503]
}
```

---

## 5. 两层重试的相乘效应（重要）

若某状态码**同时**出现在 `retry.statusCodes`（HTTP 层）与 `transientRetryStatusCodes`（整轮层），实际尝试次数为：

```
maxAttempts × (transientRetryTimes + 1)
```

默认配置下，429/500/503 **不在** HTTP 层重试列表（只有 502/504 在），所以不会相乘。但如果你手动把 429 加进 `retry.statusCodes`：

```
2 × (3 + 1) = 8 次尝试
```

**建议**：保持 `retry.maxAttempts` 较小（默认 2），且不要把平台错误（429/500/503）加进 `retry.statusCodes`——它们由整轮层处理更合适（可换 key）。

---

## 6. 移植说明

本模块**与平台无关**，直接复用。移植时按新平台的错误语义调整默认值：

1. **换 key 状态码**：`src/keys/config.ts` 的 `getRotationStatusCodes()` 默认值
2. **换 key 文本 patterns**：`getRotationErrorPatterns()` 默认值（如新平台的余额不足文案）
3. **封号文本 patterns**：`getBannedErrorPatterns()` 默认值（设置 `apiKeyBannedErrorPatterns`；新平台无封号概念时置空数组）
4. **瞬态重试状态码**：`getTransientRetryStatusCodes()` 默认值
5. **HTTP 层重试状态码**：`src/core/utils.ts` 的 `RETRYABLE_STATUS_CODES`（默认 `[502, 504]`）

> 排查方法见 `.copilot/api-reference.md`——用真实请求触发各类错误，记录状态码与响应体，据此调整上述默认值。

---

## 7. 相关文档

- [`multi-api-key-design.md`](multi-api-key-design.md) — 多 Key 轮换与失效切换的完整设计
- [`plan-usage-design.md`](plan-usage-design.md) — 套餐用量与余额显示
- `PLATFORM_PORTING.md` §2 — 平台行为差异排查清单（含限流特征）
