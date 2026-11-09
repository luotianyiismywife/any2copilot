/**
 * 三路径冲突集成测试（真实平台 API + 生产代码 + mock vscode）。
 *
 * 覆盖视觉代理重构后的核心风险点：主对话 / 视觉代理 / 主模型续跑
 * **三条链路共用 `executeApiRequest`**，验证：
 *
 * ① 主对话（非视觉模型 + 图片）
 *    - convertMessages：图片替换为文本引用 + _localImages 收集
 *    - prepareRequestBody：ask_image 工具注入 + tool_choice=auto
 *    - processStreamingResponse：拦截 ask_image → interceptedToolCall
 * ② 视觉代理（视觉模型）
 *    - callVisionModel → executeApiRequest(reasoningEffortOverride)
 *    - 断言请求体 reasoning_effort 与 visionProxyThinking 设置一致
 *      （默认留空 = auto = **不发送**该参数）
 * ③ 主模型续跑（非视觉模型）
 *    - executeApiRequest(apiInstance + apiMessagesOverride + skipVisionRounds)
 *    - 断言消息数组 = 原始消息 + tool_call + tool_result（不重复 convertMessages）
 *
 * 冲突断言：
 *    - ① 的 um.reasoning_effort 不被 ② 的 override 污染
 *    - ③ 复用外层 api 实例后 _hasImages 保留 → ask_image 工具仍在
 *
 * 用法：
 *   node test/test-three-path.mjs <API_KEY>
 *   或设置环境变量 PROVIDER_API_KEY
 *
 * 可选环境变量：
 *   PROVIDER_BASE_URL       覆盖 API 根地址（默认读 src/platform/platformConfig.ts）
 *   PROVIDER_MAIN_MODEL     主对话模型（默认取内置清单第一个非视觉模型）
 *   PROVIDER_VISION_MODEL   视觉模型（默认取内置清单第一个视觉模型）
 *   PROVIDER_VISION_THINKING 视觉代理思考档位（默认空 = 模型默认）
 *
 * 运行前需 `npm run compile`。
 */
import assert from "node:assert/strict";
import Module from "node:module";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = process.argv[2] || process.env.PROVIDER_API_KEY;
if (!KEY) {
    console.error("用法：node test/test-three-path.mjs <API_KEY>（或设置 PROVIDER_API_KEY）");
    process.exit(1);
}

// ---------------------------------------------------------------------------
// 平台常量（从源码读取，避免测试与实现各写一份）
// ---------------------------------------------------------------------------

