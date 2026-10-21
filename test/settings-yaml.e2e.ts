/**
 * E2E: the virtual ⚙ settings.yaml file in the manager, two-way with the
 * popup / storage, no folder sync involved.
 *
 * Usage: npm run build && npx tsx test/settings-yaml.e2e.ts
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { resolveBrowser } from "./browserSetup";

const EXT_ROOT = path.join(new URL("..", import.meta.url).pathname, "dist");
const profile = mkdtempSync(path.join(tmpdir(), "reso-yaml-"));
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
        type: "saveScript", id: "s_dbg", name: "Debug header",
        code: 'wt.declareScript({ match: ["*://example.invalid/*"], params: { level: { type: "string", default: "warn", description: "Value of the x-debug header" } } });\n',
    }, r)));
    await seed.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({
        type: "saveScript", id: "s_note", name: "Notes",
        code: 'wt.declareScript({ match: ["*://example.invalid/*"], params: { body: { type: "string", multiline: true, default: "", description: "Free text" } } });\n',
    }, r)));
    await seed.close();

    const mgr = await ctx.newPage();
    await mgr.goto(`chrome-extension://${extId}/manager.html`);
    await mgr.waitForFunction(() => (window as any).monaco?.editor.getEditors().length === 1 && document.querySelectorAll(".script-item").length >= 2, null, { timeout: 20000 });

    const gear = mgr.locator(".script-item", { hasText: "settings.yaml" });
    check("⚙ row present", (await gear.locator(".util-icon").textContent()) === "⚙");
    check("⚙ row has no toggle / delete", (await gear.locator(".switch, .btn-del").count()) === 0);
    await gear.click();
    const text = () => mgr.evaluate(() => (window as any).monaco.editor.getEditors()[0].getValue());
    const uri = () => mgr.evaluate(() => (window as any).monaco.editor.getEditors()[0].getModel()?.uri.toString());
    await mgr.waitForFunction(() => (window as any).monaco.editor.getEditors()[0].getModel()?.uri.toString() === "file:///settings.yaml");
    let t = await text();
    check("model is settings.yaml", (await uri()) === "file:///settings.yaml");
    check("schema modeline", t.startsWith("# yaml-language-server: $schema=./settings.schema.json\n"), t.slice(0, 120));
    check("description + commented default", t.includes("# Value of the x-debug header") && t.includes("# level: warn"), t);
    check("enabled default commented", t.includes("# enabled: true"));

    const params = () => mgr.evaluate(() => new Promise<any>((r) => chrome.storage.local.get(["resParams", "resScripts"], r)));
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "setScriptParam", scriptId: "s_dbg", key: "level", value: "trace" }, r)));
    await mgr.waitForFunction(() => (window as any).monaco.editor.getEditors()[0].getValue().includes("level: trace"), null, { timeout: 10000 });
    t = await text();
    check("popup param change reflected in manager model", t.includes("# level: warn\n    level: trace"), t);
    check("…and storage", (await params()).resParams?.s_dbg?.level === "trace");

    const set = (v: string) => mgr.evaluate((v: string) => (window as any).monaco.editor.getEditors()[0].setValue(v), v);
    await set(t.replace("level: trace", "level: debug").replace("# enabled: true", "enabled: false"));
    await mgr.locator("#btn-save").click();
    await mgr.waitForFunction(() => (document.querySelector("#editor-status")?.textContent ?? "").includes("saved"));
    let st = await params();
    check("YAML edit applied to params", st.resParams?.s_dbg?.level === "debug");
    check("YAML edit toggled script off", st.resScripts?.s_dbg?.enabled === false, JSON.stringify(st.resScripts?.s_dbg && { enabled: st.resScripts.s_dbg.enabled }));
    const listOff = await mgr.waitForFunction(() => {
        const li = [...document.querySelectorAll(".script-item")].find((e) => e.textContent?.includes("Debug header"));
        return !!li?.querySelector(".switch") && !li.querySelector(".switch.on");
    }, null, { timeout: 5000 }).then(() => true, () => false);
    check("list reflects disabled script", listOff);

    // multiline string param: popup textarea -> storage -> YAML -> storage
    await popup.reload();
    await popup.locator(".script-item", { hasText: "Notes" }).locator(".btn-fold").click();
    const ta = popup.locator("textarea");
    await ta.waitFor({ timeout: 10000 });
    check("multiline param renders a textarea", (await ta.count()) === 1);
    await ta.fill('line one\nline "two"');
    await ta.dispatchEvent("change");
    await mgr.waitForFunction(() => (window as any).monaco.editor.getEditors()[0].getValue().includes("body: |-"), null, { timeout: 10000 });
    t = await text();
    check("newline value written as a YAML block scalar", t.includes('body: |-\n      line one\n      line "two"'), t);
    check("…and storage has the real newline", (await params()).resParams?.s_note?.body === 'line one\nline "two"');
    // block scalar content must stay indented — replace whole lines
    await set(t.replace("      line one\n", "      first\n      second\n"));
    await mgr.locator("#btn-save").click();
    await mgr.waitForFunction(() => (document.querySelector("#editor-status")?.textContent ?? "").includes("saved"));
    check("YAML block scalar edit applied", (await params()).resParams?.s_note?.body === 'first\nsecond\nline "two"');

    // ---- VS Code shortcuts: Cmd+/ toggles a comment, Cmd+P quick-opens settings.yaml ----
    await mgr.locator(".script-item", { hasText: "Debug header" }).click();
    await mgr.waitForFunction(() => (window as any).monaco.editor.getEditors()[0].getModel()?.uri.toString() === "file:///Debug%20header.ts");
    await mgr.locator("#monaco-host").click();
    await mgr.evaluate(() => (window as any).monaco.editor.getEditors()[0].setPosition({ lineNumber: 1, column: 1 }));
    const line1Before = await mgr.evaluate(() => (window as any).monaco.editor.getEditors()[0].getModel().getLineContent(1));
    await mgr.keyboard.press("Meta+/");
    const line1After = await mgr.evaluate(() => (window as any).monaco.editor.getEditors()[0].getModel().getLineContent(1));
    check("Cmd+/ comments the line", !line1Before.startsWith("//") && line1After.startsWith("//"), JSON.stringify({ line1Before, line1After }));
    await mgr.keyboard.press("Meta+/");
    const line1Restored = await mgr.evaluate(() => (window as any).monaco.editor.getEditors()[0].getModel().getLineContent(1));
    check("Cmd+/ again uncomments", line1Restored === line1Before, line1Restored);
    await mgr.keyboard.press("Meta+s");
    await mgr.waitForFunction(() => (document.querySelector("#editor-status")?.textContent ?? "").includes("saved"));

    await mgr.keyboard.press("Meta+p");
    await mgr.waitForSelector("#quick-open:not(.hidden)");
    check("Cmd+P opens the quick-open palette", true);
    await mgr.keyboard.type("settings");
    await mgr.keyboard.press("Enter");
    await mgr.waitForFunction(() => (window as any).monaco.editor.getEditors()[0].getModel()?.uri.toString() === "file:///settings.yaml");
    check("Cmd+P selects settings.yaml", (await mgr.evaluate(() => document.querySelector("#quick-open")?.classList.contains("hidden"))) === true);
    check(
        "Cmd+P jump focuses the editor",
        await mgr.evaluate(() => {
            const ae = document.activeElement;
            return !!ae && (document.querySelector("#monaco-host")?.contains(ae) ?? false);
        })
    );

    const before = await params();
    await set('params:\n  "Debug header": [unclosed\n');
    await mgr.locator("#btn-save").click();
    await mgr.waitForTimeout(800);
    const status = await mgr.evaluate(() => ({ text: document.querySelector("#editor-status")?.textContent ?? "", cls: document.querySelector("#editor-status")?.className ?? "" }));
    check("malformed YAML → error status", /settings\.yaml/.test(status.text) && /error/.test(status.cls), JSON.stringify(status));
    check("malformed YAML leaves state untouched", JSON.stringify(await params()) === JSON.stringify(before));

    // ---- schema assistance: markers, completion, hover ----
    const markers = () => mgr.evaluate(() => {
        const m = (window as any).monaco;
        return m.editor.getModelMarkers({ owner: "wt-settings" }).map((x: any) => x.message);
    });
    await set('settings:\n  logLevel: loud\nparams:\n  Debug header:\n    level: 3\n    nope: 1\n  Ghost: {}\n');
    await mgr.waitForTimeout(800);
    const mk = await markers();
    check("marker: bad enum value", mk.some((x: string) => x.startsWith("Expected one of debug")), JSON.stringify(mk));
    check("marker: param type from declareScript", mk.some((x: string) => x.startsWith("Expected string")), JSON.stringify(mk));
    check("marker: undeclared param", mk.some((x: string) => x.includes('declares no param "nope"')), JSON.stringify(mk));
    check("marker: unknown script", mk.some((x: string) => x.includes('No script named "Ghost"')), JSON.stringify(mk));
    await set("params:\n  Debug header:\n    \n");
    await mgr.evaluate(() => {
        const ed = (window as any).monaco.editor.getEditors()[0];
        ed.setPosition({ lineNumber: 3, column: 5 });
        ed.focus();
        ed.trigger("t", "editor.action.triggerSuggest", {});
    });
    await mgr.waitForSelector(".suggest-widget.visible .monaco-list-row", { timeout: 5000 }).catch(() => null);
    const sugg = await mgr.evaluate(() => [...document.querySelectorAll(".suggest-widget.visible .monaco-list-row .label-name")].map((e) => e.textContent));
    check("completion: script params", sugg.includes("enabled") && sugg.includes("level"), JSON.stringify(sugg));
    await mgr.keyboard.press("Escape");
    await mgr.evaluate(() => {
        const ed = (window as any).monaco.editor.getEditors()[0];
        ed.setPosition({ lineNumber: 2, column: 5 });
        ed.trigger("t", "editor.action.showHover", {});
    });
    await mgr.waitForSelector(".monaco-hover:not(.hidden) .hover-contents", { timeout: 5000 }).catch(() => null);
    const hov = await mgr.evaluate(() => [...document.querySelectorAll(".monaco-hover .hover-contents")].map((e) => e.textContent).join(" | "));
    check("hover: script's params with descriptions", hov.includes("Value of the x-debug header"), hov);
    // popup's getScriptParams must resolve imports of other scripts (MV2 compiled the one script alone → no defs)
    await mgr.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "saveScript", id: "s_lib", name: "lib", code: "export const x = 1;\n" }, r)));
    await mgr.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({
        type: "saveScript", id: "s_imp", name: "Importer",
        code: 'import { x } from "./lib";\nwt.declareScript({ match: ["*://example.invalid/*"], params: { p: { type: "string", default: String(x) } } });\n',
    }, r)));
    const gp: any = await mgr.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "getScriptParams", scriptId: "s_imp" }, r)));
    check("getScriptParams resolves imported library", gp?.defs?.p?.default === "1", JSON.stringify(gp));
} catch (e) {
    failed++;
    console.log("FAIL  exception —", e);
} finally {
    await browser?.close().catch(() => {});
    proc.kill();
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 }); } catch {}
    process.exit(failed ? 1 : 0);
}
