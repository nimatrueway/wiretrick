import { describe, it, expect, vi } from "vitest";
import { GENERATED_NOTE } from "../src/shared/generatedFiles";

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
    runtime: { lastError: undefined, sendMessage: () => {}, getURL: (p: string) => `chrome-extension://x/${p}` },
};
let dts = "declare const tt: { v1: true };\n";
(globalThis as any).fetch = async (url: string) => {
    expect(url).toBe("chrome-extension://x/lib/tt-api.d.ts");
    return { ok: true, status: 200, text: async () => dts };
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

describe("folder sync support files", () => {
    it("writes typings, tsconfig and schema on start and refreshes them after an update", async () => {
        const sync = await import("../src/background/folderSync");
        await sync.startFromStoredHandle({ fresh: true });
        const d = files.get("tt-api.d.ts")!;
        expect(d.text).toContain(GENERATED_NOTE);
        expect(d.text).toContain("v1: true");
        const ts = files.get("tsconfig.json")!.text;
        expect(ts.startsWith(`// ${GENERATED_NOTE}\n`)).toBe(true);
        expect(JSON.parse(ts.slice(ts.indexOf("\n") + 1)).include).toEqual(["**/*.ts", "**/*.tsx"]);
        expect(JSON.parse(ts.slice(ts.indexOf("\n") + 1)).compilerOptions.paths).toMatchObject({ "https://unpkg.com/*": ["./.tangitweak/types/unpkg.com/*"], react: ["./.tangitweak/types/builtin/@types/react/index.d.ts"] });
        const pkg = JSON.parse(files.get("package.json")!.text);
        expect(pkg.$comment).toContain(GENERATED_NOTE);
        expect(pkg).toMatchObject({ private: true, type: "module" });
        expect(JSON.parse(files.get("settings.schema.json")!.text).$comment).toBe(GENERATED_NOTE);
        const stamps = ["tt-api.d.ts", "tsconfig.json", "package.json", "settings.schema.json"].map((f) => files.get(f)!.t);

        // unchanged → nothing rewritten on the next start
        sync.halt();
        await sync.startFromStoredHandle({ fresh: true });
        expect(["tt-api.d.ts", "tsconfig.json", "package.json", "settings.schema.json"].map((f) => files.get(f)!.t)).toEqual(stamps);

        // extension update with new APIs + hand-edited tsconfig/package.json → restored
        dts = "declare const tt: { v2: true };\n";
        files.set("tsconfig.json", { text: "{}", t: clock++ });
        files.set("package.json", { text: "{}", t: clock++ });
        sync.halt();
        await sync.startFromStoredHandle({ fresh: true });
        expect(files.get("tt-api.d.ts")!.text).toContain("v2: true");
        expect(files.get("tsconfig.json")!.text).toBe(ts);
        expect(JSON.parse(files.get("package.json")!.text).$comment).toContain(GENERATED_NOTE);
        sync.halt();
    });
});
