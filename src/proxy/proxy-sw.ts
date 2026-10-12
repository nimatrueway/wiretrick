/**
 * Tier B — proxy service worker, registered on the extension origin by the
 * manager page. The background redirects matched non-JS resources to
 * chrome-extension://<id>/__resproxy?p=<encoded original url>; this worker
 * intercepts, fetches the original, applies the user's transform, and serves
 * the result with the original Content-Type.
 */

const PROXY_MARKER = "/__resproxy?p=";

interface ProxyTransform {
    scriptId: string;
    name: string;
    transformSrc: string;
}

async function getTransforms(originalUrl: string): Promise<ProxyTransform[]> {
    try {
        const resp = await chrome.runtime.sendMessage({ type: "getProxyTransform", url: originalUrl });
        return (resp && resp.transforms) || [];
    } catch (e) {
        console.error("[ResOverride proxy] could not reach background", e);
        return [];
    }
}

async function handleProxy(request: Request, originalUrl: string): Promise<Response> {
    const transforms = await getTransforms(originalUrl);
    const origResp = await fetch(originalUrl, { credentials: "omit" });
    const contentType = origResp.headers.get("content-type") || "application/octet-stream";
    const isText = /text\/|json|javascript|xml/i.test(contentType);

    let body: string | Uint8Array = isText
        ? await origResp.text()
        : new Uint8Array(await origResp.arrayBuffer());

    for (const t of transforms) {
        try {
            const fn = new Function(`return (${t.transformSrc});`)();
            const out = await fn(
                {
                    url: originalUrl,
                    method: request.method,
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
        return new Response(body as any, { status: origResp.status, headers });
    }
    return new Response(body as any, { status: origResp.status, headers });
}

self.addEventListener("fetch", (event: any) => {
    const url = event.request.url;
    const markerIdx = url.indexOf(PROXY_MARKER);
    if (markerIdx === -1) return;

    const originalUrl = decodeURIComponent(url.slice(markerIdx + PROXY_MARKER.length).split("&")[0]);
    event.respondWith(handleProxy(event.request, originalUrl));
});

const sw = self as any;

sw.addEventListener("install", () => {
    sw.skipWaiting();
});

sw.addEventListener("activate", (event: any) => {
    event.waitUntil(sw.clients.claim());
});
