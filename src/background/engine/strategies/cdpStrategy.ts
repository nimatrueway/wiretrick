/**
 * Tier C: chrome.debugger + CDP Fetch domain. Opt-in per script
 * (@strategy cdp) — used for main-frame HTML transforms and anything the
 * hook/proxy tiers cannot see. Attaches lazily, only while body-modifying
 * requests are in flight for a matching script.
 */
import { matchAny } from "../../../shared/matcher";
import { compileScript, serializeHandlers } from "../../../shared/compile";
import type { Script } from "../scriptStore";
import { log } from "../logs";

interface CdpScript {
    scriptId: string;
    name: string;
    match: string[];
    transformSrc: string;
}

export class CdpStrategy {
    /** tabId → attached */
    private attached = new Set<number>();
    private scripts: CdpScript[] = [];

    reload(scripts: Script[]): void {
        this.scripts = [];
        for (const s of scripts) {
            if (!s.enabled || s.meta.strategy !== "cdp") continue;
            const c = compileScript(s.code);
            const src = serializeHandlers(c).modifyResponse;
            if (src) {
                this.scripts.push({ scriptId: s.id, name: s.meta.name, match: s.meta.match, transformSrc: src });
            }
        }
    }

    private matchingScripts(url: string): CdpScript[] {
        return this.scripts.filter((s) => matchAny(s.match, url));
    }

    private shouldAttach(url: string): boolean {
        return this.matchingScripts(url).length > 0;
    }

    /** Wire up a tab when a CDP-strategy script matches it. */
    async ensureAttached(tabId: number, mainFrameUrl: string | null): Promise<void> {
        if (!mainFrameUrl || !this.shouldAttach(mainFrameUrl) || this.attached.has(tabId)) return;
        try {
            await chrome.debugger.attach({ tabId }, "1.3");
            await chrome.debugger.sendCommand({ tabId }, "Fetch.enable", {
                patterns: [{ requestStage: "Response" }],
            });
            this.attached.add(tabId);
            log(tabId, "[Tier C] debugger attached (CDP body interception active)", "warn");
        } catch (e: any) {
            log(tabId, `[Tier C] debugger attach failed: ${e.message || e}`, "error");
        }
    }

    async handlePaused(tabId: number, params: any): Promise<void> {
        const { requestId, request } = params;
        if (!params.responseStatusCode) {
            await chrome.debugger.sendCommand({ tabId }, "Fetch.continueRequest", { requestId });
            return;
        }
        const url: string = request.url;
        const cdpScripts = this.matchingScripts(url);
        if (cdpScripts.length === 0) {
            await chrome.debugger.sendCommand({ tabId }, "Fetch.continueRequest", { requestId });
            return;
        }

        try {
            const bodyResp: any = await chrome.debugger.sendCommand({ tabId }, "Fetch.getResponseBody", { requestId });
            let body: string | Uint8Array = bodyResp.base64Encoded
                ? base64ToBytes(bodyResp.body)
                : bodyResp.body;

            const headers: { [n: string]: string } = {};
            for (const h of params.responseHeaders || []) {
                headers[h.name.toLowerCase()] = h.value || "";
            }

            for (const s of cdpScripts) {
                const fn = new Function(`return (${s.transformSrc});`)();
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
                    const out = await fn(ctx, body);
                    if (out !== undefined && out !== null) body = out;
                } catch (e: any) {
                    log(tabId, `[${s.name}] modifyResponse (cdp) threw: ${e.message || e}`, "error", s.scriptId);
                }
            }

            const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
            await chrome.debugger.sendCommand({ tabId }, "Fetch.fulfillRequest", {
                requestId,
                responseCode: params.responseStatusCode,
                responseHeaders: params.responseHeaders,
                body: bytesToBase64(bytes),
            });
        } catch (e: any) {
            log(tabId, `[Tier C] body interception failed: ${e.message || e}`, "error");
            try {
                await chrome.debugger.sendCommand({ tabId }, "Fetch.continueRequest", { requestId });
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
