import { describe, it, expect, beforeEach, vi } from "vitest";

// The synced folder mirrors the explorer: subfolders (empty ones too),
// scripts in them and JSON data files, both ways, without echoes.

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

interface Dir {
    files: Map<string, { text: string; t: number }>;
    dirs: Map<string, Dir>;
}
const newDir = (): Dir => ({ files: new Map(), dirs: new Map() });
let root = newDir();
/** every write/delete the extension makes in the folder */
const ops: string[] = [];
let clock = 1;
const notFound = () => Object.assign(new Error("nf"), { name: "NotFoundError" });
const fileObj = (f: { text: string; t: number }) => ({ lastModified: f.t, size: f.text.length, text: async () => f.text });

function fakeDir(d: Dir, name: string, prefix = ""): any {
    return {
        kind: "directory",
        name,
        async *values() {
            for (const [n, f] of d.files) yield { kind: "file", name: n, getFile: async () => fileObj(f) };
            for (const [n, sub] of d.dirs) yield fakeDir(sub, n, prefix + n + "/");
        },
        async getFileHandle(n: string, o?: any) {
            if (!d.files.has(n)) {
                if (!o?.create) throw notFound();
                d.files.set(n, { text: "", t: clock++ });
            }
            return {
                getFile: async () => fileObj(d.files.get(n)!),
                createWritable: async () => ({
                    write: async (t: string) => {
                        ops.push(`write ${prefix}${n}`);
                        d.files.set(n, { text: t, t: clock++ });
                    },
                    close: async () => {},
                }),
            };
        },
        async getDirectoryHandle(n: string, o?: any) {
            if (!d.dirs.has(n)) {
                if (!o?.create) throw notFound();
                ops.push(`mkdir ${prefix}${n}`);
                d.dirs.set(n, newDir());
            }
            return fakeDir(d.dirs.get(n)!, n, prefix + n + "/");
        },
        async removeEntry(n: string) {
            const sub = d.dirs.get(n);
            if (sub) {
                if (sub.files.size || sub.dirs.size) throw Object.assign(new Error("not empty"), { name: "InvalidModificationError" });
                d.dirs.delete(n);
            } else if (!d.files.delete(n)) throw notFound();
            ops.push(`delete ${prefix}${n}`);
        },
    };
}
const dirAt = (path: string, create = true): Dir | undefined => {
    let d: Dir | undefined = root;
    for (const seg of path.split("/").filter(Boolean)) {
        if (!d!.dirs.has(seg)) {
            if (!create) return undefined;
            d!.dirs.set(seg, newDir());
        }
        d = d!.dirs.get(seg);
    }
    return d;
};
const split = (p: string) => [p.slice(0, p.lastIndexOf("/") + 1), p.slice(p.lastIndexOf("/") + 1)];
const put = (path: string, text: string) => {
    const [dir, name] = split(path);
    dirAt(dir)!.files.set(name, { text, t: clock++ });
};
const read = (path: string) => {
    const [dir, name] = split(path);
    return dirAt(dir, false)?.files.get(name)?.text;
};
/** every file on disk, by path */
const tree = (d: Dir = root, prefix = ""): string[] => [
    ...[...d.files.keys()].map((n) => prefix + n),
    ...[...d.dirs].flatMap(([n, sub]) => [prefix + n + "/", ...tree(sub, prefix + n + "/")]),
];

vi.mock("../src/shared/folderSync", async (orig) => ({ ...(await orig<any>()), loadSavedHandle: async () => fakeDir(root, "d"), saveHandle: async () => {}, clearSavedHandle: async () => {} }));

const ss = () => import("../src/background/engine/scriptStore");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function settled(sync: typeof import("../src/background/folderSync")) {
    for (let i = 0; i < 3; i++) {
        await sleep(350);
        await sync.flush();
    }
}
const scripts = async () => (await (await ss()).listScripts()).map((s) => s.meta.name);
const dataPaths = async () => (await (await ss()).listDataFiles()).map((d) => d.path);
const folders = async () => (await ss()).listFolders();
/** the ops on synced files and folders (not the generated support files) */
const syncedOps = () => ops.filter((o) => !/ (settings\.yaml|settings\.schema\.json|tsconfig\.json|wiretrick\.d\.ts|\.wiretrick-backup.*)$/.test(o));

const IMPORTER = `import limits from "./mock/rate-limits.json";\nwt.params({ max: { type: "number", default: limits.max } });`;

/** a synced folder with a folder `mock` (a library, a data file), an importer at the root and an empty folder */
async function setup() {
    put("main.ts", IMPORTER);
    put("mock/helpers.ts", "export const h = 1;");
    put("mock/rate-limits.json", '{ "max": 5 }');
    dirAt("empty");
    await import("../src/shared/transpile"); // registered per module graph (reset between tests)
    const sync = await import("../src/background/folderSync");
    await sync.startFromStoredHandle({ fresh: true });
    await settled(sync);
    ops.length = 0;
    return sync;
}

beforeEach(async () => {
    const sync = await import("../src/background/folderSync");
    await sync.stop();
    vi.resetModules();
    root = newDir();
    ops.length = 0;
    storageListeners.length = 0;
    for (const k of Object.keys(store)) delete store[k];
});

