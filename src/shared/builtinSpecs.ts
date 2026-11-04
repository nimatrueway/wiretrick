/**
 * Which import specifiers name a built-in module (the extension's own
 * valtio and React, src/shared/builtins.ts). Pure, so the Editor, the page
 * hook and the download step can ask without loading the modules.
 */

export const REACT_BUILTINS = ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"] as const;
export const VALTIO_BUILTINS = ["valtio", "valtio/vanilla", "valtio/utils", "valtio/vanilla/utils", "valtio/react", "valtio/react/utils"] as const;
const ALL = new Set<string>([...REACT_BUILTINS, ...VALTIO_BUILTINS]);

const ESM_SH = /^https:\/\/esm\.sh\/(?:v\d+\/)?(react|react-dom|valtio)(?:@[^/?#]*)?((?:\/[^?#]*)?)(?:[?#].*)?$/;

/** the built-in a specifier names — bare (`valtio/react`) or an esm.sh URL of any version — or null */
export function builtinSpec(spec: string): string | null {
    if (ALL.has(spec)) return spec;
    const m = ESM_SH.exec(spec);
    if (!m) return null;
    const name = m[1] + (m[2] || "").replace(/\/$/, "");
    return ALL.has(name) ? name : null;
}

/** does the built-in need React (rather than only valtio's vanilla parts)? */
export function builtinNeedsReact(name: string, code = ""): boolean {
    if (name.startsWith("react")) return true;
    if (name === "valtio/react" || name === "valtio/react/utils") return true;
    // `valtio` and `valtio/utils` include the hooks; React loads only if the code uses them
    return (name === "valtio" || name === "valtio/utils") && /\buse(?:Snapshot|Proxy)\b/.test(code);
}

/**
 * A file whose JSX import source is a pinned unpkg Preact
 * (`/** @jsxImportSource https://unpkg.com/preact@10.26.4 *\/`): its
 * `react` imports go to that Preact's compat layer. Returns the package
 * root URL, or null.
 */
export function preactRoot(code: string): string | null {
    const m = /@jsxImportSource\s+(https:\/\/unpkg\.com\/preact@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?=[\s*/]|$)/.exec(code);
    return m ? m[1] : null;
}

/** what a Preact file's React built-in maps to */
export function preactTarget(root: string, name: string): string | null {
    if (name === "react" || name === "react-dom") return `${root}/compat`;
    if (name === "react-dom/client") return `${root}/compat/client`;
    if (name === "react/jsx-runtime" || name === "react/jsx-dev-runtime") return `${root}/jsx-runtime`;
    return null;
}

/** package URLs a file's built-in imports need downloaded (a Preact file's compat layer) */
export function builtinDownloads(code: string, specs: Iterable<string>): string[] {
    const root = preactRoot(code);
    if (!root) return [];
    const out = new Set<string>();
    for (const s of specs) {
        const b = builtinSpec(s);
        if (!b || !builtinNeedsReact(b, code)) continue;
        // valtio/react under Preact runs on preact/compat
        out.add(preactTarget(root, b) ?? `${root}/compat`);
    }
    return [...out];
}
