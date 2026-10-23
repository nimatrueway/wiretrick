/**
 * The `rules` strategy: handlers become declarativeNetRequest SESSION rules
 * that the browser applies itself (no banner, no helper, nothing runs per
 * request).
 *
 * On every reload each rules handler runs once with a tripwire ctx (MV3:
 * in the sandbox; MV2: right here — src/shared/rulesProbe.ts) and is
 * translated to rule specs (src/shared/dnrRules.ts). Then this extension's
 * session rules are replaced wholesale. A handler that can't become a rule
 * is skipped — its script gets a red ⚠ and a rules error in the Problems
 * view — while the script's other handlers keep running.
 *
 * Requests matched by an active rule are marked Modified in the Network
 * view (our own matcher on observed requests; no feedback permission).
 */
import { getDefaultStrategy, routeLabel, routeMatches, type RouteMeta } from "../../../shared/route";
import { regexCost, ruleErrorLine, substitute, type RuleSpec } from "../../../shared/dnrRules";
import { probeScriptRules, type ScriptRules } from "../../../shared/rulesProbe";
import { strategyUnsupported } from "../../../shared/strategyInfo";
import { dlogLevel } from "../../../shared/debugLog";
import { probeRules } from "../../compileHost";
import { log, setScriptRuleErrors } from "../logs";
import type { Script } from "../scriptStore";
import { compileMv2, ownsAny } from "./strategyScripts";
import { IS_FIREFOX } from "./helperState";

type ParamValues = { [scriptId: string]: Record<string, any> };

interface ActiveRule {
    id: number;
    scriptId: string;
    name: string;
    route: RouteMeta;
    spec: RuleSpec;
}

const CACHE_KEY = "wtRulesState";

function dnrApi(): any {
    const g = globalThis as any;
    return g.browser?.declarativeNetRequest ?? g.chrome?.declarativeNetRequest;
}

/** call a declarativeNetRequest function: promise (Firefox `browser`, MV3) or callback (MV2 Chromium) */
function dnrCall<T = any>(fn: string, ...args: any[]): Promise<T> {
    const g = globalThis as any;
    if (g.browser?.declarativeNetRequest?.[fn]) return g.browser.declarativeNetRequest[fn](...args);
    return new Promise((resolve, reject) => {
        g.chrome.declarativeNetRequest[fn](...args, (r: T) => {
            const e = g.chrome.runtime.lastError;
            if (e) reject(new Error(e.message));
            else resolve(r);
        });
    });
}

async function regexSupported(regex: string, requireCapturing: boolean): Promise<any> {
    return dnrCall("isRegexSupported", { regex, isCaseSensitive: true, requireCapturing });
}

/** why a url pattern's regex can't be a rule (isRegexSupported), or null */
async function regexProblem(regex: string, pattern: string, requireCapturing: boolean): Promise<string | null> {
    if (typeof dnrApi()?.isRegexSupported !== "function") return null;
    try {
        const r: any = await regexSupported(regex, requireCapturing);
        if (!r || r.isSupported) return null;
        if (r.reason === "memoryLimitExceeded") {
            const { classes, groups, captures } = regexCost(regex);
            const capturesOnly = requireCapturing && (await regexSupported(regex, false).catch(() => null))?.isSupported;
            const fix = capturesOnly
                ? `it fits without captures, so the redirect's ${captures} captures push it over — use fewer ctx.groups in the redirect`
                : `use fewer groups or wildcards, e.g. one * for a run of segments`;
            return `url pattern "${pattern}" is too complex for a rule: its regex exceeds the browser's regex memory limit ` +
                `(2 KB of compiled RE2 program in Chrome; the size grows with character classes and groups, not text length — roughly 10 :name groups or wildcards fit). ` +
                `Regex: ${regex} (${regex.length} chars, ${classes} character classes, ${groups} groups${requireCapturing ? `, ${captures} captured for the redirect` : ""}) — ${fix}`;
        }
        return `url pattern "${pattern}" can't be a rule: the browser's regex engine (RE2) rejects its regex ${regex} (${r.reason || "syntaxError"}) — no lookahead, lookbehind or backreferences in custom groups`;
    } catch {
        return null;
    }
}

function toRule(r: ActiveRule, priority: number): any {
    return { id: r.id, priority, action: r.spec.action, condition: r.spec.condition };
}

export class RulesStrategy {
    private chain: Promise<void> = Promise.resolve();
    private active: { rule: ActiveRule; re: RegExp }[] = [];
    private observing = false;
    private seen = new Set<string>();
    private readonly onEvent = (d: any): void => this.observe(d);

