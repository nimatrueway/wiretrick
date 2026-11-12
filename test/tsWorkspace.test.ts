import { describe, expect, it } from "vitest";
import type { PackageStatus } from "../src/shared/packageImports";
import {
    createTsWorkspace,
    IMPORT_OWNER,
    JSX_IN_TS,
    JSX_OWNER,
    TS_OWNER,
    type TsDataInput,
    type TsDiagnosticLike,
    type TsMarkerData,
    type TsModelLike,
    type TsScriptEntry,
} from "../src/ui/tsWorkspace";

interface FakeModel extends TsModelLike {
    setValue(next: string): void;
    dispose(): void;
}

function makeModel(path: string, initial: string): FakeModel {
    let text = initial;
    let version = 1;
    let disposed = false;
    const listeners = new Set<() => void>();
    const uriStr = `file:///${path.replace(/^\//, "")}`;
    return {
        uri: { toString: () => uriStr },
        getValue: () => text,
        getVersionId: () => version,
        getPositionAt(offset: number) {
            const clamped = Math.max(0, Math.min(offset, text.length));
            const lines = text.slice(0, clamped).split("\n");
            return { lineNumber: lines.length, column: lines[lines.length - 1].length + 1 };
        },
        isDisposed: () => disposed,
        onDidChangeContent(fn: () => void) {
            listeners.add(fn);
            return { dispose: () => void listeners.delete(fn) };
        },
        setValue(next: string) {
            text = next;
            version++;
            for (const fn of [...listeners]) fn();
        },
        dispose() {
            disposed = true;
            listeners.clear();
        },
    };
}

function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

const flush = async (ticks = 10) => {
    for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 0));
};

function makeHarness(opts?: {
    editDebounceMs?: number;
    statusPollMs?: number;
    builtinPromise?: Promise<Record<string, string>>;
    pkgTypingsPromise?: Promise<Record<string, string>>;
    diagnose?: (uri: string, state: { extraLibs: Map<string, string>; flushedLibs: Map<string, string>; syncedUris: string[] }) => Promise<TsDiagnosticLike[]> | TsDiagnosticLike[];
    statuses?: (urls: string[]) => Promise<Record<string, PackageStatus> | undefined>;
}) {
    const extraLibs = new Map<string, string>();
    let flushedLibs = new Map<string, string>();
    const modelsByUri = new Map<string, FakeModel>();
    const markers = new Map<string, Map<string, TsMarkerData[]>>();
    const markerWrites: { uri: string; owner: string; messages: string[] }[] = [];
    const checkedOrder: string[] = [];
    let active: FakeModel | null = null;
    let storeListener: ((typings: Record<string, string> | undefined) => void) | null = null;
    let syncedUris: string[] = [];
    let workerSyncCalls = 0;
    let builtinFetches = 0;
    let onCheckedCount = 0;

    const ws = createTsWorkspace({
        editDebounceMs: opts?.editDebounceMs ?? 10,
        statusPollMs: opts?.statusPollMs ?? 30,
        addExtraLib(content, uri) {
            extraLibs.set(uri, content);
            return {
                dispose() {
                    if (extraLibs.get(uri) === content) extraLibs.delete(uri);
                },
            };
        },
        async flushExtraLibs() {
            flushedLibs = new Map(extraLibs);
        },
        fileUri: (p) => `file://${p}`,
        async getWorker(uris) {
            workerSyncCalls++;
            syncedUris = uris.map((u: any) => u.toString());
            return {
                getSyntacticDiagnostics: async () => [],
                getSemanticDiagnostics: async (uri) => {
                    checkedOrder.push(uri);
                    return (await opts?.diagnose?.(uri, { extraLibs, flushedLibs, syncedUris })) ?? [];
                },
                getSuggestionDiagnostics: async () => [],
            };
        },
        getActiveModel: () => active,
        modelByUri: (uri) => modelsByUri.get(uri) ?? null,
        getModelMarkers: (uri: any, owner) => markers.get(uri.toString())?.get(owner) ?? [],
        setModelMarkers(model, owner, next) {
            const uri = model.uri.toString();
            let byOwner = markers.get(uri);
            if (!byOwner) {
                byOwner = new Map();
                markers.set(uri, byOwner);
            }
            byOwner.set(owner, next);
            markerWrites.push({ uri, owner, messages: next.map((m) => m.message) });
        },
        fetchBuiltinTypes: () => {
            builtinFetches++;
            return opts?.builtinPromise ?? Promise.resolve({ "@types/react/index.d.ts": "export function useState<T>(v: T): [T, (v: T) => void];" });
        },
        loadPackageTypings: () => opts?.pkgTypingsPromise ?? Promise.resolve({}),
        fetchPackageStatuses: (urls) => (opts?.statuses ? opts.statuses(urls) : Promise.resolve(Object.fromEntries(urls.map((u) => [u, { state: "ready" } as PackageStatus])))),
        subscribePackageStore(cb) {
            storeListener = cb;
            return { dispose: () => void (storeListener = null) };
        },
        onChecked: () => void onCheckedCount++,
    });

    return {
        ws,
        extraLibs,
        getFlushedLibs: () => flushedLibs,
        modelsByUri,
        markers,
        markerWrites,
        checkedOrder,
        getWorkerSyncCalls: () => workerSyncCalls,
        getBuiltinFetches: () => builtinFetches,
        getOnCheckedCount: () => onCheckedCount,
        setActive(m: FakeModel | null) {
            active = m;
            ws.prioritize(m);
        },
        emitPackageStore(typings: Record<string, string> | undefined) {
            storeListener?.(typings);
        },
        addModel(path: string, code: string) {
            const m = makeModel(path, code);
            modelsByUri.set(m.uri.toString(), m);
            return m;
        },
    };
}

