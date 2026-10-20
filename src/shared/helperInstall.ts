/** One-line terminal commands that download the right wiretrick-helper
 * release binary (checksum-verified) and register it for this extension. */

const RAW = "https://raw.githubusercontent.com/nimatrueway/wiretrick/master/helper";

export const isWindows = (): boolean => /Windows/i.test(globalThis.navigator?.userAgent || "");

export function helperInstallCommand(extensionId: string, windows = isWindows()): string {
    return windows
        ? `& ([scriptblock]::Create((irm ${RAW}/install.ps1))) -ExtensionId ${extensionId} -TrustCa`
        : `curl -fsSL ${RAW}/install.sh | sh -s -- --extension-id ${extensionId} --trust-ca`;
}

export const helperInstallShell = (windows = isWindows()): string => (windows ? "PowerShell" : "a terminal");

/** True when the helper's `x.y.z` version is older than the extension's.
 * Extension and helper are released together from one tag, so an older
 * helper means the extension auto-updated but the helper was not reinstalled. */
export function isHelperOutdated(helperVersion: string | undefined, extensionVersion: string | undefined): boolean {
    const parse = (v: string | undefined) => (v || "").replace(/^v/, "").split(/[.+-]/).slice(0, 3).map((n) => parseInt(n, 10));
    const h = parse(helperVersion);
    const e = parse(extensionVersion);
    if (h.length < 3 || e.length < 3 || [...h, ...e].some(Number.isNaN)) return false;
    for (let i = 0; i < 3; i++) if (h[i] !== e[i]) return h[i] < e[i];
    return false;
}
