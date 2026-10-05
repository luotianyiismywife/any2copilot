# 套餐用量与余额显示 — 设计与移植指南

> 适用范围：状态栏主文本、悬停提示、`<prefix>.checkUsage` 命令
> 参考实现：上游 [opencode-go-copilot](https://github.com/OnesoftQwQ/opencode-go-copilot) 的 `goUsage.ts` + `statusBar.ts`

---

## 1. 为什么需要这个模块

上游 opencode-go-copilot 的状态栏主文本显示的是**套餐用量**（`Go 5H 65%`）而不是 Token 计数——因为对订阅制供应商来说，「这个 5 小时窗口还能用多少」比「这次请求花了多少 token」更有决策价值。Token 计数退居悬停提示。

本模块的核心工作是**把「限流窗口」与「订阅额度」两套规则正确区分并归一化**，同时**兼容两种数据格式**：

- **仅余额**（平台无套餐窗口概念）：`usageInfos` 为空 → 状态栏只显示余额行
- **余额 + 用量窗口**：归一化 5h/周/月窗口 → 状态栏显示用量 + 余额

---

## 2. 两套计费规则（**关键，不可混淆**）

> ⚠️ 这是**通用概念**，不是某个平台特有。移植时按你平台的实际情况映射。

### 2.1 周期额度（限流窗口）—— 5h / 周

| 窗口 | 重置规则 | 耗尽后行为 |
|------|----------|-----------|
| 5 小时限额 | 按**首次请求时间**起算，5 小时为周期定时刷新 | **等待下一周期自动恢复** |
| 周限额 | 每周一 00:00:00 重置 | **等待下一周期自动恢复** |

**结论：5h / 周窗口耗尽 ≠ 扣余额。** 它们只是限流。

### 2.2 套餐积分（订阅额度）—— 月度总额

| 窗口 | 重置规则 | 耗尽后行为 |
|------|----------|-----------|
| 月限额 | **每订阅月第 1 日 00:00:00** 重置 | 走「超额策略」 |

**超额策略**：套餐额度用尽后暂停调用。如已开启余额自动支付，超出部分按量计费；如未开启或不支持余额支付，则自动降级至 Free 版。

**结论：月度窗口耗尽才进入超额状态。**

### 2.3 超额后的扣减顺序

```
套餐积分 → 代金券（按到期时间先后）→ 现金余额
```

`enableExtraUsage`（余额自动支付开关）决定超额后是**按量计费**还是**降级 Free 版**。

### 2.4 三态计费模式

| `billingMode` | 条件 | 状态栏主文本 |
|---------------|------|-------------|
| `plan` | 月度额度未耗尽 | `5H 65%` |
| `extra` | 月度额度耗尽 + `enableExtraUsage=true` | `余额 ¥358.78` |
| `free` | 月度额度耗尽 + `enableExtraUsage=false` | `余额 ¥0.00`（已降级 Free） |

---

## 3. 数据源（★ 移植对接点）

数据源由 `src/balance/accountInfo.ts` 的 `queryAccountInfo()` 提供，**这是唯一的平台对接层**。

### 3.1 移植步骤

1. 在 `src/platform/platformConfig.ts` 设置 `PLATFORM_USER_SELF_URL` 与 `PLATFORM_HEADERS`
2. 改写 `queryAccountInfo()` 的响应解析，把平台响应映射到 `AccountInfo`：
   - `balance`：现金余额（元）
   - `vouchers[]` / `voucherAvailableCny`：代金券（元）
   - `enableExtraUsage`：余额自动支付开关
   - `usageInfos[]`：套餐用量窗口（**无套餐概念时返回空数组**）
3. 校正 `POINTS_PER_CNY`（积分 → 元 换算比例，各平台不同）

### 3.2 `AccountInfo` 结构

```ts
interface AccountInfo {
    balance: number;                    // 现金余额（元）
    vouchers: Array<{ ... }>;           // 代金券列表（积分）
    voucherAvailablePoints: number;     // 代金券可用总额（积分）
    voucherAvailableCny: number;        // 代金券可用总额（元）
    earliestVoucherExpiry: number | null;
    enableExtraUsage: boolean;          // 余额自动支付开关
    status: string;                     // 账号状态
    usageInfos: PlanUsageWindow[];      // 套餐用量窗口（可为空）
}

interface PlanUsageWindow {
    key: string;          // 窗口标识（如 credit_5h_limit）
    desc: string;         // 窗口描述（如 "5小时积分"）
    usedCount: number;    // 已用
    pendingCount: number; // 排队中
    totalCount: number;   // 窗口上限
    resetTime: number;    // 重置时间（epoch 秒）
}
```

### 3.3 ⚠️ 单位陷阱（两个「积分」可能不是同一单位）

| 概念 | 单位 | 换算 |
|------|------|------|
| 套餐 `usageInfos` 的积分 | 套餐积分 | 直接是数字 |
| 代金券 `vouchers[].available` | 代金券积分 | **1 元 = `POINTS_PER_CNY` 积分** |

> **实测教训（SenseAudio 示例）**：代金券积分 `1 元 = 1,000,000 积分`，而套餐积分是另一个单位。
> 曾误用 `5000` 作除数导致代金券余额显示为实际值的 **200 倍**。常量 `POINTS_PER_CNY` 已固化并有回归测试。
> **移植时务必实测校正，绝不可混用换算比例。**

---

## 4. 模块结构

```
src/balance/
├── accountInfo.ts   # ★ 端点 + 字段映射（移植时只需改这里）
│   ├── POINTS_PER_CNY = 1_000_000
│   ├── queryAccountInfo(loginToken)          → AccountInfo
│   ├── getAccountInfoWithStatus(token, ttl, force) → { info, status }
│   └── formatExpiryDate(epochSec)            → "YYYY-MM-DD"
├── planUsage.ts     # 归一化 + 缓存 + 格式化（移植时原样复用）
│   ├── buildSnapshot(info)                   → PlanUsageSnapshot   [纯函数]
│   ├── getPlanUsageCached(token, force)      → 带 TTL 缓存 + 失败保留旧值
│   ├── getPlanUsageSnapshot()                → 同步读缓存（状态栏渲染用）
│   ├── classifyWindow(key, desc)             → "rolling"|"weekly"|"monthly"|"other"
│   ├── getWindowPercent(window)              → 0-100+（不截断）
│   ├── isPlanExhausted(snapshot)             → 只看月度额度窗口
│   ├── formatResetDuration(epochSec)         → "2H13M"
│   └── formatWindowLine / formatUsageSummary / formatBillingModeLine
├── config.ts        # 阈值 / TTL 配置读取 + toNumber
└── balanceCheck.ts  # barrel

src/ui/statusBar.ts  # 渲染 + 后台轮询 + 点击刷新
src/commands/checkUsageCommand.ts  # <prefix>.checkUsage 命令
```

### 4.1 数据流

```
initStatusBar(context, getLoginToken)
  └── startUsagePolling()                    ← 立即刷新一次 + 定时器
        └── refreshPlanUsage()
              └── getPlanUsageCached(token)  ← TTL 缓存（默认 60s）
                    └── getAccountInfoWithStatus()
                          └── queryAccountInfo()  ← ★ 平台端点
              └── updateStatusBarUsageText() + updateCumulativeTooltip()

点击状态栏 / <prefix>.checkUsage
  └── refreshPlanUsageNow()                  ← force=true 绕过 TTL
```

### 4.2 失败降级策略

| 场景 | 行为 |
|------|------|
| 未配置登录 token | 状态栏显示 `--`，轮询跳过（`planUsage.poll.skip`） |
| 401 token 失效 | 保留旧快照；`checkUsage` 命令提示重新复制 token |
| 网络 / 403 失败 | **保留上一次成功快照**（静默降级），状态栏不清空 |
| 首次拉取即失败 | 状态栏显示 `--` |

---

## 5. 状态栏展示

### 5.1 主文本

| 状态 | 文本 |
|------|------|
| 有数据，额度内 | `$(pulse) 5H 65%` |
| 有数据，额度耗尽 | `$(pulse) 余额 ¥358.78` |
| 无数据 | `$(pulse) --` |
| `showUsageInStatusBar=false` | `$(symbol-numeric) 12.3K ▅ 45.2%`（Token 计数，旧行为） |

### 5.2 悬停提示

```
↑ 12.3K (1.2K cached, 65%)
↓ 4.5K

5H——0% (0 / 10,000 积分)
Week——0% (0 / 10,000 积分)
Month——100% (10,012 / 10,000 积分)
五小时窗口将在 2H13M 后重置

余额——¥0.00 + 赠送 ¥358.78
套餐额度已耗尽 · 超出部分按量计费（代金券 → 现金余额）
```

> 无用量窗口（仅余额格式）时，只显示 `余额——…` 行。

### 5.3 配置项

| 配置 | 默认 | 说明 |
|------|------|------|
| `<prefix>.showUsageInStatusBar` | `true` | 主文本显示套餐用量（关闭则显示 Token 计数） |
| `<prefix>.showUsageInTooltip` | `true` | 悬停提示显示套餐用量区块 |
| `<prefix>.usageRefreshInterval` | `5` | 后台刷新间隔（分钟，1-60） |
| `<prefix>.enableThirdPartyTokenIndicator` | `false` | 是否显示高级 Token 计数器 |
| `<prefix>.minBalanceCny` | `0` | 余额阈值（合计可用 ≤ 该值标记 error 图标） |
| `<prefix>.balanceCheckIntervalSec` | `60` | 账号信息缓存 TTL（秒） |

### 5.4 ⚠️ 状态栏可见性（易踩坑）

状态栏承载**两个独立功能**：套餐用量 + 高级 Token 计数器。可见性由
`isStatusBarEnabled()` 决定：

```ts
isThirdPartyIndicatorEnabled() || isUsageInStatusBarEnabled() || isUsageTooltipEnabled()
```

**不能只用 `enableThirdPartyTokenIndicator` 把关**（默认关闭），否则套餐用量功能将永远不可见。

---

## 6. 可裁剪

若新平台**无用户中心 / 套餐概念**：

- 让 `queryAccountInfo()` 抛错即可——UI 显示"余额未知"，其余功能不受影响
- 或整体删除 `src/balance/` + `src/commands/checkUsageCommand.ts` + 状态栏用量部分
  （同步清理 `extension.ts` 初始化、`registerCommands.ts` 命令注册、`package.json` contributes；
  `npm run audit` 会帮你查漂移）
