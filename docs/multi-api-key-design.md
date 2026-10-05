# 多 API Key 轮换与失效切换 — 设计与移植指南

> 状态：**已实施** | 适用范围：聊天请求、Git 提交消息生成、模型列表、启动同步、手动检测
>
> 本文档描述**当前代码**的行为。
>
> **本模块与平台无关**，直接复用。仅"失效判定"依赖平台返回的状态码/错误文本（可配置）。

---

## 1. 功能概述

支持添加多个 API Key（SecretStorage 加密存储），提供三种使用模式：

| 模式 | 行为 |
|------|------|
| `sticky`（默认） | 固定使用一个 key（轮询游标钉住不前移），前缀缓存命中率最高；仅当该 key 失效（余额不足/401/429/503 等）时才切换到下一个可用 key 并钉住；原 key 恢复后**不自动切回**，保持缓存亲和性 |
| `rotation` | 请求轮流使用各 key（轮询，每次请求成功/失败都换 key），自动跳过不可用的 key |
| `single` | 仅使用用户指定的"当前 key"；按 `<prefix>.singleKeyFallback` 设置决定失败行为：`switch`（默认，**仅在当前 key 余额不足（402）时**自动切换到下一个可用 key 并设为当前使用，右下角弹窗提示；401/429/503 等其他错误不切换、走 single 专属报错）或 `error`（任何错误直接报错不切换） |

### 失效检测机制

- **被动检测（唯一机制）**：请求失败后根据 HTTP 状态码与错误文本判定 key 失效并切换。
  - **确定性失效**（持久化 `available=false`）：**402 余额不足** → `balance`；**401 无效 Key** → `invalid`。
  - **瞬态失效**（仅内存冷却，不持久化）：**429 限流** → `rate_limited`；**503 服务端繁忙** → `server_error`。
  - 状态码与文本 patterns 均可配置（`<prefix>.apiKeyRotationStatusCodes` / `<prefix>.apiKeyRotationErrorPatterns`）。
- **手动检测（自愈）**：QuickPick 管理中提供"检测可用性"，对选中 key 执行**最小真实聊天请求**（`say ok`、`max_tokens=8`；余额不足时被 402 拦截不耗 token），通过后标记为可用（充值后无需手动改状态）。**不使用 `/v1/models` 校验**（余额 < 0 也能返回 200，无法作为可用性判据）。
- **瞬态自动重试**：全部 key 均因瞬态错误（默认 429/500/503，`<prefix>.transientRetryStatusCodes` 可配置）失败时，按 `<prefix>.transientRetryTimes`（默认 3）自动重试整轮——指数退避等待（2s/4s/8s，上限 8s），重试前**清空瞬态冷却**（否则 `pickNextApiKey` 会跳过全部 key 使重试无效），次数用尽才报错。
- **平台侧错误不换 key**：500 Internal Server Error 是平台问题而非 key 问题——它命中瞬态重试但**不**命中轮换状态码，因此**不标记 key、不换 key**，仅退避后重试同一个 key（日志 `key.transientRetrySameKey`）。
- **全部 key 不可用报错**：报错列出每个 key 的脱敏 ID + 原因（`buildAllKeysUnavailableDetail`，如 `sk_****abcd: 服务端繁忙 (503)`），区分"瞬态失败请稍后重试"（429/503）与"确定性失败请检测"（402/401）。
- **余额展示**：管理界面所有 key 列表（主界面 / 检测二级界面 / 删除·设当前·编辑·绑定选择界面）显示账号余额——现金 `$(coin)/$(error) 充值 ¥X.XX` + 代金券 `$(gift) 赠送 ¥Y.YY（至 YYYY-MM-DD）`。数据源为登录 token 查账号信息端点（**按账号粒度**，所有 key 共享），见 `src/balance/accountInfo.ts`。

> **为什么没有主动余额预检**：旧平台 cookie 端点已废弃（实测 404）。余额不足改由 API 返回 **402** 触发被动轮换。

---

## 2. 数据模型

### 2.1 SecretStorage 存储

```jsonc
// key: "<prefix>.apiKeys"
{
  "keys": [
    {
      "value": "sk_xxxx...",          // API Key（必填）
      "label": "工作号",               // 备注（可选）
      "cookie": "sess_xxxx...",        // 平台 cookie（可选，可多个 key 共享同一值）
      "available": true,               // 可用性: true=可用 / false=不可用(余额不足或失效) / null=未检测
      "lastCheckedAt": 1723190400000   // 最近一次检测时间戳（可选）
    }
  ],
  "activeIndex": 0                     // single 模式下的"当前使用" key 下标
}

// key: "<prefix>.apiKey"（旧版，迁移后删除）
"sk_xxxx..."  // 字符串
```