    reload(scripts: Script[], paramValues?: ParamValues): Promise<void> {
        this.chain = this.chain
            .then(() => this.apply(scripts, paramValues || {}))
            .catch((e: any) => dlogLevel("rules", "error", `rules reload failed: ${e?.message || e}`));
        return this.chain;
    }

    private async apply(scripts: Script[], paramValues: ParamValues): Promise<void> {
        if (strategyUnsupported("rules", { firefox: IS_FIREFOX, mv3: __MV3__ })) return; // routeProblem warns
        const owners = scripts.filter((s) => s.enabled && s.meta.active && ownsAny(s, "rules"));
        const names = new Map(scripts.map((s) => [s.id, s.meta.name]));
        if (!owners.length) {
            await this.replace([]);
            await setScriptRuleErrors(new Map(), names);
            await this.saveCache(null);
            this.setActive([]);
            return;
        }
        const enabled = scripts.filter((s) => s.enabled);
        const sig = JSON.stringify([enabled.map((s) => [s.id, s.updatedAt]), paramValues, getDefaultStrategy()]);
        if (__MV3__ && (await this.restoreCache(sig))) return;

        const probed = await this.probe(scripts, owners, paramValues);
        const errors = new Map<string, string[]>();
        const addError = (id: string, line: string) => errors.set(id, [...(errors.get(id) || []), line]);
        // group rule specs per handler, in script order (= runtime order)
        const groups: { scriptId: string; name: string; route: RouteMeta; specs: RuleSpec[] }[] = [];
        for (const s of scripts) {
            const r = probed.get(s.id);
            if (!r) continue;
            for (const e of r.errors) addError(s.id, e);
            for (const h of r.rules) groups.push({ scriptId: s.id, name: s.meta.name, route: h.route, specs: h.specs });
        }
        // RE2 pre-check: attribute an unsupported regex to its handler
        const regexOk = new Map<string, string | null>();
        const accepted: typeof groups = [];
        for (const g of groups) {
            let problem: string | null = null;
            for (const spec of g.specs) {
                const re = spec.condition.regexFilter as string;
                const capturing = typeof spec.action.redirect?.regexSubstitution === "string";
                const key = `${capturing ? 1 : 0}${re}`;
                if (!regexOk.has(key)) regexOk.set(key, await regexProblem(re, spec.pattern, capturing));
                problem = regexOk.get(key)!;
                if (problem) break;
            }
            if (problem) addError(g.scriptId, ruleErrorLine(g.route, problem));
            else accepted.push(g);
        }
        let nextId = 1;
        const handlerRules = accepted.map((g) => g.specs.map((spec) => ({ id: nextId++, scriptId: g.scriptId, name: g.name, route: g.route, spec })));
        const all = handlerRules.flat();
        const priorities = this.priorities(all);
        const asRules = (list: ActiveRule[]) => list.map((r) => toRule(r, priorities.get(r.id)!));
        let applied: ActiveRule[] = all;
        try {
            await this.replace(asRules(all));
        } catch (e: any) {
            // one handler at a time, so the browser's error names the right handler
            dlogLevel("rules", "warn", `session rules rejected as a batch (${e?.message || e}) — adding them per handler`);
            await this.replace([]);
            applied = [];
            for (const list of handlerRules) {
                try {
                    await dnrCall("updateSessionRules", { addRules: asRules(list) });
                    applied.push(...list);
                } catch (err: any) {
                    addError(list[0].scriptId, ruleErrorLine(list[0].route, `the browser rejected the rule: ${err?.message || err}`));
                }
            }
        }
        await setScriptRuleErrors(errors, names);
        this.setActive(applied);
        dlogLevel("rules", "info", `${applied.length} session rule(s) active for ${[...new Set(applied.map((r) => `"${r.name}"`))].join(", ") || "no script"}`);
        if (__MV3__) await this.saveCache({ sig, active: applied, errors: Object.fromEntries(errors), names: Object.fromEntries(names) });
    }

    /** final rules: earlier handler wins (higher priority); header rules: later handler wins */
    private priorities(all: ActiveRule[]): Map<number, number> {
        const out = new Map<number, number>();
        const finals = all.filter((r) => r.spec.final);
        finals.forEach((r, i) => out.set(r.id, 100000 + finals.length - i));
        all.filter((r) => !r.spec.final).forEach((r, i) => out.set(r.id, 1 + i));
        return out;
    }

