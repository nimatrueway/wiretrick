/**
 * What a script can't do to a WebSocket handshake, and the warnings that
 * say so. Chrome's webRequest (and declarativeNetRequest, which it runs)
 * collects a WebSocket's redirect URL and never uses it
 * (web_request_proxying_websocket.cc), and no browser follows a redirect on
 * a WebSocket handshake. So neither a redirect nor a replaced response
 * (served by redirecting on Chromium) can apply; block and request headers
 * do. The debugger's Fetch domain and the page hook never see the handshake.
 */
import type { RouteMeta, Strategy } from "./route";

const WORKS = `On a WebSocket only block and request-header changes work — to point it elsewhere, change the URL the page opens it with (e.g. rewrite the code that calls new WebSocket() with onResponseBody)`;

/** a redirect or replaceResponse a handler returned for a WebSocket that wasn't (or, with rules, can't be) applied */
export function wsNotApplied(what: "redirect" | "replaceResponse", strategy: Strategy, url: string, to?: string): string {
    const did = what === "redirect" ? `redirect ${url} → ${to}` : `replaceResponse ${url}`;
    let why: string;
    if (strategy === "helper") why = what === "redirect" ? "browsers don't follow redirects on a WebSocket handshake (the connection would just fail), so it went through unchanged" : "a WebSocket handshake can't be answered with a body (the connection would just fail), so it went through unchanged";
    else why = what === "redirect" ? `Chrome ignores redirects on WebSocket handshakes, so the socket still connects to ${url}` : "Chrome serves a replacement by redirecting, and ignores redirects on WebSocket handshakes";
    return `${did} NOT applied: it's a WebSocket, and ${why}. ${WORKS}.`;
}

/** strategies whose handlers never run on a WebSocket handshake */
export const WS_BLIND: ReadonlySet<Strategy> = new Set(["debugger", "page"]);

/** a route aimed at WebSockets on purpose (resourceTypes or a ws:/wss: URL), not a catch-all that happens to match one */
export function targetsWebSocket(r: Pick<RouteMeta, "url" | "resourceTypes">): boolean {
    return !!r.resourceTypes?.includes("websocket") || r.url.some((u) => /^wss?:/i.test(u));
}

/** a WebSocket-aimed debugger/page route that matched a handshake it can't see */
export function wsUnseen(scriptName: string, label: string, strategy: Strategy, url: string): string {
    return `[${scriptName}] ${label} didn't run for WebSocket ${url}: the "${strategy}" strategy never sees WebSocket handshakes. Use the "rules", "extension" or "helper" strategy on the route to block it or change its request headers (no strategy can redirect a WebSocket).`;
}

/** replaceResponse / onResponseBody limited to WebSockets: there's never a body (Problems view) */
export function wsRouteProblem(r: Pick<RouteMeta, "kind" | "resourceTypes">): string | null {
    if (r.kind !== "replaceResponse" && r.kind !== "onResponseBody") return null;
    if (!r.resourceTypes?.length || !r.resourceTypes.every((t) => t === "websocket")) return null;
    return `${r.kind} never runs on a WebSocket — its handshake has no body to read or replace, and the messages after it aren't HTTP. ${WORKS}`;
}