### 2.2 内存态（不持久化，重启重置）

```ts
// 轮询游标：模块级，跨请求共享。rotation 模式选中后前移（顺序轮换）；
// sticky 模式选中后钉住不前移（固定使用，失效才切下一个）
let rotationIndex = 0;

// 瞬态失效表：429 限流 / 503 服务端繁忙等"可能恢复"的失效，带冷却时间
// Map<keyValue, { exhaustedAt: number; reason: "rate_limited" | "server_error" }>
const transientExhausted = new Map<string, TransientExhausted>();
```

### 2.3 Key 状态机

```
                    ┌────────────────────────────────────────────┐
                    │                                            ▼
 [null] 未检测 ──手动检测通过──▶ [true] 可用 ◀──请求成功(自愈)────┐
    │  ▲                          │  │                          │
    │  │                          │  │ 请求 402 / 401            │
    │  │  手动检测失败             │  ▼                          │
    │  └───────────────────────▶ [false] 不可用                  │
    │                             │  原因: balance / invalid     │
    │                             │                              │
    └────── 手动检测(余额不足/401) ┘                              │
                                                                 │
    [true] 可用 ──请求429──▶ (内存) 冷却中(rate_limited) ──冷却到期自动恢复──▶ [true]
    [true] 可用 ──请求503──▶ (内存) 冷却中(server_error) ──冷却到期自动恢复──▶ [true]
    [true] 可用 ──请求401──▶ [false] invalid（持久化）
    [false] 不可用 ──手动检测通过(自愈)──▶ [true]
    [false] 不可用 ──重置失效状态命令──▶ [null] 未检测
```

- `available=false` 是**持久化**的（SecretStorage），重启保留（确定性原因：余额不足 / 无效 Key）。
- 429/503 是**瞬态冷却**（内存 + 冷却时间 `<prefix>.apiKeyExhaustedCooldownMin`，默认 10 分钟），到期自动恢复，不写持久化。**冷却期间 `pickNextApiKey` 会跳过该 key**；瞬态整轮重试前需 `resetExhaustedKeys(secrets,false)` 清空冷却。
- **自愈**：请求成功时自动把该 key 恢复为 `available=true`。
- **503 属于瞬态而非确定性**：平台繁忙通常很快恢复，持久化不可用会导致冷却到期后仍被阻挡。`getKeyRotationReason` 精确提取原因（402/401→确定性；429/503→瞬态），`markApiKeyExhausted` 按 `TRANSIENT_REASONS`（rate_limited/server_error）决定只冷却不持久化。

---

## 3. 关键函数设计

### 3.1 `src/keys/`（barrel：`keyManager.ts`）

