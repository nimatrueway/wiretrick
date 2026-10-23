import { describe, it, expect, beforeEach, vi } from "vitest";

// A change received from the folder must not be echoed back to it (and the
// Editor's sync button must not show "sending" for it) — only real local
// changes write to the folder.

const store: Record<string, any> = {};
const storageListeners: ((c: Record<string, any>) => void)[] = [];
(globalThis as any).chrome = {
    storage: {
        local: {
            get: (k: any, cb: any) => {
                const keys = k === null ? Object.keys(store) : Array.isArray(k) ? k : [k];
                cb(Object.fromEntries(keys.filter((x: string) => x in store).map((x: string) => [x, structuredClone(store[x])])));
            },
            set: (o: any, cb?: any) => {
                const changes: Record<string, any> = {};
                for (const [k, v] of Object.entries(o)) changes[k] = { oldValue: store[k], newValue: v };
                Object.assign(store, structuredClone(o));
                cb?.();
                for (const l of storageListeners) l(changes);
            },
            remove: (k: any, cb?: any) => ((Array.isArray(k) ? k : [k]).forEach((x: string) => delete store[x]), cb?.()),
        },
        onChanged: { addListener: (fn: any) => storageListeners.push(fn) },
    },
    runtime: { lastError: undefined, sendMessage: () => {} },
};

type F = Map<string, { text: string; t: number }>;
const files: F = new Map();
/** every write/delete the extension makes in the folder */
const ops: string[] = [];
let clock = 1;
function fakeDir(m: F, name: string, prefix = ""): any {
    return {
        name,
        async *values() {
            for (const [n, f] of m) yield { kind: "file", name: n, getFile: async () => ({ lastModified: f.t, size: f.text.length, text: async () => f.text }) };
        },
        async getFileHandle(n: string, o?: any) {
            if (!m.has(n)) {
                if (!o?.create) throw Object.assign(new Error("nf"), { name: "NotFoundError" });
                m.set(n, { text: "", t: clock++ });
            }
            return {
                getFile: async () => ({ lastModified: m.get(n)!.t, size: m.get(n)!.text.length, text: async () => m.get(n)!.text }),
                createWritable: async () => ({
                    write: async (t: string) => {
                        ops.push(`write ${prefix}${n}`);
                        m.set(n, { text: t, t: clock++ });
                    },
                    close: async () => {},
                }),
            };
        },
        async getDirectoryHandle(n: string) {
            if (n !== ".wiretrick-backup") throw new Error("nf");
            return fakeDir(new Map(), n, n + "/");
        },
        async removeEntry(n: string) {
            ops.push(`delete ${prefix}${n}`);
            m.delete(n);
        },
    };
}
const dir = fakeDir(files, "d");
vi.mock("../src/shared/folderSync", async (orig) => ({ ...(await orig<any>()), loadSavedHandle: async () => dir, saveHandle: async () => {}, clearSavedHandle: async () => {} }));

/** the activities the Editor's sync button showed */
const shown: string[] = [];
vi.mock("../src/background/engine/logs", async (orig) => ({
    ...(await orig<any>()),
    broadcastToUi: (msg: any) => {
        if (msg?.type === "sync" && msg.status.activity !== "idle" && shown[shown.length - 1] !== msg.status.activity) shown.push(msg.status.activity);
    },
}));

const put = (name: string, text: string) => files.set(name, { text, t: clock++ });
const ss = () => import("../src/background/engine/scriptStore");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PARAMS = `wt.params({ n: { type: "number", default: 1 } });`;

async function settled(sync: typeof import("../src/background/folderSync")) {
    // let debounced storage → disk work fire on its own, as in the browser
    for (let i = 0; i < 3; i++) {
        await sleep(350);
        await sync.flush();
    }
}

/** a synced folder with two scripts (one declaring a param), fully settled */
async function setup() {
    put("plain.ts", "// plain");
    put("withParams.ts", PARAMS);
    const sync = await import("../src/background/folderSync");
    await sync.startFromStoredHandle({ fresh: true });
    await settled(sync);
    ops.length = 0;
    shown.length = 0;
    return sync;
}

