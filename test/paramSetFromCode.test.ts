/**
 * Param writes from code (wt.params assignment): several at once all land,
 * in order, even though each one reads and writes back every value.
 */
import { describe, it, expect, beforeEach } from "vitest";
import "../src/shared/transpile";

const store: Record<string, any> = {};
const later = (f: () => void) => setTimeout(f, Math.random() * 5);
(globalThis as any).chrome = {
    storage: {
        local: {
            get: (k: any, cb: any) => {
                const keys = k === null ? Object.keys(store) : Array.isArray(k) ? k : [k];
                const out = Object.fromEntries(keys.filter((x: string) => x in store).map((x: string) => [x, structuredClone(store[x])]));
                later(() => cb(out));
            },
            set: (o: any, cb?: any) => later(() => (Object.assign(store, structuredClone(o)), cb?.())),
        },
        onChanged: { addListener: () => {} },
    },
    runtime: { lastError: undefined, sendMessage: () => {} },
};

const { saveScript, setParamFromCode, loadAllParamValues } = await import("../src/background/engine/scriptStore");

const CODE = `const cfg = wt.params({ on: { type: "boolean", default: true }, hits: { type: "stringList", default: [] } });`;

describe("setParamFromCode", () => {
    beforeEach(() => {
        for (const k of Object.keys(store)) delete store[k];
    });

    it("two params set at once both persist", async () => {
        await saveScript({ id: "s", name: "s.wiretrick", code: CODE });
        await Promise.all([setParamFromCode("s", "on", false), setParamFromCode("s", "hits", ["page"])]);
        expect((await loadAllParamValues()).s).toEqual({ on: false, hits: ["page"] });
    });

    it("a quick flip back isn't skipped as unchanged", async () => {
        await saveScript({ id: "s", name: "s.wiretrick", code: CODE });
        await Promise.all([setParamFromCode("s", "on", false), setParamFromCode("s", "on", true)]);
        expect((await loadAllParamValues()).s).toEqual({ on: true });
    });
});
