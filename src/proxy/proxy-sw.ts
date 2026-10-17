/**
 * Tier B — proxy service worker, registered on the extension origin by the
 * manager page. The background redirects matched non-JS resources to
 * chrome-extension://<id>/__resproxy?p=<encoded original url>; this worker
 * intercepts, fetches the original (with credentials, so authenticated
 * subresources still work), applies the user's transform, and serves the
 * result with the original Content-Type.
 *
 * MV2: transforms compile right here (plain-JS — this SW has no TS
 * stripper). MV3: this worker CANNOT eval — it delegates the whole load to
 * the background service worker (→ sandbox page) and serves the returned
 * body. Register with scope "/__resproxy" (MV3) so it only intercepts
 * proxy loads, never extension pages.
 */
import { compileScript } from "../shared/compile";
import { dlog } from "../shared/debugLog";

const PROXY_MARKER = "/__resproxy?p=";

declare const __MV3__: boolean;

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

/** MV3: the background runs the whole decision+transform flow (sandbox) */
function serveViaBackground(originalUrl: string, method: string): Promise<Response> {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage({ type: "__resProxyServe", url: originalUrl, method }, (resp: any) => {
                if (chrome.runtime.lastError) {
                    dlog("sw", "proxyServe lastError:", chrome.runtime.lastError.message);
                    resolve(new Response("", { status: 502 }));
                    return;
                }
                if (!resp || resp.error) {
                    dlog("sw", "proxyServe failed:", resp?.error || "no response");
                    resolve(new Response("", { status: 502 }));
                    return;
                }
                if (resp.location) {
                    resolve(Response.redirect(resp.location, 302));
                    return;
                }
                resolve(
                    new Response(resp.body ?? "", {
                        status: resp.status ?? 200,
                        statusText: resp.statusText,
                        headers: { "content-type": resp.contentType || "application/octet-stream" },
                    })
                );
            });
        } catch (e: any) {
            dlog("sw", "proxyServe threw:", e.message || e);
            resolve(new Response("", { status: 502 }));
        }
    });
}

async function handleProxy(request: Request, originalUrl: string, method: string): Promise<Response> {
    dlog("sw", "proxy fetch", { originalUrl, method, mv3: __MV3__ });
    if (__MV3__) return serveViaBackground(originalUrl, method);
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
            for (const modify of compiled.handlers.modifyResponse) {
            const out = await modify(
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
            }
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
