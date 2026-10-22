/**
 * Hook shim resilience: the XHR shim becomes the transport, so a failure
 * must surface as a native XHR error (status 0) — NEVER a fallback OrigSend
 * (that RESUBMITS the request: double side effects on POSTs). GET/HEAD
 * sends with a body must not produce our error logs (Chrome's fetch
 * rejects a GET body; the page's own invalid calls propagate natively
 * without being logged as our pipeline errors).
 *
 * Usage: npm run build && npx tsx test/shim-resilience.e2e.ts
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { chromium } from "playwright-core";
import { resolveBrowser } from "./browserSetup";

const EXT_ROOT = path.join(new URL("..", import.meta.url).pathname, "dist");
const PORT = 8913;
const ORIGIN = `http://127.0.0.1:${PORT}`;
let posts = 0;
const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
    if (req.url?.startsWith("/data")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ value: "ORIGINAL" }));
    }
    if (req.url?.startsWith("/post") && req.method === "POST") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
            posts++;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ got: body, posts }));
        });
        return;
    }
    res.writeHead(404);
    res.end();
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r as () => void));

const profile = mkdtempSync(path.join(tmpdir(), "reso-shim-"));
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

    const seed = await ctx.newPage();
    await seed.goto(`chrome-extension://${extId}/manager.html`);
    await seed.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({
        type: "saveScript", id: "s_shim", name: "Shim probe",
        code: `wt.onResponseBody({ url: "*://*:*/*", strategy: "page" }, (ctx, body) => body);`, // pass-through shim
    }, r)));
    await seed.close();

    const page = await ctx.newPage();
    const hookErrors: string[] = [];
    page.on("console", (m: any) => { if (m.type() === "error" && (m.text() || "").includes("res:hook")) hookErrors.push(m.text()); });
    await page.goto(`${ORIGIN}/data`);

    // 1. GET XHR with a body: no shim error log; the request completes
    const getResult = await page.evaluate(() => new Promise<any>((resolve) => {
        const x = new XMLHttpRequest();
        x.open("GET", "/data");
        x.onload = () => resolve({ status: x.status, body: x.responseText });
        x.onerror = () => resolve({ status: 0 });
        try { x.send("body-on-get"); } catch (e: any) { resolve({ threw: e.message }); }
    }));
    check("GET XHR with a body completes (no fetch GET/body rejection)", getResult.status === 200 && getResult.body?.includes("ORIGINAL"), JSON.stringify(getResult));
    check("GET-with-body produces no shim error log", !hookErrors.some((t) => /GET\/HEAD|shim failed/.test(t)), JSON.stringify(hookErrors));

    // 2. a failed POST (refused port) surfaces as a native XHR error exactly once — no resubmission
    const postsBefore = posts;
    const postResult = await page.evaluate(() => new Promise<any>((resolve) => {
        const x = new XMLHttpRequest();
        x.open("POST", "http://127.0.0.1:9999/refused"); // nothing listens there
        x.onload = () => resolve({ status: x.status });
        x.onerror = () => resolve({ error: "native-error-event" });
        x.ontimeout = () => resolve({ timeout: true });
        try { x.send("side-effect"); } catch (e: any) { resolve({ threw: e.message }); }
        setTimeout(() => resolve({ hung: true }), 12000);
    }));
    check("failed POST surfaces as a native XHR error (status 0 / error event)", postResult.error === "native-error-event" || postResult.status === 0, JSON.stringify(postResult));
    await page.waitForTimeout(800);
    check("failed POST is NOT resubmitted by a fallback send", posts === postsBefore, `server saw ${posts - postsBefore} extra POST(s)`);

    // 3. the fetch patch: a page's own invalid fetch (GET with body) propagates natively without our log
    const hookErrorsBefore = hookErrors.length;
    const fetchResult = await page.evaluate(() => new Promise<any>((resolve) => {
        fetch("/data", { method: "GET", body: "x" }).then(
            (r) => resolve({ status: r.status }),
            (e) => resolve({ threw: e.message })
        );
    }));
    check("invalid GET-with-body fetch propagates natively", !!fetchResult.threw && /GET\/HEAD/.test(fetchResult.threw), JSON.stringify(fetchResult));
    check("page-caused fetch errors are not logged as pipeline errors", hookErrors.length === hookErrorsBefore, JSON.stringify(hookErrors.slice(hookErrorsBefore)));

    // 4. the healthy XHR shim still transforms
    const healthy = await page.evaluate(() => new Promise<any>((resolve) => {
        const x = new XMLHttpRequest();
        x.open("GET", "/data");
        x.onload = () => resolve({ status: x.status, body: x.responseText });
        x.onerror = () => resolve({ status: 0 });
        x.send();
    }));
    check("healthy XHR shim still works", healthy.status === 200 && healthy.body?.includes("ORIGINAL"), JSON.stringify(healthy));
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
