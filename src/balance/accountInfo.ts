import { logger } from "../core/logger";
import { PLATFORM_HEADERS, PLATFORM_USER_SELF_URL } from "../platform/platformConfig";
import { toNumber } from "./config";

/**
 * 平台用户中心账号信息查询（登录 PASETO token）。
 *
 * ⚠️ **移植对接点**：本文件是平台账号/余额数据的**唯一对接层**。
 * UI（key 管理界面余额显示、状态栏、checkUsage 命令）全部已接好，
 * 移植新平台时只需：
 * 1. 把 `PLATFORM_USER_SELF_URL` / `PLATFORM_HEADERS`（platformConfig.ts）
 *    换成新平台的账号信息端点与必需头
 * 2. 改写 `queryAccountInfo()` 内的响应解析（字段映射），填充 `AccountInfo`
 * 3. 若新平台无账号/余额概念，让 `queryAccountInfo()` 抛错即可——UI 会显示
 *    "余额未知"，其余功能不受影响
 *
 * **两种数据格式均支持**：
 * - 仅余额（无套餐窗口）：`usageInfos` 返回空数组 → 状态栏只显示余额
 * - 余额 + 套餐用量窗口（5h/周/月）：`usageInfos` 填充 → 状态栏显示用量 + 余额
 */

const REQUEST_TIMEOUT_MS = 20_000;

/**
 * 套餐用量详情（平台 `usage_infos` 子集）。
 *
 * 平台套餐通常分多个窗口（如 5 小时 / 每周 / 30 天）。
 * `resetTime` 为 epoch 秒。无套餐概念的平台返回空数组即可。
 */
export interface PlanUsageWindow {
    /** 窗口标识（如 credit_5h_limit / credit_7d_limit / credit_30d_limit） */
    key: string;
    /** 窗口描述（如 "5小时积分"） */
    desc: string;
    /** 已用 */
    usedCount: number;
    /** 排队中 */
    pendingCount: number;
    /** 窗口上限 */
    totalCount: number;
    /** 重置时间（epoch 秒） */
    resetTime: number;
}

/**
 * 积分 → 元 的换算比例（**移植对接点**，按新平台单位改）。
 *
 * ⚠️ 各平台单位差异极大，移植时务必实测校正。
 * 注意：套餐 `usage_infos` 的「积分」与代金券「积分」**可能不是同一单位**，
 * 本常量**仅用于代金券换算**，不可用于套餐额度。
 */
export const POINTS_PER_CNY = 1_000_000;

/**
 * 账号余额/套餐详情（UI 展示用的归一化结构）。
 *
 * 移植时保持此接口不变，在 `queryAccountInfo()` 里把新平台的响应
 * 映射到这些字段；新平台没有的字段填 0 / 空数组即可。
 */
export interface AccountInfo {
    /** 现金余额（元） */
    balance: number;
    /** 代金券列表（available/total/used 单位均为积分） */
    vouchers: Array<{ voucherId: number; name: string; available: number; total: number; used: number; expireAt: number | null }>;
    /** 代金券可用总额（积分） */
    voucherAvailablePoints: number;
    /** 代金券可用总额（元 = 积分 / POINTS_PER_CNY） */
    voucherAvailableCny: number;
    /** 最早到期时间（epoch 秒，无则 null） */
    earliestVoucherExpiry: number | null;
    /** 额外用量开关（套餐额度耗尽后是否回退到余额计费） */
    enableExtraUsage: boolean;
    /** 账号状态（平台原样返回，实测正常值为 `"NORMAL"`） */
    status: string;
    /** 套餐用量窗口（5小时/每周/30天）；无套餐概念的平台返回空数组 */
    usageInfos: PlanUsageWindow[];
}

/** 账号信息 TTL 缓存（按 token 粒度） */
interface AccountInfoCacheEntry {
    info: AccountInfo;
    checkedAt: number;
}
const accountInfoCache = new Map<string, AccountInfoCacheEntry>();
/** Max cached tokens — prevents unbounded growth when users paste different
 * tokens over time. Oldest entries are evicted first. */
const ACCOUNT_INFO_CACHE_MAX = 4;

/**
 * 账号信息拉取结果状态。
 * - `ok`：成功
 * - `unauthorized`：401，登录 token 失效（需重新从浏览器复制）
 * - `error`：网络错误 / 403 / 其他非 2xx
 */
export type AccountInfoFetchStatus = "ok" | "unauthorized" | "error";

/** 从错误消息中判定是否为 401 */
function isUnauthorizedError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return message.startsWith("401") || message.includes("[401]");
}

/**
 * 查询账号余额/套餐详情（**移植对接点**）。
 *
 * 默认实现：GET `PLATFORM_USER_SELF_URL`，Bearer 登录 token + `PLATFORM_HEADERS`。
 * 移植新平台时改写此函数的 URL / 头 / 响应解析；签名保持不变。
 *
 * @param loginToken 登录 PASETO token（浏览器 localStorage user.state.token）
 * @throws 网络错误 / 401（token 失效）/ 403（缺必需头）
 */
