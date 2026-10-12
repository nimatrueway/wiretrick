/**
 * Tier C: chrome.debugger + CDP Fetch domain. Opt-in per script
 * (@strategy cdp) — used for main-frame HTML transforms and anything the
 * hook/proxy tiers cannot see. Attaches lazily, only while body-modifying
 * requests are in flight for a matching script.
 */
import { matchAny } from "../../../shared/matcher";
import { compileScript, type HandlerFn } from "../../../shared/compile";
import type { Script } from "../scriptStore";
import { log } from "../logs";
import { dlog } from "../../../shared/debugLog";
import { debuggerAttach, debuggerSend } from "../../../shared/chromeApi";

interface CdpScript {
    scriptId: string;
    name: string;
    match: string[];
    transform: HandlerFn;
}

export class CdpStrategy {
    /** tabId → attached */
    private attached = new Set<number>();
    private scripts: CdpScript[] = [];

    reload(scripts: Script[]): void {
        this.scripts = [];
        // Every enabled script with a modifyResponse handler may need CDP on
        // Chrome (hook covers page fetch/XHR; CDP covers everything else).
        for (const s of scripts) {
            if (!s.enabled) continue;
            const c = compileScript(s.code);
            if (c.handlers.modifyResponse) {
                this.scripts.push({
                    scriptId: s.id,
                    name: s.meta.name,
                    match: s.meta.match,
                    transform: c.handlers.modifyResponse,
                });
            }
        }
    }

    private matchingScripts(url: string): CdpScript[] {
        return this.scripts.filter((s) => matchAny(s.match, url));
    }

    /** Injected by background: are hook-claimed URLs skipped? */
    isClaimed: (url: string) => boolean = () => false;

    /**
     * Pre-attach whenever any body script exists: subresources match
     * request urls, not the page url, so page-url gating misses them.
     * The debugger stays attached; pauses are cheap and skipped quickly.
     */
    private shouldAttach(_url: string): boolean {
        return this.scripts.length > 0;
    }

    /** Wire up a tab when a CDP-strategy script matches it. */
    async ensureAttached(tabId: number, mainFrameUrl: string | null): Promise<void> {
        if (!mainFrameUrl || !this.shouldAttach(mainFrameUrl) || this.attached.has(tabId)) return;
        dlog("cdp", "ensureAttached", { tabId, mainFrameUrl, scripts: this.scripts.map((s) => s.name) });
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                await debuggerAttach(tabId);
                await debuggerSend(tabId, "Fetch.enable", { patterns: [{ requestStage: "Response" }] });
                this.attached.add(tabId);
                dlog("cdp", "attached + Fetch.enabled", { tabId, attempt });
                log(tabId, "[Tier C] debugger attached (CDP body interception active)", "warn");
                return;
            } catch (e: any) {
                // another debugger evicted us between attach and enable —
                // retry once before giving up
                dlog("cdp", `attach attempt ${attempt} failed`, { tabId, error: e.message || e });
                if (attempt === 1) {
                    dlog("cdp", "ATTACH FAILED", { tabId, error: e.message || e });
                    log(tabId, `[Tier C] debugger attach failed: ${e.message || e}`, "error");
                    return;
                }
                await new Promise((r) => setTimeout(r, 150));
            }
        }
    }

    async handlePaused(tabId: number, params: any): Promise<void> {
        const { requestId, request } = params;
        if (!params.responseStatusCode) {
            await debuggerSend(tabId, "Fetch.continueRequest", { requestId });
            return;
        }
        const url: string = request.url;
        const cdpScripts = this.matchingScripts(url);
        dlog("cdp", "handlePaused decision", { url, matching: cdpScripts.length, claimed: this.isClaimed(url), scripts: this.scripts.map((x) => `${x.name}=${x.match.join(",")}`) });
        if (cdpScripts.length === 0 || this.isClaimed(url)) {
            // not ours, or the page hook already transformed it
            await debuggerSend(tabId, "Fetch.continueRequest", { requestId });
            return;
        }

        try {
            const bodyResp: any = await debuggerSend(tabId, "Fetch.getResponseBody", { requestId });
            dlog("cdp", "got body", { url, base64: bodyResp.base64Encoded, len: bodyResp.body ? bodyResp.body.length : 0 });
            let bytes = bodyResp.base64Encoded ? base64ToBytes(bodyResp.body) : new TextEncoder().encode(bodyResp.body);
            // textual bodies are handed to transforms as strings — most
            // transforms are string-oriented; binary stays bytes
            let body: string | Uint8Array = looksTextual(bytes) ? new TextDecoder().decode(bytes) : bytes;

            const headers: { [n: string]: string } = {};
            for (const h of params.responseHeaders || []) {
                headers[h.name.toLowerCase()] = h.value || "";
            }

            for (const s of cdpScripts) {
                const ctx = {
                    url,
                    method: request.method,
                    tabUrl: url,
                    resourceType: params.resourceType || "main_frame",
                    requestHeaders: {},
                    status: params.responseStatusCode,
                    contentType: headers["content-type"],
                };
                try {
                    const out = await s.transform(ctx, body);
                    if (out !== undefined && out !== null) body = out;
                    dlog("cdp", `transform ${s.name} applied`);
                } catch (e: any) {
                    dlog("cdp", `transform ${s.name} THREW: ${e.message || e}`);
                    log(tabId, `[${s.name}] modifyResponse (cdp) threw: ${e.message || e}`, "error", s.scriptId);
                }
            }

            const outBytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
            dlog("cdp", "fulfilling", { url, outLen: outBytes.length });
            await debuggerSend(tabId, "Fetch.fulfillRequest", {
                requestId,
                responseCode: params.responseStatusCode,
                responseHeaders: params.responseHeaders,
                body: bytesToBase64(outBytes),
            });
        } catch (e: any) {
            log(tabId, `[Tier C] body interception failed: ${e.message || e}`, "error");
            try {
                await debuggerSend(tabId, "Fetch.continueRequest", { requestId });
            } catch {
                /* detach race */
            }
        }
    }

    async handleDetach(tabId: number): Promise<void> {
        this.attached.delete(tabId);
    }

    async detach(tabId: number): Promise<void> {
        if (this.attached.has(tabId)) {
            this.attached.delete(tabId);
            try {
                await chrome.debugger.detach({ tabId });
            } catch {
                /* already gone */
            }
        }
    }
}

function looksTextual(bytes: Uint8Array): boolean {
    const n = Math.min(bytes.length, 512);
    for (let i = 0; i < n; i++) {
        if (bytes[i] === 0) return false;
    }
    return true;
}

function base64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}
