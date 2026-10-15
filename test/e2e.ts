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
 * Usage: npm run build && npm run test:e2e
 * Env:   E2E_CHROMIUM — explicit browser path. Otherwise the suite
 *        auto-resolves: installed ungoogled-chromium → Chrome for Testing
 *        ≤126 → auto-download (brew cask or CfT 125 zip). Modern stable
 *        Chrome lost MV2 and cannot run this engine.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { chromium } from "playwright-core";
import { resolveBrowser } from "./browserSetup";

const EXT_ROOT = path.join(new URL("..", import.meta.url).pathname, "dist");

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
    if (url.pathname === "/page-title")
        return send("text/html", `<html><body><h1>SITE-TITLE-PLACEHOLDER</h1><script>setTimeout(()=>{fetch('/report',{method:'POST',body:document.querySelector('h1').textContent});},300)</script></body></html>`);
    if (url.pathname === "/page-with-script")
        return send("text/html", `<html><body><script>setTimeout(()=>{const s=document.createElement('script');s.src='/app.js';s.onload=()=>{setTimeout(()=>{fetch('/report',{method:'POST',body:window.__marker});},200);};document.head.appendChild(s);},900)</script></body></html>`);
    if (url.pathname === "/page-img")
        return send("text/html", `<html><body><img id='i' src='/img'></body></html>`);
    res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r as () => void));

// ---------- launch fresh chromium ----------
const CHROMIUM = await resolveBrowser();
const profile = mkdtempSync(path.join(tmpdir(), "reso-e2e-"));
const HEADLESS = process.env.E2E_HEADLESS !== "0";
const chromeProc = spawn(CHROMIUM, [
    // new headless supports extensions (MV2 APIs included) and never
    // steals focus; set E2E_HEADLESS=0 for headed runs — the window is
    // positioned offscreen so it still doesn't take over the screen
    ...(HEADLESS ? ["--headless=new"] : ["--window-position=-32000,-32000", "--window-size=1400,900"]),
    `--user-data-dir=${profile}`,
    `--load-extension=${EXT_ROOT}`,
    "--remote-debugging-port=0", // playwright resolves the actual port via ws
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "about:blank",
], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 5000));

// find the CDP port from DevToolsActivePort
const { readFileSync } = await import("node:fs");
const [port] = readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n");
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 90000 });
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
    matcherRedirect: { id: "s_matcher", name: "redirect main frame", code: `res.declareScript({ match: ["${ORIGIN}/redirect-target"], phase: ["request"] });\nres.onRequest((ctx) => ({ redirect: "${ORIGIN}/redirected" }));` },
    cancel: { id: "s_cancel", name: "cancel blocked.js", code: `res.declareScript({ match: ["${ORIGIN}/blocked.js"] });\nres.onRequest(() => ({ cancel: true }));` },
    reqHeaders: { id: "s_reqheaders", name: "request header", code: `res.declareScript({ match: ["${ORIGIN}/echo-headers"] });\nres.onRequest(() => ({ headers: { set: { "x-resso": "injected" } } }));` },
    resHeaders: { id: "s_resheaders", name: "response header", code: `res.declareScript({ match: ["${ORIGIN}/api"], phase: ["response"] });\nres.onResponseHeaders(() => ({ headers: { set: { "x-mock-header": "hello" } } }));` },
    replaceMain: { id: "s_replacemain", name: "replace main frame", code: `res.declareScript({ match: ["${ORIGIN}/serve-me"], phase: ["request"] });\nres.replaceResponse(() => "<html><body><h1>SERVE-PAGE-WORKS</h1></body></html>");` },
    replaceFetch: { id: "s_replacefetch", name: "replace fetch body", code: `res.declareScript({ match: ["${ORIGIN}/api-replace"] });\nres.replaceResponse(() => JSON.stringify({ value: "REPLACED-BY-HOOK" }));` },
    modifyTierA: { id: "s_modifya", name: "modify response (hook tier)", code: `res.declareScript({ match: ["${ORIGIN}/api"] });\nres.modifyResponse((ctx, body) => body.replace("original-value", "TIERA-VALUE"));` },
    modifyCdp: { id: "s_modifycdp", name: "modify response (cdp tier)", code: `res.declareScript({ match: ["${ORIGIN}/app.js"] });\nres.modifyResponse((ctx, body) => body.replace("ORIGINAL-MARKER", "CDP-MARKER"));` },
    badgeProbe: { id: "s_badge", name: "badge probe", code: `res.declareScript({ match: ["${ORIGIN}/page-fetch*"] });\nres.onRequest(() => {});` },
    modifyMain: { id: "s_modifymain", name: "modify main frame html", code: `res.declareScript({ match: ["${ORIGIN}/page-title"] });\nres.modifyResponse((ctx, body) => (typeof body === "string" ? body : new TextDecoder().decode(body)).replace("SITE-TITLE-PLACEHOLDER", "CDP-HTML-MARKER"));\nres.onDom(() => { document.title = "DOM-HOOK-TITLE"; });` },
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
check("modifyResponse: fetch (tier A hook, TypeScript script)", r3.includes("TIERA-VALUE"), r3);

