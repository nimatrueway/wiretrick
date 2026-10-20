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

/** webRequest resource type → devtools-style category */
export function category(e: NetEntry): Exclude<TypeFilter, "all"> {
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

export interface NetFilter {
    text: string;
    type: TypeFilter;
    interceptedOnly: boolean;
    tabId: number | null;
}

export function matches(e: NetEntry, f: NetFilter): boolean {
    if (f.type !== "all" && category(e) !== f.type) return false;
    if (f.interceptedOnly && e.interventions.length === 0) return false;
    if (f.tabId !== null && e.tabId !== f.tabId) return false;
    const q = f.text.trim();
    if (!q) return true;
    const negate = q.startsWith("-");
    const needle = (negate ? q.slice(1) : q).toLowerCase();
    if (!needle) return true;
    const hay = `${e.url} ${e.method} ${e.status ?? ""} ${e.mime} ${e.interventions.map((i) => i.scriptName).join(" ")}`.toLowerCase();
    return hay.includes(needle) !== negate;
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
            return str((e) => e.interventions.map((i) => i.scriptName).join(","));
        case "size":
            return num((e) => e.size);
        case "time":
            return num(duration);
        default:
            return num((e) => e.startedAt);
    }
}
