/**
 * API model list fetcher.
 *
 * Fetches the list of available model IDs from the platform API
 * (/v1/models) and caches it with a 5-minute TTL.
 * Falls back to stale cache or an empty list on failure (silent degradation).
 */

import { API_BASE_URL } from "../platform/platformConfig";

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Extended model metadata returned by /v1/models (subset we consume).
 */
export interface ApiModelMetadata {
    id: string;
    /** Friendly display name from /v1/models (display_name field). */
    display_name?: string;
    /** Model description from /v1/models (desc field) — used as picker tooltip. */
    desc?: string;
    supports_responses?: boolean;
    supports_anthropic?: boolean;
    /**
     * Tri-state vision flag: `true` / `false` / `undefined` (no signal).
     * `undefined` MUST be preserved — collapsing "no signal" into `false` would
     * silently mark every unflagged model as text-only and disable the ask_image
     * proxy for it, overriding models.dev with a guess. See `visionModels.ts`.
     */
    supports_vision?: boolean;
    supports_reasoning?: boolean;
    supports_tools?: boolean;
    context_length?: number;
    max_completion_tokens?: number;
    /**
     * 平台返回的可选思考档位（如 `["low","medium","xhigh"]`）。
     *
     * **不是所有平台都返回** —— 未返回时保持 `undefined`，由 `registry.ts`
     * 依次回退到 models.dev / 内置清单 / 代码默认值。返回时以平台为准
     * （档位是平台部署级知识，平台自己最清楚）。
     */
    supported_reasoning_efforts?: string[];
    /** 平台返回的默认思考档位。 */
    default_reasoning_effort?: string;
}

/**
 * Raw model entry returned by the platform /v1/models.
 *
 * The endpoint returns ALL modality models (llm / stt / tts / voice_clone /
 * image / video / music / sfx / agent …). Only `mode === "llm"` entries are
 * text-generation chat models — everything else must be filtered out.
 *
 * `protocols` lists the API styles the model accepts, e.g.
 * ["chat_completions", "responses", "messages"] — used to derive the
 * supports_responses / supports_anthropic capability flags.
 */
interface ApiModelEntry extends Partial<Omit<ApiModelMetadata, "supported_reasoning_efforts" | "default_reasoning_effort">> {
    id: string;
    display_name?: string;
    mode?: string;
    protocols?: string[] | null;
    desc?: string;
    /** OpenRouter 风格的逐模型能力声明（可选）。 */
    supported_parameters?: string[] | null;
    /** OpenRouter 风格的上游 provider 列表（可选）。 */
    providers?: Array<{ reasoning?: boolean; tools?: boolean; vision?: boolean }> | null;
    // ── 思考档位：各平台字段名不统一，全部作为候选解析（见 parseReasoningEfforts）──
    supported_reasoning_efforts?: unknown;
    supported_reasoning_effort?: unknown;
    reasoning_efforts?: unknown;
    reasoning_effort_options?: unknown;
    reasoning_effort?: unknown;
    default_reasoning_effort?: unknown;
    reasoning_effort_default?: unknown;
    default_effort?: unknown;
    reasoning?: unknown;
}

/**
 * 已知思考档位的强度升序。
 *
 * 平台返回的数组顺序不可信（有的按字母序、有的把 `minimal` 追加在末尾），
 * 统一按本表排序后再交给选择器渲染；表外的自定义档位保持原顺序追加在末尾。
 */
export const REASONING_EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * 不是"档位"而是"思考开关形态"的值 —— 不进入档位列表。
 * 这些值由 `thinkingMode` / `enable_thinking` 表达，混进档位枚举会让选择器
 * 出现重复语义（如 `disabled` 与 `none` 并存）。
 */
const NON_EFFORT_VALUES = new Set(["auto", "adaptive", "enabled", "disabled", "default"]);

/** 把任意值归一化为单个档位名（小写、去空白）；非法值返回 `undefined`。 */
function normalizeEffortValue(value: unknown): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }
    const normalized = value.trim().toLowerCase();
    if (!normalized || NON_EFFORT_VALUES.has(normalized)) {
        return undefined;
    }
    return normalized;
}

