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

beforeEach(() => {
    files.clear();
    for (const k of Object.keys(store)) delete store[k];
});

describe("settings.json folder sync", () => {
    it("exports sparse overrides, applies external edits, resets omitted entries, and never rewrites a stable file", async () => {
        const sync = await import("../src/background/folderSync");
        const ss = await import("../src/background/engine/scriptStore");
        const id = ss.newId();
        await ss.saveScript({
            id,
            name: "S",
            code: `tt.params({ n: { type: "number", default: 1 } });`,
        });
        await sync.startFromStoredHandle();
        await sleep(600);
        // everything at default -> {}
        expect(files.get("settings.json")!.text).toBe("{}\n");

        const schema = files.get("settings.schema.json");
        expect(schema).toBeTruthy();
        expect(JSON.parse(schema!.text).properties.logLevel.enum).toEqual(["debug", "info", "warn", "error"]);

        // GUI-side change → non-default value written
        await ss.setParamValue(id, "n", 7);
        await sleep(800);
        expect(JSON.parse(files.get("settings.json")!.text)).toEqual({ scripts: { "S.ts": { n: 7 } } });

        // external edit: the whole file applies to storage
        const hand = JSON.stringify({ logLevel: "warn", scripts: { "S.ts": { n: 9 } } }, null, 2) + "\n";
        files.set("settings.json", { text: hand, t: clock++ });
        await sleep(1500);
        expect((await ss.getParamValues(id)).n).toBe(9);
        expect(store.resLogLevel).toBe("warn");
        const stable = files.get("settings.json")!;
        await sleep(1500);
        expect(files.get("settings.json")).toBe(stable); // no rewrite when unchanged

        // popup-side change updates the JSON cleanly
        await ss.setParamValue(id, "n", 5);
        await sleep(800);
        expect(JSON.parse(files.get("settings.json")!.text)).toEqual({ logLevel: "warn", scripts: { "S.ts": { n: 5 } } });

        // malformed JSON → error logged, neither storage nor the broken disk file overwritten
        files.set("settings.json", { text: "{ broken\n", t: clock++ });
        await sleep(1500);
        expect((await ss.getParamValues(id)).n).toBe(5);
        expect(store.resLogLevel).toBe("warn");
        await sync.stop();
    }, 20000);

    it("a settings.json save in the Editor is written out to the synced folder without echo", async () => {
        const sync = await import("../src/background/folderSync");
        const ss = await import("../src/background/engine/scriptStore");
        const { applySettingsText } = await import("../src/background/settingsFile");
        const id = ss.newId();
        await ss.saveScript({ id, name: "S", code: `tt.params({ n: { type: "number", default: 1 } });` });
        await sync.startFromStoredHandle();
        await sleep(600);
        const edited = JSON.stringify({ logLevel: "error", scripts: { "S.ts": { n: 3 } } }, null, 2) + "\n";
        expect((await applySettingsText(edited)).error).toBeUndefined();
        await sync.exportSettingsFrom();
        expect(files.get("settings.json")!.text).toBe(edited);
        const stamp = files.get("settings.json")!.t;
        await sleep(1500); // the poll must not bounce it back
        expect(files.get("settings.json")!.t).toBe(stamp);
        expect((await ss.getParamValues(id)).n).toBe(3);
        await sync.stop();
    }, 20000);

    it("omits removed tt.params keys from settings.json while keeping schema updated", async () => {
        const sync = await import("../src/background/folderSync");
        const ss = await import("../src/background/engine/scriptStore");
        const id = ss.newId();
        await ss.saveScript({
            id,
            name: "S",
            code: `tt.params({ n: { type: "number", default: 1 } });`,
        });
        await sync.startFromStoredHandle();
        await sleep(600);
        expect(files.get("settings.json")!.text).toBe("{}\n");

        await ss.setParamValue(id, "n", 7);
        await sleep(800);
        expect(JSON.parse(files.get("settings.json")!.text)).toEqual({ scripts: { "S.ts": { n: 7 } } });

        await ss.saveScript({
            id,
            name: "S",
            code: `tt.metadata({ description: "Extra knob" }); tt.params({ extra: { type: "string", default: "x", description: "Extra knob" } });`,
        });
        await sleep(800);
        expect(files.get("settings.json")!.text).toBe("{}\n");
        expect(JSON.parse(files.get("settings.schema.json")!.text).properties.scripts.properties["S.ts"].properties.extra).toMatchObject({ type: "string", default: "x" });
        expect((await ss.getParamValues(id)).n).toBe(7);
        await sync.stop();
    }, 15000);

    it("syncs root stores.json two-way with StoreOwner, removes deleted store entries, and leaves a broken stores.json untouched", async () => {
        const sync = await import("../src/background/folderSync");
        const ss = await import("../src/background/engine/scriptStore");
        const { storeOwner } = await import("../src/background/engine/stores");
        const id = ss.newId();
        const tsId = ss.newId();
        await ss.saveScript({ id, name: "bonsai/index.tsx", code: "// ok" });
        await ss.saveScript({ id: tsId, name: "mock/users", code: "// ok" });
        storeOwner.forget(id);
        storeOwner.forget(tsId);

        await sync.startFromStoredHandle({ fresh: true });
        await sleep(300);
        // No persisted globalStore yet -> no empty stores.json noise on disk
        expect(files.has("stores.json")).toBe(false);

        // Runtime / StoreOwner write -> writes stores.json with .ts and .tsx extensions
        await storeOwner.replace(id, "flags", { beta: true, hits: 3 });
        await storeOwner.replace(tsId, "cache", { count: 2 });
        await sync.flush();
        expect(JSON.parse(files.get("stores.json")!.text)).toEqual({
            "bonsai/index.tsx": { flags: { beta: true, hits: 3 } },
            "mock/users.ts": { cache: { count: 2 } },
        });

        // External edit on disk -> updates StoreOwner live
        files.set(
            "stores.json",
            {
                text: JSON.stringify({ "bonsai/index.tsx": { flags: { beta: false, hits: 10 }, extra: { on: true } }, "mock/users.ts": { cache: { count: 9 } } }, null, 2) + "\n",
                t: clock++,
            }
        );
        await sync.flush();
        expect(storeOwner.get(id, "flags")?.data).toEqual({ beta: false, hits: 10 });
        expect(storeOwner.get(id, "extra")?.data).toEqual({ on: true });
        expect(storeOwner.get(tsId, "cache")?.data).toEqual({ count: 9 });

        // Removing store entries on disk -> deletes them from StoreOwner
        files.set(
            "stores.json",
            {
                text: JSON.stringify({ "bonsai/index.tsx": { flags: { beta: false, hits: 10 } } }, null, 2) + "\n",
                t: clock++,
            }
        );
        await sync.flush();
        expect(storeOwner.get(id, "extra")).toBeUndefined();
        expect(storeOwner.get(tsId, "cache")).toBeUndefined();

        // Broken JSON on disk is not overwritten by runtime mutations
        files.set("stores.json", { text: "{ broken json", t: clock++ });
        await sync.flush();
        await storeOwner.replace(id, "flags", { beta: true, hits: 99 });
        await sync.flush();
        expect(files.get("stores.json")!.text).toBe("{ broken json");
        await sync.stop();
    }, 15000);
});
