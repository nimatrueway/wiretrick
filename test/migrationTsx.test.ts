import { describe, it, expect, beforeEach, vi } from "vitest";

// Migration v4: scripts with JSX get the .tsx in their names (TypeScript
// parses JSX only in .tsx files) — with their settings sections, and the
// synced folder's settings.yaml at its next start.

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
let synced = false;
vi.mock("../src/shared/folderSync", async (orig) => ({ ...(await orig<any>()), loadSavedHandle: async () => (synced ? {} : null) }));

const script = (id: string, name: string, code: string) => ({ id, code, enabled: true, createdAt: 1, updatedAt: 1, error: null, meta: { name, routes: [] } });

beforeEach(() => {
    vi.resetModules();
    synced = false;
    for (const k of Object.keys(store)) delete store[k];
});

async function migrate(scripts: ReturnType<typeof script>[], extra: Record<string, any> = {}) {
    Object.assign(store, { resMigrationVersion: 3, resScripts: Object.fromEntries(scripts.map((s) => [s.id, s])), resScriptOrder: scripts.map((s) => s.id), ...extra });
    await import("../src/shared/transpile");
    await import("../src/background/settingsFile");
    await (await import("../src/background/migration")).runMigrations();
    return Object.fromEntries(Object.values(store.resScripts as Record<string, any>).map((s) => [s.id, s.meta.name]));
}

describe("migration v4: .tsx by name", () => {
    it("renames scripts with JSX; plain ones, `<T>` casts and .tsx ones stay", async () => {
        const names = await migrate([
            script("a", "ui/Panel", 'export const P = () => <div className="x">hi</div>;'),
            script("b", "utils", "export const n = 1;"),
            script("c", "cast", "const x = <number>(1 as any);\nexport const y = x;"),
            script("d", "done.tsx", "export const Q = () => <b />;"),
            script("e", "frag", "export const F = () => <>x</>;"),
        ]);
        expect(names).toEqual({ a: "ui/Panel.tsx", b: "utils", c: "cast", d: "done.tsx", e: "frag.tsx" });
        expect(store.resMigrationVersion).toBe(4);
        // once
        store.resScripts.b.code = "export const B = () => <i />;";
        await (await import("../src/background/migration")).runMigrations();
        expect(store.resScripts.b.meta.name).toBe("utils");
    });

    it("skips a rename whose .tsx name is taken", async () => {
        const names = await migrate([script("a", "Panel", "export const P = () => <div />;"), script("b", "panel.tsx", "export const Q = () => <i />;")]);
        expect(names).toEqual({ a: "Panel", b: "panel.tsx" });
    });

    it("renamed scripts keep their settings sections, also in the synced folder's settings.yaml (pending)", async () => {
        synced = true;
        const text = "params:\n  Panel:\n    size: 3\n";
        await migrate([script("a", "Panel", "export const P = () => <div />;")], { resSettingsText: text });
        expect(store.resSettingsText).toContain("Panel.tsx:");
        expect(store.resSettingsText).not.toMatch(/^ {2}Panel:/m);
        expect(store.resMigrationPendingDisk.renames).toEqual([["Panel", "Panel.tsx"]]);
    });
});
