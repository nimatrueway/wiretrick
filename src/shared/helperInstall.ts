/** One-line terminal commands that download the right rescript-helper
 * release binary (checksum-verified) and register it for this extension. */

const RAW = "https://raw.githubusercontent.com/nimatrueway/rescript-override/master/helper";

export const isWindows = (): boolean => /Windows/i.test(globalThis.navigator?.userAgent || "");

export function helperInstallCommand(extensionId: string, windows = isWindows()): string {
    return windows
        ? `& ([scriptblock]::Create((irm ${RAW}/install.ps1))) -ExtensionId ${extensionId} -TrustCa`
        : `curl -fsSL ${RAW}/install.sh | sh -s -- --extension-id ${extensionId} --trust-ca`;
}

export const helperInstallShell = (windows = isWindows()): string => (windows ? "PowerShell" : "a terminal");
