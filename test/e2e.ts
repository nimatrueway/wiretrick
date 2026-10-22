/**
 * End-to-end test: launches a fresh Chromium (MV2-capable Chrome for
 * Testing), loads the built extension, seeds scripts through the real
 * manager page, and exercises every feature tier against a local HTTP
 * server:
 *
 *   - URL matcher (positive + negative)
 *   - onRequest: redirect, cancel, request headers
 *   - onResponseHeaders: set/remove
 *   - replaceResponse: main frame (in place via the debugger tier, or the
 *     serve page for webrequest-first scripts) and fetch (hook short-circuit)
 *   - "onResponseBody never ran" warnings: per request (hook route hit by a
 *     page load) and up front (webrequest onResponseBody on Chromium)
 *   - onResponseBody: fetch/XHR via the Tier-A page hook
 *   - onResponseBody: non-JS <script src> via the CDP tier
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
import { checkApiTypingsNav } from "./apiTypingsNav";

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
    if (url.pathname.startsWith("/tap-api/")) return send("application/json", JSON.stringify({ value: url.pathname }));
    if (url.pathname === "/page-taps")
        return send("text/html", `<html><body><script>setTimeout(async()=>{for(const p of ['m1','t1','t2','m2','t3'])await fetch('/tap-api/'+p).then(r=>r.text());document.body.dataset.done='1';},800)</script></body></html>`);
    if (url.pathname === "/html-missed") return send("text/html", "<html><body><h1>MISSED-ORIGINAL</h1></body></html>");
    if (url.pathname === "/cdp-replace") return send("text/html", "<html><body><h1>CDP-ORIGINAL</h1></body></html>");
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
    matcherRedirect: { id: "s_matcher", name: "redirect main frame", code: `wt.onRequest({ url: "${ORIGIN}/redirect-target", strategy: "webRequest" }, (ctx) => ({ redirect: "${ORIGIN}/redirected" }));` },
    cancel: { id: "s_cancel", name: "cancel blocked.js", code: `wt.onRequest({ url: "${ORIGIN}/blocked.js", strategy: "webRequest" }, () => ({ block: true }));` },
    reqHeaders: { id: "s_reqheaders", name: "request header", code: `wt.onRequest({ url: "${ORIGIN}/echo-headers", strategy: "webRequest" }, () => ({ headers: { set: { "x-resso": "injected" } } }));` },
    resHeaders: { id: "s_resheaders", name: "response header", code: `wt.onResponseHeaders({ url: "${ORIGIN}/api", strategy: "webRequest" }, () => ({ headers: { set: { "x-mock-header": "hello" } } }));` },
    replaceMain: { id: "s_replacemain", name: "replace main frame", code: `wt.replaceResponse({ url: "${ORIGIN}/serve-me", strategy: "debugger" }, () => "<html><body><h1>SERVE-PAGE-WORKS</h1></body></html>");` },
    replaceFetch: { id: "s_replacefetch", name: "replace fetch body", code: `wt.replaceResponse({ url: "${ORIGIN}/api-replace", strategy: "page" }, () => JSON.stringify({ value: "REPLACED-BY-HOOK" }));` },
    modifyTierA: { id: "s_modifya", name: "modify response (hook tier)", code: `wt.onResponseBody({ url: "${ORIGIN}/api", strategy: "page" }, (ctx, body) => body.replace("original-value", "TIERA-VALUE"));` },
    modifyCdp: { id: "s_modifycdp", name: "modify response (cdp tier)", code: `wt.onResponseBody({ url: "${ORIGIN}/app.js", strategy: "debugger" }, (ctx, body) => body.replace("ORIGINAL-MARKER", "CDP-MARKER"));` },
    badgeProbe: { id: "s_badge", name: "badge probe", code: `wt.onRequest({ url: "${ORIGIN}/page-fetch*", strategy: "page" }, () => {});` },
    modifyMain: { id: "s_modifymain", name: "modify main frame html", code: `wt.onResponseBody({ url: "${ORIGIN}/page-title", strategy: "debugger" }, (ctx, body) => (typeof body === "string" ? body : new TextDecoder().decode(body)).replace("SITE-TITLE-PLACEHOLDER", "CDP-HTML-MARKER"));\nwt.onDom("${ORIGIN}/page-title", () => { document.title = "DOM-HOOK-TITLE"; });` },
};
for (const s of Object.values(SCRIPTS)) await saveScript(s.id, s.code, s.name);

// ---------- 0. imported param definitions + param-gated library ----------
{
    const send = (msg: any): Promise<any> => mgr.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, (x) => r(x ?? null))), msg);
    await saveScript("s_plib", `export const envParam = { type: "stringList", default: ["dev"] } as const;\nconst p = wt.params({ on: { type: "boolean", default: false } });\nif (p.on) wt.onRequest("*://never.invalid/*", () => {});`, "param-lib");
    const user = await saveScript("s_puser", `import { envParam } from "./param-lib";\nwt.params({ intercept_environments: envParam });\nwt.onRequest("*://never.invalid/*", () => {});`, "param-user");
    check("imported param def: no bogus compile error, def captured", !user?.error && user?.paramDefs?.intercept_environments?.type === "stringList", JSON.stringify({ error: user?.error?.split("\n")[0], defs: user?.paramDefs }));
    const lib = (await send({ type: "listScripts" })).find((s: any) => s.id === "s_plib");
    check("param-gated library stored as a library with params", lib?.meta?.active === false && lib?.paramDefs?.on?.type === "boolean", JSON.stringify(lib?.meta));
    await send({ type: "setScriptParam", scriptId: "s_plib", key: "on", value: true });
    const flipped = (await send({ type: "listScripts" })).find((s: any) => s.id === "s_plib");
    check("library param on → it becomes a script", flipped?.meta?.active === true, JSON.stringify(flipped?.meta));
    await send({ type: "deleteScript", id: "s_puser" });
    await send({ type: "deleteScript", id: "s_plib" });
}

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

// ---------- 2. replaceResponse on main frame ----------
// strategy "debugger": the debugger tier fulfills it in place — no
// redirect, the address bar keeps the page URL
const p2 = await ctx.newPage();
await p2.goto(`${ORIGIN}/serve-me`, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {}); // warm-up: attaches the debugger
await p2.waitForTimeout(1200);
await p2.goto(`${ORIGIN}/serve-me`, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
await p2.waitForTimeout(300);
check("replaceResponse: main frame in place (cdp → debugger tier, URL kept)", (await p2.content()).includes("SERVE-PAGE-WORKS") && p2.url() === `${ORIGIN}/serve-me`, `url=${p2.url()}`);
await p2.close();
// "webRequest" listed first: Chromium's webRequest can only redirect — page loads go to serve.html
await saveScript("s_replaceserve", `wt.replaceResponse({ url: "${ORIGIN}/serve-wr", strategy: "webRequest" }, () => "<html><body><h1>SERVE-PAGE-WORKS</h1></body></html>");`, "replace via serve page");
await new Promise((r) => setTimeout(r, 600));
const p2b = await newPage("/serve-wr");
check("replaceResponse: webrequest-first main frame via serve page (redirect)", (await p2b.content()).includes("SERVE-PAGE-WORKS") && p2b.url().includes("/serve.html"), `url=${p2b.url()}`);
await p2b.close();

// ---------- 3. onResponseBody via Tier-A hook (fetch) ----------
const p3 = await newPage("/page-fetch");
await p3.reload({ waitUntil: "domcontentloaded" }); // warm background → hook patched before the page fetches
await p3.waitForFunction(() => document.body.innerText.includes("RESULT:"), null, { timeout: 8000 }).catch(() => {});
const r3 = await p3.evaluate(() => document.body.innerText.trim());
check("onResponseBody: fetch (tier A hook, TypeScript script)", r3.includes("TIERA-VALUE"), r3);

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

// ---------- 4. onResponseBody via Tier-A hook (XHR) ----------
const p4 = await newPage("/page-xhr");
await p4.reload({ waitUntil: "domcontentloaded" }); // warm background
await p4.waitForFunction(() => document.body.innerText.includes("RESULT:"), null, { timeout: 8000 }).catch(() => {});
const r4 = await p4.evaluate(() => document.body.innerText.trim());
check("onResponseBody: XHR (tier A hook)", r4.includes("TIERA-VALUE"), r4);
await p4.close();

// ---------- 5. replaceResponse via hook short-circuit (fetch) ----------
const p5 = await ctx.newPage();
await p5.goto(`${ORIGIN}/html`, { waitUntil: "domcontentloaded" });
await p5.reload({ waitUntil: "domcontentloaded" }); // warm → hook patched before fetching
await p5.waitForTimeout(1500);
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
check("onResponseBody: still transformed on same request", r7.body === "TIERA-VALUE", r7.body);
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

// ---------- 9. onResponseBody on <script src> (CDP tier) ----------
if (HEADLESS) {
    // chrome.debugger does not stay attached in headless=new — verified in
    // headed runs (E2E_HEADLESS=0)
    results.push({ name: "onResponseBody: <script src> (CDP tier)", ok: true });
    console.log("SKIP  onResponseBody: <script src> (CDP tier) — headed runs only (E2E_HEADLESS=0)");
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
    check("onResponseBody: <script src> (CDP tier)", r9 === "CDP-MARKER", `marker=${r9}`);
}

// ---------- 9b. onResponseBody on the main frame HTML (CDP tier) ----------
if (HEADLESS) {
    results.push({ name: "onResponseBody: main frame HTML (CDP tier)", ok: true });
    console.log("SKIP  onResponseBody: main frame HTML (CDP tier) — headed runs only (E2E_HEADLESS=0)");
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
    check("onResponseBody: main frame HTML (CDP tier)", r9m === "CDP-HTML-MARKER", `h1=${r9m}`);

}

// ---------- 9c. onDom: DOM/title hook (works everywhere — it is page-level JS) ----------
{
    const p9d = await ctx.newPage();
    await p9d.goto(`${ORIGIN}/page-title`, { waitUntil: "domcontentloaded" }).catch(() => {});
    await p9d.waitForTimeout(2500);
    const domState = await p9d.evaluate(() => ({ title: document.title, h1: document.querySelector("h1")?.textContent }));
    check("onDom: document.title rewritten in page", domState.title === "DOM-HOOK-TITLE", JSON.stringify(domState));
    await p9d.close();
    // that cold load reached the page before the debugger attached → warned
    await new Promise((r) => setTimeout(r, 600));
    const missLog: string = await mgr.evaluate(() => document.getElementById("log-entries")!.textContent || "");
    check("cdp: missed first page load is logged as a warning", /page load \S*\/page-title was NOT intercepted by "modify main frame html"/.test(missLog), missLog.match(/.{0,40}NOT intercepted.{0,60}/)?.[0] || "(no warning)");
}

// ---------- 10. disable a script → behavior stops ----------
await setEnabled("s_modifya", false);
const p10 = await newPage("/page-fetch");
await p10.waitForFunction(() => document.body.innerText.includes("RESULT:"), null, { timeout: 8000 }).catch(() => {});
const r10 = await p10.evaluate(() => document.body.innerText.trim());
check("disable: onResponseBody no longer applies", r10.includes("original-value") && !r10.includes("TIERA-VALUE"), r10);
await setEnabled("s_modifya", true);
await p10.close();

// ---------- 10b. respond with non-200 status (debugger tier) + log attribution ----------
// A SYNC onRequest on strategy "debugger" returning respond {status: 500}: the
// debugger tier must fulfill it — and every log line must name the stored script.
await saveScript(
    "s_respond500",
    `wt.onRequest({ url: "${ORIGIN}/nav-500", strategy: "debugger" }, () => ({ respond: { status: 500, body: { error: "e2e-500" }, mime: "application/json" } }));`,
    "e2e respond 500"
);
const p10b = await ctx.newPage();
await p10b.goto(`${ORIGIN}/nav-500`, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {}); // warm-up: attaches the debugger
await p10b.waitForTimeout(1200);
const navResp = await p10b.goto(`${ORIGIN}/nav-500`, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => null);
const navBody = await p10b.evaluate(() => document.body.innerText).catch(() => "");
check("respond 500: main frame fulfilled via debugger tier", navResp?.status() === 500 && navBody.includes("e2e-500"), `status=${navResp?.status()} body=${navBody.slice(0, 60)}`);
await p10b.waitForTimeout(800);
const logText10b: string = await mgr.evaluate(() => document.getElementById("log-entries")!.textContent || "");
check("logs: respond 500 attributed to the stored script name", logText10b.includes("[e2e respond 500] onRequest → respond 500"));
check("logs: no [Untitled script] anywhere", !logText10b.includes("[Untitled script]"));
await p10b.close();

// ---------- 10c. strategy ["debugger"] replaceResponse on a page load: in place, URL kept ----------
await saveScript("s_cdpreplace", `wt.replaceResponse({ url: "${ORIGIN}/cdp-replace", strategy: "debugger" }, () => "<html><body><h1>CDP-REPLACED</h1></body></html>");`, "cdp replace page");
await new Promise((r) => setTimeout(r, 600));
const p10c = await ctx.newPage();
await p10c.goto(`${ORIGIN}/cdp-replace`, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {}); // warm-up: attaches the debugger
await p10c.waitForTimeout(1200);
await p10c.goto(`${ORIGIN}/cdp-replace`, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
await p10c.waitForTimeout(300);
const body10c = await p10c.evaluate(() => document.body.innerText).catch(() => "");
check("replaceResponse [\"cdp\"]: page load keeps its URL (no redirect to the extension)", p10c.url() === `${ORIGIN}/cdp-replace`, `url=${p10c.url()}`);
check("replaceResponse [\"cdp\"]: page body replaced in place", body10c.includes("CDP-REPLACED"), body10c.slice(0, 60));
await p10c.close();
await new Promise((r) => setTimeout(r, 400));
const log10c: string[] = await mgr.evaluate(() => [...document.querySelectorAll("#log-entries .log-line")].map((l) => (l as HTMLElement).dataset.text || l.textContent || ""));
const replLines10c = log10c.filter((l) => l.includes("[cdp replace page] replaceResponse →") && l.includes("/cdp-replace"));
check("replaceResponse [\"cdp\"]: handler ran once per load (one log line per load, no serve.html)", replLines10c.length >= 1 && replLines10c.length <= 2 && !log10c.some((l) => l.includes("/cdp-replace") && l.includes("serve.html")), JSON.stringify(replLines10c));

// ---------- 10d. "never ran" warnings: a hook route hit by a page load (per request), and a webrequest onResponseBody on Chromium (up front) ----------
await mgr.click("#network-tab"); // the Network tab records from now on
await mgr.waitForSelector("#network-view .net-toolbar", { timeout: 5000 });
await mgr.waitForTimeout(300);
const early10d: { n: number }[] = await mgr.evaluate(() =>
    [...document.querySelectorAll("#network-view tbody tr.net-row")].map((tr) => ({ n: tr.querySelectorAll(".net-badge").length }))
);
check("network: script activity from before the tab was opened is listed", early10d.length > 0 && early10d.every((r) => r.n > 0), `rows=${early10d.length}`);
await saveScript("s_missed", `wt.onResponseBody({ url: "${ORIGIN}/html-missed", strategy: "page" }, (ctx, body) => body.replace("MISSED-ORIGINAL", "NEVER"));`, "missed probe");
await saveScript("s_missed_wr", `wt.onResponseBody({ url: "${ORIGIN}/html-missed-wr", strategy: "webRequest" }, (ctx, body) => body);`, "webrequest body probe");
await new Promise((r) => setTimeout(r, 600));
const p10d = await newPage("/html-missed");
await p10d.waitForTimeout(2500); // the check runs 1.5 s after the load completes
const log10d: string = await mgr.evaluate(() => document.getElementById("log-entries")!.textContent || "");
check("missed: WARN 'onResponseBody never ran' for a hook route hit by a page load", log10d.includes(`[missed probe] onResponseBody #1 never ran for ${ORIGIN}/html-missed (document) — the "page" strategy only sees`), log10d.match(/.{0,20}never ran.{0,120}/)?.[0] || "(no warning)");
check("up-front WARN: webrequest onResponseBody can't run on Chromium", log10d.includes(`[webrequest body probe] onResponseBody #1: onResponseBody never runs with strategy "webRequest" on Chromium`), log10d.match(/.{0,40}never runs with.{0,80}/)?.[0] || "(no warning)");
const row10d: { cls: string; badges: string[] } | null = await mgr.evaluate(() => {
    const tr = [...document.querySelectorAll("#network-view tbody tr")].find((t) => (t.querySelector(".net-name")?.textContent || "").includes("html-missed"));
    return tr ? { cls: tr.className, badges: [...tr.querySelectorAll(".net-badge")].map((b) => b.className) } : null;
});
check("missed: the Network row is not marked tapped or modified", !!row10d && !/\b(tapped|modified)\b/.test(row10d.cls) && row10d.badges.some((c) => c.includes("missed")), JSON.stringify(row10d));
await p10d.close();
await setEnabled("s_missed", false);
await setEnabled("s_missed_wr", false);

// ---------- 10e. row markers: every tapped-only row carries the dashed marker (incl. consecutive ones) ----------
await saveScript("s_tapper", `wt.onResponseBody({ url: "${ORIGIN}/tap-api/*", strategy: "page" }, () => undefined);`, "marker tapper");
await saveScript("s_marker_mod", `wt.onResponseBody({ url: "${ORIGIN}/tap-api/m*", strategy: "page" }, (ctx, body) => String(body).replace("tap-api", "TAP-API"));`, "marker modifier");
await new Promise((r) => setTimeout(r, 600));
const p10e = await newPage("/page-taps");
await p10e.waitForSelector("body[data-done]", { timeout: 10000 }).catch(() => {});
await mgr.waitForTimeout(800);
const rows10e: { name: string; cls: string; badges: string[]; bgImg: string; bgSize: string }[] = await mgr.evaluate(() =>
    [...document.querySelectorAll("#network-view tbody tr.net-row")]
        .filter((t) => (t.getAttribute("title") || "").includes("/tap-api/"))
        .map((tr) => {
            const td = tr.querySelector("td.c-name") as HTMLElement;
            const cs = getComputedStyle(td);
            return { name: tr.getAttribute("title") || "", cls: tr.className, badges: [...tr.querySelectorAll(".net-badge")].map((b) => b.className), bgImg: cs.backgroundImage, bgSize: cs.backgroundSize };
        })
);
const tappedOnly10e = rows10e.filter((r) => r.badges.length > 0 && r.badges.every((b) => /\btapped\b/.test(b)));
const modified10e = rows10e.filter((r) => r.badges.some((b) => /\bmodified\b/.test(b)));
check(
    "network: every row whose tags are all tapped has class `tapped` and a visible marker",
    tappedOnly10e.length >= 3 && tappedOnly10e.every((r) => /\btapped\b/.test(r.cls) && r.bgImg !== "none"),
    JSON.stringify(tappedOnly10e.map((r) => [r.name.replace(ORIGIN, ""), r.cls, r.bgImg.slice(0, 30)]))
);
check(
    "network: modified rows have class `modified` and a visible marker",
    modified10e.length >= 2 && modified10e.every((r) => /\bmodified\b/.test(r.cls) && r.bgImg !== "none"),
    JSON.stringify(modified10e.map((r) => [r.name.replace(ORIGIN, ""), r.cls]))
);
check(
    "network: markers are inset per row (consecutive marked rows don't merge into one line)",
    [...tappedOnly10e, ...modified10e].every((r) => /calc\(100% - [1-9]\d*px\)/.test(r.bgSize)),
    JSON.stringify([...new Set(rows10e.map((r) => r.bgSize))])
);
await p10e.close();
await setEnabled("s_tapper", false);
await setEnabled("s_marker_mod", false);

// ---------- 10f. webrequest header changes on a page opened from the manager ----------
await saveScript(
    "s_hdr_wr",
    `wt.onRequest({ url: "${ORIGIN}/echo-headers", strategy: "webRequest" }, () => ({ headers: { set: { "x-wt-req": "1" }, remove: ["accept-language"] } }));\nwt.onResponseHeaders({ url: "${ORIGIN}/echo-headers", strategy: "webRequest" }, () => ({ headers: { set: { "x-wt-res": "1" } } }));`,
    "header probe"
);
await new Promise((r) => setTimeout(r, 600));
const t10f = Date.now();
const [p10f] = await Promise.all([ctx.waitForEvent("page"), mgr.evaluate((u) => void window.open(u), `${ORIGIN}/echo-headers`)]);
await p10f.waitForLoadState("domcontentloaded");
const echoed10f = JSON.parse((await p10f.textContent("body")) || "{}");
check("webrequest onRequest: Accept-Language removed (extraHeaders) and x-wt-req set", echoed10f["x-wt-req"] === "1" && !("accept-language" in echoed10f), JSON.stringify(echoed10f));
await p10f.waitForTimeout(500);
const net10f: any[] = await mgr.evaluate(() => new Promise((resolve) => {
    const port = chrome.runtime.connect({ name: "network" });
    port.onMessage.addListener((m: any) => { if (m.type === "netSnapshot") { port.disconnect(); resolve(m.entries); } });
}));
// earlier sections' activity on this URL is kept from before the tab opened
const rows10f = net10f.filter((e) => e.url === `${ORIGIN}/echo-headers` && e.startedAt >= t10f - 50);
const page10f = rows10f.find((e) => e.type === "main_frame");
check(
    "network: a page opened from the manager is recorded; header annotations land on it, not a synthetic row",
    !!page10f && page10f.interventions.length >= 2 && !rows10f.some((e) => e.synthetic),
    JSON.stringify(rows10f.map((e) => [e.id, e.type, e.interventions.length]))
);
check("network: recorded response headers include onResponseHeaders changes", !!page10f?.responseHeaders?.some(([n, v]: string[]) => n.toLowerCase() === "x-wt-res" && v === "1"), JSON.stringify(page10f?.responseHeaders));
await p10f.close();
await setEnabled("s_hdr_wr", false);
await mgr.click("#log-header-title");

// ---------- 11. logs: script output tunnelled to the Log view, page console not captured ----------
await saveScript(
    "s_logtunnel",
    `wt.onDom("${ORIGIN}/html", () => { console.warn("E2E-CONSOLE-MARKER", { a: 1 }); wt.log("E2E-RESLOG-MARKER"); });`,
    "log tunnel"
);
await new Promise((r) => setTimeout(r, 800));
const p11 = await ctx.newPage();
const pageConsole11: string[] = [];
p11.on("console", (m) => pageConsole11.push(m.text()));
await p11.goto(`${ORIGIN}/html`, { waitUntil: "domcontentloaded" });
await p11.waitForTimeout(1200);
await p11.evaluate(() => console.log("E2E-PAGE-NOISE"));
await p11.waitForTimeout(1500);
await p11.close();
await setEnabled("s_logtunnel", false);
const logLines11: string[] = await mgr.evaluate(() => [...document.querySelectorAll("#log-entries .log-line")].map((l) => (l as HTMLElement).dataset.text || ""));
const warnLine = logLines11.find((l) => l.includes("E2E-CONSOLE-MARKER")) || "";
check("logs: script console.warn reaches the Log view, attributed", warnLine.includes("[log tunnel] console.warn: E2E-CONSOLE-MARKER {\"a\":1}"), warnLine.slice(0, 160));
check("logs: script wt.log reaches the Log view", logLines11.some((l) => l.includes("[log tunnel] wt.log: E2E-RESLOG-MARKER")));
check("logs: script console output not echoed to the page console", !pageConsole11.some((t) => t.includes("E2E-CONSOLE-MARKER") || t.includes("E2E-RESLOG-MARKER")), pageConsole11.join(" | ").slice(0, 200));
check("logs: extension adds nothing to the page console", !pageConsole11.some((t) => /\[res:|\[Wiretrick\]/.test(t)), pageConsole11.join(" | ").slice(0, 200));
const dbgAll: any = await mgr.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "getDebugLogs" }, (x) => r(x))));
const entries: any[] = dbgAll.entries || [];
const logText = entries.map((e: any) => e.msg).join("\n");
const srcs = new Set(entries.map((e: any) => e.src));
check("logs: page's own console is not captured", !logText.includes("E2E-PAGE-NOISE") && !logLines11.some((l) => l.includes("E2E-PAGE-NOISE")));
check("debug logs: hook/bridge/cdp entries present", srcs.has("page") && srcs.has("bridge") && srcs.has("debugger"), `sources: ${[...srcs].join(",")}`);

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

// log header drag → drop on a dock target (re-locate the header each
// step: it moves when the panel docks)
const dragHeaderTo = async (tx: number, ty: number) => {
    const hb = (await mgr.locator("#log-header-title").boundingBox()) || { x: 400, y: 500 };
    await mgr.mouse.move(hb.x + 5, hb.y + 8);
    await mgr.mouse.down();
    await mgr.mouse.move(tx, ty, { steps: 8 });
    await mgr.mouse.up();
    await new Promise((r) => setTimeout(r, 300));
};
const dockOf = () => mgr.evaluate(() => document.getElementById("app")!.dataset.dock);
const vp = await mgr.evaluate(() => ({ w: innerWidth, h: innerHeight }));
await dragHeaderTo(vp.w - 40, vp.h / 2);
const dockedRight = await dockOf();
await dragHeaderTo(60, vp.h - 60);
const dockedLeft = await dockOf();
const leftParent = await mgr.evaluate(() => document.getElementById("log-panel")!.parentElement!.id);
const sideRight = await mgr.evaluate(() => document.getElementById("sidebar")!.getBoundingClientRect().right);
await dragHeaderTo((sideRight + vp.w) / 2 - 40, vp.h - 40);
const dockedBack = await dockOf();
check("panels: log docks right by header drag", dockedRight === "right", `dock=${dockedRight}`);
check("panels: log docks under the script list", dockedLeft === "left" && leftParent === "sidebar", `dock=${dockedLeft} parent=${leftParent}`);
check("panels: log returns to bottom", dockedBack === "bottom", `dock=${dockedBack}`);

// script list header drag → left/right edge
const dragBrandTo = async (tx: number) => {
    const bb = (await mgr.locator("#brand h1").boundingBox())!;
    await mgr.mouse.move(bb.x + 5, bb.y + 5);
    await mgr.mouse.down();
    await mgr.mouse.move(tx, vp.h / 2, { steps: 8 });
    await mgr.mouse.up();
    await new Promise((r) => setTimeout(r, 300));
};
const geom = () =>
    mgr.evaluate(() => ({
        side: document.getElementById("app")!.dataset.side,
        sideLeft: document.getElementById("sidebar")!.getBoundingClientRect().left,
        sideW: document.getElementById("sidebar")!.offsetWidth,
        editorLeft: document.getElementById("editor-pane")!.getBoundingClientRect().left,
    }));
await dragBrandTo(vp.w - 30);
const onRight = await geom();
check("panels: script list docks right", onRight.side === "right" && onRight.sideLeft > onRight.editorLeft && onRight.editorLeft < 5, JSON.stringify(onRight));
// resize from its (now left-hand) splitter
const sv = (await mgr.locator("#split-v").boundingBox())!;
await mgr.mouse.move(sv.x + 2, sv.y + 100);
await mgr.mouse.down();
await mgr.mouse.move(sv.x - 100, sv.y + 100, { steps: 5 });
await mgr.mouse.up();
const widened = await geom();
check("panels: right script list resizes from its splitter", widened.sideW - onRight.sideW > 60, `${onRight.sideW} → ${widened.sideW}`);
// the log panel still docks under the list on the right
await dragHeaderTo(vp.w - 60, vp.h - 60);
const underRight = await mgr.evaluate(() => [document.getElementById("app")!.dataset.dock, document.getElementById("log-panel")!.parentElement!.id]);
check("panels: log docks under a right-side script list", underRight[0] === "left" && underRight[1] === "sidebar", JSON.stringify(underRight));
await dragHeaderTo(vp.w / 3, vp.h - 40);
await dragBrandTo(30);
const backLeft = await geom();
const persisted = await mgr.evaluate(() => JSON.parse(localStorage.getItem("resPanelDock") || "{}").side);
check("panels: script list back to the left (persisted)", backLeft.side === "left" && backLeft.sideLeft < 5 && persisted === "left", JSON.stringify({ ...backLeft, persisted }));

// find box filters log lines (E2E-CONSOLE-MARKER arrived via the port
// from test 11's script console)
await mgr.locator("#log-find").fill("E2E-CONSOLE");
await new Promise((r) => setTimeout(r, 300));
const visible = await mgr.evaluate(() =>
    Array.from(document.querySelectorAll("#log-entries .log-line")).filter((l) => (l as HTMLElement).style.display !== "none").length
);
const findable = await mgr.evaluate(() => document.querySelector("#log-entries")?.textContent?.includes("E2E-CONSOLE-MARKER"));
check("logs: find box filters lines", visible > 0 && !!findable, `visible=${visible}`);
await mgr.locator("#log-find").fill("");

// ---------- hover type links + read-only API typings + Go Back ----------
await checkApiTypingsNav(mgr, check);

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