| 函数 | 签名 | 职责 |
|------|------|------|
| `getApiKeyStore(secrets)` | `(secrets) => Promise<ApiKeyStore>` | 读取并缓存 store；自动迁移旧 `<prefix>.apiKey`；JSON 损坏时回退修复 |
| `saveApiKeyStore(secrets, store)` | `(secrets, store) => Promise<void>` | 写新格式；成功后删除旧 key（幂等） |
| `getApiKeyMode()` / `getSingleKeyFallback()` | 同步 | 读取 `apiKeyMode`（默认 sticky）/ `singleKeyFallback`（默认 switch），非法值回退 |
| `getRotationStatusCodes()` / `getRotationErrorPatterns()` | 同步 | 触发轮换的状态码（**默认 [401,402,429,503]**）/ 文本 patterns |
| `getTransientRetryStatusCodes()` / `getTransientRetryTimes()` | 同步 | 触发瞬态整轮重试的状态码（**默认 [429,500,503]**，与轮换状态码解耦）/ 重试次数（默认 3，0 禁用） |
| `getExhaustedCooldownMin()` | 同步 | 429/503 瞬态冷却时长（分钟，默认 10） |
| `getPrimaryApiKey(secrets)` | `(secrets) => Promise<ApiKeyEntry \| undefined>` | 模型列表/同步用：single→active；rotation→第一个可用的（跳过冷却与不可用） |
| `pickNextApiKey(secrets, mode)` | `(secrets, mode) => Promise<ApiKeyEntry \| undefined>` | 轮询/单 key 选择逻辑（见 3.2） |
| `shouldSingleKeyFallbackSwitch(secrets, failedKeys)` | `(secrets, failedKeys) => Promise<boolean>` | single+fallback=switch 时是否应切换：仅本轮 active key 因余额不足（402）失败才 true；401/429/503 与历史遗留不可用均不切换 |
| `setActiveKeyByValue(secrets, keyValue)` | `(secrets, keyValue) => Promise<void>` | 按值把 key 设为 single 当前 key（402 自动切换后调用，后续请求直接用新 key，避免重复 fallback+弹窗） |
| `getTransientExhaustedInfo(keyValue)` | 同步 | 查询瞬态冷却状态（原因 + 剩余秒数），冷却到期自动清除 |
| `hasTransientExhaustedKey(secrets)` | 异步 | 是否存在冷却中的 key（供"全部不可选"时判断是否值得整轮自动重试） |
| `isApiKeyEligible(entry)` | 同步 | 判断是否可被选中（非冷却中、非 `available=false`） |
| `isKeyRotationError(err)` | 同步 | 匹配状态码 `[401]/[402]/[429]/[503]` 或错误文本 patterns → 判定是否应切换 |
| `isTransientRetryError(err)` | 同步 | 状态码匹配 `transientRetryStatusCodes`（默认 [429,500,503]）→ 瞬态类，值得整轮自动重试 |
| `isTransientExhaustedReason(reason)` | 同步 | 是否为瞬态原因（`rate_limited`/`server_error`） |
| `getKeyRotationReason(err)` | 同步 | **精确提取失效原因**（比 patterns 更准）：402/INSUFFICIENT_BALANCE→`balance`；401→`invalid`；429/RATE_LIMITED→`rate_limited`；503→`server_error`；其他→`api_error` |
| `getKeyUnavailableReason(entry)` | 同步 | 取当前不可用原因（供报错展示）：冷却中→`rate_limited`/`server_error`；持久化不可用→`unavailable`；其他→`balance` |
| `markApiKeyExhausted(secrets, key, reason)` | 异步 | **瞬态原因**（rate_limited/server_error）→ 仅内存冷却不持久化；**确定性原因**（balance/invalid/api_error）→ 持久化 `available=false` |
| `markApiKeyAvailable(secrets, key)` | 异步 | 置 `available=true`，清冷却（自愈/手动检测通过） |
| `updateKeyAvailability(secrets, key, available)` | 异步 | 通用状态更新 |
| `resetExhaustedKeys(secrets, resetPersisted)` | 异步 | 清空瞬态冷却；可选将所有 `available=false` 重置为 `null`（`resetPersisted=true`） |
| `addApiKey(secrets, entry)` | 异步 | 添加单个 key（校验重复值） |
| `addApiKeys(secrets, entries)` | 异步 | **批量添加**（三元组 value/cookie/label）；已有重复 key 更新其 cookie（不重复添加），返回 `{added, updated}` |
| `updateApiKey(secrets, index, fields)` | 异步 | **三字段编辑**（value/cookie/label）；value 冲突校验，返回 `{ok, conflict?}` |
| `removeApiKey(secrets, index)` | 异步 | 删除；调整 activeIndex 与轮询游标；**同步清理该 key 的瞬态冷却条目** |
| `setActiveKey(secrets, index)` | 异步 | 设置 single 模式的当前 key |
| `setKeyCookie(secrets, index, cookie?)` | 异步 | 绑定/更新/清除指定 key 的 cookie |
| `getKeyDisplayStatus(entry)` | 同步 | `available` / `unavailable` / `unknown` / `cooldown`（供 QuickPick UI） |
| `maskApiKey(key)` / `maskCookie(cookie)` | 同步 | `sk_****abcd` / `sess_****abcd` 脱敏 |

### 3.2 `pickNextApiKey` 选择逻辑

```
pickNextApiKey(secrets, mode):
  store = await getApiKeyStore(secrets)
  if store.keys.length == 0: return undefined

  if mode == "single":
    entry = store.keys[store.activeIndex] ?? 第一个
    if isApiKeyEligible(entry): return entry
    // 不可用时由调用方（rotation.ts）决定：
    //   fallback=error  → 直接报错，不切换
    //   fallback=switch → 仅当本轮原因为余额不足(402)时以 rotation 模式再次调用本函数
    return undefined

  // rotation：从 rotationIndex 开始顺序查找第一个 eligible 的 key
  for i in 0..keys.length-1:
    idx = (rotationIndex + i) % keys.length
    entry = keys[idx]
    if isApiKeyEligible(entry):
      rotationIndex = (idx + 1) % keys.length   // 游标前移到下一个，保证下次从下一个开始
      return entry
  return undefined   // 全部不可用或冷却中

  // sticky：同 rotation 的扫描，但命中后**不前移游标**（钉住）
```

