/**
 * `tt.fetch(..., { from: "background" })`: the fetch runs here, with the
 * extension's host permissions (no CORS) and the browser's own cookie jar.
 * `bypass` registers the request so no script's handlers touch it.
 */
import type { WireRequest, WireResponse } from "../../shared/wire";
import { fromWireRequest, toWireResponse } from "../../shared/ttFetch";
import { addBypass, withBypassRule } from "./bypass";

export async function backgroundFetch(w: WireRequest, o: { bypass: boolean; scriptId: string; scriptName: string }): Promise<WireResponse> {
    const [url, init] = fromWireRequest(w, { credentials: "include" });
    const run = async () => toWireResponse(await fetch(url, init));
    if (!o.bypass) return run();
    const remove = addBypass({ method: w.method, url, tabId: -1, scriptId: o.scriptId, scriptName: o.scriptName });
    try {
        return await withBypassRule(w.method, url, run);
    } finally {
        remove();
    }
}
