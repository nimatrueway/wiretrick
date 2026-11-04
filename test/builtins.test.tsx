import { describe, it, expect, beforeAll } from "vitest";
import { act, render } from "@testing-library/react";
import * as React from "react";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
import * as JsxRuntime from "react/jsx-runtime";
import * as vanilla from "valtio/vanilla";
import "../src/shared/transpile";
import { compileWithLibs, makeModuleResolver } from "../src/shared/compile";
import { builtinModule, ensureBuiltins, needsReact, setBuiltinLoader } from "../src/shared/builtins";
import { builtinDownloads, builtinSpec } from "../src/shared/builtinSpecs";
import { badPackageImports } from "../src/shared/scriptImports";
import { endpointPair } from "../src/shared/wire";
import { ReplicaHub } from "../src/shared/storeReplica";
import { StoreOwner } from "../src/background/engine/storeOwner";

const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

const PREACT = "https://unpkg.com/preact@10.26.4";

describe("built-in module specifiers", () => {
    it("maps bare and esm.sh react/valtio specifiers, not unpkg ones", () => {
        expect(builtinSpec("valtio")).toBe("valtio");
        expect(builtinSpec("valtio/react")).toBe("valtio/react");
        expect(builtinSpec("react-dom/client")).toBe("react-dom/client");
        expect(builtinSpec("https://esm.sh/valtio@2.1.0")).toBe("valtio");
        expect(builtinSpec("https://esm.sh/valtio@2/vanilla/utils?bundle")).toBe("valtio/vanilla/utils");
        expect(builtinSpec("https://esm.sh/react@19")).toBe("react");
        expect(builtinSpec("https://esm.sh/v135/react-dom@18.3.1/client")).toBe("react-dom/client");
        expect(builtinSpec("https://esm.sh/react@19/jsx-runtime")).toBe("react/jsx-runtime");
        expect(builtinSpec("https://unpkg.com/react@19.0.0")).toBeNull();
        expect(builtinSpec("https://esm.sh/react-router@7")).toBeNull();
        expect(builtinSpec("react-router")).toBeNull();
        expect(builtinSpec("valtio/macro")).toBeNull();
    });
    it("doesn't flag an esm.sh built-in as a bad package import", () => {
        expect(badPackageImports(`import { proxy } from "https://esm.sh/valtio@2";`)).toEqual([]);
        expect(badPackageImports(`import x from "https://esm.sh/lodash@4";`)).toHaveLength(1);
    });
    it("needs React only for React imports or valtio hooks", () => {
        expect(needsReact([`import { proxy } from "valtio";`])).toBe(false);
        expect(needsReact([`import { proxy, useSnapshot } from "valtio";`])).toBe(true);
        expect(needsReact([`import { useSnapshot } from "valtio/react";`])).toBe(true);
        expect(needsReact([`import { useState } from "https://esm.sh/react@19";`])).toBe(true);
        expect(needsReact([`/** @jsxImportSource ${PREACT} */\nimport { useState } from "react";`])).toBe(false);
        expect(needsReact([], { aliases: {}, modules: { u: { js: "", requires: { react: "x" } } } })).toBe(true);
    });
    it("downloads a Preact file's compat layer for its react imports", () => {
        const code = `/** @jsxImportSource ${PREACT} */\nimport { useState } from "react";\nimport { createRoot } from "react-dom/client";\nimport { proxy } from "valtio";`;
        expect(builtinDownloads(code, ["react", "react-dom/client", "valtio"]).sort()).toEqual([`${PREACT}/compat`, `${PREACT}/compat/client`]);
        expect(builtinDownloads(`import "react";`, ["react"])).toEqual([]);
    });
});

