import { describe, it, expect, beforeEach, vi } from "vitest";

// in-memory chrome.storage + directory handle (with a backup subfolder)
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
type F = Map<string, { text: string; t: number }>;
const files: F = new Map();
const backups: F = new Map();
let clock = 1;
function fakeDir(m: F, name: string): any {
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
                createWritable: async () => ({ write: async (t: string) => m.set(n, { text: t, t: clock++ }), close: async () => {} }),
            };
        },
        async getDirectoryHandle(n: string) {
            if (n !== ".wiretrick-backup") throw new Error("nf");
            return fakeDir(backups, n);
        },
        async removeEntry(n: string) {
            m.delete(n);
        },
    };
}
const dir = fakeDir(files, "d");
vi.mock("../src/shared/folderSync", async (orig) => ({ ...(await orig<any>()), loadSavedHandle: async () => dir, saveHandle: async () => {}, clearSavedHandle: async () => {} }));

const put = (name: string, text: string) => files.set(name, { text, t: clock++ });
const ss = () => import("../src/background/engine/scriptStore");
const all = async () => (await (await ss()).listScripts()).map((s) => ({ id: s.id, name: s.meta.name, code: s.code })).sort((a, b) => a.name.localeCompare(b.name));
const scriptFiles = () => [...files.keys()].filter((n) => n.endsWith(".ts") && n !== "wt-api.d.ts").sort();

async function started() {
    const sync = await import("../src/background/folderSync");
    await sync.startFromStoredHandle({ fresh: true });
    return sync;
}

beforeEach(async () => {
    const sync = await import("../src/background/folderSync");
    await sync.stop();
    vi.resetModules();
    files.clear();
    backups.clear();
    for (const k of Object.keys(store)) delete store[k];
});