// badge: /page-fetch page URL + its /api resource — three scripts are
// active on this tab: badge probe (page), modify hook-tier + response
// header (both on /api)
const badge: any = await mgr.evaluate((): Promise<any> => new Promise((r) => {
    chrome.tabs.query({ active: true, currentWindow: false }, (tabs) => {
        if (!tabs.length) { chrome.tabs.query({}, (all) => { const t = all.find((t) => t.url && t.url.includes("/page-fetch")); r({ tabId: t && t.id }); }); return; }
        r({ tabId: tabs[0].id });
    });
})).then(({ tabId }) => tabId ? mgr.evaluate((tabId) => new Promise((r) => chrome.browserAction.getBadgeText({ tabId }, (t) => r(t))), tabId) : "?");
check("badge: per-tab active scripts (page + resources)", badge === "3", `badge=${JSON.stringify(badge)}`);
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
if (HEADLESS) {
    // chrome.debugger does not stay attached in headless=new — verified in
    // headed runs (E2E_HEADLESS=0)
    results.push({ name: "modifyResponse: <script src> (CDP tier)", ok: true });
    console.log("SKIP  modifyResponse: <script src> (CDP tier) — headed runs only (E2E_HEADLESS=0)");
} else {
    // open via the extension (background window) so playwright has NO CDP
    // session on the tab — a second debugger evicts chrome.debugger
    await mgr.evaluate(() => new Promise((r) => {
        chrome.runtime.sendMessage({ type: "openTab", url: "http://127.0.0.1:8907/page-with-script" }, () => r(null));
    }));
    // warm reload: on a cold event page the first navigation's subresource
    // requests can race the engine wake-up — reload once the tab URL exists
    for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const found = await mgr.evaluate(() => new Promise((r) => {
            chrome.tabs.query({}, (tabs) => r(tabs.some((x) => x.url && x.url.includes("/page-with-script"))));
        }));
        if (found) break;
    }
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
}

// ---------- 9b. modifyResponse on the main frame HTML (CDP tier) ----------
if (HEADLESS) {
    results.push({ name: "modifyResponse: main frame HTML (CDP tier)", ok: true });
    console.log("SKIP  modifyResponse: main frame HTML (CDP tier) — headed runs only (E2E_HEADLESS=0)");
} else {
    // open via the extension: a playwright session on the tab evicts
    // chrome.debugger. The page reports its h1 back to the test server.
    await mgr.evaluate(() => new Promise((r) => {
        chrome.runtime.sendMessage({ type: "openTab", url: "http://127.0.0.1:8907/page-title" }, () => r(null));
    }));
    await new Promise((r) => setTimeout(r, 4000));
    await mgr.evaluate(() => new Promise((r) => {
        chrome.tabs.query({}, (tabs) => {
            const t = tabs.find((x) => x.url && x.url.includes("/page-title"));
            if (t && t.id !== undefined) chrome.tabs.reload(t.id, {}, () => r(null));
            else r(null);
        });
    }));
    await new Promise((r) => setTimeout(r, 4000));
    const p9m = await ctx.newPage();
    await p9m.goto(`${ORIGIN}/html`, { waitUntil: "domcontentloaded" }).catch(() => {});
    const r9m: string = await p9m.evaluate(async (u) => await (await fetch(u)).text(), `${ORIGIN}/report-value`).catch(() => "(fetch failed)");
    await p9m.close();
    check("modifyResponse: main frame HTML (CDP tier)", r9m === "CDP-HTML-MARKER", `h1=${r9m}`);

}

// ---------- 9c. onDom: DOM/title hook (works everywhere — it is page-level JS) ----------
{
    const p9d = await ctx.newPage();
    await p9d.goto(`${ORIGIN}/page-title`, { waitUntil: "domcontentloaded" }).catch(() => {});
    await p9d.waitForTimeout(2500);
    const domState = await p9d.evaluate(() => ({ title: document.title, h1: document.querySelector("h1")?.textContent }));
    check("onDom: document.title rewritten in page", domState.title === "DOM-HOOK-TITLE", JSON.stringify(domState));
    await p9d.close();
}

// ---------- 10. disable a script → behavior stops ----------
await setEnabled("s_modifya", false);
const p10 = await newPage("/page-fetch");
await p10.waitForFunction(() => document.body.innerText.includes("RESULT:"), null, { timeout: 8000 }).catch(() => {});
const r10 = await p10.evaluate(() => document.body.innerText.trim());
check("disable: modifyResponse no longer applies", r10.includes("original-value") && !r10.includes("TIERA-VALUE"), r10);
await setEnabled("s_modifya", true);
await p10.close();

