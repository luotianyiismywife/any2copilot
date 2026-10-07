/**
 * 封号检测与轮换测试（`src/keys/health.ts` + `src/keys/config.ts`）。
 *
 * 覆盖：
 *  1. 封号错误（可配置 patterns）→ isKeyRotationError 命中 + reason = "banned"
 *  2. 封号是确定性失败 → markApiKeyExhausted 持久化 available=false
 *  3. 封号 key 被 pickNextApiKey 跳过
 *  4. 全部 key 封号 → 报错显示 REASON_TEXT["banned"]
 *  5. 自定义封号 patterns（apiKeyBannedErrorPatterns 可配置）
 *  6. 400 状态码本身不触发轮换（仅 patterns 触发）
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
const vscodeShim = {
    env: { language: "en" },
    workspace: {
        getConfiguration: () => ({
            get: (key, fallback) => (key in settings ? settings[key] : fallback),
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

const { isKeyRotationError, getKeyRotationReason, markApiKeyExhausted, isApiKeyEligible } =
    require("../out/keys/health.js");
const { getApiKeyStore, saveApiKeyStore, invalidateApiKeyStoreCache } = require("../out/keys/store.js");
const { pickNextApiKey } = require("../out/keys/selection.js");
const { resetExhaustedKeys } = require("../out/keys/health.js");
const { setRotationIndex } = require("../out/keys/state.js");
const { REASON_TEXT } = require("../out/provider/errors.js");
const { logger } = require("../out/core/logger.js");
logger.init();

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

await check("封号错误 reason = banned", () => {
    assert.equal(getKeyRotationReason(bannedError()), "banned");
});

await check("400 状态码本身不触发轮换（仅 patterns 触发）", () => {
    // 无 patterns 命中的纯 400 错误
    const plain400 = new Error("API error: [400] Bad Request\ninvalid parameter");
    assert.equal(isKeyRotationError(plain400), false);
    assert.equal(getKeyRotationReason(plain400), "api_error");
});

// ---------------------------------------------------------------------------
// 2. 封号是确定性失败 → 持久化
// ---------------------------------------------------------------------------
console.log("封号持久化");

await check("markApiKeyExhausted(banned) 持久化 available=false", async () => {
    const secrets = makeSecrets();
    await reset(secrets, [K("a"), K("b")]);
    await markApiKeyExhausted(secrets, "a", "banned");
    const store = await getApiKeyStore(secrets);
    assert.equal(store.keys.find((k) => k.value === "a").available, false);
});

await check("封号 key 变 ineligible", async () => {
    const secrets = makeSecrets();
    await reset(secrets, [K("a"), K("b")]);
    await markApiKeyExhausted(secrets, "a", "banned");
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
    await markApiKeyExhausted(secrets, "a", "banned");
    const picked = await pickNextApiKey(secrets, "rotation");
    assert.equal(picked.value, "b");
});

// ---------------------------------------------------------------------------
// 4. 报错文案
// ---------------------------------------------------------------------------
console.log("报错文案");

await check("REASON_TEXT 含 banned 文案", () => {
    assert.equal(REASON_TEXT["banned"], "Account banned (billing frozen)");
});

// ---------------------------------------------------------------------------
// 5. 自定义封号 patterns
// ---------------------------------------------------------------------------
console.log("自定义封号 patterns");

await check("自定义 patterns 生效", () => {
    settings = { apiKeyBannedErrorPatterns: ["account suspended"] };
    const err = new Error("API error: [400] Bad Request\naccount suspended");
    assert.equal(isKeyRotationError(err), true);
    assert.equal(getKeyRotationReason(err), "banned");
    settings = {};
});

await check("清空 patterns 后不再识别为封号", () => {
    settings = { apiKeyBannedErrorPatterns: [] };
    assert.equal(getKeyRotationReason(bannedError()), "api_error");
    settings = {};
});

Module._load = originalLoad;
console.log(`\nbanned rotation: ${passed} checks passed`);
