/**
 * Regenerates the README screenshots in docs/shots/ (MV3 bundle, needs internet).
 *
 * Usage: npm run build && E2E_CHROMIUM=/usr/bin/chromium npx tsx scripts/screenshots.ts
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { chromium } from "playwright-core";
import { resolveBrowser } from "../test/browserSetup";
import { SAMPLES } from "../src/ui/samples";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT_ROOT = path.join(ROOT, "dist-mv3");
const OUT = path.join(ROOT, "docs/shots");
const EXT_ID = crypto.createHash("sha256").update(EXT_ROOT, "utf8").digest("hex").split("").map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join("").slice(0, 32);
const SHOWN = ["Replace a fetch/XHR response", "CORS unlock", "DOM / title changes", "Rewrite page HTML"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(path.join(tmpdir(), "wiretrick-shots-"));
const proc = spawn(await resolveBrowser(), ["--headless=new", `--user-data-dir=${profile}`, `--load-extension=${EXT_ROOT}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
await sleep(5000);
let browser: any;
try {
    const [port] = readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n");
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 90000 });
    const ctx = browser.contexts()[0];
    const mgr = await ctx.newPage();
    await mgr.setViewportSize({ width: 1280, height: 720 });
    await mgr.goto(`chrome-extension://${EXT_ID}/manager.html`);
    const send = (msg: any) => mgr.evaluate((m: any) => new Promise<any>((r) => chrome.runtime.sendMessage(m, r)), msg);
    // no local helper here: use the debugger strategy so the log shows real activity
    await mgr.evaluate(() => new Promise<void>((r) => chrome.storage.local.set({ resStrategy: "debugger" }, () => r())));

    for (const name of SHOWN) {
        const s = SAMPLES.find((x) => x.name === name)!;
        await send({ type: "saveScript", id: "shot_" + name.replace(/\W+/g, "_"), code: s.code, name });
    }
    await sleep(1500);

    // produce some live log lines
    const page = await ctx.newPage();
    await page.goto("https://dummyjson.com/users/1").catch(() => {});
    await page.goto("https://dummyjson.com/users/1").catch(() => {});
    await page.close();

    await mgr.goto(`chrome-extension://${EXT_ID}/manager.html?script=shot_Mock_a_fetch_XHR_API`);
    await sleep(2500);
    await mgr.screenshot({ path: path.join(OUT, "editor.png") });

    await mgr.click("#btn-help");
    await mgr.click('[data-help-tab="samples"]');
    await sleep(800);
    await mgr.screenshot({ path: path.join(OUT, "samples.png") });

    const pop = await ctx.newPage();
    const cdp = await ctx.newCDPSession(pop);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 600, height: 400, deviceScaleFactor: 2, mobile: false });
    await pop.goto(`chrome-extension://${EXT_ID}/popup.html`);
    await sleep(1500);
    await pop.locator("body").screenshot({ path: path.join(OUT, "popup.png") });
    console.log("wrote", OUT);
} finally {
    await browser?.close().catch(() => {});
    proc.kill();
    await sleep(500);
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 5 }); } catch { /* best effort */ }
}
process.exit(0);