describe("folder sync: folders and data files", () => {
    it("imports subfolders recursively, skipping dot folders, node_modules and tooling config", async () => {
        put("node_modules/pkg/index.ts", "// no");
        put(".git/hooks/x.ts", "// no");
        put("package.json", "{}");
        put("mock/tsconfig.json", "{}");
        put("mock/api/types.d.ts", "// no");
        put("mock/api/deep.json", "[1]");
        const sync = await setup();
        expect((await scripts()).sort()).toEqual(["main", "mock/helpers"]);
        expect(await dataPaths()).toEqual(["mock/api/deep.json", "mock/rate-limits.json"]);
        expect(await folders()).toEqual(["empty", "mock", "mock/api"]);
        const main = (await (await ss()).listScripts()).find((s) => s.meta.name === "main")!;
        expect(main.error).toBeNull();
        expect(main.paramDefs?.max.default).toBe(5);
        // left alone
        expect(read("package.json")).toBe("{}");
        expect(read("node_modules/pkg/index.ts")).toBe("// no");
        await sync.stop();
    });

    it("an edited data file on disk recompiles its importers; invalid JSON is their compile error", async () => {
        const sync = await setup();
        put("mock/rate-limits.json", '{ "max": 9 }');
        await settled(sync);
        let main = (await (await ss()).listScripts()).find((s) => s.meta.name === "main")!;
        expect(main.paramDefs?.max.default).toBe(9);
        put("mock/rate-limits.json", '{ "max": }');
        await settled(sync);
        main = (await (await ss()).listScripts()).find((s) => s.meta.name === "main")!;
        expect(main.error).toMatch(/mock\/rate-limits\.json:1:\d+ is not valid JSON/);
        expect((await (await ss()).listDataFiles())[0].text).toBe('{ "max": }');
        expect(syncedOps()).toEqual([]);
        await sync.stop();
    });

    it("mirrors new folders, data files and scripts in folders to disk, without echo", async () => {
        const sync = await setup();
        const s = await ss();
        await s.createFolder("fixtures/empty");
        await s.saveDataFile({ path: "fixtures/users.json", text: "[]" });
        await s.saveScript({ id: s.newId(), name: "fixtures/seed", code: "// seed" });
        await settled(sync);
        expect(read("fixtures/users.json")).toBe("[]");
        expect(read("fixtures/seed.ts")).toBe("// seed");
        expect(tree()).toContain("fixtures/empty/");
        const before = JSON.stringify(store);
        ops.length = 0;
        await settled(sync);
        expect(ops).toEqual([]);
        expect(JSON.stringify(store)).toBe(before);
        await sync.stop();
    });

    it("an external edit of a data file is only received", async () => {
        const sync = await setup();
        put("mock/rate-limits.json", '{ "max": 6 }');
        await settled(sync);
        expect((await (await ss()).listDataFiles())[0].text).toBe('{ "max": 6 }');
        expect(syncedOps()).toEqual([]);
        await sync.stop();
    });

    it("a folder renamed on disk keeps the scripts and data files (same ids)", async () => {
        const sync = await setup();
        const s = await ss();
        const lib = (await s.listScripts()).find((x) => x.meta.name === "mock/helpers")!;
        const data = (await s.listDataFiles())[0];
        root.dirs.set("fixtures", root.dirs.get("mock")!);
        root.dirs.delete("mock");
        await settled(sync);
        expect((await s.getScript(lib.id))?.meta.name).toBe("fixtures/helpers");
        expect((await s.getDataFile(data.id))?.path).toBe("fixtures/rate-limits.json");
        expect(await folders()).toEqual(["empty", "fixtures"]);
        expect(syncedOps()).toEqual([]);
        await sync.stop();
    });

    it("a folder renamed or deleted in the extension follows on disk", async () => {
        const sync = await setup();
        const s = await ss();
        await s.renameFolder("mock", "fixtures");
        await settled(sync);
        expect(tree().filter((p) => /mock|fixtures/.test(p)).sort()).toEqual(["fixtures/", "fixtures/helpers.ts", "fixtures/rate-limits.json"]);
        await s.deleteFolder("fixtures");
        await s.deleteFolder("empty");
        await settled(sync);
        expect(tree().filter((p) => /mock|fixtures|empty/.test(p))).toEqual([]);
        expect(await dataPaths()).toEqual([]);
        expect(await scripts()).toEqual(["main"]);
        await sync.stop();
    });

    it("a folder holding files Wiretrick doesn't sync stays on disk", async () => {
        put("mock/README.md", "notes");
        const sync = await setup();
        await (await ss()).deleteFolder("mock");
        await settled(sync);
        expect(tree().filter((p) => p.startsWith("mock"))).toEqual(["mock/", "mock/README.md"]);
        await sync.stop();
    });

    it("a data file changed on both sides while stopped keeps a backup at its relative path", async () => {
        let sync = await setup();
        sync.halt();
        const s = await ss();
        await s.saveDataFile({ id: (await s.listDataFiles())[0].id, text: '{ "max": 1 }' });
        put("mock/rate-limits.json", '{ "max": 2 }');
        vi.resetModules();
        await import("../src/shared/transpile");
        sync = await import("../src/background/folderSync");
        await sync.startFromStoredHandle();
        await settled(sync);
        const backups = tree(dirAt(".wiretrick-backup/mock")!).filter((p) => p.startsWith("rate-limits ") && p.endsWith(".json.bak"));
        expect(backups).toHaveLength(1);
        const kept = (await (await ss()).listDataFiles())[0].text;
        expect(read("mock/rate-limits.json")).toBe(kept);
        expect(dirAt(".wiretrick-backup/mock")!.files.get(backups[0])!.text).toBe(kept === '{ "max": 1 }' ? '{ "max": 2 }' : '{ "max": 1 }');
        await sync.stop();
    });
});
