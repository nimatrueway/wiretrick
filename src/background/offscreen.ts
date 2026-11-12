/**
 * MV3 offscreen document: the bridge between the service worker (which
 * cannot eval) and the sandbox iframe (the only eval-permitted context).
 *
 *   SW ⇄ chrome.runtime ⇄ HERE ⇄ window.postMessage ⇄ sandbox iframe
 *
 * Pure transport — no logic. Besides the request/response ops it relays
 * the L1 wire link (`wire` messages: tt.globalStore, tt.fetch) both ways. chrome.runtime messaging is JSON, so body
 * bytes arrive packed ({ __ttBytes }) and are unpacked for postMessage
 * (structured clone keeps Uint8Array); results are packed on the way back.
 */
import { packBytes, unpackBytes } from "../shared/bytesPack";
import { watchCall, type CallWatch } from "../shared/callWatch";

const pending = new Map<string, Pending>();
let seq = 0;
/** quiet time before asking the sandbox whether a call still runs (no limit while it does) */
const RPC_CHECK_MS = 20000;
const RPC_GRACE_MS = 5000;
/** the extension id, learned from the SW's first RPC — feeds the sandbox's chrome shim */
let extId: string | null = null;
/** true while the iframe reloads (extId learned → src rewrite → load event) */
let frameReloading = false;

function sandboxFrame(): HTMLIFrameElement | null {
    const frame = document.querySelector<HTMLIFrameElement>("#sb");
    if (frame && extId && frame.src.includes("__EXT_ID__")) {
        // first call after learning the id: reload the iframe so the shim
        // (built at document load) sees the real extension id
        frameReloading = true;
        frame.addEventListener("load", () => (frameReloading = false), { once: true });
        frame.src = `sandbox.html?extId=${encodeURIComponent(extId)}`;
    }
    return frame;
}

function forward(reqId: string, payload: any): void {
    const send = () => {
        const frame = document.querySelector<HTMLIFrameElement>("#sb");
        if (frame?.contentWindow) {
            frame.contentWindow.postMessage({ kind: "sandboxCall", reqId, payload }, "*");
        } else {
            dbg(`frame GONE for ${payload?.op}`);
            pending.get(reqId)?.resolve({ error: "sandbox iframe not ready" });
        }
    };
    if (frameReloading) {
        // the iframe is mid-reload (extId learned on this very call) — hold
        // the message until it's back, then forward
        const frame = document.querySelector<HTMLIFrameElement>("#sb");
        frame?.addEventListener("load", () => setTimeout(send, 50), { once: true });
        setTimeout(() => {
            if (pending.has(reqId)) send(); // load event missed (already loaded)
        }, 1500);
    } else {
        send();
    }
}

interface Pending {
    resolve: (r: any) => void;
    watch: CallWatch;
    /** the SW's id for this call (its own watchdog asks about it) */
    swReqId: string;
}

function dbg(msg: string): void {
    try {
        chrome.runtime.sendMessage({ type: "debugLog", entry: { at: Date.now(), src: "offscreen", msg } }, () => void chrome.runtime.lastError);
    } catch {}
}

function reqIdOf(msg: any): string {
    return msg?.reqId ?? "?";
}

chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
    if (msg?.type === "__resSandboxWire") {
        // the SW's side of the L1 wire link (store patches, call results)
        document.querySelector<HTMLIFrameElement>("#sb")?.contentWindow?.postMessage({ kind: "wire", msg: unpackBytes(msg.msg) }, "*");
        return false;
    }
    if (msg?.type === "__resSandboxAlive?") {
        // the SW's watchdog: is this call still running in the sandbox?
        sendResponse({ alive: [...pending.values()].some((p) => p.swReqId === msg.reqId) });
        return false;
    }
    if (!msg || msg.type !== "__resSandbox") return false;
    // the SW tags every call with its runtime.id — the first one teaches us
    // the id the sandbox's chrome shim should present (iframe reloads once)
    if (!extId && msg.extId) {
        extId = msg.extId;
        sandboxFrame();
    }
    const reqId = "sb_" + ++seq;
    const watch = watchCall({
        checkMs: RPC_CHECK_MS,
        graceMs: RPC_GRACE_MS,
        ask: () => document.querySelector<HTMLIFrameElement>("#sb")?.contentWindow?.postMessage({ kind: "sandboxAlive?", reqId }, "*"),
        onLost: () => {
            pending.delete(reqId);
            sendResponse({ error: "sandbox timeout" });
        },
    });
    pending.set(reqId, {
        resolve: (result) => {
            watch.stop();
            pending.delete(reqId);
            sendResponse(packBytes(result));
        },
        watch,
        swReqId: msg.reqId,
    });
    const payload = msg.payload?.args ? { ...msg.payload, args: unpackBytes(msg.payload.args) } : msg.payload;
    forward(reqId, payload);
    return true; // async sendResponse
});

window.addEventListener("message", (event) => {
    const data = event.data;
    if (data?.kind === "wire") {
        if (event.source !== document.querySelector<HTMLIFrameElement>("#sb")?.contentWindow) return;
        chrome.runtime.sendMessage({ type: "__resWire", msg: packBytes(data.msg) }, () => void chrome.runtime.lastError);
        return;
    }
    if (data?.kind === "sandboxAlive") {
        if (event.source === document.querySelector<HTMLIFrameElement>("#sb")?.contentWindow) pending.get(data.reqId)?.watch.alive();
        return;
    }
    if (!data || (data.kind !== "sandboxResult" && data.kind !== "reverse")) return;
    if (data.kind === "sandboxResult") {
        pending.get(data.reqId)?.resolve(data.result);
        return;
    }
    // reverse call from the sandbox: storage / logging — resolved by the SW
    chrome.runtime.sendMessage({ type: "__resReverse", payload: data }, (resp: any) => {
        if (data.op === "storageGet" || data.op === "storageSet") {
            const frame = document.querySelector<HTMLIFrameElement>("#sb");
            frame?.contentWindow?.postMessage({ kind: "reverseResult", reqId: data.reqId, result: resp || null }, "*");
        }
    });
});
