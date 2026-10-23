/**
 * 封号检测与轮换测试（`src/keys/health.ts` + `src/keys/config.ts`）。
 *
 * 覆盖：
 *  1. 封号错误（errorRules code=billing）→ isKeyRotationError 命中 + reason = 规则 message
 *  2. 封号是确定性失败 → markApiKeyExhausted 持久化 available=false
 *  3. 封号 key 被 pickNextApiKey 跳过
 *  4. 自定义 errorRules（code 可配置）
 *  5. 400 状态码本身不触发轮换（code 优先）
 *
 * 运行前需 `npm run compile`。
 * 用法：node test/test-banned-rotation.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ── VS Code 运行时 shim ──
const Module = require("node:module");
const originalLoad = Module._load;

let settings = {};

// 默认 errorRules（镜像 package.json 的 default——shim 不经过 package.json）
const DEFAULT_ERROR_RULES = [
    { code: "billing", message: "计费账户已被冻结（封号）", action: "rotatePersist" },
    { code: "upstream_stream_error", message: "上游模型流意外中断", action: "retrySameKey" },
    { code: "INSUFFICIENT_BALANCE", message: "余额不足", action: "rotatePersist" },
    { statusCode: 401, message: "无效 key", action: "rotatePersist" },
    { statusCode: 402, message: "余额不足", action: "rotatePersist" },
    { statusCode: 429, message: "限流", action: "rotateCooldown" },
    { statusCode: 503, message: "服务端繁忙", action: "rotateCooldown" },
    { statusCode: 400, message: "上游中断复用 400", action: "retrySameKey" },
    { statusCode: 500, message: "内部错误", action: "retrySameKey" },
];
const vscodeShim = {
    env: { language: "en" },
    workspace: {
        getConfiguration: () => ({
            get: (key, fallback) =>
                key in settings ? settings[key] : fallback ?? (key === "errorRules" ? DEFAULT_ERROR_RULES : undefined),
        }),
    },
    window: {
        createOutputChannel: () => ({ debug() {}, info() {}, warn() {}, error() {}, dispose() {} }),
    },
};
Module._load = function (request, parent, isMain) {
    if (request === "vscode") {
        return vscodeShim;
    }
    return originalLoad.call(this, request, parent, isMain);
};

function makeSecrets(initial = {}) {
    const map = new Map(Object.entries(initial));
    return {
        get: async (k) => map.get(k),
        store: async (k, v) => void map.set(k, v),
        delete: async (k) => void map.delete(k),
    };
}

const { matchErrorRule, markApiKeyExhausted, isApiKeyEligible } = require("../out/keys/health.js");
const { getApiKeyStore, saveApiKeyStore, invalidateApiKeyStoreCache } = require("../out/keys/store.js");
const { pickNextApiKey } = require("../out/keys/selection.js");
const { resetExhaustedKeys } = require("../out/keys/health.js");
const { setRotationIndex } = require("../out/keys/state.js");
const { logger } = require("../out/core/logger.js");
logger.init();

// 从 matchErrorRule 派生语义断言（生产代码直接用 matchErrorRule，不再导出薄封装）
const isKeyRotationError = (err) => {
    const r = matchErrorRule(err);
    return r !== undefined && r.action !== "retrySameKey";
};
const getKeyRotationReason = (err) => matchErrorRule(err)?.message;

let passed = 0;
async function check(name, fn) {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
}

/** 实测抓取的封号响应（400 + code=billing） */
const bannedError = () =>
    new Error(
        'API error: [400] Bad Request\n{"code":"billing","message":"计费账户已被冻结","ref_code":400901,"ref_scope":"common"}\nURL: https://api.example.com/v1/chat/completions'
    );

async function reset(secrets, keys, activeIndex = 0) {
    invalidateApiKeyStoreCache();
    setRotationIndex(0);
    await resetExhaustedKeys(secrets, true);
    await saveApiKeyStore(secrets, { keys, activeIndex });
}

const K = (value, extra = {}) => ({ value, available: null, ...extra });

// ---------------------------------------------------------------------------
// 1. 封号错误识别
// ---------------------------------------------------------------------------
console.log("封号错误识别");

await check("封号错误命中 isKeyRotationError", () => {
    assert.equal(isKeyRotationError(bannedError()), true);
});

await check("封号错误 reason = 规则的 message 说明", () => {
    assert.equal(getKeyRotationReason(bannedError()), "计费账户已被冻结（封号）");
});

await check("400 状态码本身不触发轮换（code 优先，纯 400 → retrySameKey）", () => {
    // 无 code 命中的纯 400 错误 → statusCode 400 兜底 → retrySameKey（不轮换）
    const plain400 = new Error("API error: [400] Bad Request\ninvalid parameter");
    assert.equal(isKeyRotationError(plain400), false);
    assert.equal(getKeyRotationReason(plain400), "上游中断复用 400");
});

// ---------------------------------------------------------------------------
// 2. 封号是确定性失败 → 持久化
// ---------------------------------------------------------------------------
console.log("封号持久化");

await check("markApiKeyExhausted(banned) 持久化 available=false", async () => {
    const secrets = makeSecrets();
    await reset(secrets, [K("a"), K("b")]);
    await markApiKeyExhausted(secrets, "a", "计费账户已被冻结（封号）", "rotatePersist");
    const store = await getApiKeyStore(secrets);
    assert.equal(store.keys.find((k) => k.value === "a").available, false);
});

await check("封号 key 变 ineligible", async () => {
    const secrets = makeSecrets();
    await reset(secrets, [K("a"), K("b")]);
    await markApiKeyExhausted(secrets, "a", "计费账户已被冻结（封号）", "rotatePersist");
    const store = await getApiKeyStore(secrets);
    assert.equal(isApiKeyEligible(store.keys.find((k) => k.value === "a")), false);
});

// ---------------------------------------------------------------------------
// 3. 封号 key 被跳过
// ---------------------------------------------------------------------------
console.log("封号 key 跳过");

await check("pickNextApiKey 跳过封号 key", async () => {
    const secrets = makeSecrets();
    await reset(secrets, [K("a"), K("b")]);
    await markApiKeyExhausted(secrets, "a", "计费账户已被冻结（封号）", "rotatePersist");
    const picked = await pickNextApiKey(secrets, "rotation");
    assert.equal(picked.value, "b");
});

// ---------------------------------------------------------------------------
// 4. 自定义 errorRules
// ---------------------------------------------------------------------------
console.log("自定义 errorRules");

await check("自定义规则生效（新增 code）", () => {
    settings = { errorRules: [{ code: "account_suspended", message: "账号被暂停", action: "rotatePersist" }] };
    const err = new Error('API error: [400] Bad Request\n{"code":"account_suspended"}');
    assert.equal(isKeyRotationError(err), true);
    assert.equal(getKeyRotationReason(err), "账号被暂停");
    settings = {};
});

await check("清空规则后无规则匹配（errorRules=[] 禁用所有规则）", () => {
    settings = { errorRules: [] };
    assert.equal(getKeyRotationReason(bannedError()), undefined);
    settings = {};
});

Module._load = originalLoad;
console.log(`\nbanned rotation: ${passed} checks passed`);
