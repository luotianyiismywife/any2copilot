/**
 * checkUsageCommand.ts — 套餐用量查询命令（`senseaudio.checkUsage`）。
 *
 * 强制刷新套餐用量（绕过 TTL）并弹窗展示窗口使用率 + 余额。
 * 同时绑定到状态栏条目点击（见 `ui/statusBar.ts`）。
 *
 * 数据来自 `balance/`（accountInfo + planUsage），移植新平台时无需改本文件。
 */

import * as vscode from "vscode";
import { l10n, l10nFormat } from "../core/localize";
import { logger } from "../core/logger";
import {
    formatUsageSummary,
    getPlanUsageFetchStatus,
} from "../balance/balanceCheck";
import { refreshPlanUsageNow } from "../ui/statusBar";

/**
 * 套餐用量查询命令。
 *
 * 错误区分：
 * - 未配置登录 token → 提示先在「管理 API Keys」设置
 * - 401 token 失效 → 提示重新复制
 * - 一般失败 → 提示查看输出通道
 */
export async function checkUsageCommand(context: vscode.ExtensionContext): Promise<void> {
    const getLoginToken = (): string | undefined => context.globalState.get<string>("senseaudio.loginToken");
    if (!getLoginToken()) {
        vscode.window.showInformationMessage(l10n("No login token configured. Set it via the Manage API Keys command first."));
        return;
    }

    const snapshot = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: l10n("Querying plan usage...") },
        () => refreshPlanUsageNow(),
    );

    const status = getPlanUsageFetchStatus();
    // The refresh failed. `refreshPlanUsageNow` returns the last good snapshot
    // (stale-cache fallback), so a non-null snapshot does NOT mean the data is
    // fresh — surface the failure instead of silently showing stale numbers.
    if (status !== "ok") {
        logger.warn("planUsage.checkUsage.failed", { status, hasStale: snapshot !== null });
        if (status === "unauthorized") {
            vscode.window.showErrorMessage(
                l10n("Login token expired. Copy a fresh token from the browser (see LOGIN_TOKEN_SOURCE_HINT)."),
            );
        } else {
            vscode.window.showErrorMessage(l10n("Failed to fetch plan usage. See the extension output channel for details."));
        }
        return;
    }
    if (!snapshot) {
        vscode.window.showInformationMessage(l10n("No plan usage data available for this account."));
        return;
    }
    const summary = formatUsageSummary(snapshot);
    vscode.window.showInformationMessage(
        summary || l10n("No plan usage data available for this account."),
        { modal: true },
    );
}

// l10nFormat kept referenced for platform-specific extensions.
void l10nFormat;
