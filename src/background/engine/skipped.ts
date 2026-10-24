/**
 * "→ skipped:" warnings — a handler that matched a request but didn't run
 * because a final result (block, redirect, replacement) took priority.
 * The rules live in shared/precedence.ts; this keeps the enabled routes
 * (refreshed by pipeline.reload) and logs throttled WARN lines that the
 * Network view shows as "missed" (`is:missed`).
 */
import { effectiveStrategy } from "../../shared/route";
import { skippedBy, skippedLine, type RouteRef, type SkipRequest, type Winner } from "../../shared/precedence";
import { makeMissedThrottle } from "../../shared/missedTap";
import { log } from "./logs";
import type { Script } from "./scriptStore";

let routes: RouteRef[] = [];
const throttle = makeMissedThrottle();

/** enabled scripts' routes, in list order */
export function setSkipRoutes(scripts: Script[]): void {
    const next: RouteRef[] = [];
    scripts.forEach((s, order) => {
        if (!s.enabled || !s.meta.active) return;
        for (const route of s.meta.routes || []) {
            if (route.kind !== "onDocument") next.push({ scriptId: s.id, scriptName: s.meta.name, order, route, strategy: effectiveStrategy(route) });
        }
    });
    routes = next;
}

/** warn for every handler `w` kept from running on this request */
export function reportSkipped(tabId: number, req: SkipRequest, w: Winner | null | undefined): void {
    if (!w || !routes.length) return;
    for (const r of skippedBy(routes, req, w)) {
        const key = `${r.scriptId}|${r.route.kind}|${r.route.index}|${w.scriptId}|${w.kind}|${w.index}|${req.url}`;
        if (throttle(key)) log(tabId, skippedLine(r, w, req.url), "warn", r.scriptId, "missed", req.url);
    }
}

/** test seam */
export function __skipRoutes(): RouteRef[] {
    return routes;
}
