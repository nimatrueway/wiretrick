/**
 * Diagnostic report: one Markdown document with everything needed to
 * investigate a problem (environment, engine state, scripts, settings,
 * LOG, debug log, recorded network) — meant to be pasted into an issue or
 * fed to an LLM. Credentials in headers are redacted; bodies are capped.
 */
import { listScripts, loadAllParamValues } from "./engine/scriptStore";
import { listAllStores } from "./engine/stores";
import { allLogs } from "./engine/logs";
import { getDebugBuffer } from "../shared/debugLog";
import { isRecording, networkSnapshot } from "./network";
import { getSettingsText } from "./settingsFile";
import type { NetBody, NetEntry } from "../shared/netTypes";
import { routeLabel } from "../shared/route";
import { scriptFileName } from "../shared/scriptName";
import type { ProblemGroup } from "../ui/problems";
import { DIAG_SECTIONS, type DiagSection, type DiagnosticsInclude } from "../shared/diagnosticsSections";

const SECRET_HEADERS = /^(cookie|set-cookie|authorization|proxy-authorization|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)$/i;
const BODY_CAP = 4000;
const NET_CAP = 300;

export interface DiagnosticsExtra {
    /** collected by the UI page: other installed extensions (needs "management") */
    extensions?: { name: string; id: string; version: string; enabled: boolean; permissions?: string[] }[] | string;
    /** UI-side environment, e.g. the page's navigator */
    ui?: Record<string, unknown>;
    /** engine state the caller owns (process helper, folder sync…) */
    state?: Record<string, unknown>;
    /** the Editor's Problems view as shown (live type errors included) */
    problems?: ProblemGroup[];
    /** what the sender chose to put in the report (default: everything) */
    include?: DiagnosticsInclude;
}

/** the Problems view as text: per file, `severity line:col [kind] message` */
export function problemsSection(groups: ProblemGroup[] | undefined): string[] {
    if (!Array.isArray(groups)) return [`## Problems`, "", `_not collected: open the Editor and collect from there_`];
    let errors = 0;
    let warnings = 0;
    const lines: string[] = [];
    for (const g of groups) {
        lines.push(g.label);
        for (const p of g.problems) {
            p.severity === "error" ? errors++ : warnings++;
            const at = p.line ? `${p.line}${p.column ? `:${p.column}` : ""}` : "-";
            lines.push(`  ${p.severity.padEnd(7)} ${at.padEnd(7)} [${p.kind}] ${p.message.replace(/\n/g, "\n            ")}`);
            if (p.context) lines.push(`            context: ${p.context}`);
        }
    }
    const title = `## Problems (${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"})`;
    return lines.length ? [title, "", fence("text", lines.join("\n"))] : [title, "", "_none_"];
}

const iso = (t: number) => new Date(t).toISOString();

function fence(lang: string, text: string): string {
    const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
    const f = "`".repeat(longest + 1);
    return `${f}${lang}\n${text.replace(/\n$/, "")}\n${f}`;
}

export function redactHeaders(h?: [string, string][]): [string, string][] | undefined {
    return h?.map(([n, v]) => [n, SECRET_HEADERS.test(n) ? `[redacted, ${v.length} chars]` : v]);
}

function capBody(b?: NetBody): NetBody | undefined {
    if (!b || b.text.length <= BODY_CAP) return b;
    return { ...b, text: b.text.slice(0, BODY_CAP) + `\n…[cut at ${BODY_CAP} chars for the report]`, truncated: true };
}

export function redactEntry(e: NetEntry): NetEntry {
    return {
        ...e,
        requestHeaders: redactHeaders(e.requestHeaders),
        responseHeaders: redactHeaders(e.responseHeaders),
        requestBody: capBody(e.requestBody),
        responseBody: capBody(e.responseBody),
        originalResponseBody: capBody(e.originalResponseBody),
    };
}

