import { describe, it, expect, beforeEach } from "vitest";

const store: Record<string, any> = {};
(globalThis as any).chrome = {
    storage: {
        local: {
            get: (k: any, cb: any) => {
                const keys = k === null ? Object.keys(store) : Array.isArray(k) ? k : typeof k === "string" ? [k] : Object.keys(k);
                const out = Object.fromEntries(keys.filter((x: string) => x in store).map((x: string) => [x, structuredClone(store[x])]));
                return cb ? cb(out) : Promise.resolve(out);
            },
            set: (o: any, cb?: any) => (Object.assign(store, structuredClone(o)), cb ? cb() : Promise.resolve()),
            remove: (k: any, cb?: any) => {
                for (const x of Array.isArray(k) ? k : [k]) delete store[x];
                return cb ? cb() : Promise.resolve();
            },
        },
        onChanged: { addListener: () => {} },
    },
    runtime: { lastError: undefined, sendMessage: () => {} },
};

await import("../src/shared/transpile");
const ss = await import("../src/background/engine/scriptStore");
const pk = await import("../src/background/engine/packages");
const { filesHash } = await import("../src/shared/packageSource");
const { entryIds } = await import("../src/shared/packageModel");

const SRC = "https://example.com/dark.wiretrick.ts";
const entry = (url: string, extra = "") => `import { tint } from "./lib";\nimport cfg from "./cfg.json";\nwt.metadata({ name: "Dark", version: "1.0.0" });\n${extra}wt.onRequest({ url: "${url}", strategy: "page" }, async (req) => { tint(cfg.n); return req; });\n`;
const files = (e: string, lib = "export const tint = (n: number) => n;\n") => ({ "dark.wiretrick.ts": e, "lib.ts": lib, "cfg.json": '{"n": 1}' });
const fetched = async (f: Record<string, string>, source = SRC) => ({ source, entries: ["dark.wiretrick.ts"], files: f, revision: await filesHash(f) });

beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
});

