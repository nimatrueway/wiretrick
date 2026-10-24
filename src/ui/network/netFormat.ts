import type { NetEntry } from "../../shared/netTypes";

export type TypeFilter = "all" | "fetch" | "doc" | "css" | "js" | "img" | "media" | "font" | "ws" | "other";

export const TYPE_FILTERS: { id: TypeFilter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "fetch", label: "Fetch/XHR" },
    { id: "doc", label: "Doc" },
    { id: "css", label: "CSS" },
    { id: "js", label: "JS" },
    { id: "img", label: "Img" },
    { id: "media", label: "Media" },
    { id: "font", label: "Font" },
    { id: "ws", label: "WS" },
    { id: "other", label: "Other" },
];

export type TypeCategory = Exclude<TypeFilter, "all">;
/** every request category */
export const ALL_TYPES: TypeCategory[] = TYPE_FILTERS.filter((t) => t.id !== "all").map((t) => t.id as TypeCategory);

/** webRequest resource type → devtools-style category */
export function category(e: NetEntry): TypeCategory {
    switch (e.type) {
        case "xmlhttprequest":
        case "fetch":
            return "fetch";
        case "main_frame":
        case "sub_frame":
            return "doc";
        case "stylesheet":
            return "css";
        case "script":
            return "js";
        case "image":
        case "imageset":
            return "img";
        case "media":
            return "media";
        case "font":
            return "font";
        case "websocket":
            return "ws";
        default:
            return "other";
    }
}

/** devtools "Type" column text */
export function typeLabel(e: NetEntry): string {
    if (e.synthetic) return "script";
    const map: Record<string, string> = {
        main_frame: "document",
        sub_frame: "document",
        xmlhttprequest: "xhr",
        stylesheet: "stylesheet",
        script: "script",
        image: "img",
        imageset: "img",
        font: "font",
        media: "media",
        websocket: "websocket",
        ping: "ping",
        csp_report: "csp",
        object: "object",
    };
    return map[e.type] || e.type || "other";
}

export function displayName(url: string): { name: string; host: string } {
    try {
        const u = new URL(url);
        const last = u.pathname.split("/").filter(Boolean).pop();
        return { name: (last || u.host) + u.search, host: u.host };
    } catch {
        return { name: url, host: "" };
    }
}

export function formatBytes(n: number | null): string {
    if (n === null) return "—";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function duration(e: NetEntry): number | null {
    return e.endedAt === null ? null : Math.max(0, e.endedAt - e.startedAt);
}

export function formatMs(ms: number | null): string {
    if (ms === null) return "pending";
    if (ms < 1000) return `${Math.round(ms)} ms`;
    return `${(ms / 1000).toFixed(2)} s`;
}

export function statusText(e: NetEntry): string {
    if (e.state === "failed") return e.error?.replace(/^net::/, "") || "(failed)";
    if (e.synthetic) return "(script)";
    if (e.status === null) return "(pending)";
    return String(e.status);
}

/** "modified" if any script changed the request, "observed" if one only ran on it ("missed" warnings don't count) */
export type TouchState = "none" | "observed" | "modified";

export function touchState(e: NetEntry): TouchState {
    let observed = false;
    for (const i of e.outcomes) {
        if (i.kind === "modified") return "modified";
        if (i.kind === "observed") observed = true;
    }
    return observed ? "observed" : "none";
}

/** observed = rows a script ran on without changing them; modified = rows a script changed */
export function touchCounts(rows: NetEntry[]): { observed: number; modified: number } {
    let observed = 0;
    let modified = 0;
    for (const e of rows) {
        const t = touchState(e);
        if (t === "observed") observed++;
        else if (t === "modified") modified++;
    }
    return { observed, modified };
}

export type SortKey = "start" | "name" | "status" | "method" | "type" | "script" | "size" | "time";

export function compare(key: SortKey): (a: NetEntry, b: NetEntry) => number {
    const num = (f: (e: NetEntry) => number | null) => (a: NetEntry, b: NetEntry) => (f(a) ?? -1) - (f(b) ?? -1);
    const str = (f: (e: NetEntry) => string) => (a: NetEntry, b: NetEntry) => f(a).localeCompare(f(b));
    switch (key) {
        case "name":
            return str((e) => displayName(e.url).name);
        case "status":
            return num((e) => e.status);
        case "method":
            return str((e) => e.method);
        case "type":
            return str(typeLabel);
        case "script":
            return str((e) => e.outcomes.map((i) => i.scriptName).join(","));
        case "size":
            return num((e) => e.size);
        case "time":
            return num(duration);
        default:
            return num((e) => e.startedAt);
    }
}