async function environment(): Promise<Record<string, unknown>> {
    const manifest = chrome.runtime.getManifest();
    const env: Record<string, unknown> = {
        extension: { name: manifest.name, version: manifest.version_name ?? manifest.version, manifest_version: manifest.manifest_version, id: chrome.runtime.id, build: __MV3__ ? "mv3" : "mv2", commit: __COMMIT__, builtAt: __BUILD_TIME__ },
        firefox: typeof (globalThis as any).browser?.webRequest?.filterResponseData === "function",
        userAgent: navigator.userAgent,
        language: navigator.language,
    };
    try {
        env.platform = await new Promise((r) => chrome.runtime.getPlatformInfo((p) => r(p)));
    } catch {}
    try {
        const uad = (navigator as any).userAgentData;
        if (uad?.getHighEntropyValues) {
            env.userAgentData = await uad.getHighEntropyValues(["fullVersionList", "platformVersion", "architecture", "bitness", "model"]);
        }
    } catch {}
    try {
        const info = await (globalThis as any).browser?.runtime?.getBrowserInfo?.();
        if (info) env.browserInfo = info;
    } catch {}
    env.apis = {
        webRequestBlocking: !__MV3__ && !!chrome.webRequest?.onBeforeRequest,
        onActionIgnored: !!(chrome.webRequest as any)?.onActionIgnored,
        debugger: !!chrome.debugger,
        proxy: !!chrome.proxy,
        nativeMessaging: !!chrome.runtime.connectNative,
    };
    return env;
}

