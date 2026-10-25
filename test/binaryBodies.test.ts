/** Binary response bodies: the shared text/binary check, settings.textTypes, `binary: true` routes and byte packing. */
import { describe, it, expect, afterEach } from "vitest";
import { bodyKind, DEFAULT_TEXT_TYPES, getTextTypes, globMatch, isTextType, mimeEssence, setTextTypes, sniffBinary } from "../src/shared/bodyKind";
import { packBytes, unpackBytes } from "../src/shared/bytesPack";
import { normalizeRoute, NET_KINDS } from "../src/shared/route";
import { runOp } from "../src/shared/bodyOps";
import { parseSettings, planSettings, renderSettings, type GlobalSettings } from "../src/shared/settingsYaml";
import { patchSettings } from "../src/shared/settingsYamlPatch";
import { buildSettingsSchema } from "../src/shared/settingsSchema";
import { settingsDiagnostics } from "../src/shared/settingsAssist";

describe("bodyKind / isTextType", () => {
    afterEach(() => setTextTypes(null));

    it("globs: * matches any run, whole string, case-insensitive", () => {
        expect(globMatch("text/*", "text/html")).toBe(true);
        expect(globMatch("*json", "application/vnd.api+json")).toBe(true);
        expect(globMatch("*/x-www-form-urlencoded", "application/x-www-form-urlencoded")).toBe(true);
        expect(globMatch("*json", "application/jsonp")).toBe(false);
        expect(globMatch("image/png", "image/png")).toBe(true);
        expect(globMatch("IMAGE/*", "image/png")).toBe(true);
        expect(globMatch("a*b*c", "abc")).toBe(true);
        expect(globMatch("a*bc*c", "abc")).toBe(false);
        expect(mimeEssence(" Text/HTML ; charset=utf-8")).toBe("text/html");
    });

    it("default text types", () => {
        const text = ["text/html; charset=utf-8", "application/json", "application/ld+json", "image/svg+xml", "application/xml", "application/javascript", "text/javascript", "application/ecmascript", "application/vnd.apple.mpegurl", "audio/mpegurl", "application/x-yaml", "application/toml", "application/graphql", "application/x-www-form-urlencoded"];
        for (const ct of text) expect(isTextType(ct), ct).toBe(true);
        const binary = ["image/png", "video/mp4", "video/mp2t", "font/woff2", "application/wasm", "application/pdf", "application/octet-stream", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/zip"];
        for (const ct of binary) expect(isTextType(ct), ct).toBe(false);
    });

    it("text that isn't valid UTF-8 is binary (decoding it would corrupt it)", () => {
        // x.com's onboarding payload: binary served as text/plain
        const blob = new Uint8Array([0xe9, 0x16, 0x00, 0x72, 0xff, 0xfe, 0x03]);
        expect(bodyKind("text/plain", blob)).toBe("binary");
        expect(bodyKind("", blob)).toBe("binary");
        expect(bodyKind("text/html; charset=utf-8", new TextEncoder().encode("héllo ✓"))).toBe("text");
        // decided from the header alone until the bytes are known
        expect(bodyKind("text/plain", null)).toBe("text");
    });

    it("a Content-Type is trusted; bytes are sniffed only without one", () => {
        const nul = new Uint8Array([1, 0, 2]);
        expect(bodyKind("text/plain", nul)).toBe("text");
        expect(bodyKind("image/png", new TextEncoder().encode("hello"))).toBe("binary");
        expect(bodyKind("", nul)).toBe("binary");
        expect(bodyKind(null, new TextEncoder().encode("hello"))).toBe("text");
        expect(bodyKind("", null)).toBe("unknown");
        expect(bodyKind("image/png", null)).toBe("binary");
        // only the first 512 bytes are sniffed
        const late = new Uint8Array(600).fill(65);
        late[550] = 0;
        expect(sniffBinary(late)).toBe(false);
    });

    it("custom patterns replace the defaults", () => {
        expect(isTextType("application/json", ["text/*"])).toBe(false);
        expect(bodyKind("application/x-custom", null, ["*custom"])).toBe("text");
        setTextTypes(["text/*", "application/x-ndjson"]);
        expect(getTextTypes()).toEqual(["text/*", "application/x-ndjson"]);
        expect(isTextType("application/json")).toBe(false);
        expect(isTextType("application/x-ndjson")).toBe(true);
        setTextTypes([]);
        expect(getTextTypes()).toBe(DEFAULT_TEXT_TYPES);
    });
});

describe("packBytes / unpackBytes", () => {
    it("round-trips bytes nested anywhere, through JSON", () => {
        const all = new Uint8Array(256).map((_, i) => i);
        const v = { a: all, list: [new Uint8Array([0, 255]), "s", 1, null], deep: { x: { y: new Uint8Array(0) } }, body: "text" };
        const wire = JSON.parse(JSON.stringify(packBytes(v)));
        expect(wire.a).toEqual({ __wtBytes: expect.any(String) });
        const back = unpackBytes(wire);
        expect(back.a).toBeInstanceOf(Uint8Array);
        expect([...back.a]).toEqual([...all]);
        expect([...back.list[0]]).toEqual([0, 255]);
        expect(back.list.slice(1)).toEqual(["s", 1, null]);
        expect(back.deep.x.y).toBeInstanceOf(Uint8Array);
        expect(back.body).toBe("text");
    });

    it("leaves values without bytes alone; only a lone __wtBytes key is unpacked", () => {
        expect(packBytes("x")).toBe("x");
        expect(unpackBytes(null)).toBe(null);
        expect(unpackBytes({ __wtBytes: "AA==", other: 1 })).toEqual({ __wtBytes: "AA==", other: 1 });
        const big = new Uint8Array(200_000).map((_, i) => i % 251);
        expect([...unpackBytes(JSON.parse(JSON.stringify(packBytes(big))))]).toEqual([...big]);
    });
});

describe("route binary option", () => {
    it("onResponseBody only: true, false or \"both\" (false is kept: it silences the warning)", () => {
        expect(normalizeRoute("onResponseBody", { url: "*", binary: true }, 0).binary).toBe(true);
        expect(normalizeRoute("onResponseBody", { url: "*", binary: false }, 0).binary).toBe(false);
        expect(normalizeRoute("onResponseBody", { url: "*", binary: "both" }, 0).binary).toBe("both");
        expect(normalizeRoute("onResponseBody", "*", 0).binary).toBeUndefined();
        expect(() => normalizeRoute("onResponseBody", { url: "*", binary: "yes" }, 0)).toThrow(/binary must be true, false or "both", got "yes"/);
        for (const k of ["onRequest", "onResponseHeaders", "replaceResponse"] as const) {
            expect(() => normalizeRoute(k, { url: "*", binary: true }, 0)).toThrow(/onResponseBody only/);
        }
        expect(() => normalizeRoute("onDocument", { url: "*", binary: true }, 0)).toThrow();
    });
});

describe("transform op: binary bodies reach binary routes only", () => {
    const handlers = (h: Record<string, { fn: Function; binary?: boolean | "both" }[]>): any =>
        Object.fromEntries([...NET_KINDS, "onDocument"].map((k) => [k, (h[k] ?? []).map(({ fn, binary }, i) => ({ fn, route: normalizeRoute(k as any, binary !== undefined ? { url: "*://x.test/*", binary } : "*://x.test/*", i) }))]));
    let logs: string[] = [];
    const run = (h: any, body: string | Uint8Array) => {
        logs = [];
        return runOp([{ id: "s", name: "S", handlers: handlers(h) }] as any, "transform", { url: "https://x.test/a", method: "GET", body }, { log: (_id: string, level: string, msg: string) => void logs.push(`${level} ${msg}`) } as any);
    };

    it("bytes skip text handlers and go to binary ones, staying bytes", async () => {
        const seen: string[] = [];
        const out = await run(
            {
                onResponseBody: [
                    { fn: () => void seen.push("text") },
                    { fn: (_c: any, b: Uint8Array) => (seen.push(`bin:${b.length}`), new Uint8Array([7, 7])), binary: true },
                ],
            },
            new Uint8Array([1, 0, 2])
        );
        expect(seen).toEqual(["bin:3"]);
        expect(out).toBeInstanceOf(Uint8Array);
        expect([...(out as Uint8Array)]).toEqual([7, 7]);
    });

    it("a body handed back unchanged is no change (the original bytes are kept)", async () => {
        expect(await run({ onResponseBody: [{ fn: (_c: any, b: string) => b }] }, "\uFEFFsame")).toBeNull();
        expect(await run({ onResponseBody: [{ fn: (_c: any, b: string) => b + "!" }, { fn: (_c: any, b: string) => b.slice(0, -1) }] }, "same")).toBeNull();
        expect(await run({ onResponseBody: [{ fn: (_c: any, b: Uint8Array) => new Uint8Array(b), binary: true }] }, new Uint8Array([1, 0, 2]))).toBeNull();
    });

    it("no binary route: a binary body is left alone", async () => {
        expect(await run({ onResponseBody: [{ fn: () => "changed" }] }, new Uint8Array([1, 0]))).toBeNull();
    });

    it("binary: true is binary only: a text body skips it", async () => {
        const seen: string[] = [];
        const out = await run({ onResponseBody: [{ fn: () => void seen.push("bin"), binary: true }, { fn: (_c: any, b: string) => b + "!" }] }, "hi");
        expect(seen).toEqual([]);
        expect(out).toBe("hi!");
    });

    it('"both" gets text and bytes', async () => {
        const seen: string[] = [];
        const h = { onResponseBody: [{ fn: (_c: any, b: unknown) => void seen.push(typeof b === "string" ? "text" : "bytes"), binary: "both" as const }] };
        await run(h, "hi");
        await run(h, new Uint8Array([1, 0]));
        expect(seen).toEqual(["text", "bytes"]);
    });

    it("every route opted out by an explicit binary option: a DEBUG line (counts as handled); unset: nothing", async () => {
        await run({ onResponseBody: [{ fn: () => "x", binary: false }] }, new Uint8Array([1, 0]));
        expect(logs).toEqual(["debug [S] onResponseBody → not run — the body is binary and the route has binary: false https://x.test/a"]);
        await run({ onResponseBody: [{ fn: () => "x", binary: true }] }, "hi");
        expect(logs).toEqual(["debug [S] onResponseBody → not run — the body is text and the route has binary: true (binary only) https://x.test/a"]);
        await run({ onResponseBody: [{ fn: () => "x" }] }, new Uint8Array([1, 0]));
        expect(logs).toEqual([]);
        await run({ onResponseBody: [{ fn: () => "x" }, { fn: () => "x", binary: false }] }, new Uint8Array([1, 0]));
        expect(logs).toEqual([]);
    });

    it('"both" gets text; bytes it returns are decoded for the next text handler', async () => {
        const out = await run(
            {
                onResponseBody: [
                    { fn: (_c: any, b: string) => new TextEncoder().encode(b + "!"), binary: "both" },
                    { fn: (_c: any, b: unknown) => (typeof b === "string" ? b + "?" : "not text") },
                ],
            },
            "hi"
        );
        expect(out).toBe("hi!?");
    });
});

describe("settings.textTypes", () => {
    const G: GlobalSettings = { logLevel: "info", logCap: 500, defaultStrategy: "helper" };

    it("renders the defaults commented, a custom list live", () => {
        const def = renderSettings(G, []);
        expect(def).toContain("  # textTypes:\n  #   - text/*\n");
        expect(def).toContain('binary: true');
        const custom = renderSettings({ ...G, textTypes: ["text/*", "image/svg+xml"] }, []);
        expect(custom).toContain("  textTypes:\n    - text/*\n    - image/svg+xml\n");
        expect(parseSettings(custom).settings?.textTypes).toEqual(["text/*", "image/svg+xml"]);
    });

    it("plans: missing = defaults; invalid lists are skipped", () => {
        const plan = (t: string, cur: GlobalSettings = G) => planSettings(parseSettings(t), cur, []).globals.textTypes;
        expect(plan("settings:\n  textTypes: [text/*, '*json']\n")).toEqual(["text/*", "*json"]);
        expect(plan("settings:\n  logLevel: info\n")).toBeUndefined();
        expect(plan("settings:\n  logLevel: info\n", { ...G, textTypes: ["text/*"] })).toEqual([...DEFAULT_TEXT_TYPES]);
        expect(plan("settings:\n  textTypes: [text/*]\n", { ...G, textTypes: ["text/*"] })).toBeUndefined();
        for (const bad of ["[]", "text/*", "[1, 2]", '[""]']) expect(plan(`settings:\n  textTypes: ${bad}\n`), bad).toBeUndefined();
    });

    it("patches a file to a custom list and back", () => {
        const def = renderSettings(G, []);
        const custom = patchSettings(def, { ...G, textTypes: ["text/*", "image/svg+xml"] }, [])!;
        expect(custom).not.toBeNull();
        expect(parseSettings(custom).settings?.textTypes).toEqual(["text/*", "image/svg+xml"]);
        const back = patchSettings(custom, G, [])!;
        expect(back).not.toBeNull();
        // like the other globals, a reverted entry stays live at the default value
        expect(parseSettings(back).settings?.textTypes).toEqual([...DEFAULT_TEXT_TYPES]);
        expect(planSettings(parseSettings(back), G, []).globals).toEqual({});
        expect(patchSettings(def, G, [])).toBe(def);
    });

    it("schema and diagnostics", () => {
        const schema: any = buildSettingsSchema([]);
        expect(schema.properties.settings.properties.textTypes).toMatchObject({ type: "array", items: { type: "string" }, default: [...DEFAULT_TEXT_TYPES] });
        const msgs = (t: string) => settingsDiagnostics(t, []).map((d) => d.message);
        expect(msgs("settings:\n  textTypes: [text/*, image/svg+xml]\n")).toEqual([]);
        expect(msgs("settings:\n  textTypes: []\n")[0]).toMatch(/non-empty list of Content-Type globs/);
        expect(msgs("settings:\n  textTypes: text/*\n")[0]).toMatch(/non-empty list of Content-Type globs/);
    });
});
