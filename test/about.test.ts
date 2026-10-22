import { describe, expect, it } from "vitest";
import { aboutText, checkLatestRelease, describeBrowser, describeHelper, describeLatest, describeOs, diagnosticsFileName, formatBuildTime, isNewerVersion } from "../src/ui/about";

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

    it("compares release versions numerically", () => {
        expect(isNewerVersion("v0.3.10", "0.3.9")).toBe(true);
        expect(isNewerVersion("0.4.0", "0.3.99")).toBe(true);
        expect(isNewerVersion("v0.3.8", "0.3.8")).toBe(false);
        expect(isNewerVersion("0.3.7", "0.3.8")).toBe(false);
    });

    it("describes the latest release", () => {
        const latest = { version: "0.3.9", url: "https://github.com/nimatrueway/wiretrick/releases/tag/v0.3.9" };
        expect(describeLatest(latest, "0.3.8")).toEqual({ text: "0.3.9 — update available", url: latest.url, update: true });
        expect(describeLatest(latest, "0.3.9")).toEqual({ text: "0.3.9 — up to date" });
    });

    it("fetches the latest release once, retrying after a failure", async () => {
        let calls = 0;
        const fail = (async () => {
            calls++;
            return new Response("rate limited", { status: 403 });
        }) as typeof fetch;
        await expect(checkLatestRelease(fail)).rejects.toThrow("403");
        const ok = (async () => {
            calls++;
            return Response.json({ tag_name: "v0.3.9", html_url: "https://example.test/v0.3.9" });
        }) as typeof fetch;
        expect(await checkLatestRelease(ok)).toEqual({ version: "0.3.9", url: "https://example.test/v0.3.9" });
        expect(await checkLatestRelease(ok)).toEqual({ version: "0.3.9", url: "https://example.test/v0.3.9" });
        expect(calls).toBe(2);
    });
});

describe("formatBuildTime", () => {
    it("renders the UTC build time in the given time zone", () => {
        const out = formatBuildTime("2026-10-21T23:08:58.118Z", "America/Los_Angeles");
        expect(out).toMatch(/2026/);
        expect(out).toMatch(/4:08:58/);
        expect(out).not.toMatch(/23:08/);
    });
    it("passes through unparseable values", () => {
        expect(formatBuildTime("dev")).toBe("dev");
    });
});

