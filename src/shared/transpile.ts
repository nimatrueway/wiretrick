/**
 * TypeScript → JS for user scripts (background side). Sucrase strips types
 * while preserving formatting (blank lines + comments survive).
 * Registered into compile.ts so bundled contexts without this module
 * (the page hook) compile plain JS only.
 *
 * JSX compiles with the automatic runtime from `jsxImportSource(code)`
 * (the built-in React unless a `@jsxImportSource` pragma picks another).
 * Code that doesn't parse as TSX (an old-style `<T>value` cast) compiles
 * as plain TypeScript.
 *
 * Modern syntax (`?.`, `??`, class fields) stays as written: Sucrase would
 * otherwise rewrite it into helpers declared at the top of the module, which
 * code run from its source elsewhere wouldn't have.
 */
import { transform } from "sucrase";
import { jsxImportSource } from "./builtinSpecs";
import { setTranspiler } from "./compile";
import { dlogLevel } from "./debugLog";

setTranspiler((code) => {
    try {
        return transform(code, { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic", jsxImportSource: jsxImportSource(code), production: true, disableESTransforms: true }).code;
    } catch {}
    try {
        return transform(code, { transforms: ["typescript", "imports"], disableESTransforms: true }).code;
    } catch (e: any) {
        // the script's error (Problems view) carries the syntax error and its line
        dlogLevel("compile", "debug", "TS transpile failed (a syntax error — see the Problems view)");
        throw e;
    }
});
