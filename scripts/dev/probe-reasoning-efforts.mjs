#!/usr/bin/env node

/**
 * 探测平台各 chat 模型的 `reasoning_effort` 档位支持范围。
 *
 * 背景：`/v1/models` 与 models.dev **通常都不返回**具体档位列表，只给
 * "是否支持 reasoning_effort" 的布尔标记。档位是平台部署级知识，只能实测
 * （发请求看 200 / 400）确定，然后手写进 `src/models/models.ts` 的
 * `supportedReasoningEfforts` / `defaultReasoningEffort`。
 *
 * 本脚本对每个 chat 模型 × 每个档位发一个最小请求，输出支持矩阵与
 * `models.ts` 更新建议。
 *
 * Usage:
 *   node scripts/dev/probe-reasoning-efforts.mjs --api-key <key>
 *   PROVIDER_API_KEY=<key> node scripts/dev/probe-reasoning-efforts.mjs
 *
 * Options:
 *   --models <id1,id2,...>   只探测指定模型（默认全部 chat 模型）
 *   --efforts <e1,e2,...>    只探测指定档位（默认全部）
 *   --gap-ms <n>             请求间隔（默认 3000ms，避免触发 RPM 限制）
 *   --timeout-ms <n>         单请求超时（默认 300000ms；慢模型首字延迟可达 2 分钟）
 *   --base-url <url>         覆盖 API 根地址（默认读 src/platform/platformConfig.ts）
 *
 * ⚠️ 每个请求都消耗额度。建议在额度充足时运行，或先用 `--models` 跑子集。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ⚠️ 移植对接点：API 根地址与内置清单路径。
// 根地址默认从 `src/platform/platformConfig.ts` 的 `API_BASE_URL` 读取，
// 与扩展运行时保持一致；读不到时用 `--base-url` / `PROVIDER_BASE_URL` 兜底。
const PLATFORM_CONFIG_PATH = fileURLToPath(new URL("../../src/platform/platformConfig.ts", import.meta.url));
const MODELS_TS_PATH = fileURLToPath(new URL("../../src/models/models.ts", import.meta.url));
const API_KEY_ENV = "PROVIDER_API_KEY";

/** 档位按强度升序（与 `apiModelList.ts` 的 REASONING_EFFORT_ORDER 一致）。 */
const ALL_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

// ── CLI 解析 ──

function parseArgs(argv) {
    const args = { models: null, efforts: null, gapMs: 3000, timeoutMs: 300000, baseUrl: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--api-key") args.apiKey = argv[++i];
        else if (a === "--models") args.models = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
        else if (a === "--efforts") args.efforts = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
        else if (a === "--gap-ms") args.gapMs = Number(argv[++i]) || 3000;
        else if (a === "--timeout-ms") args.timeoutMs = Number(argv[++i]) || 300000;
        else if (a === "--base-url") args.baseUrl = argv[++i];
    }
    return args;
}

// ── Helpers ──