/** 从任意形状里收集档位名（数组 / 分隔字符串 / 带列表字段的对象）。 */
function collectEffortValues(raw: unknown): string[] {
    if (Array.isArray(raw)) {
        return raw.map(normalizeEffortValue).filter((value): value is string => value !== undefined);
    }
    if (typeof raw === "string") {
        // 单值字符串不当作列表 —— 它更可能是"默认档位"而不是"全部可选档位"，
        // 误判会让选择器只剩一个选项。默认档位请用 parseDefaultReasoningEffort()。
        if (!/[,|\s/]/.test(raw.trim())) {
            return [];
        }
        return raw
            .split(/[,|\s/]+/)
            .map(normalizeEffortValue)
            .filter((value): value is string => value !== undefined);
    }
    if (raw && typeof raw === "object") {
        const obj = raw as Record<string, unknown>;
        for (const key of ["supported", "supported_efforts", "efforts", "values", "enum", "options", "levels", "list"]) {
            const candidate = obj[key];
            if (Array.isArray(candidate)) {
                return candidate.map(normalizeEffortValue).filter((value): value is string => value !== undefined);
            }
        }
    }
    return [];
}

/**
 * 解析平台返回的"可选思考档位"列表。
 *
 * 各平台字段形状不统一，这里全部容忍：
 *   - 字符串数组：`["low","medium","xhigh"]`
 *   - 逗号 / 空格 / 竖线 / 斜杠分隔的字符串：`"low,medium,xhigh"`
 *   - 对象：`{ supported: [...] }` / `{ efforts: [...] }` / `{ values: [...] }` /
 *     `{ enum: [...] }` / `{ options: [...] }` / `{ levels: [...] }`
 *
 * 输出统一为**小写、去重、按强度升序**的列表。
 *
 * @returns 归一化后的档位列表；无有效值时返回 `undefined`（调用方继续回退）。
 */
export function parseReasoningEfforts(raw: unknown): string[] | undefined {
    const values = collectEffortValues(raw);
    if (values.length === 0) {
        return undefined;
    }
    const unique = [...new Set(values)];
    const known = REASONING_EFFORT_ORDER.filter((effort) => unique.includes(effort));
    const unknown = unique.filter((effort) => !(REASONING_EFFORT_ORDER as readonly string[]).includes(effort));
    return [...known, ...unknown];
}

/**
 * 解析平台返回的默认思考档位（单值）。
 *
 * 同时接受 `"high"` 与 `{ default: "high" }` 两种形状。
 */
export function parseDefaultReasoningEffort(raw: unknown): string | undefined {
    const direct = normalizeEffortValue(raw);
    if (direct) {
        return direct;
    }
    if (raw && typeof raw === "object") {
        const obj = raw as Record<string, unknown>;
        for (const key of ["default", "default_effort", "default_reasoning_effort"]) {
            const value = normalizeEffortValue(obj[key]);
            if (value) {
                return value;
            }
        }
    }
    return undefined;
}

// ── Module-level cache ──
let cachedModelIds: string[] | null = null;
let cachedModelMetadata: ApiModelMetadata[] | null = null;
let cacheTimestamp = 0;
let lastFetchSuccess = false;
/** In-flight fetch promise — deduplicates concurrent calls (e.g. startup model
 * sync + model list request racing) so the API is only hit once. */
let inFlightFetch: Promise<void> | null = null;

/**
 * Fetch the model list from the API's /models endpoint.
 * The endpoint returns all modality models:
 *   { object: "list", data: [{ id, display_name, mode, protocols, desc, ... }] }
 *
 * Only `mode === "llm"` entries are text-generation models — TTS/ASR/image/
 * video/music etc. are filtered out here so model discovery and the picker
 * never show non-chat models.
 */