function readApiBaseUrl() {
    const source = readFileSync(fileURLToPath(new URL("../src/platform/platformConfig.ts", import.meta.url)), "utf8");
    const match = source.match(/API_BASE_URL\s*=\s*["'`]([^"'`]+)["'`]/);
    return match?.[1];
}

function readBuiltInModels() {
    const source = readFileSync(fileURLToPath(new URL("../src/models/models.ts", import.meta.url)), "utf8");
    const models = [];
    const regex = /\{\s*baseId:\s*"([^"]+)"[^}]*?vision:\s*(true|false)/g;
    let match;
    while ((match = regex.exec(source)) !== null) {
        models.push({ id: match[1], vision: match[2] === "true" });
    }
    return models;
}

const BASE = (process.env.PROVIDER_BASE_URL || readApiBaseUrl() || "").replace(/\/+$/, "");
if (!BASE) {
    console.error("无法确定 API 根地址：请设置 PROVIDER_BASE_URL，或检查 src/platform/platformConfig.ts。");
    process.exit(1);
}

const builtIn = readBuiltInModels();
const MAIN_MODEL = process.env.PROVIDER_MAIN_MODEL || builtIn.find((m) => !m.vision)?.id;
const VISION_MODEL = process.env.PROVIDER_VISION_MODEL || builtIn.find((m) => m.vision)?.id;
if (!MAIN_MODEL || !VISION_MODEL) {
    console.error("无法确定主模型 / 视觉模型：请设置 PROVIDER_MAIN_MODEL 与 PROVIDER_VISION_MODEL。");
    process.exit(1);
}
const VISION_THINKING = (process.env.PROVIDER_VISION_THINKING ?? "").trim();

// ---------------------------------------------------------------------------
// vscode mock（OpenaiApi / imageProxy / apiDispatch 依赖的类与 API）
// ---------------------------------------------------------------------------

const noopChannel = { debug() {}, info() {}, warn() {}, error() {}, dispose() {} };

class LanguageModelChatMessage {
    constructor(role, content) {
        this.role = role;
        this.content = content;
    }
}
const LanguageModelChatMessageRole = { User: 1, Assistant: 2, System: 3 };
const LanguageModelChatToolMode = { Auto: 1, Required: 2 };
class LanguageModelTextPart {
    constructor(value) {
        this.value = value;
    }
}
class LanguageModelDataPart {
    constructor(data, mimeType) {
        this.data = data;
        this.mimeType = mimeType;
    }
}
class LanguageModelThinkingPart {
    constructor(value, id) {
        this.value = value;
        this.id = id;
    }
}
class LanguageModelToolCallPart {
    constructor(callId, name, input) {
        this.callId = callId;
        this.name = name;
        this.input = input;
    }
}
class LanguageModelToolResultPart {
    constructor(callId, content) {
        this.callId = callId;
        this.content = content;
    }
}

const vscodeMock = {
    LanguageModelChatMessage,
    LanguageModelChatMessageRole,
    LanguageModelChatToolMode,
    LanguageModelTextPart,
    LanguageModelDataPart,
    LanguageModelThinkingPart,
    LanguageModelToolCallPart,
    LanguageModelToolResultPart,
    workspace: {
        getConfiguration(section) {
            return {
                get(key, def) {
                    // 视觉代理思考档位：让 resolveVisionReasoningEffort 读到测试值。
                    if (section === "any2copilot" && key === "visionProxyThinking") {
                        return VISION_THINKING;
                    }
                    return def;
                },
            };
        },
    },
    window: {
        createOutputChannel() {
            return noopChannel;
        },
    },
    env: { language: "en" },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === "vscode") {
        return vscodeMock;
    }
    return originalLoad.call(this, request, parent, isMain);
};

const require = createRequire(import.meta.url);
const { OpenaiApi } = require("../out/api/openai/openaiApi.js");
const { executeApiRequest } = require("../out/provider/apiDispatch.js");
const { callVisionModel } = require("../out/vision/imageProxy.js");
const { getModelInfo, toProviderModelItem, toLanguageModelChatInformation } = require("../out/models/index.js");
const { createRetryConfig } = require("../out/core/utils.js");
const { logger } = require("../out/core/logger.js");
logger.init();

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 1x1 红色 PNG（合法） */
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let passed = 0;
const check = (name, cond, detail = "") => {
    if (cond) {
        passed++;
        console.log(`  ok  ${name}`);
    } else {
        console.log(`  FAIL ${name} ${detail}`);
        process.exitCode = 1;
    }
};

/** 捕获请求体的 fetch 包装：记录最后一次请求的 body，转发真实请求；429 限流自动重试。 */
function makeCapturingFetch() {
    const captured = { bodies: [] };
    const wrapped = async (url, init) => {
        captured.bodies.push({ url, body: JSON.parse(init.body) });
        for (let attempt = 0; attempt < 3; attempt++) {
            const res = await fetch(url, init);
            if (res.status !== 429) {
                return res;
            }
            await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
        }
        return fetch(url, init);
    };
    return { wrapped, captured };
}

/** 构造 LanguageModelChatRequestMessage（user + 图片）。 */
function makeUserMessageWithImage() {
    return new LanguageModelChatMessage(LanguageModelChatMessageRole.User, [
        new LanguageModelTextPart("这张图里是什么？"),
        new LanguageModelDataPart(Uint8Array.from(Buffer.from(PNG_B64, "base64")), "image/png"),
    ]);
}

/** 构造最小 options（满足 ProvideLanguageModelChatResponseOptions 类型）。 */
function makeOptions() {
    return { requestInitiator: "test", toolMode: 1 };
}

/** 构造最小 token（满足 CancellationToken 类型）。 */
function makeToken() {
    return { isCancellationRequested: false, onCancellationRequested: () => undefined };
}

/** 构造 trackingProgress（收集文本）。 */
function makeProgress() {
    const texts = [];
    return {
        report: (part) => {
            if (part instanceof LanguageModelTextPart) {
                texts.push(part.value);
            }
        },
        texts,
    };
}

// ---------------------------------------------------------------------------
// ① 主对话：非视觉模型 + 图片
// ---------------------------------------------------------------------------

console.log(`\n=== ① 主对话（${MAIN_MODEL} + 图片）===`);

const mainInfo = getModelInfo(MAIN_MODEL);
check(`${MAIN_MODEL} 归一化信息存在`, !!mainInfo);
if (!mainInfo) {
    process.exit(1);
}

const mainApi = new OpenaiApi(MAIN_MODEL);
const mainUm = toProviderModelItem(mainInfo);
const mainModel = toLanguageModelChatInformation(mainInfo);

// 1a. convertMessages：图片 → 文本引用
const userMsg = makeUserMessageWithImage();
const converted = mainApi.convertMessages([userMsg], { includeReasoningInRequest: true, vision: false });
const convertedText = JSON.stringify(converted);
check("图片被替换为文本引用（含 ask_image 指令）", convertedText.includes("ask_image"), convertedText.slice(0, 120));
check("_localImages 收集到 1 张图", mainApi.localImages.length === 1, `n=${mainApi.localImages.length}`);

// 1b. prepareRequestBody：ask_image 工具注入
const body1 = mainApi.prepareRequestBody(
    { model: MAIN_MODEL, messages: converted, stream: true, stream_options: { include_usage: true } },
    mainUm,
    makeOptions()
);
const tools1 = body1.tools ?? [];
check("ask_image 工具被注入", tools1.some((t) => t.function?.name === "ask_image"), JSON.stringify(tools1.map((t) => t.function?.name)));
check("tool_choice=auto", body1.tool_choice === "auto", `tc=${body1.tool_choice}`);

// 1c. 真实请求 + 流式解析 → 拦截 ask_image
const { wrapped: fetch1, captured: cap1 } = makeCapturingFetch();
const progress1 = makeProgress();
await executeApiRequest({
    apiMode: "openai",
    model: mainModel,
    um: mainUm,
    modelConfig: { includeReasoningInRequest: true, vision: false },
    messages: [userMsg],
    options: makeOptions(),
    trackingProgress: progress1,
    token: makeToken(),
    apiKey: KEY,
    baseUrl: BASE,
    requestHeaders: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    retryConfig: createRetryConfig(),
    abortController: new AbortController(),
    dispatchFetch: fetch1,
    timeoutId: undefined,
    onUsage: () => {},
    collectedOutputText: progress1.texts,
});
check(`① 请求体 model=${MAIN_MODEL}`, cap1.bodies[0]?.body?.model === MAIN_MODEL, cap1.bodies[0]?.body?.model);
// 模型可能直接脑补图片内容而不调 ask_image —— 这是模型行为，不是重构 bug。
// 拦截到 ask_image 是期望路径；直接回答也接受（记录行为）。
const intercepted = mainApi.interceptedToolCall;
if (intercepted) {
    check("① 拦截到 ask_image 工具调用", true, `name=${intercepted.name}`);
} else {
    console.log(`  [diag] ① 未拦截 ask_image（模型直接回答）: ${JSON.stringify(progress1.texts.join("").slice(0, 120))}`);
    check("① 模型直接回答（未调 ask_image，模型行为）", progress1.texts.join("").length > 0, "");
}
check("① 请求体无 reasoning_effort=none", cap1.bodies[0]?.body?.reasoning_effort !== "none", `effort=${cap1.bodies[0]?.body?.reasoning_effort}`);

// ---------------------------------------------------------------------------
// ② 视觉代理：视觉模型描述图片（reasoningEffortOverride 来自 visionProxyThinking）
// ---------------------------------------------------------------------------

console.log(`\n=== ② 视觉代理（${VISION_MODEL} + visionProxyThinking="${VISION_THINKING}"）===`);

const { wrapped: fetch2, captured: cap2 } = makeCapturingFetch();
const visionCtx = {
    apiMode: "openai",
    modelApiKey: KEY,
    baseUrl: BASE,
    dispatchFetch: fetch2,
    requestHeaders: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    retryConfig: createRetryConfig(),
    token: makeToken(),
};
const visionProgress = { onThinking: () => {}, onText: () => {} };
const description = await callVisionModel(
    Uint8Array.from(Buffer.from(PNG_B64, "base64")),
    "image/png",
    VISION_MODEL,
    "What color is this image?",
    visionCtx,
    visionProgress
);
check("② 视觉模型返回非空描述", typeof description === "string" && description.length > 0, `len=${description?.length}`);
check(`② 请求体 model=${VISION_MODEL}`, cap2.bodies[0]?.body?.model === VISION_MODEL, cap2.bodies[0]?.body?.model);
if (!VISION_THINKING || VISION_THINKING === "auto") {
    check("② 留空/auto → 不发送 reasoning_effort（模型默认）", cap2.bodies[0]?.body?.reasoning_effort === undefined, `effort=${cap2.bodies[0]?.body?.reasoning_effort}`);
} else {
    check(`② reasoning_effort=${VISION_THINKING}`, cap2.bodies[0]?.body?.reasoning_effort === VISION_THINKING, `effort=${cap2.bodies[0]?.body?.reasoning_effort}`);
}
check("② 请求体含真实图片（image_url）", JSON.stringify(cap2.bodies[0]?.body?.messages).includes("image_url"), "");

// ---------------------------------------------------------------------------
// ③ 主模型续跑：非视觉模型 + tool_call + tool_result（复用 ① 的 api 实例）
// ---------------------------------------------------------------------------

console.log(`\n=== ③ 主模型续跑（${MAIN_MODEL} + tool 回填，复用 ① 的 api 实例）===`);

// ③ 不依赖 ① 的真实拦截（模型可能直接回答而非调 ask_image）——直接构造
// interceptedToolCall 来验证 executeApiRequest 的 apiInstance + apiMessagesOverride
// + skipVisionRounds 三个参数的行为。
const intercepted3 = mainApi.interceptedToolCall ?? {
    id: "call_test_1",
    name: "ask_image",
    args: { imageIndex: 0, query: "What color is this image?" },
};
const roundMessages = [...(mainApi.originalApiMessages ?? [])];
roundMessages.push({
    role: "assistant",
    reasoning_content: mainApi.capturedReasoningContent ?? "",
    tool_calls: [{ id: intercepted3.id, type: "function", function: { name: intercepted3.name, arguments: JSON.stringify(intercepted3.args) } }],
});
roundMessages.push({ role: "tool", tool_call_id: intercepted3.id, content: description });

const { wrapped: fetch3, captured: cap3 } = makeCapturingFetch();
const progress3 = makeProgress();
await executeApiRequest({
    apiMode: "openai",
    model: mainModel,
    um: mainUm,
    modelConfig: { includeReasoningInRequest: true, vision: false },
    messages: [],
    options: makeOptions(),
    trackingProgress: progress3,
    token: makeToken(),
    apiKey: KEY,
    baseUrl: BASE,
    requestHeaders: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    retryConfig: createRetryConfig(),
    abortController: new AbortController(),
    dispatchFetch: fetch3,
    timeoutId: undefined,
    onUsage: () => {},
    collectedOutputText: progress3.texts,
    apiInstance: mainApi,
    apiMessagesOverride: roundMessages,
    skipVisionRounds: true,
});
const body3 = cap3.bodies[0]?.body;
check(`③ 请求体 model=${MAIN_MODEL}`, body3?.model === MAIN_MODEL, body3?.model);
check("③ 消息含 assistant tool_call", JSON.stringify(body3?.messages).includes("tool_calls"), "");
check("③ 消息含 tool result（图片描述）", JSON.stringify(body3?.messages).includes(description.slice(0, 20)), "");
check("③ 消息数 = 原始 + 2（tool_call + tool_result）", body3?.messages?.length === roundMessages.length, `n=${body3?.messages?.length}`);
check("③ ask_image 工具仍在（_hasImages 保留）", (body3?.tools ?? []).some((t) => t.function?.name === "ask_image"), "");
// apiMessagesOverride 生效：图片引用只出现一次（原始消息里的），未重复 convertMessages。
const imageRefCount = (JSON.stringify(body3?.messages).match(/imageIndex=/g) ?? []).length;
check("③ 图片引用只出现一次（未重复 convertMessages）", imageRefCount === 1, `count=${imageRefCount}`);

// ---------------------------------------------------------------------------
// 冲突断言
// ---------------------------------------------------------------------------

console.log("\n=== 冲突断言 ===");

// ① 的 um 不被 ② 的 override 污染：② 传了 reasoningEffortOverride，
// 但 ① 的 um 是独立对象，executeApiRequest 只改传入的 um。
check(
    "① 的 um.reasoning_effort 未被 ② 污染",
    mainUm.reasoning_effort === undefined || mainUm.reasoning_effort === mainInfo.defaultReasoningEffort,
    `effort=${mainUm.reasoning_effort}`
);

// ③ 复用 ① 的 api 实例：capturedReasoningContent 是新一轮流式捕获的 reasoning
// （直接调 executeApiRequest 没有 runOpenAIRound 的清空步骤，非空是正常的）。
check("③ 后 capturedReasoningContent 是字符串", typeof mainApi.capturedReasoningContent === "string", `v=${mainApi.capturedReasoningContent}`);

console.log(`\n=== 三路径冲突测试: ${passed} 项通过 ===`);
process.exit(process.exitCode ?? 0);
