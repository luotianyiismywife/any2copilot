/**
 * platformConfig.ts — 平台配置单一事实来源（脚手架核心）。
 *
 * 移植到新平台时，**理论上只需要改这一个文件**（外加 package.json 的
 * 命令前缀 / vendor / 包名，见根目录 PLATFORM_PORTING.md 移植清单）。
 *
 * 分层说明：
 * - `API_BASE_URL`        — OpenAI 兼容 API 根地址（/v1），聊天/模型列表/余额检测共用
 * - `PLATFORM_*_URL`      — 平台官网 / 用户中心 / 文档等外围地址
 * - `PLATFORM_HEADERS`    — 用户中心接口的必需固定头（部分平台有域校验）
 * - `FALLBACK_TEST_MODEL` — 模型列表不可用时的兜底测试模型 ID
 *
 * 命令前缀（`any2copilot.`）与 languageModelChatProviders 的 `vendor` 是
 * VS Code 静态声明（package.json contributes），无法运行时改——移植时用
 * 全局替换一次性改掉（见 PLATFORM_PORTING.md §1）。
 */

// ── API 域 ──────────────────────────────────────────────────────────────

/** OpenAI 兼容 API 根地址（以 / 结尾，子路径直接拼接） */
export const API_BASE_URL = "https://api.example.com/v1/";

// ── 平台外围地址 ────────────────────────────────────────────────────────

/** 用户中心账号信息端点（套餐用量 / 余额查询，Bearer 登录 PASETO token） */
export const PLATFORM_USER_SELF_URL = "https://platform.example.com/api/user/self";

// ── 用户中心接口固定头 ──────────────────────────────────────────────────

/**
 * platform 域必需的固定头（缺 x-platform/x-product 会 403 forbidden）。
 * 移植时按新平台的域校验要求调整；无域校验的平台可置空对象。
 */
export const PLATFORM_HEADERS: Record<string, string> = {
    "x-platform": "WEB",
    "x-product": "Example",
    "x-version": "1.0.2",
    "Accept": "application/json",
};

// ── 兜底值 ──────────────────────────────────────────────────────────────

/**
 * 模型列表不可用时的兜底测试模型 ID（key 可用性检测用）。
 * 注意：平台退役模型后此值会失效——优先用 /v1/models 实时列表。
 */
export const FALLBACK_TEST_MODEL_ID = "example-model";

/**
 * 浏览器 localStorage 中登录 token 的来源说明（提示文案用）。
 * 移植时按新平台的存储结构改写。
 */
export const LOGIN_TOKEN_SOURCE_HINT =
    "F12 → Application → Local Storage → example.com → user → state.token";
