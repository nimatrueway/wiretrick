import { proxy, ref } from "valtio";
import { aboutRows, checkLatestRelease, describeLatest, RELEASES_URL, type HelperStatus } from "../about";
import type { LaunchMode } from "../bundle";
import type { ThemePref } from "../theme";
import { DEFAULT_BODY_CAP } from "../../shared/settingsYaml";
import { helperInstallCommand, helperInstallShell } from "../../shared/helperInstall";

/** What the local helper reports (`processStatus`). */
export type HelperReport = HelperStatus & {
    scripts?: string[];
    extensionId: string;
    routing?: { active: boolean; reason?: string; mode?: string; note?: string };
    caTrusted?: boolean;
    caFingerprint?: string;
    caPath?: string;
    trust?: { msg: string };
};

/** The scripts folder: off, synced, or saved but waiting for a permission click. */
export type FolderMode = "off" | "synced" | "reconnect";

/**
 * The Settings dialog's values. The log level, panel history and status-bar
 * counts live in the log / panel stores they configure.
 */
export const settings = proxy({
    themePref: "system" as ThemePref,
    monacoVerbose: false,
    /** Network body capture, kB */
    bodyCap: DEFAULT_BODY_CAP,
    /** absolute path of the synced folder, for the ↗ button */
    vscodePath: "",
    launchMode: "vscode" as LaunchMode,
    /** the custom editor's URL template */
    editorUrl: "",
    folder: {
        /** the File System Access API is available (not in Firefox) */
        supported: true,
        mode: "off" as FolderMode,
        /** the synced folder as reported (a name, or an absolute path) */
        path: "",
        /** Folder path is missing or names another folder: the warning, else "" */
        pathWarning: "",
        /** bumped to draw the eye to Folder path */
        flash: 0,
    },
    helper: null as HelperReport | null,
    /** About's rows, Latest included */
    about: ref({ rows: [] as [string, string][], latest: { text: "" } as { text: string; url?: string; update?: boolean } }),
    diagnostics: { busy: false, text: "", title: "", report: "" },
});

/** #folder-state: where the scripts are synced */
export function folderStateText(f: { mode: FolderMode; path: string }): string {
    return f.mode === "synced" ? f.path || "(syncing)" : f.mode === "reconnect" ? "reconnect needed" : "";
}

/** Local helper status: the state line, the detail lines and which buttons show. */
export function helperView(st: HelperReport) {
    const labels: Record<string, string> = {
        idle: "not needed — no enabled handler uses the \"helper\" strategy",
        unsupported: "unavailable in this browser (Chrome only) — handlers using \"helper\" don't run",
        connecting: "connecting…",
        ready: `running${st.version ? ` (v${st.version})` : ""}${st.port ? ` on 127.0.0.1:${st.port}` : ""}`,
        missing: "not installed",
        error: `error: ${st.error || "unknown"}`,
    };
    const lines: string[] = [];
    if (st.scripts?.length) lines.push(`Scripts: ${st.scripts.join(", ")}`);
    if (st.state === "missing") {
        lines.push(`Install the helper: paste this into ${helperInstallShell()}, then click Retry:`);
        lines.push(`  ${helperInstallCommand(st.extensionId)}`);
    }
    if (st.state === "ready") {
        if (st.outdated) {
            lines.push(`⚠ The helper (v${st.version}) is older than this extension needs — upgrade it: paste this into ${helperInstallShell()}, then click Retry:`);
            lines.push(`  ${helperInstallCommand(st.extensionId)}`);
        }
        if (st.routing && !st.routing.active && st.routing.reason) lines.push(`Routing inactive: ${st.routing.reason}`);
        if (st.routing?.active) lines.push(`Other traffic: your proxy setting (${st.routing.mode})`);
        if (st.routing?.note) lines.push(st.routing.note);
        if (st.caTrusted === false) lines.push("Chrome does not trust the helper certificate yet — click Trust certificate (or run: wiretrick-helper trust-ca).");
        if (st.caTrusted === true) lines.push("Helper certificate trusted ✓");
        if (st.caFingerprint) lines.push(`Helper certificate: ${st.caPath} (SHA-256 ${st.caFingerprint})`);
    }
    if (st.trust) lines.push(`Trust certificate: ${st.trust.msg}`);
    const needsInstall = st.state === "missing" || !!st.outdated;
    return {
        state: labels[st.state] || st.state,
        detail: lines.join("\n"),
        trust: st.state === "ready" && st.caTrusted !== true,
        /** the install command to copy, or "" */
        installCommand: needsInstall ? helperInstallCommand(st.extensionId) : "",
        retry: !((st.state === "ready" && !st.outdated) || st.state === "idle" || st.state === "unsupported"),
    };
}

export function setHelperStatus(st: HelperReport | null | undefined): void {
    if (st) settings.helper = ref(st);
}

/** Ask the background for the helper's status. */
export function queryHelperStatus(type: "processStatus" | "processRetry" = "processStatus"): void {
    chrome.runtime.sendMessage({ type }, (st) => {
        void chrome.runtime.lastError;
        setHelperStatus(st);
    });
}

/** About's rows as copied: version, Latest, then the rest. */
export function aboutInfo(a: { rows: readonly (readonly [string, string])[]; latest: { text: string } }): [string, string][] {
    return a.rows.length ? [[...a.rows[0]], ["Latest", a.latest.text], ...a.rows.slice(1).map(([k, v]): [string, string] => [k, v])] : [];
}

let aboutGen = 0;
/** Reload About's rows, then check for a newer release. */
export async function refreshAbout(): Promise<void> {
    const gen = ++aboutGen;
    const rows = await aboutRows(settings.helper);
    if (gen !== aboutGen) return;
    settings.about = ref({ rows, latest: { text: "checking…" } });
    const latest = await checkLatestRelease().then(
        (r) => describeLatest(r, chrome.runtime.getManifest().version_name ?? chrome.runtime.getManifest().version),
        (e) => ({ text: `couldn't check (${e?.message || e})`, url: RELEASES_URL })
    );
    if (gen === aboutGen) settings.about = ref({ rows, latest });
}
