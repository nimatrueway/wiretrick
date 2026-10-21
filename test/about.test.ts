import { describe, expect, it } from "vitest";
import { aboutText, describeBrowser, describeHelper, describeOs, diagnosticsFileName } from "../src/ui/about";

describe("About section", () => {
    it("names the branded browser and its Chromium version", () => {
        const ua = {
            fullVersionList: [
                { brand: "Google Chrome", version: "131.0.6778.86" },
                { brand: "Not_A Brand", version: "24.0.0.0" },
                { brand: "Chromium", version: "131.0.6778.86" },
            ],
        };
        expect(describeBrowser(ua, "UA")).toBe("Google Chrome 131.0.6778.86 (Chromium 131.0.6778.86)");
        expect(describeBrowser({ fullVersionList: [{ brand: "Chromium", version: "130.0.1" }] }, "UA")).toBe("Chromium 130.0.1");
    });

    it("falls back to Firefox info, then the user agent", () => {
        expect(describeBrowser(null, "UA", { name: "Firefox", version: "133.0" })).toBe("Firefox 133.0");
        expect(describeBrowser(null, "Mozilla/5.0 X")).toBe("Mozilla/5.0 X");
    });

    it("describes OS and helper", () => {
        expect(describeOs({ os: "linux", arch: "x86-64" }, { platformVersion: "6.8.0" })).toBe("linux x86-64 (6.8.0)");
        expect(describeOs(null, null)).toBe("unknown");
        expect(describeHelper({ state: "ready", version: "0.2.0", port: 8899 })).toBe("running v0.2.0 on 127.0.0.1:8899");
        expect(describeHelper({ state: "missing" })).toBe("missing");
        expect(describeHelper(null)).toBe("unknown");
    });

    it("formats copyable text and the report file name", () => {
        expect(aboutText([["Version", "1.0"], ["Extension ID", "abc"]])).toBe("Wiretrick\nVersion:      1.0\nExtension ID: abc");
        expect(diagnosticsFileName(new Date("2025-01-02T03:04:05.678Z"))).toBe("wiretrick-diagnostics-2025-01-02T03-04-05Z.md");
    });
});