async function fetchApiModelList(apiKey: string): Promise<ApiModelMetadata[]> {
    const url = `${API_BASE_URL.replace(/\/+$/, "")}/models`;
    const response = await fetch(url, {
        headers: {
            Authorization: `Bearer ${apiKey}`,
        },
    });

    if (!response.ok) {
        throw new Error(`API model list error: [${response.status}] ${response.statusText}`);
    }

    const body = (await response.json()) as { data?: ApiModelEntry[] };
    return (body.data ?? [])
        // Filter out non-text-generation models (stt / tts / voice_clone / …).
        .filter((m) => m.mode === "llm")
        .map((m) => {
            // The platform /v1/models does not return supports_* capability flags,
            // 从 protocols 数组（chat_completions / responses / messages）推导协议能力。
            const protocols = m.protocols ?? [];
            const provider0 = m.providers?.[0] ?? {};
            const supportedParams = m.supported_parameters ?? [];
            const reasoningObj = m.reasoning && typeof m.reasoning === "object"
                ? (m.reasoning as Record<string, unknown>)
                : undefined;
            return {
                id: m.id,
                display_name: m.display_name,
                desc: m.desc,
                supports_responses: protocols.includes("responses") || m.supports_responses,
                supports_anthropic: protocols.includes("messages") || m.supports_anthropic,
                supports_vision: m.supports_vision,
                // 思考能力：显式布尔标记优先；否则从 OpenRouter 风格的
                // providers[0].reasoning / supported_parameters 推导。
                supports_reasoning:
                    m.supports_reasoning ??
                    (provider0.reasoning === true ||
                        supportedParams.includes("reasoning_effort") ||
                        supportedParams.includes("reasoning")),
                supports_tools: m.supports_tools ?? (supportedParams.includes("tools") || provider0.tools === true),
                context_length: m.context_length,
                max_completion_tokens: m.max_completion_tokens,
                // 思考档位：平台返回就用平台的（最权威），否则留 undefined 让
                // registry 回退到 models.dev / 内置清单 / 代码默认值。
                supported_reasoning_efforts: parseReasoningEfforts(
                    m.supported_reasoning_efforts ??
                    m.supported_reasoning_effort ??
                    m.reasoning_efforts ??
                    m.reasoning_effort_options ??
                    m.reasoning_effort ??
                    reasoningObj?.efforts ??
                    reasoningObj?.supported_efforts
                ),
                default_reasoning_effort: parseDefaultReasoningEffort(
                    m.default_reasoning_effort ??
                    m.reasoning_effort_default ??
                    m.default_effort ??
                    reasoningObj?.default
                ),
            };
        });
}

/**
 * Get the list of model IDs available via the platform API.
 *
 * @param apiKey - The API key for authentication.
 * @returns A set of model ID strings available on the API server.
 *          Returns an empty set on failure (silent degradation).
 */
export async function getApiModelIds(apiKey: string | undefined): Promise<Set<string>> {
    await ensureApiModelCache(apiKey);
    return new Set(cachedModelIds ?? []);
}

/**
 * Get the full metadata list (context_length, max_completion_tokens and the
 * supports_* capability flags) from the cached /v1/models response.
 * Returns an empty list on failure (silent degradation).
 *
 * Used by model discovery as the PRIMARY spec source for auto-discovered
 * models — the platform's own metadata is more accurate and fresher than
 * models.dev, whose catalog may lag or lack platform-specific entries
 * (fetch failures previously degraded specs to 128K context / 4096 output).
 */
export async function getApiModelMetadataList(apiKey: string | undefined): Promise<ApiModelMetadata[]> {
    await ensureApiModelCache(apiKey);
    return cachedModelMetadata ?? [];
}

/**
 * Ensure the module-level model cache is populated (5-minute TTL, silent fallback).
 */
async function ensureApiModelCache(apiKey: string | undefined): Promise<void> {
    const now = Date.now();

    // Use cached result if still fresh
    if (cachedModelMetadata !== null && now - cacheTimestamp < CACHE_TTL_MS) {
        return;
    }

    if (!apiKey) {
        // No API key — keep stale cache or leave empty
        return;
    }

    // Deduplicate concurrent fetches: if a fetch is already in flight (e.g.
    // startup model sync and the model list request running at the same time),
    // reuse its promise instead of issuing a second request.
    if (inFlightFetch) {
        return inFlightFetch;
    }

    inFlightFetch = (async () => {
        try {
            const models = await fetchApiModelList(apiKey);
            cachedModelIds = models.map((m) => m.id);
            cachedModelMetadata = models;
            cacheTimestamp = Date.now();
            lastFetchSuccess = true;
        } catch {
            // API call failed — keep stale cache if available
            lastFetchSuccess = false;
        }
    })().finally(() => {
        inFlightFetch = null;
    });

    return inFlightFetch;
}

/**
 * Returns true if the most recent API model list fetch was successful.
 * Used by the model provider to decide whether to apply API-based filtering.
 */
export function isApiFetchSuccessful(): boolean {
    return lastFetchSuccess;
}
