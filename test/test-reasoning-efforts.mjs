/**
 * 思考档位解析测试（`src/models/apiModelList.ts` + `src/models/registry.ts`）。
 *
 * 覆盖：
 *  1. parseReasoningEfforts：数组 / 分隔字符串 / 对象 / 单值字符串 / 去重 / 强度升序
 *  2. parseDefaultReasoningEffort：字符串 / 对象 / 非法值
 *  3. resolveReasoningEfforts：平台 → models.dev → 内置清单 → 默认值 的四级回退
 *  4. 默认档位必须 ∈ 支持列表（否则回退 high / 列表末项）
 *
 * 运行前需 `npm run compile`。
 * 用法：node test/test-reasoning-efforts.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ── VS Code 运行时 shim ──
const Module = require("node:module");
const originalLoad = Module._load;
const vscodeShim = {
    workspace: {
        getConfiguration: () => ({
            get: (_key, fallback) => fallback,
        }),
    },
};
Module._load = function (request, parent, isMain) {
    if (request === "vscode") {
        return vscodeShim;
    }
    return originalLoad.call(this, request, parent, isMain);
};

const { parseReasoningEfforts, parseDefaultReasoningEffort } = require("../out/models/apiModelList.js");
const { resolveReasoningEfforts } = require("../out/models/registry.js");

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
const eq = (name, actual, expected) =>
    check(name, JSON.stringify(actual) === JSON.stringify(expected), `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);

// ── 1. parseReasoningEfforts ──

console.log("\n=== parseReasoningEfforts ===");

eq("数组按强度升序归一化", parseReasoningEfforts(["high", "low", "medium"]), ["low", "medium", "high"]);
eq("含 xhigh / minimal 的升序", parseReasoningEfforts(["max", "xhigh", "high", "medium", "low", "minimal", "none"]), [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
]);
eq("逗号分隔字符串", parseReasoningEfforts("low,medium,xhigh"), ["low", "medium", "xhigh"]);
eq("空格 / 竖线 / 斜杠分隔字符串", parseReasoningEfforts("low | medium xhigh/max"), ["low", "medium", "xhigh", "max"]);
eq("对象 supported 字段", parseReasoningEfforts({ supported: ["xhigh", "low"] }), ["low", "xhigh"]);
eq("对象 efforts 字段", parseReasoningEfforts({ efforts: ["medium", "low"] }), ["low", "medium"]);
eq("对象 enum 字段", parseReasoningEfforts({ enum: ["high", "low"] }), ["low", "high"]);
eq("去重", parseReasoningEfforts(["low", "low", "medium"]), ["low", "medium"]);
eq("大小写归一化", parseReasoningEfforts(["LOW", " Medium "]), ["low", "medium"]);
eq("过滤思考开关形态（auto/adaptive/enabled/disabled）", parseReasoningEfforts(["auto", "adaptive", "enabled", "disabled", "low"]), ["low"]);
eq("单值字符串不当作列表", parseReasoningEfforts("high"), undefined);
eq("空数组返回 undefined", parseReasoningEfforts([]), undefined);
eq("undefined 返回 undefined", parseReasoningEfforts(undefined), undefined);
eq("非字符串元素被忽略", parseReasoningEfforts([1, null, "low"]), ["low"]);
eq("表外自定义档位追加在末尾", parseReasoningEfforts(["ultra", "low"]), ["low", "ultra"]);

// ── 2. parseDefaultReasoningEffort ──

console.log("\n=== parseDefaultReasoningEffort ===");

check("字符串归一化", parseDefaultReasoningEffort("XHigh") === "xhigh");
check("对象 default 字段", parseDefaultReasoningEffort({ default: "medium" }) === "medium");
check("对象 default_effort 字段", parseDefaultReasoningEffort({ default_effort: "low" }) === "low");
check("auto 不是档位", parseDefaultReasoningEffort("auto") === undefined);
check("undefined 返回 undefined", parseDefaultReasoningEffort(undefined) === undefined);

// ── 3. resolveReasoningEfforts 四级回退 ──

console.log("\n=== resolveReasoningEfforts ===");

const apiOnly = resolveReasoningEfforts("unknown-model", {
    id: "unknown-model",
    supported_reasoning_efforts: ["low", "medium", "xhigh"],
    default_reasoning_effort: "xhigh",
});
eq("平台列表优先", apiOnly.supported, ["low", "medium", "xhigh"]);
check("平台默认档位生效", apiOnly.default === "xhigh", `default=${apiOnly.default}`);
check("来源标记为 api", apiOnly.source === "api", `source=${apiOnly.source}`);

const devOnly = resolveReasoningEfforts("unknown-model", undefined, {
    id: "unknown-model",
    reasoning_efforts: ["minimal", "low"],
    default_reasoning_effort: "minimal",
});
eq("models.dev 列表兜底", devOnly.supported, ["minimal", "low"]);
check("models.dev 默认档位生效", devOnly.default === "minimal", `default=${devOnly.default}`);
check("来源标记为 modelsdev", devOnly.source === "modelsdev", `source=${devOnly.source}`);

const none = resolveReasoningEfforts("unknown-model");
eq("全部缺失时用代码默认列表", none.supported, ["low", "medium", "high"]);
check("全部缺失时默认 high", none.default === "high", `default=${none.default}`);
check("来源标记为 default", none.source === "default", `source=${none.source}`);

// 平台列表不含 high → 默认取列表末项（强度最高）
const noHigh = resolveReasoningEfforts("unknown-model", {
    id: "unknown-model",
    supported_reasoning_efforts: ["low", "medium", "xhigh"],
});
check("列表无 high 时默认取末项", noHigh.default === "xhigh", `default=${noHigh.default}`);

// 平台默认档位不在平台列表里 → 忽略，回退到列表内的默认
const badDefault = resolveReasoningEfforts("unknown-model", {
    id: "unknown-model",
    supported_reasoning_efforts: ["low", "medium"],
    default_reasoning_effort: "max",
});
check("非法默认档位被忽略", badDefault.default === "medium", `default=${badDefault.default}`);

// 平台只给默认档位、不给列表 → 列表回退默认值，默认档位仍被采纳（若在列表内）
const defaultOnly = resolveReasoningEfforts("unknown-model", {
    id: "unknown-model",
    default_reasoning_effort: "medium",
});
eq("平台只给默认档位时列表回退", defaultOnly.supported, ["low", "medium", "high"]);
check("平台只给默认档位时采纳该值", defaultOnly.default === "medium", `default=${defaultOnly.default}`);

// 平台列表顺序错乱 → 输出仍为强度升序
const unsorted = resolveReasoningEfforts("unknown-model", {
    id: "unknown-model",
    supported_reasoning_efforts: ["max", "minimal", "high", "low", "xhigh", "medium"],
});
eq("平台乱序列表被重排为升序", unsorted.supported, ["minimal", "low", "medium", "high", "xhigh", "max"]);

console.log(`\n=== 思考档位解析测试: ${passed} 项通过 ===`);
process.exit(process.exitCode ?? 0);
