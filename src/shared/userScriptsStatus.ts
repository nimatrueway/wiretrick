/**
 * Chrome MV3 runs onPage code (the default world) and onSite code
 * through the `chrome.userScripts` API, which needs the optional `userScripts`
 * permission and the user's "Allow User Scripts" switch (Developer mode
 * before Chrome 138). These are the words every place that explains it uses.
 */

/** ok: onPage and onSite code run; no-permission: the optional permission isn't granted; off: the user hasn't allowed user scripts */
export type UserScriptsStatus = "ok" | "no-permission" | "off";

/** what calls into onPage or onSite code reject with while user scripts can't run */
export const USER_SCRIPTS_OFF = "not running on this page (user scripts are off)";

/** the core of the Problems error (the UI shows route problems containing it as errors, not warnings) */
export const USER_SCRIPTS_PROBLEM = "this code doesn't run: user scripts are off";

/** how to turn them on (Chrome's own wording for the switch) */
export function userScriptsHowTo(status: Exclude<UserScriptsStatus, "ok">, extensionId: string): string {
    const allow = `turn on "Allow User Scripts" on Wiretrick's details page (chrome://extensions/?id=${extensionId}; before Chrome 138: Developer mode on chrome://extensions)`;
    return status === "no-permission" ? `grant the "user scripts" permission from the Editor's banner, then ${allow}` : allow;
}

/** the Problems error for an onPage or onSite handler (`label`: "onPage #2") */
export function userScriptsProblem(label: string, status: Exclude<UserScriptsStatus, "ok">, extensionId: string): string {
    return `${label}: ${USER_SCRIPTS_PROBLEM} — ${userScriptsHowTo(status, extensionId)}`;
}
