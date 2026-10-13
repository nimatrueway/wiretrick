/**
 * Resolves an MV2-capable Chromium binary for the e2e suite:
 *   1. E2E_CHROMIUM env var (explicit override)
 *   2. Any installed ungoogled-chromium (homebrew cask, all versions)
 *   3. Any Chrome for Testing ≤ 126 under /tmp or ~/Library/Caches
 *   4. Auto-download: ungoogled-chromium via brew install --cask
 *      (fallback: last MV2-capable Chrome for Testing, 125.0.6422.78)
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import https from "node:https";

const CFT_URL = "https://storage.googleapis.com/chrome-for-testing-public/125.0.6422.78/mac-arm64/chrome-mac-arm64.zip";

function candidates(): string[] {
    const out: string[] = [];
    const casks = "/opt/homebrew/Caskroom/ungoogled-chromium";
    if (existsSync(casks)) {
        // newest version dir wins
        try {
            const { readdirSync } = require("node:fs") as any;
            const versions = (readdirSync as (d: string) => string[])(casks).sort().reverse();
            for (const v of versions) out.push(path.join(casks, v, "Chromium.app/Contents/MacOS/Chromium"));
        } catch {}
    }
    // common manual installs
    out.push("/Applications/Chromium.app/Contents/MacOS/Chromium");
    out.push("/tmp/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
    out.push(path.join(process.env.HOME || "", "Library/Caches/chrome-for-testing/125.0.6422.78/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"));
    return out.filter((p) => existsSync(p));
}

function download(url: string, dest: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const file = require("node:fs");
        const out = (file as any).createWriteStream(dest);
        const get = (u: string, redirects = 0): void => {
            if (redirects > 5) return reject(new Error("too many redirects"));
            (https as any).get(u, (res: any) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    return get(res.headers.location, redirects + 1);
                }
                if (res.statusCode !== 200) return reject(new Error("HTTP " + res.statusCode));
                res.pipe(out);
                out.on("finish", () => out.close(resolve));
            }).on("error", reject);
        };
        get(url);
    });
}

export async function resolveBrowser(): Promise<string> {
    // 1. explicit
    if (process.env.E2E_CHROMIUM && existsSync(process.env.E2E_CHROMIUM)) {
        console.log("[browser] using E2E_CHROMIUM:", process.env.E2E_CHROMIUM);
        return process.env.E2E_CHROMIUM;
    }

    // 2/3. installed candidates
    const found = candidates();
    if (found.length) {
        console.log("[browser] using installed:", found[0]);
        return found[0];
    }

    // 4a. brew install ungoogled-chromium
    if (spawnSync("brew", ["--version"], { stdio: "ignore" }).status === 0) {
        console.log("[browser] no MV2 Chromium found — installing ungoogled-chromium via brew…");
        const r = spawnSync("brew", ["install", "--cask", "ungoogled-chromium"], { stdio: "inherit" });
        if (r.status === 0) {
            const after = candidates();
            if (after.length) {
                console.log("[browser] installed:", after[0]);
                return after[0];
            }
        }
        console.log("[browser] brew install failed — falling back to Chrome for Testing download");
    }

    // 4b. download Chrome for Testing 125 (last MV2-capable)
    const dl = "/tmp/chrome-mac-arm64";
    const zip = "/tmp/chrome-mac-arm64.zip";
    console.log("[browser] downloading Chrome for Testing 125 (~120MB)…");
    await download(CFT_URL, zip);
    spawnSync("unzip", ["-oq", zip, "-d", "/tmp"], { stdio: "ignore" });
    const exe = dl + "/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
    if (!existsSync(exe)) throw new Error("downloaded browser not found at " + exe);
    console.log("[browser] downloaded:", exe);
    return exe;
}
