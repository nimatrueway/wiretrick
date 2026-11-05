/**
 * The built-in React chunk's source, for isolated onPage code that imports
 * React: its world evaluates it (a <script> tag would run it in the page).
 * MV2/Firefox: the bridge asks with `getBuiltinReact`; MV3: user-script
 * worlds over L6 (`builtin.react`).
 */
import { REACT_CHUNK } from "../shared/builtins";

let source: Promise<string> | null = null;

export function reactChunkSource(): Promise<string> {
    source ??= fetch(chrome.runtime.getURL(REACT_CHUNK)).then((r) => {
        if (!r.ok) throw new Error(`${REACT_CHUNK}: HTTP ${r.status}`);
        return r.text();
    });
    source.catch(() => (source = null));
    return source;
}
