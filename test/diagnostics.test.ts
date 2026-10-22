import { describe, it, expect, vi, beforeEach } from "vitest";

const store: Record<string, any> = {};
beforeEach(() => {
    (globalThis as any).__MV3__ = false;
    (globalThis as any).chrome = {
        runtime: { id: "testid", getManifest: () => ({ name: "Wiretrick", version: "9.9.9", manifest_version: 2 }), getPlatformInfo: (cb: any) => cb({ os: "linux", arch: "x86-64" }), getURL: (p: string) => `chrome-extension://testid/${p}`, connectNative: () => {} },
        storage: { local: { get: async (keys: any) => { const o: any = {}; for (const k of [keys].flat()) if (k in store) o[k] = store[k]; return o; }, set: async (o: any) => Object.assign(store, o) } },
        tabs: { query: (_q: any, cb: any) => cb([{ id: 1, url: "https://example.com/", title: "Ex" }]) },
        webRequest: { onBeforeRequest: {} },
    };
});

describe("diagnostic report", () => {
    it("redacts credential headers and caps bodies", async () => {
        const { redactEntry } = await import("../src/background/diagnostics");
        const e = redactEntry({
            id: "1", tabId: 1, url: "https://x/", method: "GET", type: "script", status: 200, statusText: "", mime: "", size: null, fromCache: false, startedAt: 0, endedAt: 1, state: "done", interventions: [],
            requestHeaders: [["Cookie", "sid=secret"], ["Accept", "*/*"], ["Authorization", "Bearer abc"]],
            responseBody: { text: "x".repeat(10000), size: 10000, truncated: false, binary: false },
        });
        expect(JSON.stringify(e)).not.toContain("secret");
        expect(JSON.stringify(e)).not.toContain("Bearer abc");
        expect(e.requestHeaders![1]).toEqual(["Accept", "*/*"]);
        expect(e.responseBody!.text.length).toBeLessThan(5000);
        expect(e.responseBody!.truncated).toBe(true);
    });

    it("renders every section, including logs and scripts", async () => {
        vi.resetModules();
        const scriptStore = await import("../src/background/engine/scriptStore");
        vi.spyOn(scriptStore, "listScripts").mockResolvedValue([
            { id: "s1", code: "", enabled: true, createdAt: 0, updatedAt: 0, error: null, meta: { name: "redwood", match: ["*://a/*"], strategy: "webrequest,hook", declared: true } } as any,
        ]);
        vi.spyOn(scriptStore, "loadAllParamValues").mockResolvedValue({ s1: { port: "8081" } });
        const settings = await import("../src/background/settingsFile");
        vi.spyOn(settings, "getSettingsText").mockResolvedValue("settings:\n  logLevel: debug\n");
        const { log } = await import("../src/background/engine/logs");
        log(3, "[webRequest] request FAILED net::ERR_BLOCKED_BY_CLIENT script https://a/x.js", "warn");
        const { collectDiagnostics } = await import("../src/background/diagnostics");
        const md = await collectDiagnostics({ extensions: [{ name: "uBlock", id: "u", version: "1", enabled: true }], state: { process: { state: "idle" } } });
        for (const h of ["## Environment", "## Other installed extensions", "## Engine state", "## settings.yaml", "## Scripts (1)", "### redwood.ts — enabled", "## LOG", "## Debug log", "## Network"]) expect(md).toContain(h);
        expect(md).toContain("ERR_BLOCKED_BY_CLIENT");
        expect(md).toContain("uBlock");
        expect(md).toContain('"port": "8081"');
        expect(md).toContain("recording is OFF");
        expect(md).toContain('"os": "linux"');
    });
});
