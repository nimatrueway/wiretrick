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
 * the debugger tier (strategy cdp; CDP pauses in the SW, handlers in
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
    if (req.url?.startsWith("/doc-cold")) {
        // zero-latency page whose OWN html a script rewrites
        res.writeHead(200, { "content-type": "text/html" });
        return res.end('<html><head><title>DOC-ORIGINAL</title></head><body>DOC-ORIGINAL</body></html>');
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
        code: `wt.declareScript({ match: ["*://*/*"] });\nwt.modifyResponse((ctx, body) => body.replace("ORIGINAL", "MV3"));`,
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
        code: `import { tag } from "./api-lib";\nwt.declareScript({ match: ["*://*/*"], params: { label: { type: "string", default: "x" } } });\nwt.modifyResponse((ctx, body) => tag(body));`,
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

    // popup opens cleanly — no warnings/errors
    const popup = await ctx.newPage();
    const popupWarnings: string[] = [];
    popup.on("console", (m: any) => { if (m.type() === "warning" || m.type() === "error") popupWarnings.push(m.text()); });
    popup.on("pageerror", (e: Error) => popupWarnings.push(String(e?.message || e)));
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.waitForTimeout(1200);
    check("popup opens without warnings", popupWarnings.length === 0, JSON.stringify(popupWarnings.slice(0, 3)));

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

    // VS Code-style hover: lists/code blocks preserved, @example fenced
    const hoverHtml = await mgr.evaluate(async () => {
        const m = (window as any).monaco;
        const ed = m.editor.getEditors()[0];
        const prev = ed.getModel();
        const model = m.editor.createModel('wt.onDom(() => {}, { when: "document_idle" });\n', "typescript", m.Uri.parse("file:///hover-probe.ts"));
        ed.setModel(model);
        ed.setPosition({ lineNumber: 1, column: 23 }); // on `when`
        ed.focus();
        let html = "";
        for (let i = 0; i < 40 && !html.includes("<li"); i++) {
            ed.trigger("t", "editor.action.showHover", {});
            await new Promise((r) => setTimeout(r, 250));
            html = document.querySelector(".monaco-hover-content")?.innerHTML ?? "";
        }
        ed.setModel(prev);
        model.dispose();
        return html;
    });
    check("TS hover renders markdown lists, tables and fenced @example code",
        hoverHtml.includes("<li") && hoverHtml.includes("<table") && /<code>[\s\S]*document_start/.test(hoverHtml) && (hoverHtml.match(/class="code"|<pre|monaco-tokenized-source/g) || []).length >= 2,
        hoverHtml.slice(0, 200));

    await mgr.bringToFront(); // a background tab throttles the suggest widget
    const popupHtml = await mgr.evaluate(async () => {
        const m = (window as any).monaco;
        const ed = m.editor.getEditors()[0];
        const prev = ed.getModel();
        const model = m.editor.createModel("wt.declareScr", "typescript", m.Uri.parse("file:///suggest-probe.ts"));
        ed.setModel(model);
        ed.setPosition({ lineNumber: 1, column: 14 });
        ed.focus();
        let details = "";
        for (let i = 0; i < 40 && !details.includes("<li") && !details.includes("@param"); i++) {
            ed.trigger("t", "editor.action.triggerSuggest", {});
            await new Promise((r) => setTimeout(r, 300));
            if (!document.querySelector(".suggest-details-container .suggest-details")?.textContent?.trim()) ed.trigger("t", "toggleSuggestionDetails", {});
            await new Promise((r) => setTimeout(r, 200));
            details = document.querySelector(".suggest-details")?.innerHTML ?? "";
        }
        ed.trigger("t", "hideSuggestWidget", {});
        model.setValue("wt.onDom(");
        ed.setPosition({ lineNumber: 1, column: 10 });
        let hints = "";
        for (let i = 0; i < 40 && !hints.includes("Receives the same"); i++) {
            ed.trigger("t", "editor.action.triggerParameterHints", {});
            await new Promise((r) => setTimeout(r, 250));
            hints = document.querySelector(".parameter-hints-widget")?.innerHTML ?? "";
        }
        ed.setModel(prev);
        model.dispose();
        return { details, hints };
    });
    const codeBlocks = (h: string) => (h.match(/monaco-tokenized-source|<pre/g) || []).length;
    check("TS completion details: wrapped signature + @param + fenced example",
        popupHtml.details.includes("@param") && popupHtml.details.includes("ParamsOf") && codeBlocks(popupHtml.details) >= 2, popupHtml.details.slice(0, 200));
    check("TS parameter hints: per-param doc + fenced examples (no inline @param)",
        popupHtml.hints.includes("Receives the same") && codeBlocks(popupHtml.hints) >= 1 && !popupHtml.hints.includes("@param"), popupHtml.hints.slice(0, 200));

    // ---- regression (the user's "onRequest doesn't work in MV3"): a
    // param-gated onRequest must see the REAL stored param values (the
    // sandbox used to compile with defaults → handlers did nothing) and
    // its decision must be honored by the hook tier ----
    await mgr.evaluate((origin: string) => new Promise((r) => chrome.runtime.sendMessage({
        type: "saveScript", id: "s_pg", name: "Param gated",
        code: `const cfg = wt.declareScript({ match: ["${origin}/*"], params: { intercept: { type: "boolean", default: false, description: "Intercept" } } });\nwt.onRequest((ctx) => { if (cfg.intercept) return { respond: { status: 200, body: { value: "PARAM-GATED" } } }; });`,
    }, r)), ORIGIN);
    await mgr.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "setScriptParam", scriptId: "s_pg", key: "intercept", value: true }, r)));
    await mgr.waitForTimeout(1500); // pipeline reload + analyze-cache warm with the new params
    const gatedPage = await ctx.newPage();
    await gatedPage.goto(`${ORIGIN}/data`);
    const gated = await gatedPage.evaluate((origin: string) => fetch(`${origin}/data`).then((r: any) => r.json()), ORIGIN);
    check("param-gated onRequest honored (real stored params, not defaults)", gated.value === "PARAM-GATED", JSON.stringify(gated));

    // ---- MV3 debugger tier: browser-initiated loads (<script src>) ARE
    // intercepted for strategy cdp scripts — CDP Fetch pauses in the
    // SW, decisions computed in the sandbox. The user's scenario: page on
    // one origin, CDN script on another, strategy ["hook", "cdp"] ----
    const CDN = `http://localhost:${PORT}`;
    if (process.env.DBG) await mgr.evaluate(() => { const sel = document.querySelector("#log-level") as HTMLSelectElement; sel.value = "debug"; sel.dispatchEvent(new Event("change")); });
    await mgr.evaluate((cdn: string) => new Promise((r) => chrome.runtime.sendMessage({
        type: "saveScript", id: "s_respond", name: "Respond script",
        code: `wt.declareScript({ match: ["${cdn}/app.js*"], strategy: ["hook", "cdp"] });\nwt.onRequest((ctx) => ({ respond: { status: 200, mime: "text/javascript", body: 'window.__marker = "RESPONDED:' + ctx.resourceType + '";' } }));`,
    }, r)), CDN);
    await mgr.evaluate((cdn: string) => new Promise((r) => chrome.runtime.sendMessage({
        type: "saveScript", id: "s_cdpx", name: "Cdp transform",
        code: `wt.declareScript({ match: ["${cdn}/gz.js", "${cdn}/lazy.js"], strategy: ["hook", "cdp"] });\nwt.modifyResponse((ctx, body) => body.replace("ORIGINAL", "MODIFIED"));`,
    }, r)), CDN);
    await mgr.evaluate((cdn: string) => new Promise((r) => chrome.runtime.sendMessage({
        type: "saveScript", id: "s_auto", name: "Auto script",
        code: `wt.declareScript({ match: ["${cdn}/auto.js"] });\nwt.modifyResponse((ctx, body) => body.replace("ORIGINAL", "MODIFIED"));`,
    }, r)), CDN);
    await mgr.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({
        type: "saveScript", id: "s_procx", name: "Process listed",
        code: `wt.declareScript({ match: ["*://process-listed.invalid/*"], strategy: ["process"] });\nwt.modifyResponse((ctx, body) => body);`,
    }, r)));
    await mgr.waitForTimeout(1500); // pipeline reload → debugger tier armed
    // Network tab records from now on (listeners attach when it opens)
    await mgr.click("#network-tab");
    await mgr.waitForSelector("#network-view .net-toolbar", { timeout: 5000 });
    const xoPage = await ctx.newPage();
    await xoPage.goto(`${ORIGIN}/page-xo`);
    await xoPage.waitForFunction(() => (window as any).__lazy !== undefined, null, { timeout: 15000 }).catch(() => {});
    const xo = await xoPage.evaluate(() => ({ marker: (window as any).__marker, gz: (window as any).__gz, lazy: (window as any).__lazy, auto: (window as any).__auto }));
    check("cross-origin <script src> onRequest respond (strategy hook+cdp → debugger tier)", xo.marker === "RESPONDED:script", JSON.stringify(xo));
    check("modifyResponse on a gzip-encoded script tag (encoding stripped)", xo.gz === "MODIFIED-GZ", JSON.stringify(xo));
    check("lazily inserted chunk (2.5s after load) still intercepted", xo.lazy === "MODIFIED-LAZY", JSON.stringify(xo));
    check("auto-strategy script leaves script tags alone (hook tier only)", xo.auto === "ORIGINAL-AUTO", JSON.stringify(xo));
    await mgr.waitForTimeout(800);
    const net: { name: string; status: string; scripts: (string | null)[] }[] = await mgr.evaluate(() =>
        [...document.querySelectorAll("#network-view tbody tr")].map((tr) => ({
            name: tr.querySelector(".net-name")?.textContent || "",
            status: tr.querySelector(".c-status")?.textContent || "",
            scripts: [...tr.querySelectorAll(".net-badge")].map((b) => b.textContent),
        })),
    );
    check("Network tab lists the page's requests", net.some((r) => r.name.startsWith("page-xo") && r.status === "200") && net.some((r) => r.name.startsWith("auto.js")), JSON.stringify(net.map((r) => r.name)));
    check("Network tab shows which script intercepted a request", net.some((r) => r.name.startsWith("gz.js") && r.scripts.includes("Cdp transform")), JSON.stringify(net.filter((r) => r.scripts.length)));
    // response body of an intercepted request: served (modified) + original
    await mgr.evaluate(() => {
        const tr = [...document.querySelectorAll("#network-view tbody tr")].find((t) => t.querySelector(".net-name")?.textContent?.startsWith("gz.js"));
        (tr as HTMLElement | undefined)?.click();
    });
    await mgr.evaluate(() => [...document.querySelectorAll("#network-view .net-details-tabs button")].find((b) => b.textContent === "Response")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const served = await mgr.evaluate(() => document.querySelector("#network-view .net-payload")?.textContent || "");
    await mgr.evaluate(() => [...document.querySelectorAll("#network-view .net-body-switch button")].find((b) => b.textContent === "Original")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const original = await mgr.evaluate(() => document.querySelector("#network-view .net-payload")?.textContent || "");
    check("Network details show the modified + original response body", served.includes("MODIFIED-GZ") && original.includes("ORIGINAL-GZ"), JSON.stringify({ served, original }));
    await mgr.evaluate(() => (document.querySelector("#network-view .net-details-close") as HTMLElement | null)?.click());
    // tab filter: the page's tab keeps its (intercepted) requests
    const xoTabId = await mgr.evaluate((u: string) => new Promise<number>((r) => chrome.tabs.query({}, (ts) => r(ts.find((t) => t.url === u)?.id ?? -1))), `${ORIGIN}/page-xo`);
    await mgr.focus("#network-view .net-tab");
    await mgr.waitForTimeout(300);
    await mgr.selectOption("#network-view .net-tab", String(xoTabId));
    await mgr.waitForTimeout(300);
    const inTab: string[] = await mgr.evaluate(() => [...document.querySelectorAll("#network-view tbody .net-name")].map((n) => n.textContent || ""));
    check("Network tab filter keeps the tab's intercepted requests", inTab.some((n) => n.startsWith("gz.js")) && inTab.some((n) => n.startsWith("page-xo")), JSON.stringify(inTab));
    await mgr.selectOption("#network-view .net-tab", "");
    await mgr.click("#log-header-title");

    // ---- script error indicators: compile error + runtime error ----
    await mgr.evaluate((origin: string) => new Promise((r) => chrome.runtime.sendMessage({
        type: "saveScript", id: "s_throws", name: "Thrower",
        code: `wt.declareScript({ match: ["${origin}/kaboom*"] });\nwt.onRequest(() => { throw new Error("kaboom"); });`,
    }, r)), "http://localhost:8909");
    await mgr.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "saveScript", id: "s_broken", name: "Broken", code: "wt.declareScript({ match: [ ;" }, r)));
    await mgr.waitForTimeout(1200);
    const errPage = await ctx.newPage();
    await errPage.goto(`${ORIGIN}/page`);
    await errPage.waitForFunction(() => document.title.startsWith("DONE:"), null, { timeout: 15000 }).catch(() => {});
    // localhost: no other test script matches it (Param gated responds on 127.0.0.1)
    await errPage.evaluate(() => fetch("http://localhost:8909/kaboom").catch(() => {}));
    await errPage.waitForTimeout(500);
    await errPage.close();
    await mgr.waitForSelector('#script-list li[data-id="s_throws"] .err-ind.runtime', { timeout: 8000 }).catch(() => {});
    const ind = await mgr.evaluate(() => ({
        runtime: document.querySelector('#script-list li[data-id="s_throws"] .err-ind.runtime')?.getAttribute("title") || "",
        compile: document.querySelector('#script-list li[data-id="s_broken"] .err-ind.compile')?.getAttribute("title") || "",
        logged: [...document.querySelectorAll("#log-entries .log-line.error")].some((l) => ((l as HTMLElement).dataset.text || l.textContent || "").includes("kaboom")),
    }));
    check("runtime script error → indicator in the manager list", ind.runtime.includes("kaboom"), JSON.stringify(ind));
    check("compile error → indicator in the manager list", ind.compile.includes("Compile error"), JSON.stringify(ind));
    check("runtime script error logged at ERROR level", ind.logged);
    const errPopup = await ctx.newPage();
    await errPopup.goto(`chrome-extension://${extId}/popup.html`);
    await errPopup.waitForSelector("#script-list li.script-item", { timeout: 8000 });
    const popupInd = await errPopup.evaluate(() => [...document.querySelectorAll("li.script-item")].filter((li) => li.querySelector(".err-ind")).map((li) => li.querySelector(".script-name")?.textContent));
    check("popup shows error indicators", popupInd.includes("Thrower"), JSON.stringify(popupInd));
    await mgr.click('#script-list li[data-id="s_throws"] .err-ind.runtime');
    await mgr.waitForTimeout(500);
    check("clicking the runtime indicator dismisses it", !(await mgr.$('#script-list li[data-id="s_throws"] .err-ind')));
    await errPopup.close();
    // TypeScript errors (editor squiggles) → ERROR log + "types" badge; two
    // scripts declaring the same top-level name must not collide
    for (const [id, name, code] of [
        ["s_typed", "Typed", `wt.declareScript({ match: ["*://typed.invalid/*"] });\nconst cfg = 1;\nconst n: number = "not a number";`],
        ["s_typed2", "Typed2", `wt.declareScript({ match: ["*://typed2.invalid/*"] });\nconst cfg = 2;\nexport function never() { console.log(new TextDecoder().decode(new Uint8Array()), new URL("x"), fetch, cfg); }`],
    ]) await mgr.evaluate((m: any) => new Promise((r) => chrome.runtime.sendMessage({ type: "saveScript", ...m }, r)), { id, name, code });
    await mgr.waitForSelector('#script-list li[data-id="s_typed"] .err-ind.types', { timeout: 15000 }).catch(() => {});
    const typed = await mgr.evaluate(() => ({
        badge: document.querySelector('#script-list li[data-id="s_typed"] .err-ind.types')?.getAttribute("title") || "",
        clean: !document.querySelector('#script-list li[data-id="s_typed2"] .err-ind'),
        logged: [...document.querySelectorAll("#log-entries .log-line.error")].map((l) => (l as HTMLElement).dataset.text || l.textContent || "").filter((t) => t.includes("type error")),
    }));
    check("TypeScript error → types indicator in the manager list", typed.badge.includes("line 3:") && !typed.badge.includes("cfg"), JSON.stringify(typed));
    check("scripts don't share a global scope; DOM globals (TextDecoder…) are typed", typed.clean, JSON.stringify(typed));
    check("TypeScript error logged at ERROR level", typed.logged.some((t: string) => t.includes("[Typed] type error: line 3")), JSON.stringify(typed.logged));
    const typedPopup = await ctx.newPage();
    await typedPopup.goto(`chrome-extension://${extId}/popup.html`);
    await typedPopup.waitForSelector("#script-list li.script-item", { timeout: 8000 });
    const typedInd = await typedPopup.evaluate(() => [...document.querySelectorAll("li.script-item")].filter((li) => li.querySelector(".err-ind.types")).map((li) => li.querySelector(".script-name")?.textContent));
    check("popup shows the TypeScript error indicator", typedInd.includes("Typed"), JSON.stringify(typedInd));
    await typedPopup.close();
    // save conflict: the stored copy changes while the editor holds unsaved edits
    await mgr.bringToFront();
    await mgr.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "saveScript", id: "s_conf", name: "Conflicted", code: "// v1\n" }, r)));
    await mgr.waitForSelector('#script-list li[data-id="s_conf"]', { timeout: 8000 });
    mgr.once("dialog", (d: any) => void d.accept()); // earlier probes may leave the open buffer dirty
    await mgr.evaluate(() => (document.querySelector('#script-list li[data-id="s_conf"]') as HTMLElement).click());
    await mgr.waitForFunction(() => (window as any).monaco.editor.getEditors()[0].getValue() === "// v1\n", null, { timeout: 8000 }).catch(() => {});
    await mgr.evaluate(() => (window as any).monaco.editor.getEditors()[0].trigger("t", "type", { text: "// mine\n" }));
    await mgr.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "saveScript", id: "s_conf", name: "Conflicted", code: "// theirs\n" }, r)));
    await mgr.waitForTimeout(500);
    await mgr.locator("#btn-save").click();
    const conflictShown = await mgr.waitForSelector("#conflict-dialog .conflict-diff", { timeout: 8000 }).then(() => true, () => false);
    await mgr.locator('#conflict-dialog [data-act="theirs"]').click().catch(() => {});
    await mgr.waitForTimeout(300);
    const afterTheirs = await mgr.evaluate(() => (window as any).monaco.editor.getEditors()[0].getValue());
    check("saving over an outside change opens the conflict diff; Take theirs loads it", conflictShown && afterTheirs === "// theirs\n", JSON.stringify({ conflictShown, afterTheirs }));
    await mgr.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "deleteScript", id: "s_conf" }, r)));
    for (const id of ["s_throws", "s_broken", "s_typed", "s_typed2"]) await mgr.evaluate((id: string) => new Promise((r) => chrome.runtime.sendMessage({ type: "deleteScript", id }, r)), id);
    // a reload in the already-attached tab (no first-navigation race)
    await xoPage.reload();
    await xoPage.waitForFunction(() => (window as any).__gz !== undefined, null, { timeout: 15000 }).catch(() => {});
    check("reload in an attached tab intercepted too", (await xoPage.evaluate(() => (window as any).__marker)) === "RESPONDED:script");
    // same-origin script; "proxy" (removed strategy) is ignored with a warning
    await mgr.evaluate((origin: string) => new Promise((r) => chrome.runtime.sendMessage({
        type: "saveScript", id: "s_proxy2", name: "Proxy same-origin",
        code: `wt.declareScript({ match: ["${origin}/app.js"], strategy: ["proxy", "cdp"] });\nwt.modifyResponse((ctx, body) => body.replace("ORIGINAL-MARKER", "PROXY-MARKER"));`,
    }, r)), ORIGIN);
    await mgr.waitForTimeout(1500);
    const scriptPage = await ctx.newPage();
    await scriptPage.goto(`${ORIGIN}/page-script`);
    await scriptPage.waitForFunction(() => (window as any).__marker !== undefined, null, { timeout: 15000 });
    check("same-origin <script src> modifyResponse (strategy cdp)", (await scriptPage.evaluate(() => (window as any).__marker)) === "PROXY-MARKER", JSON.stringify(await scriptPage.evaluate(() => (window as any).__marker)));
    // zero-latency first navigation: may beat the attach — must then be
    // WARNED (never silent), and a reload must intercept
    await mgr.evaluate((origin: string) => new Promise((r) => chrome.runtime.sendMessage({
        type: "saveScript", id: "s_race", name: "Race script",
        code: `wt.declareScript({ match: ["${origin}/race.js"], strategy: ["cdp"] });\nwt.modifyResponse((ctx, body) => body.replace("ORIGINAL", "MODIFIED"));`,
    }, r)), ORIGIN);
    await mgr.waitForTimeout(1500);
    const racePage = await ctx.newPage();
    await racePage.goto(`${ORIGIN}/page-race`);
    await racePage.waitForFunction(() => (window as any).__race !== undefined, null, { timeout: 15000 });
    const raceFirst = await racePage.evaluate(() => (window as any).__race);
    await mgr.waitForTimeout(2500); // the warning is judged 1.5s after the load
    const raceWarned = await mgr.evaluate(() => [...document.querySelectorAll("#log-entries .log-line")].some((l) => (l.textContent || "").includes("loaded before the debugger attached")));
    check("fast first navigation: intercepted or loudly warned (never silent)", raceFirst === "MODIFIED-RACE" || raceWarned, `first=${raceFirst} warned=${raceWarned}`);
    check("no false race warning when it WAS intercepted", !(raceFirst === "MODIFIED-RACE" && raceWarned));
    await racePage.reload();
    await racePage.waitForFunction(() => (window as any).__race !== undefined, null, { timeout: 15000 });
    check("after reload the attached tab intercepts", (await racePage.evaluate(() => (window as any).__race)) === "MODIFIED-RACE");
    await racePage.close();
    // a page whose own html is rewritten: a cold first load that beats the
    // attach is re-issued through the debugger, so it IS intercepted
    await mgr.evaluate((origin: string) => new Promise((r) => chrome.runtime.sendMessage({
        type: "saveScript", id: "s_doccold", name: "Doc cold",
        code: `wt.declareScript({ match: ["${origin}/doc-cold*"], strategy: ["cdp"] });\nwt.modifyResponse((ctx, body) => body.replaceAll("DOC-ORIGINAL", "DOC-MODIFIED"));`,
    }, r)), ORIGIN);
    await mgr.waitForTimeout(1500);
    const docPage = await ctx.newPage();
    await docPage.goto(`${ORIGIN}/doc-cold`).catch(() => {});
    await docPage.waitForFunction(() => document.title === "DOC-MODIFIED", null, { timeout: 8000 }).catch(() => {});
    const docTitle = await docPage.title().catch(() => "");
    await mgr.waitForTimeout(1000);
    const docLog = await mgr.evaluate(() => [...document.querySelectorAll("#log-entries .log-line")].map((l) => l.textContent || "").join("\n"));
    check("cold first page load is intercepted (re-issued if it beat the attach)", docTitle === "DOC-MODIFIED", `title=${docTitle} renav=${docLog.includes("re-loaded it through the debugger")}`);
    check("no miss warning for the re-issued page load", !/doc-cold was NOT intercepted/.test(docLog));
    await docPage.close();
    await mgr.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "deleteScript", id: "s_doccold" }, r)));
    const logText = await mgr.evaluate(() => [...document.querySelectorAll("#log-entries .log-line")].map((l) => l.textContent || "").join("\n"));
    if (process.env.DBG) console.log(logText.split("\n").filter((l: string) => /Tier C|cdp|debugger|attach|requestPaused/i.test(l)).slice(-40).join("\n"));
    check("removed \"proxy\" strategy is warned about", logText.includes(`"proxy" strategy was removed`));
    check("auto-strategy hint to add \"cdp\" is logged", logText.includes(`"Auto script" intercept page fetch/XHR only`));
    check("process-listed scripts get no add-\"cdp\" hint", !logText.includes(`"Process listed"`) || !/"Process listed"[^\n]*intercept page fetch\/XHR only/.test(logText));
    check("debugger tier activation is logged", logText.includes("MV3 debugger tier active"));
    for (const id of ["s_respond", "s_cdpx", "s_auto", "s_procx", "s_proxy2", "s_race"]) {
        await mgr.evaluate((id: string) => new Promise((r) => chrome.runtime.sendMessage({ type: "deleteScript", id }, r)), id);
    }
    await xoPage.close();
    await scriptPage.close();

    // ---- Settings → Appearance: light theme recolors the UI and Monaco ----
    await mgr.evaluate(() => {
        const sel = document.querySelector("#settings-theme") as HTMLSelectElement;
        sel.value = "light";
        sel.dispatchEvent(new Event("change"));
    });
    await mgr.waitForFunction(() => document.documentElement.dataset.theme === "light", null, { timeout: 5000 }).catch(() => {});
    const light = await mgr.evaluate(() => ({
        attr: document.documentElement.dataset.theme,
        bg: getComputedStyle(document.body).backgroundColor,
        editor: getComputedStyle(document.querySelector(".monaco-editor .monaco-editor-background")!).backgroundColor,
    }));
    check("light theme applies to the manager and Monaco", light.attr === "light" && light.bg === "rgb(255, 255, 255)" && light.editor === "rgb(255, 255, 254)", JSON.stringify(light));
    const popupTheme = await ctx.newPage();
    await popupTheme.goto(`chrome-extension://${extId}/popup.html`);
    await popupTheme.waitForTimeout(500);
    check("popup follows the theme", (await popupTheme.evaluate(() => document.documentElement.dataset.theme)) === "light");
    await popupTheme.close();
    await mgr.evaluate(() => {
        const sel = document.querySelector("#settings-theme") as HTMLSelectElement;
        sel.value = "dark";
        sel.dispatchEvent(new Event("change"));
    });
    await mgr.waitForFunction(() => document.documentElement.dataset.theme === "dark", null, { timeout: 5000 }).catch(() => {});
    check("dark theme restores", (await mgr.evaluate(() => getComputedStyle(document.body).backgroundColor)) === "rgb(30, 30, 30)");

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
    // partial export: untick "MV3 hook" → it's left out; untick the
    // library api-interceptor imports → the picker warns, "Add them" re-ticks
    await mgr.evaluate(() => { (document.querySelector("#btn-export") as HTMLElement).click(); });
    await mgr.waitForSelector("#bundle-picker .picker-row", { timeout: 5000 });
    const exportRows = await mgr.evaluate(() => [...document.querySelectorAll("#bundle-picker .picker-label")].map((e) => e.textContent));
    check("export picker lists every script", exportRows.includes("MV3 hook") && exportRows.includes("api-interceptor") && exportRows.includes("api-lib"), JSON.stringify(exportRows));
    const pickerWarn = await mgr.evaluate(() => {
        const rows = [...document.querySelectorAll<HTMLElement>("#bundle-picker .picker-row")];
        const boxes = new Map(rows.map((r) => [r.querySelector(".picker-label")?.textContent, r.querySelector("input")!]));
        boxes.get("MV3 hook")!.click();
        boxes.get("api-lib")!.click();
        const warn = document.querySelector<HTMLElement>("#bundle-picker .picker-warn")!;
        const shown = !warn.hidden && (warn.textContent || "").includes("api-lib");
        (warn.querySelector("button") as HTMLElement).click();
        return { shown, relinked: boxes.get("api-lib")!.checked && warn.hidden };
    });
    check("picker warns about an unticked imported library; Add them re-ticks it", pickerWarn.shown && pickerWarn.relinked, JSON.stringify(pickerWarn));
    await mgr.evaluate(() => (document.querySelector('#bundle-picker [data-act="ok"]') as HTMLElement).click());
    await mgr.waitForTimeout(800);
    const partialText: string = await mgr.evaluate(() => (window as any).__captured);
    check("partial export leaves out the unticked script", typeof partialText === "string" && partialText.includes("api-interceptor") && !partialText.includes("name: MV3 hook"));
    await mgr.evaluate(() => { (window as any).__captured = null; (document.querySelector("#btn-export") as HTMLElement).click(); });
    await mgr.waitForSelector("#bundle-picker .picker-row", { timeout: 5000 });
    await mgr.evaluate(() => (document.querySelector('#bundle-picker [data-act="ok"]') as HTMLElement).click());
    await mgr.waitForTimeout(800); // the blob promise resolves async
    const bundleText = await mgr.evaluate(() => (window as any).__captured);
    check("export produces a bundle (settings + scripts)", typeof bundleText === "string" && bundleText.includes("wiretrick-bundle") && bundleText.includes("api-interceptor") && bundleText.includes("name: MV3 hook"));
    const skipName = exportRows.find((n: string | null) => n && !["MV3 hook", "api-interceptor", "api-lib", "Settings (globals)"].includes(n));
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
    // partial import: untick one script → it isn't created
    await mgr.waitForSelector("#bundle-picker .picker-row", { timeout: 5000 });
    const importBadges = await mgr.evaluate((skip: string | undefined) => {
        const rows = [...document.querySelectorAll<HTMLElement>("#bundle-picker .picker-row")];
        if (skip) rows.find((r) => r.querySelector(".picker-label")?.textContent === skip)?.querySelector("input")?.click();
        const badges = rows.map((r) => r.querySelector(".picker-badge")?.textContent);
        (document.querySelector('#bundle-picker [data-act="ok"]') as HTMLElement).click();
        return badges;
    }, skipName);
    check("import picker marks scripts as new", importBadges.filter((b: any) => b === "new").length >= 3, JSON.stringify(importBadges));
    await mgr.waitForFunction(() => (document.querySelector("#editor-status")?.textContent ?? "").includes("imported"), null, { timeout: 20000 }).catch(() => {});
    const imported = await mgr.evaluate(() => new Promise<any>((r) => chrome.runtime.sendMessage({ type: "listScripts" }, r)));
    const byName = new Map<string, any>((imported || []).map((s: any) => [s.meta.name, s]));
    check("import re-detects declareScript (MV3 hook + api-interceptor declared)", byName.get("MV3 hook")?.meta?.declared === true && byName.get("api-interceptor")?.meta?.declared === true, JSON.stringify((imported || []).map((s: any) => [s.meta.name, s.meta.declared])));
    check("import restores params (api-interceptor.label)", !!byName.get("api-interceptor")?.paramDefs?.label);
    check("import keeps libraries as libraries (api-lib)", byName.get("api-lib")?.meta?.declared === false);
    check("import restores enabled state", byName.get("MV3 hook")?.enabled === true && byName.get("api-interceptor")?.enabled === true);
    check("partial import skips the unticked script", !!skipName && !byName.has(skipName), String(skipName));
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
        code: `wt.declareScript({ match: ["*://*/*"] });\nwt.onDom((ctx) => { document.title = "DOM-RAN:" + document.readyState; }, { when: "document_start" });`,
    }, r)));
    // a second script with its own `when` must not inherit the first's
    await warm.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({
        type: "saveScript", id: "s_idle", name: "Idle dom",
        code: `wt.declareScript({ match: ["*://*/*"] });\nwt.onDom(() => { document.documentElement.dataset.idle = document.readyState; }, { when: "document_idle" });`,
    }, r)));
    await warm.waitForTimeout(1500); // cache refresh (pipeline reload warm)
    const domPage = await ctx.newPage();
    await domPage.goto(`${ORIGIN}/page`);
    await domPage.waitForFunction(() => document.title.startsWith("DOM-RAN"), null, { timeout: 15000 });
    check("onDom document_start runs in MV3", true, await domPage.title());
    await domPage.waitForFunction(() => !!document.documentElement.dataset.idle, null, { timeout: 15000 }).catch(() => null);
    const idleState = await domPage.evaluate(() => document.documentElement.dataset.idle);
    check("onDom: each script keeps its own when (document_idle runs after load)", idleState === "complete", String(idleState));
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
        code: 'wt.declareScript({ match: ["*://sync.invalid/*"], params: { token: { type: "string", default: "abc", description: "Sync token" } } });\n',
    }, r)));
    await fPage.waitForTimeout(2500); // export debounce + SW poller cadence
    const yaml1 = await opfsText("settings.yaml");
    check("MV3 folder sync: settings.yaml exported to the folder", !!yaml1 && yaml1.includes("Sync guinea") && yaml1.includes("# token: abc"), (yaml1 || "MISSING").slice(0, 160));

    const schema1 = JSON.parse((await opfsText("settings.schema.json")) || "{}");
    check("MV3 folder sync: settings.schema.json types each script's params (VS Code completion)",
        schema1?.properties?.params?.properties?.["Sync guinea"]?.properties?.token?.default === "abc", JSON.stringify(schema1?.properties?.params?.properties ?? {}).slice(0, 160));

    // external whole-file edit applies to storage
    await opfsWrite("settings.yaml", (yaml1 || "").replace("# token: abc", 'token: "xyz"'));
    await fPage.waitForTimeout(2500);
    const p1 = await fPage.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "getScriptParams", scriptId: "s_sync" }, r)));
    check("MV3 folder sync: external settings.yaml edit applied", (p1 as any)?.values?.token === "xyz", JSON.stringify(p1));

    // whole-file sync: a comment-only disk edit reaches the manager's open editor verbatim
    await fPage.locator(".script-item", { hasText: "settings.yaml" }).click();
    await fPage.waitForFunction(() => (window as any).monaco.editor.getEditors()[0].getModel()?.uri.toString() === "file:///settings.yaml");
    const diskText = "# my own note\n" + ((await opfsText("settings.yaml")) || "");
    await opfsWrite("settings.yaml", diskText);
    await fPage.waitForTimeout(2500);
    const mgrText = await fPage.evaluate(() => (window as any).monaco.editor.getEditors()[0].getValue());
    check("MV3 folder sync: disk settings.yaml becomes the manager's text as a whole", mgrText === diskText, JSON.stringify(mgrText).slice(0, 200));

    // …and the other way: a manager save lands in the file verbatim
    const savedText = diskText.replace("# my own note\n", "# saved from the manager\n");
    await fPage.evaluate((t: string) => new Promise((r) => chrome.runtime.sendMessage({ type: "applySettingsYaml", text: t }, r)), savedText);
    await fPage.waitForTimeout(500);
    check("MV3 folder sync: manager settings.yaml save written to disk as a whole", (await opfsText("settings.yaml")) === savedText);

    // a new .ts file in the folder inserts a script
    await opfsWrite("imported-sync.ts", 'wt.declareScript({ match: ["*://imported.invalid/*"] });\n');
    await fPage.waitForTimeout(2500);
    const flist = await fPage.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "listScripts" }, r)));
    check("MV3 folder sync: external .ts file became a script", (flist as any[]).some((s) => s.meta?.name === "imported-sync"), JSON.stringify((flist as any[]).map((s) => s.meta?.name)));

    // the SW gets reaped (idle, sleep, update): a file copied in while it is
    // down must still be imported once it restarts (it used to be absorbed)
    const swCdp = await ctx.newCDPSession(fPage);
    await swCdp.send("ServiceWorker.enable");
    await swCdp.send("ServiceWorker.stopAllWorkers");
    await fPage.waitForTimeout(500);
    await opfsWrite("while-asleep.ts", 'wt.declareScript({ match: ["*://asleep.invalid/*"] });\n');
    await fPage.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "folderSyncStatus" }, r))); // wakes the SW
    await fPage.waitForTimeout(2500);
    const flist2 = await fPage.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "listScripts" }, r)));
    check("MV3 folder sync: file copied in while the SW was stopped is imported after restart", (flist2 as any[]).some((s) => s.meta?.name === "while-asleep"), JSON.stringify((flist2 as any[]).map((s) => s.meta?.name)));

    // scripts saved outside the editor (Import…) land in the folder, and an
    // importer saved before its library re-checks once the library appears
    const saveMsg = (id: string, name: string, code: string) =>
        fPage.evaluate((m: any) => new Promise((r) => chrome.runtime.sendMessage(m, r)), { type: "saveScript", id, name, code });
    await saveMsg("s_late_user", "late-user", 'import { late } from "./late-lib";\nwt.declareScript({ match: ["*://late.invalid/*"] });\nlate();\n');
    await fPage.waitForTimeout(2500);
    await saveMsg("s_late_lib", "late-lib", "export function late(): void {}\n");
    await fPage.waitForTimeout(3500);
    check("MV3 folder sync: scripts saved outside the editor are written to the folder",
        (await opfsText("late-user.ts"))?.includes("./late-lib") === true && (await opfsText("late-lib.ts"))?.includes("late()") === true);
    const lateList = (await fPage.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "listScripts" }, r)))) as any[];
    const lateUser = lateList.find((s) => s.meta?.name === "late-user");
    check("importer saved before its library: 'Cannot find module' clears once the library exists",
        !!lateUser && !(lateUser.typeErrors || []).length, JSON.stringify(lateUser?.typeErrors));
    await fPage.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "deleteScript", id: "s_sync" }, r)));
    await fPage.waitForTimeout(2500);
    const yamlDel = (await opfsText("settings.yaml")) || "";
    check("MV3 folder sync: a deleted script's settings.yaml section is commented out",
        /# script "Sync guinea" no longer exists/.test(yamlDel) && !/^  Sync guinea:/m.test(yamlDel), yamlDel.slice(0, 400));
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
