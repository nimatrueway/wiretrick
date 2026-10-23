/**
 * Page strategy: a MAIN-world content script overrides
 * fetch/XHR and asks the background to run the hook-owned handlers for
 * page-initiated requests — onRequest decisions, replaceResponse and
 * onResponseBody (streamed body). Banner-free. The page claims each request
 * it handles so the other strategies skip it.
 *
 * Only routes whose strategy is "page" run here; navigations, subresources,
 * workers and anything the page didn't fetch itself never reach this strategy.
 */
import { runOp, type OpScript } from "../../../shared/bodyOps";
import type { HeaderChanges, HookDisposition, InterceptionStrategy, MaybePromise, WebRequestDetailsLike } from "./types";
import type { Script } from "../scriptStore";
import { log } from "../logs";
import { runBodyOp } from "../../compileHost";
import { dlogLevel } from "../../../shared/debugLog";
import { compileMv2, ownsAny } from "./strategyScripts";

type Decision = { kind: "respond"; mime: string; content: string; status?: number; headers?: any; scriptId?: string; scriptName?: string } | { kind: "redirect"; url: string } | { kind: "cancel" } | { kind: "headers"; changes: any } | null;

export class PageStrategy implements InterceptionStrategy {
    readonly name = "page";

    /** MV2: compiled scripts owning hook routes */
    private ops: OpScript[] = [];
    /** MV3: plain script data for the sandbox RPCs (no local compilation) */
    private mv3Scripts: { id: string; name: string; code: string; updatedAt: number; enabled: boolean }[] = [];
    private mv3Params: { [scriptId: string]: Record<string, any> } = {};
    private hookOwners = 0;
    private claimedUrls = new Map<string, number>();

    reload(scripts: Script[], paramValues?: { [scriptId: string]: Record<string, any> }): void {
        const owners = scripts.filter((s) => s.enabled && ownsAny(s, "page"));
        this.hookOwners = owners.length;
        if (__MV3__) {
            // the SW cannot compile — handlers execute in the sandbox page; the
            // sandbox needs every enabled script (imports)
            this.mv3Scripts = scripts.filter((s) => s.enabled).map((s) => ({ id: s.id, name: s.meta.name, code: s.code, updatedAt: s.updatedAt, enabled: true }));
            this.mv3Params = paramValues || {};
            return;
        }
        this.ops = compileMv2(scripts, paramValues, (s) => ownsAny(s, "page")).map((c) => ({ id: c.id, name: c.name, handlers: c.compiled.handlers }));
    }

    /** does any enabled script own a hook route? */
    hasOwners(): boolean {
        return this.hookOwners > 0;
    }

    private run(op: "requestDecision" | "transform" | "replace", args: Record<string, any>, tabId: number): Promise<any> {
        const a = { ...args, tabId, tier: "page", resourceType: "xmlhttprequest" };
        if (__MV3__) return runBodyOp(this.mv3Scripts, this.mv3Params, op, a);
        return runOp(this.ops, op, a, {
            log: (scriptId, level, msg, kind) => log(tabId, msg, level, scriptId, kind),
            debug: (msg) => dlogLevel("page", "debug", msg),
        });
    }

    /** onRequest handlers ONCE: the first final decision (replaceResponse | redirect | block) or merged headers; null = none. */
    runRequestDecision(url: string, method: string, tabId = -1): Promise<Decision> {
        return this.run("requestDecision", { url, method }, tabId);
    }

    /** chained onResponseBody over the body (async handlers awaited) */
    runTransform(url: string, method: string, body: string, extra?: { status?: number; contentType?: string }, tabId = -1): Promise<string | null> {
        return this.run("transform", { url, method, body, status: extra?.status, contentType: extra?.contentType }, tabId);
    }

    /** first replaceResponse handler's result, or null */
    runReplace(url: string, method: string, tabId = -1): Promise<{ mime: string; content: string } | null> {
        return this.run("replace", { url, method }, tabId);
    }

    supportsBodyModification(): boolean {
        return true;
    }

    /** Called by the hook (via background messaging) to claim a request. */
    claimRequest(url: string): void {
        this.claimedUrls.set(url, Date.now());
        if (this.claimedUrls.size > 500) {
            const cutoff = Date.now() - 30_000;
            for (const [u, t] of this.claimedUrls) {
                if (t < cutoff) this.claimedUrls.delete(u);
            }
        }
    }

    isClaimed(url: string): boolean {
        const t = this.claimedUrls.get(url);
        return t !== undefined && Date.now() - t < 10_000;
    }

    forgetTab(_tabId: number): void {}

    handleBeforeRequest(_d: WebRequestDetailsLike, _t: string | null): MaybePromise<HookDisposition> {
        return { kind: "allow" }; // the hook runs in the page, not in webRequest
    }

    handleBeforeSendHeaders(_d: WebRequestDetailsLike, _t: string | null): MaybePromise<HeaderChanges | null> {
        return null;
    }

    handleHeadersReceived(_d: WebRequestDetailsLike, _t: string | null): MaybePromise<HeaderChanges | null> {
        return null;
    }

    dispose(): void {
        this.ops = [];
        this.claimedUrls.clear();
    }
}
