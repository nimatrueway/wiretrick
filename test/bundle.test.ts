/** Scripts-folder and "open in editor" helpers (src/ui/bundle.ts). */
import { describe, it, expect } from "vitest";
import { syncFileNameFor, vscodeTargetPath, editorLaunchUrl, launchAppName, cleanFolderPath, copyPathHint, hostOs } from "../src/ui/bundle";
import { SETTINGS_FILE } from "../src/shared/settingsYaml";

const SETTINGS_ID = "__settings__"; // mirrors editor.ts's virtual entry id

describe("open-in-vscode target path", () => {
    it("settings entry → <folder>/settings.yaml (virtual row, not a stored script)", () => {
        expect(vscodeTargetPath("/Users/x/scripts", SETTINGS_ID, undefined, SETTINGS_ID, SETTINGS_FILE)).toBe("/Users/x/scripts/settings.yaml");
    });

    it("real script → <folder>/<sanitized name>.ts", () => {
        expect(vscodeTargetPath("/Users/x/scripts", "s_abc", "Debug header", SETTINGS_ID, SETTINGS_FILE)).toBe("/Users/x/scripts/Debug header.ts");
    });

    it("trailing slashes on the folder are stripped", () => {
        expect(vscodeTargetPath("/Users/x/scripts//", SETTINGS_ID, undefined, SETTINGS_ID, SETTINGS_FILE)).toBe("/Users/x/scripts/settings.yaml");
    });

    it("syncFileNameFor: settings id wins even if a script name is passed", () => {
        expect(syncFileNameFor(SETTINGS_ID, "whatever", SETTINGS_ID, SETTINGS_FILE)).toBe("settings.yaml");
    });
});

describe("editorLaunchUrl", () => {
    const file = "/Users/x/My scripts/Debug header.ts";
    it("VS Code / Insiders: vscode://file<path>, segments encoded", () => {
        expect(editorLaunchUrl("vscode", "", file)).toBe("vscode://file/Users/x/My%20scripts/Debug%20header.ts");
        expect(editorLaunchUrl("vscode-insiders", "ignored", file, 9)).toBe("vscode-insiders://file/Users/x/My%20scripts/Debug%20header.ts");
    });
    it("custom: fills {path} and {line} (every occurrence)", () => {
        expect(editorLaunchUrl("custom", " cursor://file{path}:{line} ", file, 12)).toBe("cursor://file/Users/x/My%20scripts/Debug%20header.ts:12");
        expect(editorLaunchUrl("custom", "idea://open?file={path}&line={line}&l2={line}", "/a/b.ts", 3)).toBe("idea://open?file=/a/b.ts&line=3&l2=3");
    });
    it("nothing to launch: off, or an empty custom URL", () => {
        expect(editorLaunchUrl("off", "", file)).toBeNull();
        expect(editorLaunchUrl("custom", "  ", file)).toBeNull();
    });
    it("names the target", () => {
        expect(launchAppName("vscode")).toBe("VS Code");
        expect(launchAppName("vscode-insiders")).toBe("VS Code Insiders");
        expect(launchAppName("custom")).toBe("your editor");
    });
});

describe("synced folder path (pasted in Settings)", () => {
    it("cleans what the OS copy-path commands produce", () => {
        expect(cleanFolderPath('  "C:\\Users\\me\\Wiretrick"  ')).toBe("C:\\Users\\me\\Wiretrick");
        expect(cleanFolderPath("file:///home/me/My%20Scripts/")).toBe("/home/me/My Scripts");
        expect(cleanFolderPath("file:///C:/Users/me/Wiretrick")).toBe("C:/Users/me/Wiretrick");
        expect(cleanFolderPath("/Users/me/Wiretrick/")).toBe("/Users/me/Wiretrick");
        expect(cleanFolderPath("/")).toBe("/");
        expect(cleanFolderPath("C:\\")).toBe("C:\\");
        expect(cleanFolderPath("")).toBe("");
    });

    it("gives the hint for the user's OS", () => {
        expect(hostOs("MacIntel")).toBe("mac");
        expect(hostOs("Win32")).toBe("windows");
        expect(hostOs("Linux x86_64")).toBe("linux");
        expect(copyPathHint("mac").hint).toContain("⌥⌘C");
        expect(copyPathHint("windows").example).toBe("C:\\Users\\you\\Wiretrick");
    });
});
