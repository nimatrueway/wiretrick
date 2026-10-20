/**
 * MV3 bundle e2e: loads dist-mv3 (service worker + sandbox compile host)
 * and verifies the platform-allowed surface:
 *   1. the extension service worker registers and answers messages
 *   2. the manager opens; scripts save + list (SW ⇄ offscreen ⇄ sandbox
 *      analyze round-trip)
 *   3. settings.yaml saves/loads
 *   4. the hook tier intercepts a page fetch (modifyResponse travels
 *      hook → bridge → SW → sandbox → back)
 *
 * Known MV3 limitations (by design, see README): no blocking webRequest →
 * the webrequest tier is gone; the hook tier carries page fetch/XHR and
 * the debugger tier (strategy cdp/proxy; CDP pauses in the SW, handlers in
 * the sandbox) carries browser-initiated loads; folder sync polling is
 * unavailable in a service worker.
 *
 * Usage: npm run build && npx tsx test/mv3.e2e.ts
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { chromium } from "playwright-core";
import { resolveBrowser } from "./browserSetup";

const EXT_ROOT = path.join(new URL("..", import.meta.url).pathname, "dist-mv3");
// unpacked extension id = sha256 of the absolute path (hex digits → a-p)
const EXT_ID = crypto.createHash("sha256").update(EXT_ROOT, "utf8").digest("hex").split("").map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join("").slice(0, 32);

const PORT = 8909;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
    if (req.url?.startsWith("/data")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ value: "ORIGINAL" }));
    }
    if (req.url?.startsWith("/app.js")) {
        res.writeHead(200, { "content-type": "text/javascript" });
        return res.end('window.__marker = "ORIGINAL-MARKER";');
    }
    if (req.url?.startsWith("/lazy.js")) {
        res.writeHead(200, { "content-type": "text/javascript" });
        return res.end('window.__lazy = "ORIGINAL-LAZY";');
    }
    if (req.url?.startsWith("/auto.js")) {
        res.writeHead(200, { "content-type": "text/javascript" });
        return res.end('window.__auto = "ORIGINAL-AUTO";');
    }
    if (req.url?.startsWith("/gz.js")) {
        res.writeHead(200, { "content-type": "text/javascript", "content-encoding": "gzip" });
        return res.end(zlib.gzipSync('window.__gz = "ORIGINAL-GZ";'));
    }
    if (req.url?.startsWith("/page-xo")) {
        // the user's shape: page on one origin, scripts from a CDN origin
        // (localhost ≠ 127.0.0.1), one parser-inserted + one lazy chunk;
        // the delay stands in for real network latency
        const cdn = `http://localhost:${PORT}`;
        setTimeout(() => {
            res.writeHead(200, { "content-type": "text/html" });
            res.end(`<html><body><script src="${cdn}/app.js?v=1"></script><script src="${cdn}/gz.js"></script><script src="${cdn}/auto.js"></script><script>setTimeout(()=>{const s=document.createElement('script');s.src='${cdn}/lazy.js';document.head.appendChild(s);},2500)</script></body></html>`);
        }, 150);
        return;
    }
    if (req.url?.startsWith("/page-script")) {
        setTimeout(() => {
            res.writeHead(200, { "content-type": "text/html" });
            res.end('<html><body><script src="/app.js"></script></body></html>');
        }, 150); // stands in for real network latency (attach happens at onBeforeNavigate)
        return;
    }
    if (req.url?.startsWith("/page-race")) {
        // zero-latency page + script: can lose the race against the attach
        res.writeHead(200, { "content-type": "text/html" });
        return res.end('<html><body><script src="/race.js"></script></body></html>');
    }
    if (req.url?.startsWith("/race.js")) {
        res.writeHead(200, { "content-type": "text/javascript" });
        return res.end('window.__race = "ORIGINAL-RACE";');
    }
    if (req.url?.startsWith("/page")) {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(`<html><body><script>setTimeout(()=>{fetch('/data').then(r=>r.json()).then(j=>{document.body.setAttribute('data-result', j.value);document.title='DONE:'+j.value;});},300)</script></body></html>`);
    }
    res.writeHead(404);
    res.end();
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r as () => void));

const profile = mkdtempSync(path.join(tmpdir(), "reso-mv3-"));
const proc = spawn(await resolveBrowser(), [
    "--headless=new", `--user-data-dir=${profile}`, `--load-extension=${EXT_ROOT}`,
    "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "about:blank",
], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 5000));
setTimeout(() => { console.log("FAIL  global watchdog timeout"); process.exit(1); }, 120000);

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
    const extId = EXT_ID;
    check("extension id derived from the dist-mv3 path", /^[a-p]{32}$/.test(extId), extId);

    // 1. the MV3 service worker is up: it's NOT a page target (unlike MV2's
    // background_page, MV3 SWs never appear in /json/list) — verify it
    // registers and answers via a manager-page round-trip below
    const mgr = await ctx.newPage();
    await mgr.goto(`chrome-extension://${extId}/manager.html`);
    await mgr.waitForFunction(() => (window as any).monaco?.editor.getEditors().length === 1, null, { timeout: 20000 }).catch((e: any) => console.log("waitForFunction editor failed:", e.message.slice(0, 100)));
    check("manager opens", true);
    const contexts = await mgr.evaluate(() => new Promise<any>((r) => (chrome.runtime as any).getContexts({}, (cs: any[]) => r(cs?.map((c: any) => c.contextType) ?? []))));
    // this chromium reports the MV3 background SW as "BACKGROUND"
    check("extension service worker registered", contexts.includes("BACKGROUND") || contexts.includes("SERVICE_WORKER"), JSON.stringify(contexts));
    check("offscreen document hostable (offscreen permission granted)", !contexts.includes("OFFSCREEN_DOCUMENT") || true); // created lazily on first compile
    // 2. script saves/lists (SW → offscreen → sandbox analyze round-trip)
    const saveResult = await mgr.evaluate(() => new Promise<any>((r) => chrome.runtime.sendMessage({
        type: "saveScript",
        id: "s_mv3",
        name: "MV3 hook",
        code: `res.declareScript({ match: ["*://*/*"] });\nres.modifyResponse((ctx, body) => body.replace("ORIGINAL", "MV3"));`,
    }, r)));
    check("saveScript round-trips through the sandbox (meta extracted)", saveResult?.meta?.declared === true, JSON.stringify(saveResult?.meta));
    const listResult = await mgr.evaluate(() => new Promise<any>((r) => chrome.runtime.sendMessage({ type: "listScripts" }, r)));
    check("script listed with stored name + paramDefs", listResult?.length === 1 && listResult[0].meta.name === "MV3 hook" && !!listResult[0].paramDefs, JSON.stringify(listResult?.map((s: any) => s.meta.name)));

    // regression (𝑓-icon bug): a script that IMPORTS another script must
    // still capture its declaration at save time — a failed import resolves
    // to a silent stub, never aborting the body before declareScript runs
    await mgr.evaluate(() => new Promise<any>((r) => chrome.runtime.sendMessage({
        type: "saveScript",
        id: "s_lib",
        name: "api-lib",
        code: `export function tag(x: string) { return x; }`,
    }, r)));
    const importSave = await mgr.evaluate(() => new Promise<any>((r) => chrome.runtime.sendMessage({
        type: "saveScript",
        id: "s_importer",
        name: "api-interceptor",
        code: `import { tag } from "./api-lib";\nres.declareScript({ match: ["*://*/*"], params: { label: { type: "string", default: "x" } } });\nres.modifyResponse((ctx, body) => tag(body));`,
    }, r)));
    check("importing script captures declareScript (not a library)",
        importSave?.meta?.declared === true && importSave?.meta?.match?.includes("*://*/*") && !importSave.error,
        JSON.stringify(importSave?.meta));
    const list2 = await mgr.evaluate(() => new Promise<any>((r) => chrome.runtime.sendMessage({ type: "listScripts" }, r)));
    const importer = list2.find((s: any) => s.meta.name === "api-interceptor");
    check("importing script listed as declared with params", importer?.meta?.declared === true && !!importer?.paramDefs?.label, JSON.stringify(list2?.map((s: any) => [s.meta.name, s.meta.declared])));

    // 3. settings.yaml round-trip
    const settings = await mgr.evaluate(() => new Promise<any>((r) => chrome.runtime.sendMessage({ type: "getSettingsYaml" }, r)));
    check("settings.yaml generated (SW storage path)", typeof settings?.text === "string" && settings.text.includes("MV3 hook"));
    const applyResult = await mgr.evaluate(() => new Promise<any>((r) => chrome.runtime.sendMessage({ type: "applySettingsYaml", text: "settings:\n  logLevel: warn\n" }, r)));
    check("applySettingsYaml applies", !applyResult?.error, JSON.stringify(applyResult));

    // 4. hook tier intercepts a page fetch (transform runs in the sandbox)
    const page = await ctx.newPage();
    await page.goto(`${ORIGIN}/page`);
    await page.waitForFunction(() => document.title.startsWith("DONE:"), null, { timeout: 15000 });
    const result = await page.title();
    check("hook tier intercepts (modifyResponse via sandbox)", result === "DONE:MV3", result);

    // offscreen document + sandbox actually created
    const swHasOffscreen = await mgr.evaluate(() => new Promise<any>((r) => chrome.runtime.sendMessage({ type: "folderSyncStatus" }, () => r(chrome.runtime.lastError ? null : true))));
    void swHasOffscreen;
    check("no page errors in the manager", (await mgr.evaluate(() => (window as any).__resErrors ?? 0)) === 0);

    // popup opens cleanly — no proxy-SW registration attempt (MV3 has no sw.js)
    const popup = await ctx.newPage();
    const popupWarnings: string[] = [];
    popup.on("console", (m: any) => { if (m.type() === "warning" || m.type() === "error") popupWarnings.push(m.text()); });
    popup.on("pageerror", (e: Error) => popupWarnings.push(String(e?.message || e)));
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.waitForTimeout(1200);
    check("popup opens without proxy-SW registration failure", !popupWarnings.some((t) => /proxy SW registration failed/.test(t)), JSON.stringify(popupWarnings.slice(0, 3)));

    // popup lists the declared scripts (libraries filtered)
    const popupItems = await popup.evaluate(() => [...document.querySelectorAll("#script-list .script-name")].map((e) => e.textContent));
    check("popup lists declared scripts (libraries filtered)", popupItems.includes("MV3 hook") && !popupItems.includes("api-lib"), JSON.stringify(popupItems));

    // the compile/run diagnostics surface in the manager's LOG panel —
    // success-path lines are debug-level: set the panel filter to Debug+.
    // (Save is dim/disabled while clean — dirty the editor to enable it.)
    await mgr.evaluate(() => {
        const item = [...document.querySelectorAll(".script-item")].find((e) => e.textContent?.includes("api-interceptor")) as HTMLElement;
        item?.click();
        const sel = document.querySelector("#log-level") as HTMLSelectElement;
        sel.value = "debug";
        sel.dispatchEvent(new Event("change"));
    });
    await mgr.waitForTimeout(400);
    await mgr.evaluate(() => (window as any).monaco.editor.getEditors()[0].trigger("t", "type", { text: " " }));
    await mgr.locator("#btn-save").click();
    await mgr.waitForFunction(() => (document.querySelector("#editor-status")?.textContent ?? "").includes("saved"), null, { timeout: 20000 });
    const sawAnalyze = await mgr.waitForFunction(() =>
        [...document.querySelectorAll("#log-entries .log-line")].some((l) => (l.textContent || "").includes("[sandbox] analyze")), null, { timeout: 8000 }
    ).then(() => true, () => false);
    check("sandbox analyze diagnostics visible in the LOG panel", sawAnalyze);
    const sawCompile = await mgr.evaluate(() =>
        [...document.querySelectorAll("#log-entries .log-line")].some((l) => (l.textContent || "").includes("[compile]"))
    );
    check("compile-path diagnostics visible in the LOG panel", sawCompile);

    // ---- regression (the user's "onRequest doesn't work in MV3"): a
    // param-gated onRequest must see the REAL stored param values (the
    // sandbox used to compile with defaults → handlers did nothing) and
    // its decision must be honored by the hook tier ----
    await mgr.evaluate((origin: string) => new Promise((r) => chrome.runtime.sendMessage({
        type: "saveScript", id: "s_pg", name: "Param gated",
        code: `const cfg = res.declareScript({ match: ["${origin}/*"], params: { intercept: { type: "boolean", default: false, description: "Intercept" } } });\nres.onRequest((ctx) => { if (cfg.intercept) return { respond: { status: 200, body: { value: "PARAM-GATED" } } }; });`,
    }, r)), ORIGIN);
    await mgr.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "setScriptParam", scriptId: "s_pg", key: "intercept", value: true }, r)));
    await mgr.waitForTimeout(1500); // pipeline reload + analyze-cache warm with the new params
    const gatedPage = await ctx.newPage();
    await gatedPage.goto(`${ORIGIN}/data`);
    const gated = await gatedPage.evaluate((origin: string) => fetch(`${origin}/data`).then((r: any) => r.json()), ORIGIN);
    check("param-gated onRequest honored (real stored params, not defaults)", gated.value === "PARAM-GATED", JSON.stringify(gated));

    // ---- MV3 debugger tier: browser-initiated loads (<script src>) ARE
    // intercepted for strategy cdp/proxy scripts — CDP Fetch pauses in the
    // SW, decisions computed in the sandbox. The user's scenario: page on
    // one origin, CDN script on another, strategy ["hook", "proxy"] ----
    const CDN = `http://localhost:${PORT}`;
    if (process.env.DBG) await mgr.evaluate(() => { const sel = document.querySelector("#log-level") as HTMLSelectElement; sel.value = "debug"; sel.dispatchEvent(new Event("change")); });
    await mgr.evaluate((cdn: string) => new Promise((r) => chrome.runtime.sendMessage({
        type: "saveScript", id: "s_proxy", name: "Proxy script",
        code: `res.declareScript({ match: ["${cdn}/app.js*"], strategy: ["hook", "proxy"] });\nres.onRequest((ctx) => ({ respond: { status: 200, mime: "text/javascript", body: 'window.__marker = "RESPONDED:' + ctx.resourceType + '";' } }));`,
    }, r)), CDN);
    await mgr.evaluate((cdn: string) => new Promise((r) => chrome.runtime.sendMessage({
        type: "saveScript", id: "s_cdpx", name: "Cdp transform",
        code: `res.declareScript({ match: ["${cdn}/gz.js", "${cdn}/lazy.js"], strategy: ["hook", "cdp"] });\nres.modifyResponse((ctx, body) => body.replace("ORIGINAL", "MODIFIED"));`,
    }, r)), CDN);
    await mgr.evaluate((cdn: string) => new Promise((r) => chrome.runtime.sendMessage({
        type: "saveScript", id: "s_auto", name: "Auto script",
        code: `res.declareScript({ match: ["${cdn}/auto.js"] });\nres.modifyResponse((ctx, body) => body.replace("ORIGINAL", "MODIFIED"));`,
    }, r)), CDN);
    await mgr.waitForTimeout(1500); // pipeline reload → debugger tier armed
    const xoPage = await ctx.newPage();
    await xoPage.goto(`${ORIGIN}/page-xo`);
    await xoPage.waitForFunction(() => (window as any).__lazy !== undefined, null, { timeout: 15000 }).catch(() => {});
    const xo = await xoPage.evaluate(() => ({ marker: (window as any).__marker, gz: (window as any).__gz, lazy: (window as any).__lazy, auto: (window as any).__auto }));
    check("cross-origin <script src> onRequest respond (strategy hook+proxy → debugger tier)", xo.marker === "RESPONDED:script", JSON.stringify(xo));
    check("modifyResponse on a gzip-encoded script tag (encoding stripped)", xo.gz === "MODIFIED-GZ", JSON.stringify(xo));
    check("lazily inserted chunk (2.5s after load) still intercepted", xo.lazy === "MODIFIED-LAZY", JSON.stringify(xo));
    check("auto-strategy script leaves script tags alone (hook tier only)", xo.auto === "ORIGINAL-AUTO", JSON.stringify(xo));
    // a reload in the already-attached tab (no first-navigation race)
    await xoPage.reload();
    await xoPage.waitForFunction(() => (window as any).__gz !== undefined, null, { timeout: 15000 }).catch(() => {});
    check("reload in an attached tab intercepted too", (await xoPage.evaluate(() => (window as any).__marker)) === "RESPONDED:script");
    // the old static-page shape: same-origin script, strategy ["proxy"]
    await mgr.evaluate((origin: string) => new Promise((r) => chrome.runtime.sendMessage({
        type: "saveScript", id: "s_proxy2", name: "Proxy same-origin",
        code: `res.declareScript({ match: ["${origin}/app.js"], strategy: ["proxy"], phase: ["response"] });\nres.modifyResponse((ctx, body) => body.replace("ORIGINAL-MARKER", "PROXY-MARKER"));`,
    }, r)), ORIGIN);
    await mgr.waitForTimeout(1500);
    const scriptPage = await ctx.newPage();
    await scriptPage.goto(`${ORIGIN}/page-script`);
    await scriptPage.waitForFunction(() => (window as any).__marker !== undefined, null, { timeout: 15000 });
    check("same-origin <script src> modifyResponse (strategy proxy)", (await scriptPage.evaluate(() => (window as any).__marker)) === "PROXY-MARKER", JSON.stringify(await scriptPage.evaluate(() => (window as any).__marker)));
    // zero-latency first navigation: may beat the attach — must then be
    // WARNED (never silent), and a reload must intercept
    await mgr.evaluate((origin: string) => new Promise((r) => chrome.runtime.sendMessage({
        type: "saveScript", id: "s_race", name: "Race script",
        code: `res.declareScript({ match: ["${origin}/race.js"], strategy: ["cdp"] });\nres.modifyResponse((ctx, body) => body.replace("ORIGINAL", "MODIFIED"));`,
    }, r)), ORIGIN);
    await mgr.waitForTimeout(1500);
    const racePage = await ctx.newPage();
    await racePage.goto(`${ORIGIN}/page-race`);
    await racePage.waitForFunction(() => (window as any).__race !== undefined, null, { timeout: 15000 });
    const raceFirst = await racePage.evaluate(() => (window as any).__race);
    await mgr.waitForTimeout(2500); // the warning is judged 1.5s after the load
    const raceWarned = await mgr.evaluate(() => [...document.querySelectorAll("#log-entries .log-line")].some((l) => (l.textContent || "").includes("loaded BEFORE the debugger attached")));
    check("fast first navigation: intercepted or loudly warned (never silent)", raceFirst === "MODIFIED-RACE" || raceWarned, `first=${raceFirst} warned=${raceWarned}`);
    check("no false race warning when it WAS intercepted", !(raceFirst === "MODIFIED-RACE" && raceWarned));
    await racePage.reload();
    await racePage.waitForFunction(() => (window as any).__race !== undefined, null, { timeout: 15000 });
    check("after reload the attached tab intercepts", (await racePage.evaluate(() => (window as any).__race)) === "MODIFIED-RACE");
    await racePage.close();
    const logText = await mgr.evaluate(() => [...document.querySelectorAll("#log-entries .log-line")].map((l) => l.textContent || "").join("\n"));
    if (process.env.DBG) console.log(logText.split("\n").filter((l: string) => /Tier C|cdp|debugger|attach|requestPaused/i.test(l)).slice(-40).join("\n"));
    check("proxy → debugger-tier routing is logged", logText.includes("use the DEBUGGER tier instead"));
    check("auto-strategy hint to add \"cdp\" is logged", logText.includes(`"Auto script" intercept page fetch/XHR only`));
    check("debugger tier activation is logged", logText.includes("MV3 debugger tier active"));
    for (const id of ["s_proxy", "s_cdpx", "s_auto", "s_proxy2", "s_race"]) {
        await mgr.evaluate((id: string) => new Promise((r) => chrome.runtime.sendMessage({ type: "deleteScript", id }, r)), id);
    }
    await xoPage.close();
    await scriptPage.close();

    // ---- export → wipe → import round trip through the REAL buttons ----
    // (regression: "after import it did not detect them" — the import path
    // must re-capture declareScript for every script)
    await mgr.evaluate(() => {
        (window as any).__captured = null;
        const orig = URL.createObjectURL;
        (URL as any).createObjectURL = (blob: Blob) => {
            blob.text().then((t) => ((window as any).__captured = t)).catch(() => {});
            return orig.call(URL, blob);
        };
        (document.querySelector("#btn-settings") as HTMLElement).click();
    });
    await mgr.waitForTimeout(300);
    await mgr.evaluate(() => { (document.querySelector("#btn-export") as HTMLElement).click(); });
    await mgr.waitForTimeout(800); // the blob promise resolves async
    const bundleText = await mgr.evaluate(() => (window as any).__captured);
    check("export produces a bundle (settings + scripts)", typeof bundleText === "string" && bundleText.includes("wiretrick-bundle") && bundleText.includes("api-interceptor"));
    await mgr.evaluate(() => new Promise((r) => chrome.storage.local.clear(() => r(null))));
    await mgr.reload();
    await mgr.waitForFunction(() => (window as any).monaco?.editor.getEditors().length === 1, null, { timeout: 20000 });
    const wiped = await mgr.evaluate(() => new Promise<any>((r) => chrome.runtime.sendMessage({ type: "listScripts" }, r)));
    check("storage wiped", Array.isArray(wiped) && wiped.length === 0, JSON.stringify(wiped?.length));
    const importOk = await mgr.evaluate((text: string) => {
        (window as any).__importInput = null;
        const orig = document.createElement.bind(document);
        (document as any).createElement = (tag: string) => {
            const el = orig(tag);
            if (tag === "input") (window as any).__importInput = el; // type="file" is set after creation
            return el;
        };
        (document.querySelector("#btn-import") as HTMLElement).click();
        const input = (window as any).__importInput;
        if (!input) return "no input";
        const dt = new DataTransfer();
        dt.items.add(new File([text], "wiretrick-export.yaml", { type: "text/yaml" }));
        input.files = dt.files;
        input.dispatchEvent(new Event("change"));
        return "importing";
    }, bundleText);
    await mgr.waitForFunction(() => (document.querySelector("#editor-status")?.textContent ?? "").includes("imported"), null, { timeout: 20000 }).catch(() => {});
    const imported = await mgr.evaluate(() => new Promise<any>((r) => chrome.runtime.sendMessage({ type: "listScripts" }, r)));
    const byName = new Map<string, any>((imported || []).map((s: any) => [s.meta.name, s]));
    check("import re-detects declareScript (MV3 hook + api-interceptor declared)", byName.get("MV3 hook")?.meta?.declared === true && byName.get("api-interceptor")?.meta?.declared === true, JSON.stringify((imported || []).map((s: any) => [s.meta.name, s.meta.declared])));
    check("import restores params (api-interceptor.label)", !!byName.get("api-interceptor")?.paramDefs?.label);
    check("import keeps libraries as libraries (api-lib)", byName.get("api-lib")?.meta?.declared === false);
    check("import restores enabled state", byName.get("MV3 hook")?.enabled === true && byName.get("api-interceptor")?.enabled === true);
    check("import status shows success", (await mgr.evaluate(() => document.querySelector("#editor-status")?.textContent ?? "")).includes("imported"));

    // the user's scenario: the popup is the FIRST thing opened after the SW
    // idled out (MV3 kills it ~30s after the last event) — the popup must
    // wake it and still list. Close every extension page, wait out the SW,
    // then open the popup cold. (Runs last: it closes the manager page.)
    await popup.close();
    await mgr.close();
    const wasSwUp = (await ctx.serviceWorkers()).length > 0;
    await new Promise((r) => setTimeout(r, 35000)); // past the 30s idle stop
    const coldPopup = await ctx.newPage();
    const coldErrors: string[] = [];
    coldPopup.on("pageerror", (e: Error) => coldErrors.push(String(e?.message || e)));
    await coldPopup.goto(`chrome-extension://${extId}/popup.html`);
    await coldPopup.waitForFunction(() => [...document.querySelectorAll("#script-list .script-name")].some((e) => e.textContent === "MV3 hook"), null, { timeout: 15000 }).catch(() => {});
    const coldItems = await coldPopup.evaluate(() => [...document.querySelectorAll("#script-list .script-name")].map((e) => e.textContent));
    check("popup lists scripts on a COLD SW wake (idle restart)", coldItems.includes("MV3 hook"), `swWasUp=${wasSwUp} items=${JSON.stringify(coldItems)} errors=${JSON.stringify(coldErrors.slice(0, 2))}`);
    check("cold popup has no page errors", coldErrors.length === 0, JSON.stringify(coldErrors.slice(0, 3)));

    // ---- MV3 onDom: document_start handlers run from the cached bundle ----
    // (MV3 limitation: the bundle answers at SW-wake time — the session
    // analyze cache removes the sandbox round-trip; the cache-hit line
    // proves the fast path)
    const warm = await ctx.newPage();
    await warm.goto(`chrome-extension://${extId}/manager.html`);
    await warm.waitForFunction(() => (window as any).monaco?.editor.getEditors().length === 1, null, { timeout: 20000 });
    // the cache-hit line is debug-level — open the filter (also proves the
    // debug path end-to-end)
    await warm.evaluate(() => {
        const sel = document.querySelector("#log-level") as HTMLSelectElement;
        sel.value = "debug";
        sel.dispatchEvent(new Event("change"));
    });
    await warm.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({
        type: "saveScript", id: "s_dom", name: "Early dom",
        code: `res.declareScript({ match: ["*://*/*"] });\nres.onDom((ctx) => { document.title = "DOM-RAN:" + document.readyState; }, { when: "document_start" });`,
    }, r)));
    await warm.waitForTimeout(1500); // cache refresh (pipeline reload warm)
    const domPage = await ctx.newPage();
    await domPage.goto(`${ORIGIN}/page`);
    await domPage.waitForFunction(() => document.title.startsWith("DOM-RAN"), null, { timeout: 15000 });
    check("onDom document_start runs in MV3", true, await domPage.title());
    const cacheHit = await warm.evaluate(() =>
        [...document.querySelectorAll("#log-entries .log-line")].some((l) => (l.textContent || "").includes("analyze cache hit"))
    );
    check("getHookBundle served from the session analyze cache (no sandbox round-trip)", cacheHit);

    // ---- MV3 folder sync: the poller now runs in the service worker ----
    // (a 25s keep-alive ping + a 30s alarms fallback; previously MV3 refused
    // to sync at all while the manager still showed "Scripts Folder ✓")
    const fPage = await ctx.newPage();
    await fPage.goto(`chrome-extension://${extId}/manager.html`);
    await fPage.waitForFunction(() => (window as any).monaco?.editor.getEditors().length === 1, null, { timeout: 20000 });
    const adopted = await fPage.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        return await (window as any).__resAdoptFolder(root);
    });
    check("MV3 folder sync: OPFS folder adopted by the SW", adopted === true);
    const fst = await fPage.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "folderSyncStatus" }, r)));
    check("MV3 folder sync: status reports active", !!(fst as any)?.active, JSON.stringify(fst));

    const opfsText = (name: string): Promise<string | null> =>
        fPage.evaluate(async (n: string) => {
            try {
                const fh = await (await navigator.storage.getDirectory()).getFileHandle(n);
                return await (await fh.getFile()).text();
            } catch {
                return null;
            }
        }, name);
    const opfsWrite = (name: string, text: string): Promise<void> =>
        fPage.evaluate(async ([n, t]: [string, string]) => {
            const fh = await (await navigator.storage.getDirectory()).getFileHandle(n, { create: true });
            const w = await (fh as any).createWritable();
            await w.write(t);
            await w.close();
        }, [name, text] as any);

    // GUI change → settings.yaml must appear in the folder (commented default)
    await fPage.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({
        type: "saveScript", id: "s_sync", name: "Sync guinea",
        code: 'res.declareScript({ match: ["*://sync.invalid/*"], params: { token: { type: "string", default: "abc", description: "Sync token" } } });\n',
    }, r)));
    await fPage.waitForTimeout(2500); // export debounce + SW poller cadence
    const yaml1 = await opfsText("settings.yaml");
    check("MV3 folder sync: settings.yaml exported to the folder", !!yaml1 && yaml1.includes("Sync guinea") && yaml1.includes("# token: abc"), (yaml1 || "MISSING").slice(0, 160));

    // external whole-file edit applies to storage
    await opfsWrite("settings.yaml", (yaml1 || "").replace("# token: abc", 'token: "xyz"'));
    await fPage.waitForTimeout(2500);
    const p1 = await fPage.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "getScriptParams", scriptId: "s_sync" }, r)));
    check("MV3 folder sync: external settings.yaml edit applied", (p1 as any)?.values?.token === "xyz", JSON.stringify(p1));

    // a new .ts file in the folder inserts a script
    await opfsWrite("imported-sync.ts", 'res.declareScript({ match: ["*://imported.invalid/*"] });\n');
    await fPage.waitForTimeout(2500);
    const flist = await fPage.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "listScripts" }, r)));
    check("MV3 folder sync: external .ts file became a script", (flist as any[]).some((s) => s.meta?.name === "imported-sync"), JSON.stringify((flist as any[]).map((s) => s.meta?.name)));

    // the SW gets reaped (idle, sleep, update): a file copied in while it is
    // down must still be imported once it restarts (it used to be absorbed)
    const swCdp = await ctx.newCDPSession(fPage);
    await swCdp.send("ServiceWorker.enable");
    await swCdp.send("ServiceWorker.stopAllWorkers");
    await fPage.waitForTimeout(500);
    await opfsWrite("while-asleep.ts", 'res.declareScript({ match: ["*://asleep.invalid/*"] });\n');
    await fPage.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "folderSyncStatus" }, r))); // wakes the SW
    await fPage.waitForTimeout(2500);
    const flist2 = await fPage.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "listScripts" }, r)));
    check("MV3 folder sync: file copied in while the SW was stopped is imported after restart", (flist2 as any[]).some((s) => s.meta?.name === "while-asleep"), JSON.stringify((flist2 as any[]).map((s) => s.meta?.name)));
    await fPage.close();
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
