/** Settings → About (version, build, browser, OS, helper) and the
 * "Collect diagnostics…" report (assembled by the background page). */

interface UaBrand {
    brand: string;
    version: string;
}
export interface UaHighEntropy {
    platform?: string;
    platformVersion?: string;
    architecture?: string;
    bitness?: string;
    fullVersionList?: UaBrand[];
}
export interface HelperStatus {
    state: string;
    version?: string;
    port?: number;
    outdated?: boolean;
    error?: string;
}

/** userAgentData high-entropy values (Chromium only), or null. */
export async function uaHighEntropy(): Promise<UaHighEntropy | null> {
    const uad = (navigator as any).userAgentData;
    if (!uad?.getHighEntropyValues) return null;
    try {
        return await uad.getHighEntropyValues(["fullVersionList", "platformVersion", "architecture", "bitness"]);
    } catch {
        return null;
    }
}

/** "Google Chrome 131.0.6778.86 (Chromium 131.0.6778.86)", "Firefox 133.0", or the raw UA. */
export function describeBrowser(ua: UaHighEntropy | null, userAgent: string, firefox?: { name: string; version: string } | null): string {
    if (firefox) return `${firefox.name} ${firefox.version}`;
    const list = (ua?.fullVersionList ?? []).filter((b) => !/not.?a.?brand/i.test(b.brand));
    const engine = list.find((b) => b.brand === "Chromium");
    const product = list.find((b) => b !== engine) ?? engine;
    if (!product) return userAgent;
    const name = `${product.brand} ${product.version}`;
    return engine && product !== engine ? `${name} (Chromium ${engine.version})` : name;
}

/** "linux x86-64 (6.8.0)" from runtime.getPlatformInfo + userAgentData. */
export function describeOs(platform: { os?: string; arch?: string } | null, ua: UaHighEntropy | null): string {
    const parts = [platform?.os ?? ua?.platform ?? "unknown", platform?.arch ?? ua?.architecture].filter(Boolean);
    return parts.join(" ") + (ua?.platformVersion ? ` (${ua.platformVersion})` : "");
}

export function describeHelper(st: HelperStatus | null): string {
    if (!st) return "unknown";
    const v = st.version ? ` v${st.version}${st.outdated ? " (outdated)" : ""}` : "";
    if (st.state === "ready") return `running${v}${st.port ? ` on 127.0.0.1:${st.port}` : ""}`;
    if (st.state === "error") return `error${v}: ${st.error || "unknown"}`;
    if (st.state === "idle") return "not needed";
    return `${st.state}${v}`;
}

function platformInfo(): Promise<{ os?: string; arch?: string } | null> {
    return new Promise((r) => {
        try {
            chrome.runtime.getPlatformInfo((p) => r(chrome.runtime.lastError ? null : p));
        } catch {
            r(null);
        }
    });
}

async function firefoxInfo(): Promise<{ name: string; version: string } | null> {
    try {
        return (await (globalThis as any).browser?.runtime?.getBrowserInfo?.()) ?? null;
    } catch {
        return null;
    }
}

export const RELEASES_URL = "https://github.com/nimatrueway/wiretrick/releases";
const LATEST_RELEASE_API = "https://api.github.com/repos/nimatrueway/wiretrick/releases/latest";

export interface LatestRelease {
    version: string;
    url: string;
}