describe("built-in module resolution", () => {
    beforeAll(async () => {
        setBuiltinLoader(async () => ({ react: React, "react-dom": ReactDOM, "react-dom/client": ReactDOMClient, "react/jsx-runtime": JsxRuntime, "react/jsx-dev-runtime": JsxRuntime }));
        await ensureBuiltins([`import "react";`]);
    });

    it("resolves bare and esm.sh valtio to the extension's own copy", () => {
        const r = makeModuleResolver([{ id: "m", name: "main", code: "" }], () => ({}));
        const from = r.resolveFrom("main");
        expect(from("valtio").proxy).toBe(vanilla.proxy);
        expect(from("https://esm.sh/valtio@2.3.0").subscribe).toBe(vanilla.subscribe);
        expect(from("valtio/vanilla")).toBe(vanilla);
        expect(typeof from("valtio/utils").subscribeKey).toBe("function");
        expect(typeof from("valtio/react").useSnapshot).toBe("function");
        expect(from("valtio").useSnapshot).toBe(from("valtio/react").useSnapshot);
        expect(r.deps.size).toBe(0);
    });

    it("resolves bare and esm.sh React to the built-in React", () => {
        const r = makeModuleResolver([{ id: "m", name: "main", code: "" }], () => ({}));
        expect(r.resolve("react")).toBe(React);
        expect(r.resolve("https://esm.sh/react@19.0.0")).toBe(React);
        expect(r.resolve("react-dom/client")).toBe(ReactDOMClient);
        expect(r.resolve("react/jsx-runtime")).toBe(JsxRuntime);
    });

    it("prefers a script with the same name as a bare built-in", () => {
        const c = compileWithLibs(
            { id: "m", name: "main", code: `import { v } from "valtio";\nexport const got = v;` },
            [{ id: "l", name: "valtio", code: `export const v = "mine";` }]
        );
        expect(c.error).toBeNull();
        expect(c.exports.got).toBe("mine");
    });

    it("maps a Preact file's react imports to preact/compat", () => {
        const compat = { useState: "preact-useState", useSyncExternalStore: () => {} };
        const packages = {
            aliases: {},
            modules: { [`${PREACT}/compat/dist/compat.js`]: { js: "module.exports = globalThis.__compat;", requires: {} } },
        };
        packages.aliases = { [`${PREACT}/compat`]: `${PREACT}/compat/dist/compat.js` };
        (globalThis as any).__compat = compat;
        const code = `/** @jsxImportSource ${PREACT} */\nimport { useState } from "react";\nexport const s = useState;`;
        const c = compileWithLibs({ id: "m", name: "main", code }, [], {}, [], packages);
        expect(c.error).toBeNull();
        expect(c.exports.s).toBe("preact-useState");
        expect(c.deps).toContain(`${PREACT}/compat`);
        delete (globalThis as any).__compat;
    });

    it("gives a downloaded package's require('react') the built-in, except inside React itself", () => {
        const packages = {
            aliases: {},
            modules: {
                "https://unpkg.com/uses-react@1.0.0/index.js": { js: "module.exports = require('react');", requires: { react: "https://unpkg.com/react@19.0.0/index.js" } },
                "https://unpkg.com/react@19.0.0/index.js": { js: "module.exports = { own: true, inner: require('react') };", requires: { react: "!no" } },
            },
        };
        const r = makeModuleResolver([], () => ({}), { packages });
        expect(r.resolve("https://unpkg.com/uses-react@1.0.0/index.js")).toBe(React);
        // unpkg React's own require("react") isn't redirected
        expect(() => r.resolve("https://unpkg.com/react@19.0.0/index.js")).toThrow(/no/);
    });

    it("useSnapshot from the resolved valtio/react re-renders only components that read a changed path", async () => {
        const { useSnapshot } = builtinModule("valtio/react");
        const owner = new StoreOwner({ storageAll: async () => ({}), storageSet: async () => {}, persistDelayMs: 1 });
        const hub = (ctx: string) => {
            const [a, b] = endpointPair();
            owner.attach(a, { all: true });
            const h = new ReplicaHub({ ctx, log: () => {} });
            h.attach(b);
            return h;
        };
        const here = hub("ui").store("s", "st", { a: 1, b: 1 });
        const there = hub("bg").store("s", "st", { a: 1, b: 1 });
        await settle();
        const renders = { a: 0, b: 0 };
        function A() {
            const s = useSnapshot(here);
            renders.a++;
            return <i data-testid="a">{s.a}</i>;
        }
        function B() {
            const s = useSnapshot(here);
            renders.b++;
            return <i data-testid="b">{s.b}</i>;
        }
        const v = render(
            <>
                <A />
                <B />
            </>
        );
        const before = { ...renders };
        await act(async () => {
            there.b = 2;
            await settle();
        });
        expect(here.b).toBe(2);
        expect(v.getByTestId("b").textContent).toBe("2");
        expect(renders.b).toBeGreaterThan(before.b);
        expect(renders.a).toBe(before.a);
        v.unmount();
    });
});
