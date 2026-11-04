/**
 * Support files folder sync keeps in the scripts folder for VS Code:
 * wt-api.d.ts (typings), tsconfig.json and settings.schema.json, plus the
 * package imports' and the built-in modules' (valtio, React) typings under
 * .wiretrick/types/. Wiretrick owns them:
 * they are rewritten whenever sync starts (every browser start and
 * extension update) if their content differs, so edits don't stick.
 */
import { builtinPaths } from "./builtinSpecs";
import { packagePaths, TYPINGS_ROOT } from "./packageImports";

/** the built-in modules' typings in the scripts folder (lib/builtin-types.json keys go under it) */
export const BUILTIN_TYPINGS_ROOT = `${TYPINGS_ROOT}/builtin`;

export const API_DTS_FILE = "wt-api.d.ts";
export const TSCONFIG_FILE = "tsconfig.json";

export const GENERATED_NOTE = "Managed by Wiretrick: rewritten on every browser start and extension update. Don't edit: your changes will be lost.";

/** the extension's typings with the do-not-edit header */
export const apiDtsText = (dts: string): string => `// ${GENERATED_NOTE}\n\n${dts}`;

/** tsconfig.json (TypeScript and VS Code read it as JSON with comments) */
export function tsconfigText(): string {
    const config = {
        compilerOptions: {
            target: "esnext",
            lib: ["esnext", "dom", "dom.iterable"],
            // wt-api.d.ts declares web APIs (URLPattern…) that newer TS libs may also have
            skipLibCheck: true,
            module: "esnext",
            moduleResolution: "bundler",
            allowImportingTsExtensions: true,
            // `import x from "./mock/data.json"` (data files)
            resolveJsonModule: true,
            // .tsx scripts: the automatic runtime, the built-in React by default
            jsx: "react-jsx",
            noEmit: true,
            // package imports (`https://unpkg.com/x@1.2.3`) → their downloaded typings
            // and the built-ins (`valtio`, `react`, `react-dom/client`…) → the extension's typings of them
            paths: { ...packagePaths(`./${TYPINGS_ROOT}`), ...builtinPaths(`./${BUILTIN_TYPINGS_ROOT}`) },
        },
        include: ["**/*.ts", "**/*.tsx"],
    };
    return `// ${GENERATED_NOTE}\n${JSON.stringify(config, null, 2)}\n`;
}
