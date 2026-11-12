/** Scripts-folder and "open in editor" helpers: sync file names, folder paths, the ↗ button's launch URL. */
import { fileNameFor } from "./fsBridge";

/** File name within the synced folder for a script — or settings.yaml for the virtual settings entry. */
export function syncFileNameFor(selectedId: string, scriptName: string | undefined, settingsId: string, settingsFile: string): string {
    return selectedId === settingsId ? settingsFile : fileNameFor(selectedId, scriptName || "");
}

/** Absolute file path the ↗ VS Code button opens for the current selection. */
export function vscodeTargetPath(folder: string, selectedId: string, scriptName: string | undefined, settingsId: string, settingsFile: string): string {
    return folder.replace(/\/+$/, "") + "/" + syncFileNameFor(selectedId, scriptName, settingsId, settingsFile);
}

export type HostOs = "mac" | "windows" | "linux";
export const hostOs = (platform: string): HostOs => (/Mac|iPhone|iPad/.test(platform) ? "mac" : /^Win/.test(platform) ? "windows" : "linux");

/** How to copy a folder's absolute path on this OS (the browser can't read it), and an example path. */
export function copyPathHint(os: HostOs): { hint: string; example: string } {
    if (os === "mac") return { hint: "In Finder, select the folder and press ⌥⌘C (Copy as Pathname), then paste it here.", example: "/Users/you/TangiTweak" };
    if (os === "windows") return { hint: "In File Explorer, select the folder and press Ctrl+Shift+C (or Shift+right-click → Copy as path), then paste it here.", example: "C:\\Users\\you\\TangiTweak" };
    return { hint: "In your file manager, open the folder and press Ctrl+L to show its path, or run pwd in a terminal there, then paste it here.", example: "/home/you/TangiTweak" };
}

/** A pasted folder path, cleaned up: quotes from Windows' Copy as path, a file:// URI some file managers copy, a trailing slash. */
export function cleanFolderPath(raw: string): string {
    let p = raw.trim().replace(/^(["'])(.*)\1$/, "$2").trim();
    if (/^file:\/\//i.test(p)) {
        try {
            p = decodeURIComponent(new URL(p).pathname).replace(/^\/([A-Za-z]:)/, "$1");
        } catch {}
    }
    return p.replace(/(?<=[^/\\:])[/\\]+$/, "");
}

/** What the ↗ button launches: Settings → Open button. */
export type LaunchMode = "vscode" | "vscode-insiders" | "custom" | "off";

/** Display name of the ↗ button's target. */
export function launchAppName(mode: string): string {
    return mode === "vscode-insiders" ? "VS Code Insiders" : mode === "custom" ? "your editor" : "VS Code";
}

/**
 * The URL the ↗ button opens for an absolute file path. "custom" fills a
 * template like React DevTools' "Open in Editor URL" — `{path}` (absolute,
 * starts with "/") and `{line}` (1-based), e.g. `cursor://file{path}:{line}`.
 * null when there's nothing to launch (off, or an empty custom template).
 */
export function editorLaunchUrl(mode: string, template: string, file: string, line = 1): string | null {
    const path = file.split("/").map(encodeURIComponent).join("/");
    if (mode === "off") return null;
    if (mode === "custom") {
        const t = template.trim();
        return t ? t.split("{path}").join(path).split("{line}").join(String(line)) : null;
    }
    return (mode === "vscode-insiders" ? "vscode-insiders://file" : "vscode://file") + path;
}