beforeEach(async () => {
    const sync = await import("../src/background/folderSync");
    await sync.stop();
    vi.resetModules();
    files.clear();
    ops.length = 0;
    shown.length = 0;
    storageListeners.length = 0;
    for (const k of Object.keys(store)) delete store[k];
});

const names = async () => (await (await ss()).listScripts()).map((s) => s.meta.name).sort();
const scriptOps = () => ops.filter((o) => o.endsWith(".ts"));
const DERIVED = ["write settings.yaml", "write settings.schema.json"];

describe("folder sync: received changes are not echoed back", () => {
    it("an external delete is only received", async () => {
        const sync = await setup();
        files.delete("plain.ts");
        await settled(sync);
        expect(await names()).toEqual(["withParams"]);
        expect(shown).toEqual(["receiving"]);
        expect(ops).toEqual([]);
        await sync.stop();
    });

    it("an external delete of a script with a settings section is only received", async () => {
        const sync = await setup();
        files.delete("withParams.ts");
        await settled(sync);
        expect(await names()).toEqual(["plain"]);
        // its settings.yaml section and schema entry go, as part of receiving the delete
        expect(shown).toEqual(["receiving"]);
        expect(ops).toEqual(DERIVED);
        expect(files.get("settings.yaml")!.text).toMatch(/no longer exists/);
        expect(scriptOps()).toEqual([]);
        await sync.stop();
    });

    it("an external edit is only received", async () => {
        const sync = await setup();
        put("plain.ts", "// plain edited");
        put("withParams.ts", PARAMS + "\n// edited");
        await settled(sync);
        const by = Object.fromEntries((await (await ss()).listScripts()).map((s) => [s.meta.name, s.code]));
        expect(by).toEqual({ plain: "// plain edited", withParams: PARAMS + "\n// edited" });
        expect(shown).toEqual(["receiving"]);
        expect(ops).toEqual([]);
        await sync.stop();
    });

    it("an external edit declaring a param is only received", async () => {
        const sync = await setup();
        put("plain.ts", `wt.params({ m: { type: "number", default: 2 } });`);
        await settled(sync);
        expect(files.get("settings.yaml")!.text).toMatch(/plain:[\s\S]*# m: 2/);
        expect(shown).toEqual(["receiving"]);
        expect(ops).toEqual(DERIVED);
        await sync.stop();
    });

    it("an external add is only received", async () => {
        const sync = await setup();
        put("added.ts", "// added");
        put("Added Params.ts", `wt.params({ k: { type: "boolean", default: true } });`);
        await settled(sync);
        expect(await names()).toEqual(["Added Params", "added", "plain", "withParams"].sort());
        expect(shown).toEqual(["receiving"]);
        expect(scriptOps()).toEqual([]);
        await sync.stop();
    });

    it("an external settings.yaml edit is only received", async () => {
        const sync = await setup();
        put("settings.yaml", files.get("settings.yaml")!.text.replace(/# n: 1|n: 1/, "n: 7"));
        await settled(sync);
        const { listScripts, getParamValues } = await ss();
        expect(await getParamValues((await listScripts()).find((s) => s.meta.name === "withParams")!.id)).toMatchObject({ n: 7 });
        expect(shown).toEqual(["receiving"]);
        expect(ops).toEqual([]);
        await sync.stop();
    });

    it("a local edit is only sent", async () => {
        const sync = await setup();
        const { saveScript, listScripts } = await ss();
        const s = (await listScripts()).find((x) => x.meta.name === "plain")!;
        await saveScript({ id: s.id, code: "// local edit", name: "plain" });
        await settled(sync);
        expect(files.get("plain.ts")?.text).toBe("// local edit");
        expect(shown).toEqual(["sending"]);
        expect(ops).toEqual(["write plain.ts"]);
        await sync.stop();
    });

    it("a local delete is only sent", async () => {
        const sync = await setup();
        const { deleteScript, listScripts } = await ss();
        await deleteScript((await listScripts()).find((x) => x.meta.name === "withParams")!.id);
        await settled(sync);
        expect(await names()).toEqual(["plain"]);
        expect(shown).toEqual(["sending"]);
        expect(ops).toEqual(["delete withParams.ts", ...DERIVED]);
        await sync.stop();
    });
});
