import { proxy } from "valtio";
import type { UserScriptsStatus } from "../../shared/userScriptsStatus";

const DISMISSED_KEY = "wt.userScriptsBanner.dismissed";

/**
 * Chrome MV3: the Editor's one-time "user scripts are off" banner, shown
 * while an enabled script has `world: "isolated"` onPage code that can't
 * run (the Problems error stays until it can).
 */
export const userScriptsBanner = proxy({
    status: "ok" as UserScriptsStatus,
    /** enabled scripts with isolated onPage code */
    scripts: 0,
    extensionId: "",
    dismissed: (() => {
        try {
            return localStorage.getItem(DISMISSED_KEY) === "1";
        } catch {
            return false;
        }
    })(),
});

export const bannerShown = (s: { status: UserScriptsStatus; scripts: number; dismissed: boolean }): boolean => s.status !== "ok" && s.scripts > 0 && !s.dismissed;

/** ask the background (a fresh check) */
export function refreshUserScripts(): void {
    if (!__MV3__) return;
    try {
        chrome.runtime.sendMessage({ type: "userScriptsStatus" }, (r: any) => {
            if (chrome.runtime.lastError || !r) return;
            userScriptsBanner.status = r.status;
            userScriptsBanner.scripts = r.scripts;
            userScriptsBanner.extensionId = r.id;
        });
    } catch {}
}

export function dismissUserScriptsBanner(): void {
    userScriptsBanner.dismissed = true;
    try {
        localStorage.setItem(DISMISSED_KEY, "1");
    } catch {}
}

/** Must run straight from a click: permissions.request needs the user gesture. */
export function requestUserScripts(): void {
    try {
        chrome.permissions.request({ permissions: ["userScripts" as any] }, () => {
            void chrome.runtime.lastError;
            // the background re-registers on permissions.onAdded; this only refreshes the banner
            refreshUserScripts();
        });
    } catch {}
}