/** 从 platformConfig.ts 读取 API_BASE_URL（避免脚本与代码各写一份地址）。 */
function readApiBaseUrl() {
    try {
        const source = readFileSync(PLATFORM_CONFIG_PATH, "utf8");
        const match = source.match(/API_BASE_URL\s*=\s*["'`]([^"'`]+)["'`]/);
        return match?.[1];
    } catch {
        return undefined;
    }
}

/** 从 models.ts 的 BUILT_IN_MODELS 里提取 baseId（离线兜底模型清单）。 */
function extractModelsFromBuiltIn(fileContent) {
    const ids = [];
    const regex = /\{\s*baseId:\s*"([^"]+)"/g;
    let match;
    while ((match = regex.exec(fileContent)) !== null) {
        ids.push(match[1]);
    }
    return [...new Set(ids)].sort();
}

/**
 * 从 `/v1/models` 响应里挑出 chat 模型。
 *
 * 各平台字段不同，这里按信号强弱依次判断：
 *   1. `architecture.output_modalities` 含 `text`（OpenRouter 风格）
 *   2. `mode === "llm"`（AMD TokenFactory 风格）
 *   3. 两者都没有 → 全部保留（无法判断，交给用户 `--models` 过滤）
 */
function extractChatModelsFromApi(data) {
    const entries = Array.isArray(data) ? data : [];
    const filtered = entries.filter((m) => {
        const outputs = m.architecture?.output_modalities;
        if (Array.isArray(outputs) && outputs.length > 0) {
            return outputs.includes("text");
        }
        if (typeof m.mode === "string") {
            return m.mode === "llm";
        }
        return true;
    });
    return filtered.map((m) => m.id).filter((id) => typeof id === "string" && id);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 主流程 ──

const args = parseArgs(process.argv.slice(2));
const apiKey = args.apiKey || process.env[API_KEY_ENV];
if (!apiKey) {
    console.error(`用法: node scripts/dev/probe-reasoning-efforts.mjs --api-key <key>`);
    console.error(`  或  ${API_KEY_ENV}=<key> node scripts/dev/probe-reasoning-efforts.mjs`);
    process.exit(1);
}

const baseUrl = (args.baseUrl || process.env.PROVIDER_BASE_URL || readApiBaseUrl() || "").replace(/\/+$/, "");
if (!baseUrl) {
    console.error("无法确定 API 根地址：请用 --base-url 指定，或检查 src/platform/platformConfig.ts 的 API_BASE_URL。");
    process.exit(1);
}

// 1. 拉 /v1/models 拿 chat 模型列表
let apiChatModels = [];
try {
    const modelsResp = await fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!modelsResp.ok) {
        console.error(`/v1/models 失败: [${modelsResp.status}] ${modelsResp.statusText}`);
        process.exit(1);
    }
    const modelsData = await modelsResp.json();
    apiChatModels = extractChatModelsFromApi(modelsData.data);
} catch (err) {
    console.error(`/v1/models 请求异常: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
}

// 2. 内置清单模型（兜底：API 失败时用内置清单）
const builtInModels = extractModelsFromBuiltIn(readFileSync(MODELS_TS_PATH, "utf8"));

// 3. 确定要探测的模型
const targetModels = args.models ?? [...new Set([...apiChatModels, ...builtInModels])].sort();
const targetEfforts = args.efforts ?? ALL_EFFORTS;

console.log(`API 根地址: ${baseUrl}`);
console.log(`探测模型 (${targetModels.length}): ${targetModels.join(", ")}`);
console.log(`探测档位 (${targetEfforts.length}): ${targetEfforts.join(", ")}`);
console.log(`请求间隔: ${args.gapMs}ms\n`);

// 4. 逐模型 × 逐档位发最小请求
const results = {};
let total = 0;
let okCount = 0;
let quotaExhausted = false;

for (const model of targetModels) {
    const ok = [];
    const bad = [];
    for (const effort of targetEfforts) {
        total++;
        const r = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
                model,
                messages: [{ role: "user", content: "hi" }],
                stream: false,
                max_tokens: 8,
                reasoning_effort: effort,
            }),
            signal: AbortSignal.timeout(args.timeoutMs),
        });
        if (r.ok) {
            ok.push(effort);
            okCount++;
        } else {
            const text = await r.text();
            if (/Daily usage limit exceeded|rate_limit_exceeded|quota/i.test(text)) {
                quotaExhausted = true;
                bad.push(`${effort}(额度耗尽)`);
            } else {
                bad.push(`${effort}(${r.status})`);
            }
        }
        await sleep(args.gapMs);
    }
    results[model] = { ok, bad };
    console.log(`${model}: ok=[${ok.join(",")}] bad=[${bad.join(",")}]`);
}

// 5. 汇总
console.log(`\n=== 汇总: ${okCount}/${total} 请求成功 ===`);
if (quotaExhausted) {
    console.log("⚠️ 检测到额度耗尽 —— 部分结果不可靠，请额度重置后重跑。");
}

// 6. 输出 models.ts 更新建议
console.log("\n=== models.ts supportedReasoningEfforts 更新建议 ===");
for (const model of targetModels) {
    const { ok } = results[model] ?? { ok: [] };
    if (ok.length === 0) {
        console.log(`  ${model}: 全部失败（可能额度问题，或模型不支持 reasoning_effort）`);
        continue;
    }
    // 默认档位：优先 xhigh（部分平台以 xhigh 为默认），否则 high，否则最高档
    const defaultEffort = ok.includes("xhigh") ? "xhigh" : ok.includes("high") ? "high" : ok[ok.length - 1];
    console.log(
        `  ${model}: supportedReasoningEfforts: [${ok.map((e) => `"${e}"`).join(", ")}], defaultReasoningEffort: "${defaultEffort}"`
    );
}
