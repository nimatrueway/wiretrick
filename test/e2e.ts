/**
 * End-to-end test: launches a fresh Chromium (MV2-capable Chrome for
 * Testing), loads the built extension, seeds scripts through the real
 * manager page, and exercises every feature tier against a local HTTP
 * server:
 *
 *   - URL matcher (positive + negative)
 *   - onRequest: redirect, cancel, request headers
 *   - onResponseHeaders: set/remove
 *   - replaceResponse: main frame (serve page) and fetch (hook short-circuit)
 *   - modifyResponse: fetch/XHR via the Tier-A page hook
 *   - modifyResponse: non-JS <script src> via the CDP tier
 *   - per-tab badge counting
 *   - enable/disable toggling
 *
 * Usage: npm run build && node test/e2e.mjs
 * Env:   E2E_CHROMIUM — path to an MV2-capable Chromium/Chrome-for-Testing
 *        (must support blocking webRequest; modern stable Chrome won't do)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { chromium } from "playwright-core";

const EXT_ROOT = path.join(new URL("..", import.meta.url).pathname, "dist");
const CHROMIUM = process.env.E2E_CHROMIUM ||
    "/tmp/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const PORT = 8907;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const EXT_ID = "mgbfmgeopkkpfcgjafmmdlnplkdnglki"; // derived from the dist path

// ---------- results ----------
interface Check { name: string; ok: boolean }
const results: Check[] = [];
function check(name: string, ok: boolean, extra = ""): void {
    results.push({ name, ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
}

// ---------- local test server ----------
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url || "/", ORIGIN);
    const send = (ct: string, body: string | Buffer) => { res.writeHead(200, { "content-type": ct }); res.end(body); };
    if (url.pathname === "/html") return send("text/html", "<html><body><h1 id='t'>ORIGINAL TITLE</h1></body></html>");
    if (url.pathname === "/api") return send("application/json", JSON.stringify({ value: "original-value" }));
    if (url.pathname === "/echo-headers") return send("application/json", JSON.stringify(req.headers));
    if (url.pathname === "/app.js") return send("text/javascript", 'window.__marker = "ORIGINAL-MARKER";');
    if (url.pathname === "/report-value") {
        res.writeHead(200, { "content-type": "text/plain" });
        return res.end(String((globalThis as any).__reportedMarker || ""));
    }
    if (url.pathname === "/report" && req.method === "POST") {
        let body = "";
        req.on("data", (c: Buffer) => (body += c));
        req.on("end", () => { (globalThis as any).__reportedMarker = body.trim(); res.writeHead(204); res.end(); });
        return;
    }
    if (url.pathname === "/blocked.js") return send("text/javascript", 'window.__blockedLoaded = true;');
    if (url.pathname === "/img") { res.writeHead(200, { "content-type": "image/png" }); return res.end(PNG); }
    if (url.pathname === "/redirect-target") return send("text/html", "<html><body>REDIRECT-LANDING</body></html>");
    if (url.pathname === "/redirected") return send("text/html", "<html><body>REDIRECTED-OK</body></html>");
    if (url.pathname === "/page-fetch")
        return send("text/html", `<html><body><script>setTimeout(()=>{fetch('/api').then(r=>r.json()).then(j=>{document.body.innerHTML='RESULT:'+j.value;});},400)</script></body></html>`);
    if (url.pathname === "/page-xhr")
        return send("text/html", `<html><body><script>setTimeout(()=>{const x=new XMLHttpRequest();x.open('GET','/api');x.onload=()=>{document.body.innerHTML='RESULT:'+JSON.parse(x.responseText).value;};x.send();},700)</script></body></html>`);
    if (url.pathname === "/page-with-script")
        return send("text/html", `<html><body><script>setTimeout(()=>{const s=document.createElement('script');s.src='/app.js';s.onload=()=>{setTimeout(()=>{fetch('/report',{method:'POST',body:window.__marker});},200);};document.head.appendChild(s);},900)</script></body></html>`);
    if (url.pathname === "/page-img")
        return send("text/html", `<html><body><img id='i' src='/img'></body></html>`);
    res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r as () => void));

// ---------- launch fresh chromium ----------
const profile = mkdtempSync(path.join(tmpdir(), "reso-e2e-"));
const chromeProc = spawn(CHROMIUM, [
    `--user-data-dir=${profile}`,
    `--load-extension=${EXT_ROOT}`,
    "--remote-debugging-port=0", // playwright resolves the actual port via ws
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 5000));

// find the CDP port from DevToolsActivePort
const { readFileSync } = await import("node:fs");
const [port] = readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n");
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const ctx = browser.contexts()[0];

// ---------- open the manager page ----------
const targetList = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const bgWsUrl = targetList.find((t: any) => t.type === "background_page").webSocketDebuggerUrl;
await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(bgWsUrl);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: `chrome.tabs.create({url: chrome.runtime.getURL("manager.html")})` } }));
    ws.onmessage = (m) => { if (JSON.parse(m.data).id === 1) { ws.close(); resolve(); } };
    ws.onerror = () => reject(new Error("background ws error"));
});
await new Promise((r) => setTimeout(r, 3000));
const mgr = ctx.pages().find((p) => p.url().includes("manager.html"));
if (!mgr) { console.error("FATAL: manager page did not open"); process.exit(1); }

const saveScript = (id: string, code: string, name: string): Promise<any> =>
    mgr.evaluate(({ id, code, name }) => new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "saveScript", id, code, name }, (r) => resolve(r || null));
    }), { id, code, name });
const setEnabled = (id: string, enabled: boolean): Promise<void> =>
    mgr.evaluate(({ id, enabled }) => new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "setEnabled", id, enabled }, () => resolve());
    }), { id, enabled });

// ---------- the sample scripts ----------
interface SampleScript { id: string; name: string; code: string }
const SCRIPTS: Record<string, SampleScript> = {
    matcherRedirect: { id: "s_matcher", name: "redirect main frame", code: `// ==ResScript==\n// @name       redirect main frame\n// @match      ${ORIGIN}/redirect-target\n// @phase      request\n// ==/ResScript==\nres.onRequest((ctx) => ({ redirect: "${ORIGIN}/redirected" }));` },
    cancel: { id: "s_cancel", name: "cancel blocked.js", code: `// ==ResScript==\n// @name       cancel\n// @match      ${ORIGIN}/blocked.js\n// ==/ResScript==\nres.onRequest(() => ({ cancel: true }));` },
    reqHeaders: { id: "s_reqheaders", name: "request header", code: `// ==ResScript==\n// @name       request header\n// @match      ${ORIGIN}/echo-headers\n// ==/ResScript==\nres.onRequest(() => ({ headers: { set: { "x-resso": "injected" } } }));` },
    resHeaders: { id: "s_resheaders", name: "response header", code: `// ==ResScript==\n// @name       response header\n// @match      ${ORIGIN}/api\n// @phase      response\n// ==/ResScript==\nres.onResponseHeaders(() => ({ headers: { set: { "x-mock-header": "hello" } } }));` },
    replaceMain: { id: "s_replacemain", name: "replace main frame", code: `// ==ResScript==\n// @name       replace main frame\n// @match      ${ORIGIN}/serve-me\n// @phase      request\n// ==/ResScript==\nres.replaceResponse(() => "<html><body><h1>SERVE-PAGE-WORKS</h1></body></html>");` },
    replaceFetch: { id: "s_replacefetch", name: "replace fetch body", code: `// ==ResScript==\n// @name       replace fetch\n// @match      ${ORIGIN}/api-replace\n// ==/ResScript==\nres.replaceResponse(() => JSON.stringify({ value: "REPLACED-BY-HOOK" }));` },
    modifyTierA: { id: "s_modifya", name: "modify response (hook tier)", code: `// ==ResScript==\n// @name       modify tier A\n// @match      ${ORIGIN}/api\n// ==/ResScript==\nres.modifyResponse((ctx, body) => body.replace("original-value", "TIERA-VALUE"));` },
    modifyCdp: { id: "s_modifycdp", name: "modify response (cdp tier)", code: `// ==ResScript==\n// @name       modify cdp\n// @match      ${ORIGIN}/app.js\n// ==/ResScript==\nres.modifyResponse((ctx, body) => body.replace("ORIGINAL-MARKER", "CDP-MARKER"));` },
    badgeProbe: { id: "s_badge", name: "badge probe", code: `// ==ResScript==\n// @name       badge probe\n// @match      ${ORIGIN}/page-fetch*\n// ==/ResScript==\nres.onRequest(() => {});` },
};
for (const s of Object.values(SCRIPTS)) await saveScript(s.id, s.code, s.name);

const newPage = async (pathName: string): Promise<any> => {
    const p = await ctx.newPage();
    p.on("console", (m) => console.log(`  [page${pathName}]`, m.text().slice(0, 160)));
    await p.goto(`${ORIGIN}${pathName}`, { waitUntil: "domcontentloaded", timeout: 15000 }).catch((e) => console.log("  nav:", String(e).slice(0, 80)));
    await p.waitForTimeout(600);
    return p;
};

// ---------- 1. URL matcher + main-frame redirect ----------
const p1 = await newPage("/redirect-target");
check("matcher: main-frame redirect", (await p1.content()).includes("REDIRECTED-OK"), `url=${p1.url()}`);
const p1b = await newPage("/html");
check("matcher: negative (no redirect on /html)", (await p1b.content()).includes("ORIGINAL TITLE"));
await p1b.close();

// ---------- 2. replaceResponse on main frame (serve page) ----------
const p2 = await newPage("/serve-me");
check("replaceResponse: main frame via serve page", (await p2.content()).includes("SERVE-PAGE-WORKS"), `url=${p2.url()}`);
await p2.close();

// ---------- 3. modifyResponse via Tier-A hook (fetch) ----------
const p3 = await newPage("/page-fetch");
await p3.reload({ waitUntil: "domcontentloaded" }); // warm background → hook patched before the page fetches
await p3.waitForFunction(() => document.body.innerText.includes("RESULT:"), null, { timeout: 8000 }).catch(() => {});
const r3 = await p3.evaluate(() => document.body.innerText.trim());
check("modifyResponse: fetch (tier A hook)", r3.includes("TIERA-VALUE"), r3);

// badge: /page-fetch matches only the badge probe script
const badge: any = await mgr.evaluate((): Promise<any> => new Promise((r) => {
    chrome.tabs.query({ active: true, currentWindow: false }, (tabs) => {
        // fall back to any tab on our origin
        if (!tabs.length) { chrome.tabs.query({}, (all) => { const t = all.find((t) => t.url && t.url.includes("/page-fetch")); r({ tabId: t && t.id }); }); return; }
        r({ tabId: tabs[0].id });
    });
})).then(({ tabId }) => tabId ? mgr.evaluate((tabId) => new Promise((r) => chrome.browserAction.getBadgeText({ tabId }, (t) => r(t))), tabId) : "?");
check("badge: per-tab active script count", badge === "1", `badge=${JSON.stringify(badge)}`);
await p3.close();

// ---------- 4. modifyResponse via Tier-A hook (XHR) ----------
const p4 = await newPage("/page-xhr");
await p4.reload({ waitUntil: "domcontentloaded" }); // warm background
await p4.waitForFunction(() => document.body.innerText.includes("RESULT:"), null, { timeout: 8000 }).catch(() => {});
const r4 = await p4.evaluate(() => document.body.innerText.trim());
check("modifyResponse: XHR (tier A hook)", r4.includes("TIERA-VALUE"), r4);
await p4.close();

// ---------- 5. replaceResponse via hook short-circuit (fetch) ----------
const p5 = await ctx.newPage();
await p5.goto(`${ORIGIN}/html`, { waitUntil: "domcontentloaded" });
const r5 = await p5.evaluate(async () => (await (await fetch("/api-replace")).json()).value);
check("replaceResponse: fetch short-circuit (hook)", r5 === "REPLACED-BY-HOOK", r5);
await p5.close();

// ---------- 6. request headers ----------
const p6 = await ctx.newPage();
await p6.goto(`${ORIGIN}/html`, { waitUntil: "domcontentloaded" });
const r6 = await p6.evaluate(async () => (await (await fetch("/echo-headers")).json()));
check("onRequest: request header set", r6["x-resso"] === "injected", JSON.stringify(r6).slice(0, 100));
await p6.close();

// ---------- 7. response headers ----------
const p7 = await ctx.newPage();
await p7.goto(`${ORIGIN}/html`, { waitUntil: "domcontentloaded" });
await p7.reload({ waitUntil: "domcontentloaded" }); // warm → hook patched before fetching
await p7.waitForTimeout(1500);
const r7 = await p7.evaluate(async () => {
    const resp = await fetch("/api");
    return { header: resp.headers.get("x-mock-header"), body: (await resp.json()).value };
});
check("onResponseHeaders: set", r7.header === "hello", JSON.stringify(r7));
check("modifyResponse: still transformed on same request", r7.body === "TIERA-VALUE", r7.body);
await p7.close();

// ---------- 8. cancel ----------
const p8 = await ctx.newPage();
await p8.goto(`${ORIGIN}/html`, { waitUntil: "domcontentloaded" });
const r8 = await p8.evaluate((origin) => new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = `${origin}/blocked.js`;
    s.onload = () => resolve("loaded (should have been cancelled)");
    s.onerror = () => resolve((window as any).__blockedLoaded ? "loaded (should have been cancelled)" : "cancelled ✓");
    document.head.appendChild(s);
    setTimeout(() => resolve("cancelled ✓"), 5000);
}), ORIGIN);
check("onRequest: cancel", String(r8).includes("cancelled"), String(r8));
await p8.close();

// ---------- 9. modifyResponse on <script src> (CDP tier) ----------
// open via the extension (background window) so playwright has NO CDP
// session on the tab — a second debugger evicts chrome.debugger
await mgr.evaluate(() => new Promise((r) => {
    chrome.runtime.sendMessage({ type: "openTab", url: "http://127.0.0.1:8907/page-with-script" }, () => r(null));
}));
// warm reload: on a cold event page the first navigation's subresource
// requests can race the engine wake-up — a reload is the realistic case
await mgr.evaluate(() => new Promise((r) => {
    chrome.tabs.query({}, (tabs) => {
        const t = tabs.find((x) => x.url && x.url.includes("/page-with-script"));
        if (t && t.id !== undefined) chrome.tabs.reload(t.id, {}, () => r(null));
        else r(null);
    });
}));
await new Promise((r) => setTimeout(r, 5000));
const p9r = await ctx.newPage();
await p9r.goto(`${ORIGIN}/html`, { waitUntil: "domcontentloaded" }).catch(() => {});
const r9: string = await p9r.evaluate(async (u) => await (await fetch(u)).text(), `${ORIGIN}/report-value`).catch(() => "(fetch failed)");
await p9r.close();
check("modifyResponse: <script src> (CDP tier)", r9 === "CDP-MARKER", `marker=${r9}`);

// ---------- 10. disable a script → behavior stops ----------
await setEnabled("s_modifya", false);
const p10 = await newPage("/page-fetch");
await p10.waitForFunction(() => document.body.innerText.includes("RESULT:"), null, { timeout: 8000 }).catch(() => {});
const r10 = await p10.evaluate(() => document.body.innerText.trim());
check("disable: modifyResponse no longer applies", r10.includes("original-value") && !r10.includes("TIERA-VALUE"), r10);
await setEnabled("s_modifya", true);
await p10.close();

// ---------- summary ----------
const failed = results.filter((r) => !r.ok);
if (failed.length) {
    try {
        const dbg: any = await mgr.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "getDebugLogs" }, (x) => r(x))));
        console.log("--- background debug log (last 40) ---");
        for (const e of (dbg.entries || []).slice(-400)) console.log(`  ${e.src}: ${e.msg.slice(0, 130)}`);
    } catch { console.log("(could not fetch bg logs)"); }
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
await browser.close();
chromeProc.kill();
try { rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 }); } catch {}
server.close();
process.exit(failed.length ? 1 : 0);
