/** The diagnostic report's optional sections, in report order (the picker lists them so). */
export const DIAG_SECTIONS = [
    { id: "environment", label: "Environment", detail: "browser, OS, extension build, Editor layout" },
    { id: "extensions", label: "Other installed extensions", detail: "asks for the management permission" },
    { id: "state", label: "Engine state", detail: "local helper, folder sync, open tabs' URLs" },
    { id: "problems", label: "Problems", detail: "the Problems view" },
    { id: "settings", label: "settings.yaml", detail: "globals and every script's params" },
    { id: "stores", label: "Stores", detail: "globalStore and open tabs' tabStore / pageStore data (capped)" },
    { id: "log", label: "Log", detail: "the Log view's lines" },
    { id: "debug", label: "Debug log", detail: "debug-level lines" },
    { id: "network", label: "Network", detail: "last 300 requests; credentials redacted, bodies capped" },
] as const;

export type DiagSection = (typeof DIAG_SECTIONS)[number]["id"];

/** what the report holds; a missing field means all of it */
export interface DiagnosticsInclude {
    sections?: DiagSection[];
    /** script ids */
    scripts?: string[];
}
