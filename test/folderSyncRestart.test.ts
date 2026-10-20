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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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
        expect(await names()).toEqual([]); // a fresh pick snapshots existing files

        put("b.ts", "// b"); // copied in while the worker is down
        vi.resetModules();
        sync = await import("../src/background/folderSync");
        await sync.startFromStoredHandle(); // resume (initFromStorage path)
        expect(await names()).toEqual(["b"]);
        await sync.stop();
    });

    it("renames a non-canonical copied file so later edits still apply", async () => {
        const sync = await import("../src/background/folderSync");
        await sync.startFromStoredHandle({ fresh: true });
        put("my script (copy).ts", "// v1");
        await sleep(1500);
        expect(await names()).toEqual(["my script (copy)"]);
        expect(files.has("my script (copy).ts")).toBe(false);
        expect(files.get("my_script_copy_.ts")?.text).toBe("// v1");

        put("my_script_copy_.ts", "// v2");
        await sleep(1500);
        const ss = await import("../src/background/engine/scriptStore");
        expect((await ss.listScripts())[0].code).toBe("// v2");
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
});