describe("folder sync: the background is the only writer", () => {
    it("store save, rename and delete reach the folder", async () => {
        const sync = await started();
        const { saveScript, deleteScript } = await ss();
        await saveScript({ id: "a", code: "// one", name: "alpha" });
        await sync.flush();
        expect(files.get("alpha.ts")?.text).toBe("// one");

        await saveScript({ id: "a", code: "// two", name: "beta" });
        await sync.flush();
        expect(scriptFiles()).toEqual(["beta.ts"]);
        expect(files.get("beta.ts")?.text).toBe("// two");

        await deleteScript("a");
        await sync.flush();
        expect(scriptFiles()).toEqual([]);
        await sync.flush();
        expect(await all()).toEqual([]); // the delete doesn't bounce back as an import
        await sync.stop();
    });

    it("a manager save racing a poll is not reverted", async () => {
        put("x.ts", "// disk");
        const sync = await started();
        const { saveScript } = await ss();
        const id = (await all())[0].id;
        const save = saveScript({ id, code: "// mine", name: "x" });
        const poll = sync.flush();
        await Promise.all([save, poll]);
        await sync.flush();
        await sync.flush();
        expect((await all())[0].code).toBe("// mine");
        expect(files.get("x.ts")?.text).toBe("// mine");
        await sync.stop();
    });

    it("a slow drive reporting an earlier write back doesn't revert a newer save", async () => {
        const sync = await started();
        const { saveScript } = await ss();
        await saveScript({ id: "a", code: "// one", name: "alpha" });
        await sync.flush();
        await saveScript({ id: "a", code: "// two", name: "alpha" });
        await sync.flush();
        expect(files.get("alpha.ts")?.text).toBe("// two");
        put("alpha.ts", "// one"); // the drive delivers the first write late
        await sync.flush();
        expect((await all())[0].code).toBe("// two");
        await sync.flush();
        expect(files.get("alpha.ts")?.text).toBe("// two"); // rewritten
        expect(backups.size).toBe(0);
        await sync.stop();
    });

    it("a write skipped while a file's mtime moved is retried after the poll", async () => {
        const sync = await started();
        const { saveScript } = await ss();
        await saveScript({ id: "a", code: "// one", name: "alpha" });
        await sync.flush();
        put("alpha.ts", "// one"); // same text, new mtime (drive flushed its timestamp)
        await saveScript({ id: "a", code: "// two", name: "alpha" });
        await sync.flush(); // reconcile skips (unseen change), then the poll sees the old text
        expect((await all())[0].code).toBe("// two");
        await sync.flush();
        expect(files.get("alpha.ts")?.text).toBe("// two");
        await sync.stop();
    });

    it("an external edit back to an old text after the echo window is still pulled", async () => {
        const now = vi.spyOn(Date, "now");
        let t = 1_000_000;
        now.mockImplementation(() => t);
        const sync = await started();
        const { saveScript } = await ss();
        await saveScript({ id: "a", code: "// one", name: "alpha" });
        await sync.flush();
        await saveScript({ id: "a", code: "// two", name: "alpha" });
        await sync.flush();
        t += 120_000;
        put("alpha.ts", "// one");
        await sync.flush();
        expect((await all())[0].code).toBe("// one");
        now.mockRestore();
        await sync.stop();
    });

    it("renaming in the store renames the script's settings.yaml section", async () => {
        const sync = await started();
        const { saveScript } = await ss();
        const code = `wt.params({ n: { type: "number", default: 1 } });`;
        await saveScript({ id: "p", code, name: "old" });
        await sync.flush();
        put("settings.yaml", files.get("settings.yaml")!.text.replace(/# n: 1|n: 1/, "n: 9 # tuned"));
        await sync.flush();
        expect(files.get("settings.yaml")!.text).toMatch(/old:[\s\S]*n: 9 # tuned/);
        await saveScript({ id: "p", code, name: "new" });
        await sync.flush();
        const after = files.get("settings.yaml")!.text;
        expect(after).toMatch(/new:[\s\S]*n: 9 # tuned/);
        expect(after).not.toMatch(/\bold:/);
        expect(after).not.toMatch(/no longer exists/);
        await sync.stop();
    });
});

describe("folder sync: external edits", () => {
    it("renames are matched by content and keep the script id", async () => {
        put("a.ts", "// A");
        put("b.ts", "// B");
        const sync = await started();
        const ids = Object.fromEntries((await all()).map((s) => [s.name, s.id]));
        files.set("a2.ts", files.get("a.ts")!);
        files.delete("a.ts");
        files.set("b2.ts", files.get("b.ts")!);
        files.delete("b.ts");
        await sync.flush();
        const now = await all();
        expect(now.map((s) => s.name)).toEqual(["a2", "b2"]);
        expect(now.find((s) => s.name === "a2")!.id).toBe(ids.a);
        expect(now.find((s) => s.name === "b2")!.id).toBe(ids.b);
        await sync.stop();
    });

    it("rename + edit in one go is a delete and a create", async () => {
        put("a.ts", "// A");
        const sync = await started();
        files.delete("a.ts");
        put("z.ts", "// Z edited");
        await sync.flush();
        expect((await all()).map((s) => [s.name, s.code])).toEqual([["z", "// Z edited"]]);
        await sync.stop();
    });

    it("both sides changed: the disk edit wins and the store copy is backed up", async () => {
        put("c.ts", "// base");
        const sync = await started();
        const { saveScript } = await ss();
        const id = (await all())[0].id;
        await saveScript({ id, code: "// store edit", name: "c" });
        put("c.ts", "// disk edit");
        await sync.flush();
        await sync.flush();
        const code = (await all())[0].code;
        expect(files.get("c.ts")?.text).toBe(code);
        const kept = [...backups.values()].map((b) => b.text);
        expect(kept.length).toBe(1);
        expect([code, ...kept].sort()).toEqual(["// disk edit", "// store edit"]);
        await sync.stop();
    });

    it("an external delete doesn't drop unsynced store changes", async () => {
        put("d.ts", "// base");
        const sync = await started();
        const { saveScript } = await ss();
        const id = (await all())[0].id;
        await saveScript({ id, code: "// unsynced", name: "d" });
        files.delete("d.ts");
        await sync.flush();
        await sync.flush();
        expect((await all()).map((s) => s.code)).toEqual(["// unsynced"]);
        expect(files.get("d.ts")?.text).toBe("// unsynced");
        await sync.stop();
    });

    it("a file differing only in letter case from a script isn't imported", async () => {
        const sync = await started();
        const { saveScript } = await ss();
        await saveScript({ id: "f", code: "// foo", name: "foo" });
        await sync.flush();
        put("Foo.ts", "// other");
        await sync.flush();
        expect((await all()).map((s) => s.name)).toEqual(["foo"]);
        await sync.stop();
    });

    it("a broken settings.yaml is never overwritten", async () => {
        const sync = await started();
        put("settings.yaml", "params: [oops\n");
        await sync.flush();
        const { saveScript } = await ss();
        await saveScript({ id: "s", code: "// s", name: "s" });
        await sync.flush();
        expect(files.get("settings.yaml")?.text).toBe("params: [oops\n");
        expect(files.get("s.ts")?.text).toBe("// s");
        await sync.stop();
    });
});

describe("folder sync: worker restart keeps the merge base", () => {
    it("only-one-side changes while down resolve without a conflict backup", async () => {
        put("m.ts", "// m0");
        put("n.ts", "// n0");
        let sync = await started();
        const { saveScript } = await ss();
        const ids = Object.fromEntries((await all()).map((s) => [s.name, s.id]));
        sync.halt();
        await saveScript({ id: ids.m, code: "// m store", name: "m" }); // store-only change
        put("n.ts", "// n disk"); // disk-only change
        vi.resetModules();
        sync = await import("../src/background/folderSync");
        await sync.startFromStoredHandle();
        await sync.flush();
        const by = Object.fromEntries((await all()).map((s) => [s.name, s.code]));
        expect(by).toEqual({ m: "// m store", n: "// n disk" });
        expect(files.get("m.ts")?.text).toBe("// m store");
        expect(backups.size).toBe(0);
        await sync.stop();
    });
});
