import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { syncUserScripts, userScriptsStatus, onUserScriptsStatus, resetUserScripts, ISO_WORLD_CSP } from "../src/background/userScripts";
import { userScriptsProblem, USER_SCRIPTS_PROBLEM } from "../src/shared/userScriptsStatus";
import type { RouteMeta } from "../src/shared/route";

const route = (url: string, index = 0): RouteMeta => ({ kind: "onDocument", api: "onPage", index, url: [url], world: "isolated" }) as any;

/** a mocked chrome.userScripts (Chrome 133+ with per-script worlds unless `perWorld: false`) */
function mockChrome(o: { granted?: boolean; off?: "throw" | "reject" | "missing"; perWorld?: boolean } = {}) {
    const registered = new Map<string, any>();
    const worlds: any[] = [];
    const calls: string[] = [];
    const us: any = {
        getScripts: vi.fn(async () => {
            if (o.off === "reject") throw new Error("user scripts are disabled");
            return [...registered.values()].map((r) => structuredClone(r));
        }),
        register: vi.fn(async (list: any[]) => {
            calls.push(`register ${list.map((r) => r.id).join()}`);
            for (const r of list) registered.set(r.id, r);
        }),
        update: vi.fn(async (list: any[]) => {
            calls.push(`update ${list.map((r) => r.id).join()}`);
            for (const r of list) registered.set(r.id, r);
        }),
        unregister: vi.fn(async ({ ids }: { ids: string[] }) => {
            calls.push(`unregister ${ids.join()}`);
            for (const id of ids) registered.delete(id);
        }),
        configureWorld: vi.fn(async (w: any) => void worlds.push(w)),
        resetWorldConfiguration: vi.fn(async (id: string) => void calls.push(`reset ${id}`)),
    };
    if (o.perWorld !== false) us.getWorldConfigurations = vi.fn(async () => worlds);
    else delete us.resetWorldConfiguration;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: url === "chrome-extension://ext/isolated.js", status: 200, text: async () => "/*isolated runtime*/" })));
    const chromeMock: any = { runtime: { id: "ext", getURL: (p: string) => `chrome-extension://ext/${p}` }, permissions: { contains: vi.fn(async () => o.granted !== false) } };
    if (o.off === "throw")
        Object.defineProperty(chromeMock, "userScripts", {
            get() {
                throw new Error("The 'userScripts' API is only available for users in developer mode.");
            },
        });
    else if (o.off !== "missing") chromeMock.userScripts = us;
    vi.stubGlobal("chrome", chromeMock);
    return { us, registered, worlds, calls, chrome: chromeMock };
}

