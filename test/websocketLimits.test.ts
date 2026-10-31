import { describe, expect, it } from "vitest";
import { targetsWebSocket, wsNotApplied, wsRouteProblem, wsUnseen } from "../src/shared/websocketLimits";
import { routeProblem } from "../src/shared/missedTap";

describe("WebSocket limits", () => {
    it("says why a redirect/replacement can't apply, per strategy", () => {
        expect(wsNotApplied("redirect", "extension", "wss://a/ws", "wss://b/ws")).toMatch(/^redirect wss:\/\/a\/ws → wss:\/\/b\/ws NOT applied: it's a WebSocket, and Chrome ignores redirects on WebSocket handshakes, so the socket still connects to wss:\/\/a\/ws\. On a WebSocket only block and request-header changes work/);
        expect(wsNotApplied("redirect", "helper", "https://a/ws", "wss://b/ws")).toContain("browsers don't follow redirects on a WebSocket handshake");
        expect(wsNotApplied("replaceResponse", "rules", "wss://a/ws")).toContain("Chrome serves a replacement by redirecting");
    });

    it("tells WebSocket-aimed routes from catch-alls", () => {
        expect(targetsWebSocket({ url: ["wss://a/*"] })).toBe(true);
        expect(targetsWebSocket({ url: ["*://a/*"], resourceTypes: ["websocket"] })).toBe(true);
        expect(targetsWebSocket({ url: ["*://a/*"] })).toBe(false);
        expect(wsUnseen("S", "onRequest #1", "debugger", "wss://a/ws")).toContain(`the "debugger" strategy never sees WebSocket handshakes`);
    });

    it("flags body routes limited to WebSockets in Problems", () => {
        expect(wsRouteProblem({ kind: "replaceResponse", resourceTypes: ["websocket"] })).toContain("never runs on a WebSocket");
        expect(wsRouteProblem({ kind: "onResponseBody", resourceTypes: ["websocket", "script"] })).toBeNull();
        expect(wsRouteProblem({ kind: "onRequest", resourceTypes: ["websocket"] })).toBeNull();
        expect(routeProblem({ kind: "onResponseBody", strategy: "debugger", resourceTypes: ["websocket"] }, { firefox: false, mv3: true })).toContain("never runs on a WebSocket");
    });
});
