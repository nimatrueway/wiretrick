/**
 * MV3 proxy tier status.
 *
 * The design (DNR session rules redirecting browser-initiated resource
 * loads to `chrome-extension://<id>/__resproxy?p=<original>`, served with
 * transformed bodies) does NOT work on this platform — verified:
 *
 *   1. DNR redirects to chrome-extension:// targets require the target to
 *      be a web_accessible_resource (otherwise ERR_BLOCKED_BY_CLIENT) —
 *      workable.
 *   2. But the redirected load is then served STATICALLY: Chrome does not
 *      dispatch a service worker's fetch event for cross-origin
 *      page-initiated loads of extension resources (ERR_FILE_NOT_FOUND
 *      for a non-existent file). Only the extension's OWN clients
 *      (manager/popup pages) go through the SW.
 *   3. DNR cannot redirect to data:/blob: URLs (where a dynamic body
 *      would live), and static WAR files can't carry user-script
 *      transforms.
 *
 * So browser-initiated loads (script tags, images, stylesheets, main
 * frames) cannot be intercepted with dynamic bodies in MV3 at all — the
 * MV3 mechanisms are the hook tier (page fetch/XHR) and chrome.debugger
 * (CDP Fetch pauses in the SW, decisions computed in the sandbox) — so
 * "proxy" scripts are routed to the debugger tier (cdpStrategy). This module stays as the single place that reports the
 * limitation loudly instead of leaving dead machinery that would BREAK
 * pages (a 307 into a missing static file = the page's script fails).
 */
import type { Script } from "./engine/scriptStore";
import { dlogLevel } from "../shared/debugLog";

const PROXY_PATH = "__resproxy?p=";

/** strip everything before the original URL in a redirected proxy URL */
export function originalUrlOf(proxyUrl: string): string | null {
    const at = proxyUrl.indexOf(PROXY_PATH);
    return at < 0 ? null : proxyUrl.slice(at + PROXY_PATH.length);
}

/**
 * MV3: NO-OP with a loud explanation. Clears any stale rules (older
 * builds may have installed redirect rules that break page loads by
 * 307ing into a missing static file).
 */
export async function syncProxyRules(scripts: Script[]): Promise<void> {
    const dnr = (chrome as any).declarativeNetRequest;
    try {
        const existing = await dnr?.getSessionRules?.();
        if (existing?.length) await dnr.updateSessionRules({ removeRuleIds: existing.map((r: any) => r.id) });
    } catch (e: any) {
        dlogLevel("proxy", "warn", `DNR rule cleanup failed: ${e?.message || e}`);
    }
    const proxyListed = scripts.filter((s) => s.enabled && s.meta.declared && /\bproxy\b/i.test(s.meta.strategy || ""));
    if (proxyListed.length) {
        dlogLevel(
            "proxy",
            "warn",
            `proxy tier has no MV3 implementation (DNR redirects cannot serve dynamic bodies) — ${proxyListed.map((s) => `"${s.meta.name}"`).join(", ")} use the DEBUGGER tier instead for <script>/<img>/css/document loads (chrome.debugger; Chrome shows a debugging banner while attached)`
        );
    }
}
