import { describe, it, expect, vi } from "vitest";
import { PACKAGE_TYPINGS_KEY } from "../src/shared/packageImports";

const store: Record<string, any> = {};
const listeners: ((c: Record<string, any>) => void)[] = [];
(globalThis as any).chrome = {
    storage: {
        local: {
            get: (k: any, cb: any) => {
                const keys = k === null ? Object.keys(store) : Array.isArray(k) ? k : [k];
                cb(Object.fromEntries(keys.filter((x: string) => x in store).map((x: string) => [x, structuredClone(store[x])])));
            },
            set: (o: any, cb?: any) => {
                Object.assign(store, structuredClone(o));
                cb?.();
                const c = Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { newValue: v }]));
                for (const l of listeners) l(c);
            },
        },
        onChanged: { addListener: (l: any) => listeners.push(l) },
    },
    runtime: { lastError: undefined, sendMessage: () => {}, getURL: (p: string) => `chrome-extension://x/${p}` },
};
(globalThis as any).fetch = async () => ({ ok: true, status: 200, text: async () => "declare const wt: any;\n" });

type Entry = { kind: "file"; text: string; t: number } | { kind: "directory"; dir: Dir };
interface Dir {
    name: string;
    entries: Map<string, Entry>;
    values(): AsyncGenerator<any>;
    getDirectoryHandle(n: string, o?: any): Promise<Dir>;
    getFileHandle(n: string, o?: any): Promise<any>;
    removeEntry(n: string, o?: any): Promise<void>;
}
let clock = 1;
function fakeDir(name: string): Dir {
    const entries = new Map<string, Entry>();
    return {
        name,
        entries,
        async *values() {
            for (const [n, e] of [...entries]) {
                if (e.kind === "directory") yield { kind: "directory", name: n };
                else yield { kind: "file", name: n, getFile: async () => ({ lastModified: e.t, size: e.text.length, text: async () => e.text }) };
            }
        },
        async getDirectoryHandle(n: string, o?: any): Promise<Dir> {
            const e = entries.get(n);
            if (e?.kind === "directory") return e.dir;
            if (e || !o?.create) throw new Error("nf");
            const sub = fakeDir(n);
            entries.set(n, { kind: "directory", dir: sub });
            return sub;
        },
        async getFileHandle(n: string, o?: any) {
            let e = entries.get(n);
            if (e?.kind === "directory") throw new Error("is a directory");
            if (!e) {
                if (!o?.create) throw new Error("nf");
                entries.set(n, (e = { kind: "file", text: "", t: clock++ }));
            }
            const file = () => entries.get(n) as Extract<Entry, { kind: "file" }>;
            return {
                getFile: async () => ({ lastModified: file().t, size: file().text.length, text: async () => file().text }),
                createWritable: async () => ({ write: async (t: string) => entries.set(n, { kind: "file", text: t, t: clock++ }), close: async () => {} }),
            };
        },
        async removeEntry(n: string, o?: any) {
            const e = entries.get(n);
            if (e?.kind === "directory" && e.dir.entries.size && !o?.recursive) throw new Error("not empty");
            entries.delete(n);
        },
    };
}
const root = fakeDir("d");
vi.mock("../src/shared/folderSync", async (orig) => ({ ...(await orig<any>()), loadSavedHandle: async () => root, saveHandle: async () => {}, clearSavedHandle: async () => {} }));

/** every file under `d` as path → text */
function tree(d: Dir, prefix = ""): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [n, e] of d.entries) {
        if (e.kind === "directory") Object.assign(out, tree(e.dir, `${prefix}${n}/`));
        else out[prefix + n] = e.text;
    }
    return out;
}
const typingsOnDisk = () => Object.fromEntries(Object.entries(tree(root)).filter(([p]) => p.startsWith(".wiretrick/")));

describe("folder sync package typings", () => {
    it("mirrors the stored typings under .wiretrick/types and removes stale ones", async () => {
        store[PACKAGE_TYPINGS_KEY] = {
            files: {
                "unpkg.com/a@1.0.0/package.json": '{"types":"./index.d.ts"}',
                "unpkg.com/a@1.0.0/index.d.ts": "export declare const a: number;\n",
                "node_modules/b/package.json": '{"types":"../../unpkg.com/b@2.0.0/index.d.ts"}',
                "unpkg.com/b@2.0.0/index.d.ts": "export declare const b: number;\n",
            },
            tops: {},
        };
        const sync = await import("../src/background/folderSync");
        await sync.startFromStoredHandle({ fresh: true });
        await sync.flush();
        expect(typingsOnDisk()).toEqual(Object.fromEntries(Object.entries(store[PACKAGE_TYPINGS_KEY].files).map(([p, t]) => [`.wiretrick/types/${p}`, t])));
        // dot folders aren't scripts or data files
        for (const k of ["resScripts", "resDataFiles", "resFolders"]) expect(JSON.stringify(store[k] ?? null)).not.toContain(".wiretrick");

        // b no longer imported; a's entry changed
        chrome.storage.local.set({
            [PACKAGE_TYPINGS_KEY]: {
                files: {
                    "unpkg.com/a@1.0.0/package.json": '{"types":"./index.d.ts"}',
                    "unpkg.com/a@1.0.0/index.d.ts": "export declare const a: string;\n",
                },
                tops: {},
            },
        });
        await sync.flush();
        expect(typingsOnDisk()).toEqual({
            ".wiretrick/types/unpkg.com/a@1.0.0/package.json": '{"types":"./index.d.ts"}',
            ".wiretrick/types/unpkg.com/a@1.0.0/index.d.ts": "export declare const a: string;\n",
        });

        // nothing left → the folder goes
        chrome.storage.local.set({ [PACKAGE_TYPINGS_KEY]: { files: {}, tops: {} } });
        await sync.flush();
        expect(root.entries.has(".wiretrick")).toBe(false);
        expect(root.entries.has("tsconfig.json")).toBe(true);
        sync.halt();
    });
});
