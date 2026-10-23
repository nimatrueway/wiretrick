/**
 * User-facing facts about each strategy — one source for the settings
 * schema (VS Code hovers), settings.yaml comments, the Editor's strategy
 * picker and the hover help. Keep in sync with docs/strategies.md.
 */
import { builtinStrategy, STRATEGIES, type Strategy } from "./route";

export const STRATEGY_DOC_URL = "https://github.com/nimatrueway/wiretrick/blob/master/docs/strategies.md#compatibility";

export interface StrategyInfo {
    label: string;
    pros: string;
    cons: string;
}

export const STRATEGY_INFO: Record<Strategy, StrategyInfo> = {
    helper: {
        label: "helper — local helper proxy",
        pros: "Sees everything: documents, <script src>, CSS, images, workers, the first navigation. No banner. Async handlers, any status code, URL unchanged.",
        cons: "Chromium only. One-time install of the local helper and trust in the helper certificate. Matched hosts go through a local proxy (PAC); cert-pinned / mTLS sites break. Small per-request latency; bodies are buffered for onResponseBody.",
    },
    page: {
        label: "page — in-page fetch/XHR patch",
        pros: "No setup, no banner, no permissions, lightest. Works in every browser.",
        cons: "Only the page's own fetch/XHR. Misses documents, <script src>, images, workers and requests made before the page patch loads.",
    },
    webRequest: {
        label: "webRequest — blocking webRequest",
        pros: "No banner, no setup. On Firefox it reaches everything, bodies included.",
        cons: "Not on Chrome (MV3). Chromium MV2: no onResponseBody, no async handlers, replacements are served by redirect (URL changes, status always 200) — a replaced page shows a chrome-extension:// URL. Firefox: can't change a replaced response's status.",
    },
    debugger: {
        label: "debugger — chrome.debugger",
        pros: "Sees everything with nothing to install.",
        cons: "Chromium only. Chrome shows a \"being debugged\" banner while attached. May miss the first navigation in a fresh tab.",
    },
    rules: {
        label: "rules — browser-native rules",
        pros: "No banner, no setup, nothing runs per request: the browser itself applies the rules to every request, the first navigation included. Works in Chrome (MV3 and MV2) and Firefox.",
        cons: "Fixed results only: block, redirect (captures inserted as-is), set/remove request or response headers. No respond, replaceResponse or onResponseBody, no exclude. The handler runs once when scripts load and can't read the request (method, headers…).",
    },
};

function hasDnr(): boolean {
    const g = globalThis as any;
    return !!(g.chrome?.declarativeNetRequest || g.browser?.declarativeNetRequest);
}

/** why a strategy can't run in this build/browser, or null when it can */
export function strategyUnsupported(s: Strategy, env: { firefox: boolean; mv3: boolean; dnr?: boolean }): string | null {
    if (s === "rules") return (env.dnr ?? hasDnr()) ? null : "not available in this browser (no declarativeNetRequest)";
    if (env.firefox && (s === "helper" || s === "debugger")) return "not available in Firefox";
    if (!env.firefox && env.mv3 && s === "webRequest") return "not available in Chrome MV3 (blocking webRequest was removed)";
    return null;
}

/** markdown: description + link + pros/cons table (schema markdownDescription, hovers) */
export function strategyMarkdown(): string {
    const rows = STRATEGIES.map((s) => `| \`${s}\` | ${STRATEGY_INFO[s].pros} | ${STRATEGY_INFO[s].cons} |`);
    return [
        "Interception strategy for every handler whose route doesn't set its own `strategy`.",
        `Default: \`${builtinStrategy(false)}\` on Chromium, \`${builtinStrategy(true)}\` on Firefox. A handler whose strategy isn't available doesn't run (⚠ in the popup/Editor, warning in the Log view) — there is no fallback.`,
        "",
        `[Compatibility](${STRATEGY_DOC_URL})`,
        "",
        "| Strategy | Pros | Cons |",
        "|---|---|---|",
        ...rows,
    ].join("\n");
}

export function strategyEnumMarkdown(): string[] {
    return STRATEGIES.map((s) => `**${STRATEGY_INFO[s].label}**\n\n✅ ${STRATEGY_INFO[s].pros}\n\n⚠️ ${STRATEGY_INFO[s].cons}`);
}