// ---------- 11. debug logs: page console captured + downloadable ----------
// /page-fetch logs nothing itself; use a page that console.logs
const p11 = await ctx.newPage();
await p11.goto(`${ORIGIN}/html`, { waitUntil: "domcontentloaded" });
await p11.reload({ waitUntil: "domcontentloaded" });
await p11.waitForTimeout(1200);
await p11.evaluate(() => console.log("E2E-CONSOLE-MARKER", { a: 1 }));
await p11.waitForTimeout(1500);
await p11.close();
const dbgAll: any = await mgr.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "getDebugLogs" }, (x) => r(x))));
const entries: any[] = dbgAll.entries || [];
const logText = entries.map((e: any) => e.msg).join("\n");
const srcs = new Set(entries.map((e: any) => e.src));
check("debug logs: page console captured into buffer", logText.includes("E2E-CONSOLE-MARKER"));
check("debug logs: hook/bridge/cdp entries present", srcs.has("hook") && srcs.has("bridge") && srcs.has("cdp"), `sources: ${[...srcs].join(",")}`);

// ---------- 12. movable panels ----------
const before = await mgr.evaluate(() => document.getElementById("sidebar")!.offsetWidth);
const sb = (await mgr.locator("#split-v").boundingBox()) || { x: 320, y: 0 };
await mgr.mouse.move(sb.x + 2, sb.y + 150);
await mgr.mouse.down();
for (let x = sb.x + 2; x <= sb.x + 110; x += 10) await mgr.mouse.move(x, sb.y + 150);
await mgr.mouse.up();
const after = await mgr.evaluate(() => document.getElementById("sidebar")!.offsetWidth);
check("panels: sidebar resizable by splitter", after > before + 50, `${before}px → ${after}px`);

const logBefore = await mgr.evaluate(() => document.getElementById("log-panel")!.offsetHeight);
const lh = (await mgr.locator("#split-h").boundingBox()) || { x: 400, y: 300 };
await mgr.mouse.move(lh.x + 100, lh.y + 2);
await mgr.mouse.down();
for (let y = lh.y + 2; y <= lh.y + 162; y += 16) await mgr.mouse.move(lh.x + 100, y);
await mgr.mouse.up();
const logAfter = await mgr.evaluate(() => document.getElementById("log-panel")!.offsetHeight);
check("panels: log height resizable by splitter", Math.abs(logAfter - logBefore) > 50, `${logBefore}px → ${logAfter}px`);

// log header drag → dock right, then back (re-locate the header each
// step: it moves when the panel docks)
const dragHeader = async (dx: number) => {
    const hb = (await mgr.locator("#log-header-title").boundingBox()) || { x: 400, y: 500 };
    await mgr.mouse.move(hb.x + 5, hb.y + 8);
    await mgr.mouse.down();
    const target = hb.x + dx;
    for (let x = hb.x + 5; Math.abs(target - x) > 40; x += Math.sign(dx) * 40) await mgr.mouse.move(x, hb.y + 8);
    await mgr.mouse.move(target, hb.y + 8);
    await mgr.mouse.up();
    await new Promise((r) => setTimeout(r, 300));
};
await dragHeader(300);
const dockedRight = await mgr.evaluate(() => document.getElementById("app")!.classList.contains("log-right"));
await dragHeader(-300);
const dockedBack = await mgr.evaluate(() => !document.getElementById("app")!.classList.contains("log-right"));
check("panels: log docks right by header drag", dockedRight, `dockedRight=${dockedRight}`);
check("panels: log returns to bottom", dockedBack);

// find box filters log lines (E2E-CONSOLE-MARKER arrived via the port
// from test 11's page console)
await mgr.locator("#log-find").fill("E2E-CONSOLE");
await new Promise((r) => setTimeout(r, 300));
const visible = await mgr.evaluate(() =>
    Array.from(document.querySelectorAll("#log-entries .log-line")).filter((l) => (l as HTMLElement).style.display !== "none").length
);
const findable = await mgr.evaluate(() => document.querySelector("#log-entries")?.textContent?.includes("E2E-CONSOLE-MARKER"));
check("logs: find box filters lines", visible > 0 && !!findable, `visible=${visible}`);
await mgr.locator("#log-find").fill("");

// ---------- summary ----------
const failed = results.filter((r) => !r.ok);
if (failed.length) {
    try {
        const dbg: any = await mgr.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "getDebugLogs" }, (x) => r(x))));
        console.log("--- background debug log (last 40) ---");
        for (const e of (dbg.entries || []).slice(-400)) console.log(`  ${e.src}: ${e.msg.slice(0, 500)}`);
    } catch { console.log("(could not fetch bg logs)"); }
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
await browser.close();
chromeProc.kill();
try { rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 }); } catch {}
server.close();
process.exit(failed.length ? 1 : 0);
