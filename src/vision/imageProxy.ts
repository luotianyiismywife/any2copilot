import * as vscode from "vscode";
import type {
    CancellationToken,
    LanguageModelChatRequestMessage,
    LanguageModelResponsePart,
    Progress,
    ProvideLanguageModelChatResponseOptions,
} from "vscode";
import type { RetryConfig } from "../core/types";
import { logger } from "../core/logger";
import { getModelInfo, toLanguageModelChatInformation, toProviderModelItem } from "../models";
import { executeApiRequest } from "../provider/apiDispatch";
import { DEFAULT_VISION_PROMPT } from "./types";
import type { StoredImage } from "./types";

/**
 * 视觉代理请求上下文 —— 复用对话请求链路（`executeApiRequest`）所需的参数。
 *
 * 视觉代理**不再**走 `vscode.lm.selectChatModels` + `sendRequest()`（嵌套重入），
 * 而是与对话一样直接调用 `executeApiRequest`：
 * - 端点由 `apiMode` 决定（与对话相同，`openai` / `anthropic` / `responses` 由
 *   `<prefix>.apiMode` 控制）
 * - `reasoning_effort` 由 `<prefix>.visionProxyThinking` 决定，经
 *   `executeApiRequest` 的 `reasoningEffortOverride` 传入
 *
 * 这样视觉代理不再是"单独实现"，视频/音乐等代理只需构造自己的 `um` + `messages`，
 * 同样调用 `executeApiRequest` 即可复用整条请求链路。
 */
export interface VisionProxyContext {
    apiMode: string;
    modelApiKey: string;
    baseUrl: string;
    dispatchFetch: typeof fetch;
    requestHeaders: Record<string, string>;
    retryConfig: RetryConfig;
    token: CancellationToken;
}

/**
 * 读取 `<prefix>.visionProxyThinking` 设置，解析为 `reasoning_effort` 值。
 *
 * 设置项是自由字符串（默认空 = 模型默认），可选值由**该视觉模型**的
 * `supportedReasoningEfforts` 决定 —— 平台 `/v1/models` 与 models.dev 通常
 * 只返回"是否支持 reasoning_effort"的布尔标记，不返回具体档位列表，因此档位
 * 来自内置清单（`models.ts`，见 AGENTS.md §5.7）。
 *
 * 档位来源链：**用户设置 → 内置清单（支持范围过滤 + 默认档位）→ 上游请求体**。
 *
 * ⚠️ 兼容旧版布尔值残留：早期版本 `visionProxyThinking` 是 boolean
 * （`true`=high / `false`=low），用户设置里可能残留 `true`/`false`。布尔值按
 * "留空 = 模型默认"处理（不做 `.trim()`，避免 `trim is not a function` 崩溃）。
 */
function resolveVisionReasoningEffort(visionModelId: string): string {
    const configured = vscode.workspace.getConfiguration().get<unknown>("any2copilot.visionProxyThinking", "");
    const value = typeof configured === "string" ? configured.trim().toLowerCase() : "";
    const info = getModelInfo(visionModelId);
    const supported = info?.supportedReasoningEfforts ?? [];
    // 设置留空 / auto / 旧版布尔残留 → 不发送 reasoning_effort（模型默认思考行为）。
    if (!value || value === "auto") {
        return "auto";
    }
    // 用户选的档位在模型支持列表里 → 直接透传。
    if (supported.includes(value)) {
        return value;
    }
    // 模型不支持该档位 → 回退到模型默认档位。
    if (info?.defaultReasoningEffort) {
        return info.defaultReasoningEffort;
    }
    return "low";
}

/**
 * 发送一条消息给视觉模型，流式转发到 progress，返回完整文本。
 *
 * 复用 `executeApiRequest`（与对话同一条请求链路）：端点由 `ctx.apiMode` 决定，
 * `reasoning_effort` 由 `<prefix>.visionProxyThinking` 决定（经
 * `reasoningEffortOverride` 传入，不经过 `applyReasoningEffort`）。
 *
 * 空答案处理：模型固有思考的部署在思考被抑制时可能只产出 reasoning、
 * `content` 为空。此时 `collectedOutputText` 为空 —— 抛错，让上层记录
 * `vision.call-failed` 并把失败原因回传给主模型，**绝不能把空串当成"成功答案"**，
 * 否则主模型只会说"工具没有返回内容"，用户完全无从排查。
 * （reasoning 已通过 `progress.onThinking` 实时展示给用户，不参与答案判定。）
 */
