import { describe, expect, it } from "vitest";
import { builtinModule, builtinsReady, ensureBuiltins, setBuiltinLoader, shippedSources, sourceLoader } from "../src/shared/builtins";
import { makeLibRequire } from "../src/shared/scriptImports";

describe("built-ins in isolated onPage code", () => {
    it("valtio alone needs no React; react-dom/client loads the chunk from its source", async () => {
        let asked = 0;
        setBuiltinLoader(
            sourceLoader(async () => {
                asked++;
                return `globalThis.__wtBuiltinReact = { react: { tag: "R" }, "react-dom/client": { createRoot: () => "root" } };`;
            })
        );
        expect(builtinsReady([`import { subscribe } from "valtio";`])).toBe(true);
        const { codes, packages } = shippedSources([`const c = require("react-dom/client");`], [{ name: "lib", src: "module.exports = 1;" }]);
        expect(codes).toHaveLength(2);
        expect(builtinsReady(codes, packages)).toBe(false);
        await ensureBuiltins(codes, packages);
        await ensureBuiltins(codes, packages);
        expect(asked).toBe(1);
        expect(builtinsReady(codes, packages)).toBe(true);
        const req = makeLibRequire([], () => {}, { builtin: (spec, _i, loadUrl) => builtinModule(spec, "", loadUrl) })("main");
        expect(req("react-dom/client").createRoot()).toBe("root");
        expect(typeof req("valtio").proxy).toBe("function");
    });

    it("a library's React import counts too", () => {
        setBuiltinLoader(sourceLoader(async () => ""));
        const { codes, packages } = shippedSources([""], [{ name: "ui", src: `const R = require("react");` }]);
        expect(builtinsReady(codes, packages)).toBe(false);
    });
});