/** True when `latest` (x.y.z, optional leading v) is newer than `current`. */
export function isNewerVersion(latest: string, current: string): boolean {
    const parse = (v: string) => v.replace(/^v/, "").split(/[.+-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
    const [a, b] = [parse(latest), parse(current)];
    for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
    return false;
}

/** The "Latest" About row: text, plus the release page when an update exists. */
export function describeLatest(latest: LatestRelease, current: string): { text: string; url?: string; update?: boolean } {
    if (isNewerVersion(latest.version, current)) return { text: `${latest.version} — update available`, url: latest.url, update: true };
    return { text: `${latest.version} — up to date` };
}

let latestCheck: Promise<LatestRelease> | null = null;
/** Latest published GitHub release; fetched once per page (a failure retries next time). */
export function checkLatestRelease(fetchFn: typeof fetch = fetch): Promise<LatestRelease> {
    latestCheck ??= (async () => {
        const res = await fetchFn(LATEST_RELEASE_API, { headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
        const j = await res.json();
        if (typeof j?.tag_name !== "string") throw new Error("no release tag");
        return { version: j.tag_name.replace(/^v/, ""), url: typeof j.html_url === "string" ? j.html_url : RELEASES_URL };
    })().catch((e) => {
        latestCheck = null;
        throw e;
    });
    return latestCheck;
}

/** Build timestamp (ISO, UTC) in the user's time zone, e.g. "Oct 21, 2026, 4:08:58 PM PDT". */
export function formatBuildTime(iso: string, timeZone?: string): string {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "long", timeZone });
}

/** Label/value rows for the About section, in display order. */
export async function aboutRows(helper: HelperStatus | null): Promise<[string, string][]> {
    const manifest = chrome.runtime.getManifest();
    const [ua, platform, firefox] = await Promise.all([uaHighEntropy(), platformInfo(), firefoxInfo()]);
    return [
        ["Version", manifest.version],
        ["Commit", __COMMIT__],
        ["Built", formatBuildTime(__BUILD_TIME__)],
        ["Build", `${__MV3__ ? "MV3" : "MV2"} (manifest_version ${manifest.manifest_version})`],
        ["Browser", describeBrowser(ua, navigator.userAgent, firefox)],
        ["OS", describeOs(platform, ua)],
        ["Extension ID", chrome.runtime.id],
        ["Local helper", describeHelper(helper)],
    ];
}

export function aboutText(rows: [string, string][]): string {
    const w = Math.max(...rows.map(([k]) => k.length));
    return ["Wiretrick", ...rows.map(([k, v]) => `${(k + ":").padEnd(w + 2)}${v}`)].join("\n");
}

export function diagnosticsFileName(d = new Date()): string {
    return `wiretrick-diagnostics-${d.toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z")}.md`;
}

export function downloadText(name: string, text: string, type = "text/plain"): void {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Must run straight from a click/keypress: permissions.request needs the user gesture. */
function requestManagement(): Promise<boolean> {
    return new Promise((r) => {
        try {
            chrome.permissions.request({ permissions: ["management"] }, (ok) => r(!chrome.runtime.lastError && !!ok));
        } catch {
            r(false);
        }
    });
}

async function installedExtensions(): Promise<unknown> {
    if (!(await requestManagement())) return "permission declined";
    try {
        const all = await new Promise<chrome.management.ExtensionInfo[]>((r, j) =>
            chrome.management.getAll((l) => (chrome.runtime.lastError ? j(new Error(chrome.runtime.lastError.message)) : r(l)))
        );
        return all
            .filter((x) => x.id !== chrome.runtime.id)
            .map((x) => ({ name: x.name, id: x.id, version: x.version, enabled: x.enabled, permissions: x.permissions }));
    } catch (e: any) {
        return `unavailable: ${e?.message || e}`;
    }
}

/** Ask the background for the Markdown report; `ui` adds manager-side context. */
export async function collectDiagnostics(ui: Record<string, unknown>): Promise<string> {
    const extensions = await installedExtensions();
    const extra = {
        extensions,
        ui: {
            userAgentData: await uaHighEntropy(),
            screen: { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight, devicePixelRatio },
            window: { width: innerWidth, height: innerHeight },
            ...ui,
        },
    };
    const r: any = await new Promise((res) => chrome.runtime.sendMessage({ type: "collectDiagnostics", extra }, (x) => res(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : x)));
    if (!r?.report) throw new Error(r?.error || "no report returned");
    return r.report;
}