describe("installed packages", () => {
    it("installs a package into its folder, then applies a same-powers update by itself", async () => {
        const v1 = await fetched(files(entry("*://a.com/*")));
        const a = await pk.analyzePackage(v1);
        expect(a.error).toBeNull();
        expect(a.folder).toBe("dark");
        expect(a.caps.urls).toEqual(["*://a.com/*"]);

        const pkg = await pk.installPackage(v1, { enabled: true, autoUpdate: true });
        const scripts = await ss.listScripts();
        expect(scripts.map((s) => s.meta.name).sort()).toEqual(["dark/dark.wiretrick", "dark/lib"]);
        expect((await ss.listDataFiles()).map((d) => d.path)).toEqual(["dark/cfg.json"]);

        const v2 = await fetched(files(entry("*://a.com/*").replace("1.0.0", "1.1.0"), "export const tint = (n: number) => n * 2;\n"));
        const after = await pk.offerPackage(pkg.id, v2, false);
        expect(after!.pending).toBeUndefined();
        expect(after!.metadata.version).toBe("1.1.0");
        expect(after!.previous?.metadata.version).toBe("1.0.0");
        expect((await ss.listScripts()).find((s) => s.meta.name === "dark/lib")!.code).toContain("n * 2");
        // same ids: the entry kept its store id
        expect(entryIds(after!)).toEqual(entryIds(pkg));

        const back = await pk.rollbackPackage(pkg.id);
        expect(back.metadata.version).toBe("1.0.0");
        expect(back.autoUpdate).toBe(false);
        expect((await ss.listScripts()).find((s) => s.meta.name === "dark/lib")!.code).not.toContain("n * 2");
    });

    it("holds an update that can do more, and one over local edits", async () => {
        const pkg = await pk.installPackage(await fetched(files(entry("*://a.com/*"))), { enabled: true, autoUpdate: true });
        const wider = await fetched(files(entry("<all_urls>")));
        const held = await pk.offerPackage(pkg.id, wider, false);
        expect(held!.pending?.added).toEqual(["runs on <all_urls>"]);
        expect(held!.revision).toBe(pkg.revision);

        // skipping it: the next automatic check doesn't offer it again
        await pk.dismissPending(pkg.id);
        const again = await pk.offerPackage(pkg.id, wider, false);
        expect(again!.pending).toBeUndefined();
        expect(again!.skipped).toBe(wider.revision);
        // asking for it does
        const asked = await pk.offerPackage(pkg.id, wider, true);
        expect(asked!.pending?.revision).toBe(wider.revision);
        const applied = await pk.applyPending(pkg.id);
        expect(applied.caps.urls).toEqual(["<all_urls>"]);

        // an edit here holds the next update
        const lib = (await ss.listScripts()).find((s) => s.meta.name === "dark/lib")!;
        await ss.saveScript({ id: lib.id, code: lib.code + "// mine\n" });
        const v3 = await fetched(files(entry("<all_urls>"), "export const tint = (n: number) => n + 1;\n"));
        const held2 = await pk.offerPackage(pkg.id, v3, false);
        expect(held2!.pending?.reasons.join()).toContain("changed here since installed: lib.ts");
    });

    it("refuses an update that doesn't compile and keeps a single file at the root", async () => {
        const single = { "solo.wiretrick.ts": 'wt.onRequest({ url: "*://a.com/*", strategy: "page" }, async (r) => r);\n' };
        const f = { source: "https://example.com/solo.wiretrick.ts", entries: ["solo.wiretrick.ts"], files: single, revision: await filesHash(single) };
        const pkg = await pk.installPackage(f, { enabled: false, autoUpdate: true });
        expect(pkg.folder).toBe("");
        const s = (await ss.listScripts()).find((x) => x.id === entryIds(pkg)[0])!;
        expect(s.meta.name).toBe("solo.wiretrick");
        expect(s.enabled).toBe(false);
        // a second install of the same name stays an entry
        const pkg2 = await pk.installPackage(f, { enabled: true, autoUpdate: true });
        expect((await ss.listScripts()).find((x) => x.id === entryIds(pkg2)[0])!.meta.name).toBe("solo (2).wiretrick");

        const broken = { "solo.wiretrick.ts": "wt.onRequest({ url: \"*://a.com/*\", strategy: \"page\" }, async (r) => r;\n" };
        const out = await pk.offerPackage(pkg.id, { ...f, files: broken, revision: await filesHash(broken) }, false);
        expect(out!.lastError).toMatch(/doesn't compile/);
        expect(out!.revision).toBe(pkg.revision);
    });

    it("installs a bundle: its scripts together, metadata from metadata.json", async () => {
        const run = (u: string) => `import { k } from "./shared";\nwt.onRequest({ url: "${u}", strategy: "page" }, async (r) => (k, r));\n`;
        const b = {
            "metadata.json": JSON.stringify({ name: "Kit", version: "2.0.0", connect: ["api.x.com"], scripts: ["a.ts", "tools/b.ts"] }),
            "a.ts": run("*://a.com/*"),
            "tools/b.ts": run("*://b.com/*").replace("./shared", "../shared"),
            "shared.ts": "export const k = 1;\n",
        };
        const f = { source: "https://example.com/kit/metadata.json", entries: ["a.ts", "tools/b.ts"], files: b, revision: await filesHash(b) };
        const a = await pk.analyzePackage(f);
        expect(a.error).toBeNull();
        expect(a.bundle).toBe(true);
        expect(a.name).toBe("Kit");
        expect(a.folder).toBe("Kit");
        expect(a.caps.urls).toEqual(["*://a.com/*", "*://b.com/*"]);
        expect(a.caps.connect).toEqual(["api.x.com"]);
        const pkg = await pk.installPackage(f, { enabled: true, autoUpdate: true });
        expect(pkg.metadata.version).toBe("2.0.0");
        expect(entryIds(pkg)).toHaveLength(2);
        const names = (await ss.listScripts()).map((s) => s.meta.name).sort();
        expect(names).toEqual(["Kit/a", "Kit/shared", "Kit/tools/b"]);
        expect((await ss.listScripts()).filter((s) => s.meta.active).map((s) => s.meta.name).sort()).toEqual(["Kit/a", "Kit/tools/b"]);
        expect((await ss.listDataFiles()).map((d) => d.path)).toEqual(["Kit/metadata.json"]);
    });

    it("updates from metadata's updateURL, even installed from local files", async () => {
        const U = "https://example.com/u/dark.wiretrick.ts";
        const withUrl = (url: string, ver = "1.0.0") => entry("*://a.com/*").replace('version: "1.0.0"', `version: "${ver}", updateURL: "${url}"`);
        let remote: Record<string, string> = {};
        const serve = (f: Record<string, string>) => (remote = Object.fromEntries(Object.entries(f).map(([k, v]) => [`https://example.com/u/${k}`, v])));
        (globalThis as any).fetch = async (url: string) => (url in remote ? { ok: true, status: 200, text: async () => remote[url] } : { ok: false, status: 404 });

        const v1 = files(withUrl(U));
        const pkg = await pk.installPackage(await fetched(v1, ""), { enabled: true, autoUpdate: true });
        expect(pkg).toMatchObject({ source: "", autoUpdate: true, metadata: { updateURL: U } });

        // the same files: only the revision moves
        serve(v1);
        const same = (await pk.checkPackages())[pkg.id];
        expect(same.pending).toBeUndefined();
        expect(same.lastError).toBeUndefined();
        expect(same.updatedAt).toBe(pkg.updatedAt);

        serve(files(withUrl(U, "1.1.0"), "export const tint = (n: number) => n * 3;\n"));
        const after = (await pk.checkPackages())[pkg.id];
        expect(after).toMatchObject({ source: "", metadata: { version: "1.1.0" } });
        expect((await ss.listScripts()).find((s) => s.meta.name === "dark/lib")!.code).toContain("n * 3");

        // moving the updates elsewhere waits for review
        serve(files(withUrl("https://github.com/me/s/tree/main/dark", "1.2.0")));
        const moved = (await pk.checkPackages())[pkg.id];
        expect(moved.pending?.reasons).toEqual(["it updates from somewhere else: https://github.com/me/s/tree/main/dark"]);
        expect(moved.metadata.version).toBe("1.1.0");
    });

    it("forgets a package whose entry is deleted", async () => {
        const pkg = await pk.installPackage(await fetched(files(entry("*://a.com/*"))), { enabled: true, autoUpdate: true });
        await pk.forgetPackage(pkg.id);
        expect(await pk.listPackages()).toEqual({});
        expect((await ss.listScripts()).length).toBe(2);
    });
});
