import { describe, it, expect, beforeEach, vi } from "vitest";

// in-memory chrome.storage + directory handle
const store: Record<string, any> = {};
(globalThis as any).chrome = {
    storage: {
        local: {
            get: (k: any, cb: any) => {
                const keys = k === null ? Object.keys(store) : Array.isArray(k) ? k : [k];
                cb(Object.fromEntries(keys.filter((x: string) => x in store).map((x: string) => [x, structuredClone(store[x])])));
            },
            set: (o: any, cb?: any) => (Object.assign(store, structuredClone(o)), cb?.()),
            remove: (k: any, cb?: any) => ((Array.isArray(k) ? k : [k]).forEach((x: string) => delete store[x]), cb?.()),
        },
        onChanged: { addListener: () => {} },
    },
    runtime: { lastError: undefined, sendMessage: () => {} },
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const files = new Map<string, { text: string; t: number }>();
let clock = 1;
const dir = {
    name: "d",
    async *values() {
        for (const [name, f] of files) yield { kind: "file", name, getFile: async () => ({ lastModified: f.t, size: f.text.length, text: async () => f.text }) };
    },
    async getFileHandle(name: string, o?: any) {
        if (!files.has(name)) {
            if (!o?.create) throw new Error("nf");
            files.set(name, { text: "", t: clock++ });
        }
        return {
            getFile: async () => ({ lastModified: files.get(name)!.t, size: files.get(name)!.text.length, text: async () => files.get(name)!.text }),
            createWritable: async () => ({ write: async (t: string) => files.set(name, { text: t, t: clock++ }), close: async () => {} }),
        };
    },
    async removeEntry(n: string) {
        files.delete(n);
    },
};
vi.mock("../src/shared/folderSync", async (orig) => ({ ...(await orig<any>()), loadSavedHandle: async () => dir, saveHandle: async () => {}, clearSavedHandle: async () => {} }));

const put = (name: string, text: string) => files.set(name, { text, t: clock++ });
const names = async () => (await (await import("../src/background/engine/scriptStore")).listScripts()).map((s) => s.meta.name).sort();

beforeEach(async () => {
    const sync = await import("../src/background/folderSync");
    await sync.stop();
    vi.resetModules(); // a fresh module graph = a restarted service worker
    files.clear();
    for (const k of Object.keys(store)) delete store[k];
});

describe("scripts folder sync", () => {
    it("imports files added while the worker was stopped", async () => {
        put("a.ts", "// a");
        let sync = await import("../src/background/folderSync");
        await sync.startFromStoredHandle({ fresh: true });
        await sleep(1200);
        expect(await names()).toEqual(["a"]); // a fresh pick imports existing files

        sync.halt(); // the worker goes down
        put("b.ts", "// b"); // copied in while the worker is down
        vi.resetModules();
        sync = await import("../src/background/folderSync");
        await sync.startFromStoredHandle(); // resume (initFromStorage path)
        expect(await names()).toEqual(["a", "b"]);
        await sync.stop();
    });

    it("keeps any valid file name as-is; renames only names a script can't round-trip", async () => {
        const sync = await import("../src/background/folderSync");
        await sync.startFromStoredHandle({ fresh: true });
        put("my script (copy).ts", "// kept");
        put("a:b.ts", "// v1"); // legal on Linux, not on Windows
        await sleep(1500);
        expect(await names()).toEqual(["a:b", "my script (copy)"]);
        expect(files.get("my script (copy).ts")?.text).toBe("// kept");
        expect(files.has("a:b.ts")).toBe(false);
        expect(files.get("a_b.ts")?.text).toBe("// v1");

        put("a_b.ts", "// v2");
        await sleep(1500);
        const ss = await import("../src/background/engine/scriptStore");
        expect((await ss.listScripts()).find((s) => s.meta.name === "a:b")?.code).toBe("// v2");
        await sync.stop();
    });

    it("an unrelated delete in the same poll doesn't swallow a new file", async () => {
        put("notes.ts", "// not a script yet");
        const sync = await import("../src/background/folderSync");
        await sync.startFromStoredHandle({ fresh: true });
        files.delete("notes.ts");
        put("new.ts", "// new");
        await sleep(1500);
        expect(await names()).toEqual(["new"]);
        await sync.stop();
    });

    it("fresh pick: two-way initial sync, newer side wins on conflicts", async () => {
        const ss = await import("../src/background/engine/scriptStore");
        await ss.saveScript({ id: "s1", code: "// only in ext", name: "ext only" });
        await ss.saveScript({ id: "s2", code: "// ext newer", name: "ext newer" });
        await ss.saveScript({ id: "s3", code: "// ext older", name: "file newer" });
        await ss.saveScript({ id: "s4", code: "// same", name: "same" });
        const saved = Object.fromEntries((await ss.listScripts()).map((s) => [s.meta.name, s.updatedAt]));
        files.set("file only.ts", { text: "// only in folder", t: 1 });
        files.set("ext newer.ts", { text: "// file older", t: saved["ext newer"] - 1000 });
        files.set("file newer.ts", { text: "// file newer", t: saved["file newer"] + 1000 });
        files.set("same.ts", { text: "// same", t: 1 });

        const sync = await import("../src/background/folderSync");
        await sync.startFromStoredHandle({ fresh: true });

        const byName = Object.fromEntries((await ss.listScripts()).map((s) => [s.meta.name, s.code]));
        expect(byName).toEqual({
            "ext only": "// only in ext",
            "ext newer": "// ext newer",
            "file newer": "// file newer",
            same: "// same",
            "file only": "// only in folder",
        });
        expect(files.get("ext only.ts")?.text).toBe("// only in ext");
        expect(files.get("ext newer.ts")?.text).toBe("// ext newer");
        expect(files.get("file newer.ts")?.text).toBe("// file newer");

        // nothing echoes back on the next polls
        await sleep(1200);
        expect((await ss.listScripts()).length).toBe(5);
        await sync.stop();
    });

    it("reconnect imports a snapshotted file whose script is missing", async () => {
        put("kept.ts", "// kept");
        let sync = await import("../src/background/folderSync");
        await sync.startFromStoredHandle({ fresh: true });
        const ss = await import("../src/background/engine/scriptStore");
        const s = (await ss.listScripts())[0];
        sync.halt();
        await ss.deleteScript(s.id); // removed while the folder wasn't connected
        vi.resetModules();
        sync = await import("../src/background/folderSync");
        await sync.startFromStoredHandle(); // reconnect
        expect(await names()).toEqual(["kept"]);
        await sync.stop();
    });

    it("every .ts file is a script named exactly after it (no renaming)", async () => {
        put("Redirect_a_URL.ts", "// a");
        put("x.script.ts", "// b");
        put("my notes (v2).ts", "// c");
        const sync = await import("../src/background/folderSync");
        await sync.startFromStoredHandle({ fresh: true });
        expect([...files.keys()].filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts")).sort()).toEqual(["Redirect_a_URL.ts", "my notes (v2).ts", "x.script.ts"]);
        expect(await names()).toEqual(["Redirect_a_URL", "my notes (v2)", "x.script"]);
        await sync.stop();
    });
});