    private async probe(scripts: Script[], owners: Script[], paramValues: ParamValues): Promise<Map<string, ScriptRules>> {
        const out = new Map<string, ScriptRules>();
        if (__MV3__) {
            // the same script set the other strategies send: keeps the sandbox's compile cache warm
            const plain = scripts.filter((s) => s.enabled).map((s) => ({ id: s.id, name: s.meta.name, code: s.code, updatedAt: s.updatedAt, enabled: true }));
            const results = await probeRules(plain, paramValues);
            if (!results) {
                dlogLevel("rules", "warn", "the sandbox didn't answer — keeping the current session rules");
                throw new Error("rules probe failed");
            }
            for (const [id, r] of Object.entries(results)) out.set(id, r);
            return out;
        }
        const ownerIds = new Set(owners.map((s) => s.id));
        for (const c of compileMv2(scripts, paramValues, (s) => ownerIds.has(s.id))) {
            if (c.compiled.error) continue;
            out.set(c.id, await probeScriptRules(c.compiled.handlers, getDefaultStrategy()));
        }
        return out;
    }

    /** remove every session rule (the extension owns them all), then add `rules` */
    private async replace(rules: any[]): Promise<void> {
        const existing: any[] = (await dnrCall("getSessionRules")) || [];
        if (!existing.length && !rules.length) return;
        await dnrCall("updateSessionRules", { removeRuleIds: existing.map((r) => r.id), addRules: rules });
    }

    // ---- MV3: skip re-probing on service-worker wake ----

    private async restoreCache(sig: string): Promise<boolean> {
        try {
            const d = await chrome.storage.session.get(CACHE_KEY);
            const c = d?.[CACHE_KEY];
            if (!c || c.sig !== sig) return false;
            const live: any[] = (await dnrCall("getSessionRules")) || [];
            const ids = new Set(live.map((r) => r.id));
            if (live.length !== c.active.length || !c.active.every((r: ActiveRule) => ids.has(r.id))) return false;
            await setScriptRuleErrors(new Map(Object.entries(c.errors || {})), new Map(Object.entries(c.names || {})));
            this.setActive(c.active);
            return true;
        } catch {
            return false;
        }
    }

    private async saveCache(v: unknown): Promise<void> {
        if (!__MV3__) return;
        try {
            if (v) await chrome.storage.session.set({ [CACHE_KEY]: v });
            else await chrome.storage.session.remove(CACHE_KEY);
        } catch {}
    }

    // ---- Network view: mark requests an active rule matched ----

    private setActive(active: ActiveRule[]): void {
        this.active = active.map((rule) => ({ rule, re: new RegExp(rule.spec.condition.regexFilter) }));
        const wr = (globalThis as any).chrome?.webRequest;
        if (!wr) return;
        const filter = { urls: ["<all_urls>"] };
        if (active.length && !this.observing) {
            this.observing = true;
            // whichever fires first for a request: a blocked one may only
            // reach onErrorOccurred, a redirected one onBeforeRedirect
            wr.onBeforeRequest.addListener(this.onEvent, filter);
            wr.onBeforeRedirect.addListener(this.onEvent, filter);
            wr.onErrorOccurred.addListener(this.onEvent, filter);
        } else if (!active.length && this.observing) {
            this.observing = false;
            wr.onBeforeRequest.removeListener(this.onEvent);
            wr.onBeforeRedirect.removeListener(this.onEvent);
            wr.onErrorOccurred.removeListener(this.onEvent);
        }
    }

    private observe(d: any): void {
        if (!this.active.length || this.seen.has(d.requestId)) return;
        this.seen.add(d.requestId);
        if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value!);
        const hits = this.active.filter((a) => a.re.test(d.url) && routeMatches(a.rule.route, d.url, d.method, d.type)).map((a) => a.rule);
        if (!hits.length) return;
        const final = hits.find((r) => r.spec.final);
        for (const r of final ? [final] : hits) {
            let what = r.spec.summary;
            const sub = r.spec.action.redirect?.regexSubstitution;
            const to = sub ? substitute(r.spec.condition.regexFilter, sub, d.url) : r.spec.action.redirect?.url;
            if (to) what = `redirect → ${to}`;
            log(d.tabId ?? -1, `[rules] [${r.name}] ${routeLabel(r.route).replace(/ #\d+$/, "")} → ${what} ${d.url}`, "info", r.scriptId, "modified", d.url);
        }
    }
}

