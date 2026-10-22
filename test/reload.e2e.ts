/**
 * Extension reload resilience: when the extension is reloaded (new build),
 * old content scripts stay in long-open pages with a dead context. The
 * bridge must detect the dead context ONCE, notify the hook, and the hook
 * must go dormant — restoring the page's own fetch/XHR — instead of
 * throwing uncaught "Extension context invalidated" on every request and
 * stalling each one on the 15s watchdog.
 *
 * Usage: npm run build && npx tsx test/reload.e2e.ts
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { chromium } from "playwright-core";
import { resolveBrowser } from "./browserSetup";

const EXT_ROOT = path.join(new URL("..", import.meta.url).pathname, "dist");

const PORT = 8911;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
    if (req.url?.startsWith("/data")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ value: "ORIGINAL" }));
    }
    if (req.url?.startsWith("/page")) {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(`<html><body><button id="go">go</button><script>
document.getElementById('go').addEventListener('click', () => {
    fetch('/data').then(r => r.json()).then(j => { document.title = 'FETCHED:' + j.value; });
});
</script></body></html>`);
    }
    res.writeHead(404);
    res.end();
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r as () => void));

const profile = mkdtempSync(path.join(tmpdir(), "reso-reload-"));
const proc = spawn(await resolveBrowser(), [
    "--headless=new", `--user-data-dir=${profile}`, `--load-extension=${EXT_ROOT}`,
    "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "about:blank",
], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 5000));

let failed = 0;
const check = (name: string, ok: boolean, extra = ""): void => {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
};
let browser: any;
try {
    const [port] = readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n");
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 90000 });
    const ctx = browser.contexts()[0];
    const extId = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t: any) => t.type === "background_page").url.split("/")[2];

    // a hook-tier script: transform /data responses
    const seed = await ctx.newPage();
    await seed.goto(`chrome-extension://${extId}/manager.html`);
    await seed.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({
        type: "saveScript", id: "s_h", name: "Hooked",
        code: `wt.onResponseBody({ url: "*://*:*/*", strategy: "page" }, (ctx, body) => body.replace("ORIGINAL", "HOOKED"));`,
    }, r)));
    await seed.close();

    // the long-lived page whose content scripts survive the reload
    const page = await ctx.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (e: Error) => pageErrors.push(String(e?.message || e)));
    await page.goto(`${ORIGIN}/page`);
    await page.click("#go");
    await page.waitForFunction(() => document.title.startsWith("FETCHED:"), null, { timeout: 10000 });
    check("hook active before reload", (await page.title()) === "FETCHED:HOOKED", await page.title());

    // reload the extension — the old content scripts' context dies
    const mgr = await ctx.newPage();
    await mgr.goto(`chrome-extension://${extId}/manager.html`);
    await mgr.waitForTimeout(1000);
    await mgr.evaluate(() => chrome.runtime.reload());
    // NOTE: mgr's context dies with the reload — don't touch it again
    await new Promise((r) => setTimeout(r, 3000));
    pageErrors.length = 0; // only errors AFTER the reload count

    // the stale hook must not stall or throw: the click's fetch passes through
    await page.evaluate(() => { document.title = "pending"; });
    const t1 = Date.now();
    await page.click("#go");
    await page.waitForFunction(() => document.title !== "pending", null, { timeout: 12000 });
    const elapsed = Date.now() - t1;
    const title = await page.title();
    check("post-reload fetch completes fast (no 15s watchdog stall)", elapsed < 8000, `${elapsed}ms title=${title}`);
    check("post-reload fetch passes through unmodified (hook dormant)", title === "FETCHED:ORIGINAL", title);
    const uncaught = pageErrors.filter((m) => /Extension context invalidated/i.test(m));
    check("no uncaught 'Extension context invalidated' errors", uncaught.length === 0, JSON.stringify(pageErrors.slice(0, 3)));
} catch (e) {
    failed++;
    console.log("FAIL  exception —", e);
} finally {
    await browser?.close().catch(() => {});
    proc.kill();
    server.close();
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 }); } catch {}
    process.exit(failed ? 1 : 0);
}