export async function collectDiagnostics(extra: DiagnosticsExtra = {}): Promise<string> {
    const now = Date.now();
    const has = (id: DiagSection) => !extra.include?.sections || extra.include.sections.includes(id);
    const [env, allScripts, params] = await Promise.all([has("environment") ? environment() : null, listScripts(), loadAllParamValues()]);
    const picked = extra.include?.scripts;
    const scripts = picked ? allScripts.filter((s) => picked.includes(s.id)) : allScripts;
    let settings = "";
    if (has("settings")) {
        try {
            settings = await getSettingsText();
        } catch (e: any) {
            settings = JSON.stringify({ error: `could not render settings.json: ${e?.message || e}` });
        }
    }
    const tabs: { id?: number; url?: string; title?: string }[] = !has("state")
        ? []
        : await new Promise((r) => {
              try {
                  chrome.tabs.query({}, (t) => r((t || []).map((x) => ({ id: x.id, url: x.url, title: x.title }))));
              } catch {
                  r([]);
              }
          });
    const logs = allLogs();
    const debug = getDebugBuffer();
    const net = has("network") ? networkSnapshot().slice(-NET_CAP).map(redactEntry) : [];
    const stores = has("stores") ? await listAllStores(scripts) : [];
    const left = [
        ...DIAG_SECTIONS.filter((x) => !has(x.id)).map((x) => x.label),
        ...(scripts.length < allScripts.length ? [`${allScripts.length - scripts.length} of ${allScripts.length} scripts`] : []),
    ];

    const out: string[] = [];
    out.push(`# TangiTweak diagnostic report`);
    out.push("");
    out.push(`Generated ${iso(now)}. Request headers like cookies/authorization are redacted; bodies are capped at ${BODY_CAP} chars. Review before sharing — scripts, settings and URLs are included as-is.`);
    if (left.length) {
        out.push("");
        out.push(`Left out by the sender: ${left.join(", ")}.`);
    }
    out.push("");
    out.push(`## Problem description (fill in)`);
    out.push("");
    out.push(`- What I did / which URL:`);
    out.push(`- What I expected:`);
    out.push(`- What happened instead:`);
    out.push(`- Strategy that works / doesn't:`);
    out.push("");
    out.push(`## Notes for the investigator`);
    out.push("");
    out.push(
        [
            "TangiTweak is a browser extension that runs user TypeScript scripts (`tt.onRequest({ url, strategy }, fn)`, `tt.onResponseBody({ url, strategy }, fn)`, …) to intercept requests.",
            "Interception strategies: `page` (page fetch/XHR patch), `debugger` (chrome.debugger), `extension` (MV2 blocking webRequest), `helper` (local helper proxy).",
            "Log view lines are per-tab (`tab=-1` = background/global); `[extension]` lines trace the extension strategy (onBeforeRequest → script decision → redirect/complete/FAILED/IGNORED).",
            "If a URL never appears in the Log view/debug log, the extension never saw that request. Debug-level lines are only produced when `logLevel: debug`.",
        ].join("\n")
    );
    out.push("");
    if (env) {
        out.push(`## Environment`);
        out.push("");
        out.push(fence("json", JSON.stringify({ ...env, ui: extra.ui }, null, 2)));
        out.push("");
    }
    if (has("extensions")) {
        out.push(`## Other installed extensions`);
        out.push("");
        if (Array.isArray(extra.extensions)) {
            out.push(fence("json", JSON.stringify(extra.extensions, null, 2)));
        } else {
            out.push(`_not collected: ${extra.extensions || "management permission not granted"}_`);
        }
        out.push("");
    }
    if (has("state")) {
        out.push(`## Engine state`);
        out.push("");
        out.push(fence("json", JSON.stringify({ ...extra.state, networkRecording: isRecording(), openTabs: tabs }, null, 2)));
        out.push("");
    }
    if (has("problems")) {
        out.push(...problemsSection(extra.problems));
        out.push("");
    }
    if (has("settings")) {
        out.push(`## settings.json`);
        out.push("");
        out.push(fence("json", settings));
        out.push("");
    }
    if (has("stores")) {
        out.push(`## Stores (${stores.length})`);
        out.push("");
        if (!stores.length) {
            out.push(`_none_`);
        } else {
            const items = stores.map((st) => {
                const raw = JSON.stringify(st.data, null, 2);
                return {
                    script: scriptFileName(st.scriptName),
                    store: st.name,
                    scope: st.scope,
                    ...(st.tabUrl ? { tabUrl: st.tabUrl } : st.tabTitle ? { tab: st.tabTitle } : {}),
                    persist: st.scope !== "global" ? false : st.persist ?? true,
                    rev: st.rev,
                    data: raw.length <= BODY_CAP ? st.data : raw.slice(0, BODY_CAP) + `…[cut at ${BODY_CAP} chars]`,
                };
            });
            out.push(fence("json", JSON.stringify(items, null, 2)));
        }
        out.push("");
    }
    if (scripts.length || !picked) {
        out.push(`## Scripts (${scripts.length}${picked ? ` of ${allScripts.length}` : ""})`);
        for (const s of scripts) {
            out.push("");
            out.push(`### ${s.meta.name}.ts — ${s.enabled ? "enabled" : "disabled"}`);
            out.push("");
            out.push(
                fence(
                    "json",
                    JSON.stringify({ id: s.id, active: s.meta.active, description: s.meta.description, routes: (s.meta.routes || []).map((r) => ({ handler: routeLabel(r), ...r, kind: undefined, index: undefined })), error: s.error, params: params[s.id] || {}, updatedAt: iso(s.updatedAt) }, null, 2)
                )
            );
            out.push("");
            out.push(fence("ts", s.code));
        }
        out.push("");
    }
    if (has("log")) {
        out.push(`## Log (${logs.length} lines)`);
        out.push("");
        out.push(fence("text", logs.map((l) => `${iso(l.at)} ${l.level.toUpperCase().padEnd(5)} tab=${l.tabId}${l.scriptId ? ` script=${l.scriptId}` : ""} ${l.message}`).join("\n") || "(empty)"));
        out.push("");
    }
    if (has("debug")) {
        out.push(`## Debug log (${debug.length} entries)`);
        out.push("");
        out.push(fence("text", debug.map((d) => `${iso(d.at)} ${(d.level || "debug").toUpperCase().padEnd(5)} [${d.src}] ${d.msg}`).join("\n") || "(empty)"));
        out.push("");
    }
    if (has("network")) {
        out.push(`## Network (${net.length} requests${isRecording() ? "" : " — recording is OFF, only script-touched requests are kept: open the Editor's Network view, reproduce, then collect again for full detail"})`);
        out.push("");
        out.push(fence("json", net.length ? net.map((e) => JSON.stringify(e)).join("\n") : "(empty)"));
        out.push("");
    }
    return out.join("\n");
}