### 3.3 `src/balance/`（barrel：`balanceCheck.ts`）★ 移植对接点

| 函数 | 签名 | 职责 |
|------|------|------|
| `queryAccountInfo(loginToken)` ★ | `(token) => Promise<AccountInfo>` | **移植对接点**：GET 账号信息端点，Bearer 登录 token + `PLATFORM_HEADERS`；返回余额 + 套餐用量窗口 |
| `getAccountInfoWithStatus(token, ttlSec, force?)` | 异步 | 带状态返回：`ok` / `unauthorized`（401）/ `error`，供状态栏与命令区分 401 |
| `getAccountInfoCached(token, ttlSec)` | 异步 | TTL 缓存；失败返回 undefined（UI 显示"余额未知"） |
| `formatExpiryDate(epochSec)` | 同步 | 格式化代金券到期日为 `YYYY-MM-DD`（本地时区）；无到期/非法返回空串 |
| `POINTS_PER_CNY` ★ | 常量 | 积分 → 元 换算比例（**移植时实测校正**） |
| `testKeyAvailability(entry, baseUrl)` | 异步 | 手动检测：**发最小真实聊天请求**（`say ok`、`max_tokens=8`）：402/INSUFFICIENT_BALANCE → `{ok:false, reason:"balance"}`，401 → `{ok:false, reason:"invalid"}`，200 → `{ok:true}`；网络/超时 → `{ok:null}` 无法确定 |

> 手动检测"请求一次"为什么用真实聊天请求而非 `/v1/models`：**实测余额不足时 `/v1/models` 仍返回 200**（模型列表不校验余额），无法区分"余额不足"与"正常可用"；而真实请求在余额不足时被 402 拦截，**不消耗 token**，语义明确。

### 3.4 `src/provider/rotation.ts` — 轮换循环

`runKeyRotationLoop(params)` 是唯一的轮换实现，聊天请求与 Git 提交生成共用：

```
while (true):
  if failedKeys.size >= totalKeys:
      if 存在瞬态失败 且 tryTransientRetryRound(wholeRoundRetryCount) → 清冷却 + 退避 + 重试整轮
      else → 报错（列脱敏 key + 原因，区分瞬态/确定性）

  key = forceKey ?? pickNextApiKey(...)          // forceKey：500 同 key 重试
  if !key:
      single + fallback=switch + 本轮余额不足 → 降级 rotation 选下一个 + setActiveKeyByValue
      if 仍无 key:
          if 存在瞬态冷却 key 且 tryTransientRetryRound → 重试整轮
          else → 报错（single 专属文案 / 全部不可用文案）

  try:
      execute(key, headers)
      成功 → 自愈置可用 + 返回
  catch err:
      取消/超时 → 抛出
      isKeyRotationError(err):                   // 401/402/429/503
          reason = 瞬态重试命中但原因非瞬态 ? "server_error" : getKeyRotationReason(err)
          failedKeys.set(key, reason)
          markApiKeyExhausted(key, reason)       // 瞬态→仅冷却；确定性→持久化
          continue                               // 换下一个 key
      isTransientRetryError(err):                // 500 等平台侧错误
          if tryTransientRetryRound(sameKeyRetryCount):
              forceKey = key                     // 强制同一 key，不轮换
              continue
          抛出
      其他（400/403/网络/IMAGE_SENSITIVE）→ 抛出，不轮换
```

**两个独立的重试计数器**：`wholeRoundRetryCount`（全部 key 瞬态失败 / 无可用 key）与 `sameKeyRetryCount`（500 同 key 重试）分开计数——500 重试不消耗 429/503 的整轮配额，反之亦然。

---

## 4. 移植说明

本模块**与平台无关**，直接复用。移植时只需：

1. **配置前缀**：`<prefix>` 全局替换（见 `PLATFORM_PORTING.md` §1.2）。
2. **失效判定**：若新平台的错误语义不同，调整 `src/keys/config.ts` 的默认状态码与 patterns：
   - `getRotationStatusCodes()` 默认 `[401, 402, 429, 503]`
   - `getRotationErrorPatterns()` 默认含 `余额不足` / `insufficient balance` / `billing` 等
   - `getTransientRetryStatusCodes()` 默认 `[429, 500, 503]`
3. **余额展示**：实现 `src/balance/accountInfo.ts` 的 `queryAccountInfo()`（见 `plan-usage-design.md` §3）。

> 若新平台无多 key 需求，可保留 `single` 模式并只配置一个 key——其余逻辑自动退化。
