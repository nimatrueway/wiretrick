/**
 * TypeScript → JS for user scripts (background side). Sucrase strips types
 * while preserving formatting (blank lines + comments survive).
 * Registered into compile.ts so bundled contexts without this module
 * (the page hook) compile plain JS only.
 */
import { transform } from "sucrase";
import { setTranspiler } from "./compile";
import { dlogLevel } from "./debugLog";

setTranspiler((code) => {
    try {
        return transform(code, { transforms: ["typescript", "imports"] }).code;
    } catch (e: any) {
        // the compile then falls back to the RAW source, which new Function
        // usually rejects — the script's error field carries it; this log
        // says WHY (a TS syntax sucrase can't handle)
        dlogLevel("compile", "warn", `TS transpile failed — running raw source (likely a syntax error): ${e?.message || e}`);
        throw e;
    }
});
