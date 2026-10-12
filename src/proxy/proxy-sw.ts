/**
 * Tier B — proxy service worker, registered on the extension origin by the
 * manager page. The background redirects matched non-JS resources to
 * chrome-extension://<id>/__resproxy?p=<encoded original url>; this worker
 * intercepts, fetches the original (with credentials, so authenticated
 * subresources still work), applies the user's transform, and serves the
 * result with the original Content-Type.
 */
import { compileScript } from "../shared/compile";
import { dlog } from "../shared/debugLog";

const PROXY_MARKER = "/__resproxy?p=";

interface ProxyTransform {
    scriptId: string;
    name: string;
    code: string;
}

function getTransforms(originalUrl: string): Promise<ProxyTransform[]> {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage({ type: "getProxyTransform", url: originalUrl }, (resp: any) => {
                if (chrome.runtime.lastError) {
                    dlog("sw", "getProxyTransform lastError:", chrome.runtime.lastError.message);
                    resolve([]);
                    return;
                }
                resolve((resp && resp.transforms) || []);
            });
        } catch (e: any) {
            dlog("sw", "getProxyTransform threw:", e.message || e);
            resolve([]);
        }
    });
}

async function handleProxy(request: Request, originalUrl: string, method: string): Promise<Response> {
    dlog("sw", "proxy fetch", { originalUrl, method });
    const transforms = await getTransforms(originalUrl);
    dlog("sw", "transforms", { count: transforms.length, names: transforms.map((t) => t.name) });
    const origResp = await fetch(originalUrl, { method, credentials: "include" });
    const contentType = origResp.headers.get("content-type") || "application/octet-stream";
    const isText = /text\/|json|javascript|xml/i.test(contentType);

    let body: string | Uint8Array = isText
        ? await origResp.text()
        : new Uint8Array(await origResp.arrayBuffer());

    for (const t of transforms) {
        try {
            const compiled = compileScript(t.code);
            if (!compiled.handlers.modifyResponse) continue;
            const out = await compiled.handlers.modifyResponse(
                {
                    url: originalUrl,
                    method,
                    tabUrl: originalUrl,
                    resourceType: "other",
                    requestHeaders: {},
                    contentType,
                    status: origResp.status,
                },
                body
            );
            if (out !== undefined && out !== null) body = out;
        } catch (e: any) {
            console.error(`[ResOverride proxy] ${t.name} transform threw:`, e.message || e);
        }
    }

    const headers = new Headers();
    headers.set("content-type", contentType);
    headers.set("access-control-allow-origin", "*");

    if (typeof body === "string") {
        return new Response(body, { status: origResp.status, headers });
    }
    return new Response(body as any, { status: origResp.status, headers });
}

const sw = self as any;

sw.addEventListener("fetch", (event: any) => {
    const url: string = event.request.url;
    dlog("sw", "fetch event", { url: url.slice(0, 140) });
    const markerIdx = url.indexOf(PROXY_MARKER);
    if (markerIdx === -1) return;

    const rest = url.slice(markerIdx + PROXY_MARKER.length);
    const originalUrl = decodeURIComponent(rest.split("&")[0]);
    const methodParam = rest.match(/[?&]m=([A-Z]+)/);
    const method = methodParam ? methodParam[1] : "GET";

    event.respondWith(handleProxy(event.request, originalUrl, method));
});

sw.addEventListener("install", () => {
    sw.skipWaiting();
});

sw.addEventListener("activate", (event: any) => {
    event.waitUntil(sw.clients.claim());
    dlog("sw", "activated");
});