describe("chrome.userScripts (MV3 isolated onPage)", () => {
    beforeEach(() => {
        (globalThis as any).__MV3__ = true;
        resetUserScripts();
    });
    afterEach(() => {
        (globalThis as any).__MV3__ = false;
        vi.unstubAllGlobals();
    });

    it("without the optional permission: no-permission, nothing registered", async () => {
        const m = mockChrome({ granted: false });
        expect(await userScriptsStatus(true)).toBe("no-permission");
        await syncUserScripts([{ id: "s1", routes: [route("https://a.example/*")] }]);
        expect(m.us.register).not.toHaveBeenCalled();
        expect(m.us.configureWorld).not.toHaveBeenCalled();
    });

    it("granted but not allowed (the API throws, is missing, or refuses): off", async () => {
        mockChrome({ off: "throw" });
        expect(await userScriptsStatus(true)).toBe("off");
        mockChrome({ off: "missing" });
        expect(await userScriptsStatus(true)).toBe("off");
        const m = mockChrome({ off: "reject" });
        expect(await userScriptsStatus(true)).toBe("off");
        await syncUserScripts([{ id: "s1", routes: [route("https://a.example/*")] }]);
        expect(m.us.register).not.toHaveBeenCalled();
    });

    it("registers one USER_SCRIPT per script, in its own world with messaging and an eval CSP", async () => {
        const m = mockChrome();
        expect(await userScriptsStatus(true)).toBe("ok");
        await syncUserScripts([
            { id: "s1", routes: [route("https://a.example/*")] },
            { id: "s2", routes: [route("https://b.example/*")] },
        ]);
        expect(m.worlds).toEqual([
            { worldId: "s1", csp: ISO_WORLD_CSP, messaging: true },
            { worldId: "s2", csp: ISO_WORLD_CSP, messaging: true },
        ]);
        const r = m.registered.get("wt-iso-s1");
        expect(r).toMatchObject({ matches: ["<all_urls>"], allFrames: true, runAt: "document_start", world: "USER_SCRIPT", worldId: "s1" });
        // the prelude names the script and its routes; the code itself is fetched over L6
        expect(r.js[0].code).toContain('"s":"s1"');
        expect(r.js[0].code).toContain("https://a.example/*");
        // the runtime inlined: Chrome injects a file only once per document, whatever registrations name it
        expect(r.js).toHaveLength(1);
        expect(r.js[0].code.endsWith("\n/*isolated runtime*/")).toBe(true);
        expect(m.registered.get("wt-iso-s2").js[0].code).toContain("/*isolated runtime*/");
        expect([...m.registered.keys()]).toEqual(["wt-iso-s1", "wt-iso-s2"]);
    });

    it("before Chrome 133 (no per-script worlds): the default world is configured once, no worldId", async () => {
        const m = mockChrome({ perWorld: false });
        await syncUserScripts([
            { id: "s1", routes: [route("https://a.example/*")] },
            { id: "s2", routes: [route("https://b.example/*")] },
        ]);
        expect(m.worlds).toEqual([{ csp: ISO_WORLD_CSP, messaging: true }]);
        expect(m.registered.get("wt-iso-s1").worldId).toBeUndefined();
    });

    it("re-syncing on save: unchanged registrations stay, changed routes update, removed scripts go (and their worlds reset)", async () => {
        const m = mockChrome();
        await syncUserScripts([
            { id: "s1", routes: [route("https://a.example/*")] },
            { id: "s2", routes: [route("https://b.example/*")] },
        ]);
        m.calls.length = 0;
        // same scripts: nothing to (re)register — the code reaches open pages as iso.update
        await syncUserScripts([
            { id: "s1", routes: [route("https://a.example/*")] },
            { id: "s2", routes: [route("https://b.example/*")] },
        ]);
        expect(m.calls).toEqual([]);
        await syncUserScripts([{ id: "s1", routes: [route("https://c.example/*")] }, { id: "s3", routes: [route("https://d.example/*")] }]);
        expect(m.calls).toEqual(["unregister wt-iso-s2", "reset s2", "update wt-iso-s1", "register wt-iso-s3"]);
        expect(m.registered.get("wt-iso-s1").js[0].code).toContain("https://c.example/*");
        // other extensions' ids (or a user's) are never touched
        m.registered.set("other", { id: "other", js: [] });
        await syncUserScripts([]);
        expect([...m.registered.keys()]).toEqual(["other"]);
    });

    it("a status change (the user allowed user scripts) notifies listeners; sync without arguments retries the last list", async () => {
        const m = mockChrome({ granted: false });
        const seen: string[] = [];
        onUserScriptsStatus((s) => seen.push(s));
        await syncUserScripts([{ id: "s1", routes: [route("https://a.example/*")] }]);
        expect(m.registered.size).toBe(0);
        m.chrome.permissions.contains = vi.fn(async () => true);
        expect(await userScriptsStatus(true)).toBe("ok");
        expect(seen).toEqual(["ok"]);
        await syncUserScripts();
        expect([...m.registered.keys()]).toEqual(["wt-iso-s1"]);
    });

    it("the Problems text says how to turn them on", () => {
        const p = userScriptsProblem("onPage #1", "no-permission", "abc");
        expect(p).toContain(USER_SCRIPTS_PROBLEM);
        expect(p).toContain("chrome://extensions/?id=abc");
        expect(p).toMatch(/Editor's banner/);
        expect(userScriptsProblem("onPage #1", "off", "abc")).not.toMatch(/banner/);
    });
});
