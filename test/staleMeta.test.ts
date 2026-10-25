/**
 * Scripts saved before route registration lines were recorded get them at
 * startup (refreshStaleMeta), without being re-saved.
 */
import { describe, it, expect } from "vitest";
import "../src/shared/transpile";

const store: Record<string, any> = {};
let manifestVersion = "1.0.0";
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
    runtime: { lastError: undefined, sendMessage: () => {}, getManifest: () => ({ version: manifestVersion }) },
};

const { saveScript, listScripts, refreshStaleMeta } = await import("../src/background/engine/scriptStore");

describe("refreshStaleMeta", () => {
    it("records the missing registration lines of stored routes", async () => {
        await saveScript({ id: "a", name: "a", code: '// x\nwt.onRequest("*://a.test/*", () => {});' } as any);
        const key = Object.keys(store).find((k) => store[k]?.a)!;
        expect(store[key].a.meta.routes[0].line).toBe(2);
        delete store[key].a.meta.routes[0].line; // as stored by an older version
        await refreshStaleMeta();
        expect((await listScripts()).find((s) => s.id === "a")!.meta.routes[0].line).toBe(2);
    });

    it("recompiles meta stored by another extension version (once)", async () => {
        await saveScript({ id: "b", name: "b", code: 'wt.onResponseBody({ url: "*://b.test/*", binary: false }, (c, b) => b);' } as any);
        const key = Object.keys(store).find((k) => store[k]?.b)!;
        const binary = async () => (await listScripts()).find((s) => s.id === "b")!.meta.routes[0].binary;
        await refreshStaleMeta(); // records this version
        delete store[key].b.meta.routes[0].binary; // as stored by a version that dropped `binary: false`
        await refreshStaleMeta(); // same version: left alone
        expect(await binary()).toBeUndefined();
        manifestVersion = "1.0.1";
        await refreshStaleMeta();
        expect(await binary()).toBe(false);
    });
});