async function sendVisionRequest(
    msg: LanguageModelChatRequestMessage,
    visionModelId: string,
    ctx: VisionProxyContext,
    progress?: {
        onThinking?: (text: string) => void;
        onText?: (text: string) => void;
    }
): Promise<string> {
    const info = getModelInfo(visionModelId);
    if (!info) {
        throw new Error(`Vision model "${visionModelId}" not found. Check the any2copilot.visionProxyModel setting.`);
    }

    // 视觉模型的请求配置（reasoning_effort 由 visionProxyThinking 决定）。
    const um = toProviderModelItem(info);
    const model = toLanguageModelChatInformation(info);

    // 视觉代理不需要工具；构造最小 options 满足类型。
    const options = {
        requestInitiator: "any2copilot.visionProxy",
        toolMode: vscode.LanguageModelChatToolMode.Auto,
    } as unknown as ProvideLanguageModelChatResponseOptions;

    // 收集文本 + 转发 thinking/text 到主模型的 thinking 块。
    const collectedOutputText: string[] = [];
    const visionProgress: Progress<LanguageModelResponsePart> = {
        report: (part) => {
            if (part instanceof vscode.LanguageModelThinkingPart) {
                const text = Array.isArray(part.value) ? part.value.join("") : part.value;
                if (text) {
                    progress?.onThinking?.(text);
                }
            } else if (part instanceof vscode.LanguageModelTextPart) {
                collectedOutputText.push(part.value);
                progress?.onText?.(part.value);
            }
        },
    };

    // 视觉代理自己的超时控制器（主请求的 abortController 已用完）。
    const visionAbort = new AbortController();
    const timeoutMs = vscode.workspace.getConfiguration().get<number>("any2copilot.requestTimeout", 600000);
    const timeoutId = setTimeout(() => visionAbort.abort(), timeoutMs);
    try {
        await executeApiRequest({
            apiMode: ctx.apiMode,
            model,
            um,
            modelConfig: { includeReasoningInRequest: true, vision: true },
            messages: [msg],
            options,
            trackingProgress: visionProgress,
            token: ctx.token,
            apiKey: ctx.modelApiKey,
            baseUrl: ctx.baseUrl,
            requestHeaders: ctx.requestHeaders,
            retryConfig: ctx.retryConfig,
            abortController: visionAbort,
            dispatchFetch: ctx.dispatchFetch,
            timeoutId,
            onUsage: () => {},
            collectedOutputText,
            // 思考档位由 visionProxyThinking 决定；非思考模型不传（不发该参数）。
            reasoningEffortOverride: info.reasoning ? resolveVisionReasoningEffort(visionModelId) : undefined,
        });
    } finally {
        clearTimeout(timeoutId);
    }

    const answer = collectedOutputText.join("").trim();
    if (answer) {
        return answer;
    }

    logger.error("vision.empty-answer", { visionModelId });
    throw new Error(
        `Vision model "${visionModelId}" returned an empty answer (no content, no reasoning). ` +
        `It may not accept image input, or its thinking was suppressed by the request options.`
    );
}

/**
 * Call a vision-capable model to answer a question about a single image.
 * Streams the output via progress if provided.
 * @param query The specific question to ask about the image.
 * @returns The answer text from the vision model.
 */
export async function callVisionModel(
    imageData: Uint8Array,
    mimeType: string,
    visionModelId: string,
    query: string | undefined,
    ctx: VisionProxyContext,
    progress?: {
        onThinking?: (text: string) => void;
        onText?: (text: string) => void;
    }
): Promise<string> {
    const dataPart = new vscode.LanguageModelDataPart(imageData, mimeType);
    const prompt = query ?? DEFAULT_VISION_PROMPT;
    const textPart = new vscode.LanguageModelTextPart(prompt);
    const msg = new vscode.LanguageModelChatMessage(
        vscode.LanguageModelChatMessageRole.User,
        [dataPart, textPart]
    );
    return sendVisionRequest(msg, visionModelId, ctx, progress);
}

/**
 * Call a vision-capable model to answer a question about MULTIPLE images.
 * Sends all images + query in a single message so the model can compare them.
 * Streams the output via progress if provided.
 * @param images Array of { data, mimeType } for each image.
 * @param query The comparison/analysis question.
 * @returns The answer text from the vision model.
 */
export async function callVisionModelMulti(
    images: StoredImage[],
    visionModelId: string,
    query: string | undefined,
    ctx: VisionProxyContext,
    progress?: {
        onThinking?: (text: string) => void;
        onText?: (text: string) => void;
    }
): Promise<string> {
    const prompt = query ?? "Compare and analyze these images. What do you see?";
    const parts: (vscode.LanguageModelDataPart | vscode.LanguageModelTextPart)[] = [];
    for (const img of images) {
        parts.push(new vscode.LanguageModelDataPart(img.data, img.mimeType));
    }
    parts.push(new vscode.LanguageModelTextPart(prompt));
    const msg = new vscode.LanguageModelChatMessage(
        vscode.LanguageModelChatMessageRole.User,
        parts
    );
    return sendVisionRequest(msg, visionModelId, ctx, progress);
}
