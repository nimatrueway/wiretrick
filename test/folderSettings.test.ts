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

describe("settings.yaml folder sync", () => {
    it("exports on param change, applies external edits, inserts new scripts, never rewrites a stable file", async () => {
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
        expect(files.get("settings.yaml")!.text).toContain("# n: 1");
        expect(files.get("settings.yaml")!.text.startsWith("# yaml-language-server: $schema=./settings.schema.json\n")).toBe(true);

        // the JSON schema for the modeline is written next to the settings file
        const schema = files.get("settings.schema.json");
        expect(schema).toBeTruthy();
        expect(JSON.parse(schema!.text).properties.settings.properties.logLevel.enum).toEqual(["debug", "info", "warn", "error"]);

        // GUI-side change → only that entry is patched in
        await ss.setParamValue(id, "n", 7);
        await sleep(800);
        expect(files.get("settings.yaml")!.text).toContain("\n    n: 7");

        // external edit: the WHOLE file applies to storage
        const hand = '# mine\nsettings:\n  logLevel:   "warn"  # quiet\n\n\nparams:\n  S.ts:\n    n: 9 # nine\n# bye\n';
        files.set("settings.yaml", { text: hand, t: clock++ });
        await sleep(1500);
        expect((await ss.getParamValues(id)).n).toBe(9);
        expect(store.resLogLevel).toBe("warn");
        expect(files.get("settings.yaml")!.text).toBe(hand); // hand formatting kept byte-for-byte
        const stable = files.get("settings.yaml")!;
        await sleep(1500);
        expect(files.get("settings.yaml")).toBe(stable); // no rewrite when unchanged

        // popup-side change patches one value only
        await ss.setParamValue(id, "n", 5);
        await sleep(800);
        expect(files.get("settings.yaml")!.text).toBe(hand.replace("n: 9 # nine", "n: 5 # nine"));

        // script-def change: a newly saved script's entries are inserted,
        // the rest of the file preserved
        await ss.saveScript({
            id: ss.newId(),
            name: "New",
            code: `tt.params({ x: { type: "string", default: "a" } });`,
        });
        await sleep(800);
        const withNew = files.get("settings.yaml")!.text;
        expect(withNew).toContain("\n  New.ts:\n");
        expect(withNew).toContain("    # x: a");
        expect(withNew).toContain('logLevel:   "warn"  # quiet'); // untouched
        expect(withNew).toContain("n: 5 # nine"); // untouched
        expect(withNew).toContain("# bye"); // untouched

        // malformed yaml → error logged, state untouched
        files.set("settings.yaml", { text: "settings: [unclosed\n", t: clock++ });
        await sleep(1500);
        expect((await ss.getParamValues(id)).n).toBe(5);
        expect(store.resLogLevel).toBe("warn");
        await sync.stop();
    }, 20000);

    it("a settings.yaml save in the manager is written to the folder as-is", async () => {
        const sync = await import("../src/background/folderSync");
        const ss = await import("../src/background/engine/scriptStore");
        const { applySettingsText } = await import("../src/background/settingsFile");
        const id = ss.newId();
        await ss.saveScript({ id, name: "S", code: `tt.params({ n: { type: "number", default: 1 } });` });
        await sync.startFromStoredHandle();
        await sleep(600);
        // log level only (storage.onChanged is not wired here) + a new comment
        const edited = "# from the manager\nsettings:\n  logLevel: error\nparams:\n  S.ts:\n    n: 3\n";
        expect((await applySettingsText(edited)).error).toBeUndefined();
        await sync.exportSettingsFrom(edited);
        expect(files.get("settings.yaml")!.text).toBe(edited);
        await sleep(1500); // the poll must not bounce it back
        expect(files.get("settings.yaml")!.text).toBe(edited);
        expect((await ss.getParamValues(id)).n).toBe(3);
        await sync.stop();
    }, 20000);

    it("reflects tt.params changes: added param documented, removed param commented out", async () => {
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
        expect(files.get("settings.yaml")!.text).toContain("# n: 1");

        // a param added to tt.params appears in the file even at its default
        await ss.saveScript({
            id,
            name: "S",
            code: `tt.metadata({ description: "Extra knob" }); tt.params({ n: { type: "number", default: 1 }, extra: { type: "string", default: "x", description: "Extra knob" } });`,
        });
        await sleep(800);
        let text = files.get("settings.yaml")!.text;
        expect(text).toContain("# Extra knob");
        expect(text).toContain("# extra: x");

        // a param removed from tt.params gets its live entry commented out + marked
        await ss.setParamValue(id, "n", 7);
        await sleep(800);
        expect(files.get("settings.yaml")!.text).toContain("\n    n: 7\n");
        await ss.saveScript({
            id,
            name: "S",
            code: `tt.metadata({ description: "Extra knob" }); tt.params({ extra: { type: "string", default: "x", description: "Extra knob" } });`,
        });
        await sleep(800);
        text = files.get("settings.yaml")!.text;
        expect(text).toContain("# no longer declared in the script");
        expect(text).toContain("# n: 7");
        expect(text).not.toContain("\n    n: 7\n"); // no longer live
        // …and the value no longer maps to anything, but storage is untouched
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
