/**
 * TypeScript → JS for user scripts (background side). Sucrase strips types
 * while preserving formatting (blank lines + comments survive).
 * Registered into compile.ts so bundled contexts without this module
 * (the page hook) compile plain JS only.
 */
import { transform } from "sucrase";
import { setTranspiler } from "./compile";

setTranspiler((code) => transform(code, { transforms: ["typescript", "imports"] }).code);