export async function queryAccountInfo(loginToken: string): Promise<AccountInfo> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(PLATFORM_USER_SELF_URL, {
            headers: {
                ...PLATFORM_HEADERS,
                Authorization: `Bearer ${loginToken}`,
            },
            signal: controller.signal,
        });
        if (response.status === 401) {
            throw new Error("401 未认证：登录 token 失效，请从浏览器重新复制");
        }
        if (response.status === 403) {
            throw new Error("403 禁止访问：token 格式错误或非登录 token");
        }
        if (!response.ok) {
            throw new Error(`账号信息查询失败：[${response.status}] ${response.statusText}`);
        }
        const body = (await response.json()) as {
            id?: string;
            username?: string;
            points?: number;
            balance?: number;
            account_info?: {
                balance?: number;
                vouchers?: Array<{ voucher_id: number; name: string; available: number; total: number; used: number; expire_at: number | null }>;
                enable_extra_usage?: boolean;
                status?: string;
            };
            usage_infos?: Array<{ key: string; desc: string; used_count: number; pending_count: number; total_count: number; reset_time: number }>;
        };
        const ai = body.account_info ?? {};
        const vouchers = (ai.vouchers ?? []).map((v) => ({
            voucherId: v.voucher_id,
            name: v.name,
            available: toNumber(v.available),
            total: toNumber(v.total),
            used: toNumber(v.used),
            expireAt: typeof v.expire_at === "number" ? v.expire_at : null,
        }));
        const now = Date.now() / 1000;
        const validVouchers = vouchers.filter((v) => v.available > 0 && (v.expireAt === null || v.expireAt > now));
        const voucherAvailablePoints = validVouchers.reduce((s, v) => s + v.available, 0);
        // 仅统计有到期日的代金券：全部永不过期时返回 null（而非 Infinity）
        const expiries = validVouchers
            .map((v) => v.expireAt)
            .filter((e): e is number => e !== null);
        return {
            balance: toNumber(ai.balance ?? body.balance),
            vouchers,
            voucherAvailablePoints,
            voucherAvailableCny: voucherAvailablePoints / POINTS_PER_CNY,
            earliestVoucherExpiry: expiries.length ? Math.min(...expiries) : null,
            enableExtraUsage: ai.enable_extra_usage ?? true,
            status: typeof ai.status === "string" ? ai.status : "UNKNOWN",
            usageInfos: (body.usage_infos ?? []).map((u) => ({
                key: u.key,
                desc: u.desc,
                usedCount: toNumber(u.used_count),
                pendingCount: toNumber(u.pending_count),
                totalCount: toNumber(u.total_count),
                resetTime: toNumber(u.reset_time),
            })),
        };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 带 TTL 缓存 + 状态返回的账号信息查询。
 *
 * 与 `getAccountInfoCached` 的区别：**不吞掉错误类型**，返回 `status` 供调用方
 * 区分「401 token 失效」与「一般网络失败」（状态栏与 `checkUsage` 命令需要）。
 *
 * @param force 为 true 时绕过 TTL 强制刷新（用户显式刷新）
 */
export async function getAccountInfoWithStatus(
    loginToken: string,
    ttlSec: number,
    force = false,
): Promise<{ info: AccountInfo | undefined; status: AccountInfoFetchStatus }> {
    if (!force && ttlSec > 0) {
        const cached = accountInfoCache.get(loginToken);
        if (cached && Date.now() - cached.checkedAt < ttlSec * 1000) {
            return { info: cached.info, status: "ok" };
        }
    }
    try {
        const info = await queryAccountInfo(loginToken);
        accountInfoCache.set(loginToken, { info, checkedAt: Date.now() });
        while (accountInfoCache.size > ACCOUNT_INFO_CACHE_MAX) {
            const oldest = accountInfoCache.keys().next().value;
            if (oldest === undefined) break;
            accountInfoCache.delete(oldest);
        }
        return { info, status: "ok" };
    } catch (err) {
        const status: AccountInfoFetchStatus = isUnauthorizedError(err) ? "unauthorized" : "error";
        logger.warn("key.accountInfo", {
            status,
            error: err instanceof Error ? err.message : String(err),
        });
        return { info: undefined, status };
    }
}

/** 带 TTL 缓存的账号信息查询（按 token 粒度）；查询失败返回 undefined（不抛错） */
export async function getAccountInfoCached(loginToken: string, ttlSec: number): Promise<AccountInfo | undefined> {
    return (await getAccountInfoWithStatus(loginToken, ttlSec)).info;
}

/**
 * 格式化代金券到期时间为 "YYYY-MM-DD"（本地时区）。
 * @param epochSec 到期时间（epoch 秒）；null / 非法值返回空字符串
 */
export function formatExpiryDate(epochSec: number | null | undefined): string {
    if (epochSec === null || epochSec === undefined || !Number.isFinite(epochSec)) {
        return "";
    }
    const d = new Date(epochSec * 1000);
    if (Number.isNaN(d.getTime())) {
        return "";
    }
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}