describe("tsWorkspace", () => {
    it("stages built-in, package, and data-file typings plus sibling models before running a single prioritized check pass", async () => {
        const builtins = deferred<Record<string, string>>();
        const pkgTypes = deferred<Record<string, string>>();
        const pkgStatuses = deferred<Record<string, PackageStatus> | undefined>();

        const h = makeHarness({
            builtinPromise: builtins.promise,
            pkgTypingsPromise: pkgTypes.promise,
            statuses: () => pkgStatuses.promise,
            diagnose(uri, { flushedLibs, syncedUris }) {
                const errs: TsDiagnosticLike[] = [];
                if (!flushedLibs.has("file:///node_modules/@types/react/index.d.ts")) {
                    errs.push({ category: 1, code: 2307, messageText: "Cannot find module 'react' or its corresponding type declarations." });
                }
                if (!flushedLibs.has("file:///.tangitweak/types/unpkg.com/cmdk@1.1.1/index.d.ts")) {
                    errs.push({ category: 1, code: 2307, messageText: "Cannot find module 'https://unpkg.com/cmdk@1.1.1' or its corresponding type declarations." });
                }
                if (!flushedLibs.has("file:///cfg/limits.d.json.ts")) {
                    errs.push({ category: 1, code: 2307, messageText: "Cannot find module './limits.json' or its corresponding type declarations." });
                }
                if (syncedUris.length < 3) {
                    errs.push({ category: 1, code: 2307, messageText: "Cannot find module './lib' or its corresponding type declarations." });
                }
                void uri;
                return errs;
            },
        });

        const lib = h.addModel("lib.ts", "export const x = 1;\n");
        const app = h.addModel("app.tsx", 'import { useState } from "react";\nimport { Command } from "https://unpkg.com/cmdk@1.1.1";\nimport limits from "./cfg/limits.json";\nimport { x } from "./lib";\nexport const v = () => <div>{useState(x)[0]}{String(Command)}{limits.max}</div>;\n');
        const other = h.addModel("other.ts", 'import { x } from "./lib";\nexport const y = x + 1;\n');

        const scripts: TsScriptEntry[] = [
            { id: "s1", name: "lib", model: lib },
            { id: "s2", name: "app.tsx", model: app },
            { id: "s3", name: "other", model: other },
        ];
        const data: TsDataInput[] = [{ path: "cfg/limits.json", text: '{"max": 10}\n' }];

        h.ws.sync(() => {}, () => scripts, () => data);
        // Active file selected right after sync (as selectReal does on startup)
        h.setActive(app);

        await flush();
        // Nothing checked yet while built-ins, package typings, and package statuses are still loading
        expect(h.checkedOrder).toEqual([]);
        expect(h.ws.isChecked(app)).toBe(false);

        pkgTypes.resolve({ "unpkg.com/cmdk@1.1.1/index.d.ts": "export declare const Command: any;" });
        await flush();
        expect(h.checkedOrder).toEqual([]);

        builtins.resolve({ "@types/react/index.d.ts": "export function useState<T>(v: T): [T, (v: T) => void];" });
        await flush();
        expect(h.checkedOrder).toEqual([]);

        pkgStatuses.resolve({ "https://unpkg.com/cmdk@1.1.1": { state: "ready" } });
        await flush();

        // Active model (`app.tsx`) checked first, every script checked once, zero false errors written
        expect(h.checkedOrder).toEqual([app.uri.toString(), lib.uri.toString(), other.uri.toString()]);
        expect(h.getWorkerSyncCalls()).toBe(1);
        expect(h.markerWrites.filter((w) => w.owner === TS_OWNER)).toEqual([]);
        expect(h.ws.isChecked(app)).toBe(true);
        expect(h.ws.isChecked(lib)).toBe(true);
        expect(h.ws.isChecked(other)).toBe(true);
        h.ws.dispose();
    });

    it("awaits built-in typings when a user first types a React/valtio import mid-session", async () => {
        const builtins = deferred<Record<string, string>>();
        const h = makeHarness({
            builtinPromise: builtins.promise,
            diagnose(uri, { flushedLibs }) {
                const code = h.modelsByUri.get(uri)?.getValue() ?? "";
                if (!code.includes('"valtio"')) return [];
                return flushedLibs.has("file:///node_modules/valtio/esm/index.d.mts")
                    ? []
                    : [{ category: 1, code: 2307, messageText: "Cannot find module 'valtio' or its corresponding type declarations." }];
            },
        });

        const plain = h.addModel("plain.ts", "export const a = 1;\n");
        h.ws.sync(() => {}, () => [{ id: "s1", name: "plain", model: plain }], () => []);
        await flush();
        // Plain TS script does not fetch the ~1.3 MB builtin-types.json
        expect(h.getBuiltinFetches()).toBe(0);
        expect(h.checkedOrder).toEqual([plain.uri.toString()]);

        // User edits plain.ts to import valtio
        plain.setValue('import { proxy } from "valtio";\nexport const st = proxy({ a: 1 });\n');
        await new Promise((r) => setTimeout(r, 25));
        expect(h.getBuiltinFetches()).toBe(1);
        // Must wait for builtin-types.json before running the worker check
        expect(h.checkedOrder).toHaveLength(1);
        expect(h.ws.isChecked(plain)).toBe(false);

        builtins.resolve({ "valtio/esm/index.d.mts": "export function proxy<T extends object>(x: T): T;" });
        await flush();

        expect(h.checkedOrder).toEqual([plain.uri.toString(), plain.uri.toString()]);
        expect(h.markerWrites.filter((w) => w.owner === TS_OWNER)).toEqual([]);
        expect(h.ws.isChecked(plain)).toBe(true);
        h.ws.dispose();
    });

    it("re-checks only the edited library and its transitive dependants, not unrelated scripts", async () => {
        const h = makeHarness();
        const lib = h.addModel("shared/lib.ts", "export const n = 1;\n");
        const mid = h.addModel("feat/mid.ts", 'import { n } from "../shared/lib";\nexport const m = n + 1;\n');
        const leaf = h.addModel("feat/leaf.ts", 'import { m } from "./mid";\nexport const out = m;\n');
        const unrelated = h.addModel("other/solo.ts", "export const solo = true;\n");

        const entries: TsScriptEntry[] = [
            { id: "1", name: "shared/lib", model: lib },
            { id: "2", name: "feat/mid", model: mid },
            { id: "3", name: "feat/leaf", model: leaf },
            { id: "4", name: "other/solo", model: unrelated },
        ];
        h.ws.sync(() => {}, () => entries, () => []);
        await flush();
        expect(h.checkedOrder).toHaveLength(4);
        h.checkedOrder.length = 0;

        h.setActive(lib);
        lib.setValue('export const n = "broken";\n');
        await new Promise((r) => setTimeout(r, 25));
        await flush();

        expect(h.checkedOrder).toEqual([lib.uri.toString(), mid.uri.toString(), leaf.uri.toString()]);
        expect(h.checkedOrder).not.toContain(unrelated.uri.toString());
        h.ws.dispose();
    });

    it("discards in-flight stale epoch diagnostics when package typings arrive mid-check", async () => {
        const firstCheckGate = deferred<void>();
        let calls = 0;
        const h = makeHarness({
            async diagnose(_uri, { flushedLibs }) {
                calls++;
                if (calls === 1) await firstCheckGate.promise;
                return flushedLibs.has("file:///.tangitweak/types/unpkg.com/redux@5.0.1/index.d.ts")
                    ? []
                    : [{ category: 1, code: 2307, messageText: "Cannot find module 'https://unpkg.com/redux@5.0.1' or its corresponding type declarations." }];
            },
        });

        const s = h.addModel("store.ts", 'import { compose } from "https://unpkg.com/redux@5.0.1";\nexport const c = compose;\n');
        h.ws.sync(() => {}, () => [{ id: "1", name: "store", model: s }], () => []);
        await flush();
        expect(calls).toBe(1);

        // New package typings land while check #1 is still in flight
        h.emitPackageStore({ "unpkg.com/redux@5.0.1/index.d.ts": "export declare function compose(): void;" });
        firstCheckGate.resolve();
        await flush(20);

        expect(calls).toBe(2);
        // Stale check #1 was discarded before setModelMarkers, so TS2307 was never published
        expect(h.markerWrites.filter((w) => w.owner === TS_OWNER)).toEqual([]);
        expect(h.ws.isChecked(s)).toBe(true);
        h.ws.dispose();
    });

    it("suppresses TS2307 while a package downloads, shows tt-imports warning, and marks JSX in .ts files", async () => {
        let state: PackageStatus = { state: "downloading" };
        const h = makeHarness({
            statuses: async (urls) => Object.fromEntries(urls.map((u) => [u, state])),
            diagnose: () => [
                { category: 1, code: 2307, messageText: "Cannot find module 'https://unpkg.com/dayjs@1.11.13' or its corresponding type declarations." },
                { category: 1, code: 2322, messageText: "Type 'string' is not assignable to type 'number'." },
            ],
        });

        const badJsx = h.addModel("ui.ts", 'import dayjs from "https://unpkg.com/dayjs@1.11.13";\nexport const el = <div>{String(dayjs)}</div>;\n');
        h.ws.sync(() => {}, () => [{ id: "1", name: "ui", model: badJsx }], () => []);
        await flush();

        // JSX in a .ts file gets the rename-to-.tsx marker
        const jsxMarkers = h.markers.get(badJsx.uri.toString())?.get(JSX_OWNER) ?? [];
        expect(jsxMarkers).toHaveLength(1);
        expect(jsxMarkers[0].code).toBe(JSX_IN_TS);

        // Downloading URL gets a tt-imports warning, and its TS2307 is suppressed while real TS2322 still shows
        const impMarkers = h.markers.get(badJsx.uri.toString())?.get(IMPORT_OWNER) ?? [];
        expect(impMarkers).toHaveLength(1);
        expect(impMarkers[0].message).toContain("downloading");
        const tsMarkers = h.markers.get(badJsx.uri.toString())?.get(TS_OWNER) ?? [];
        expect(tsMarkers.map((m) => m.code)).toEqual(["2322"]);

        // Once the package becomes ready (if TS2307 remained for e.g. a bad subpath), tt-imports clears and TS2307 reveals
        state = { state: "ready" };
        h.emitPackageStore(undefined);
        await flush();
        expect(h.markers.get(badJsx.uri.toString())?.get(IMPORT_OWNER) ?? []).toEqual([]);
        expect((h.markers.get(badJsx.uri.toString())?.get(TS_OWNER) ?? []).map((m) => m.code)).toEqual(["2307", "2322"]);
        h.ws.dispose();
    });

    it("re-checks JSON data-file importers when setDataFiles updates declarations", async () => {
        const h = makeHarness();
        const cfgConsumer = h.addModel("consumer.ts", 'import cfg from "./data.json";\nexport const v = cfg;\n');
        const other = h.addModel("other.ts", "export const ok = 1;\n");
        const scripts: TsScriptEntry[] = [
            { id: "1", name: "consumer", model: cfgConsumer },
            { id: "2", name: "other", model: other },
        ];
        h.ws.sync(() => {}, () => scripts, () => [{ path: "data.json", text: '{"a": 1}\n' }]);
        await flush();
        h.checkedOrder.length = 0;

        const changed = h.ws.setDataFiles([{ path: "data.json", text: '{"a": "changed"}\n' }]);
        expect(changed.length).toBeGreaterThan(0);
        await flush();

        expect(h.checkedOrder).toEqual([cfgConsumer.uri.toString()]);
        h.ws.dispose();
    });
});
