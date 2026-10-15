/**
 * E2E regression: the real "Go to Definition" editor action on an imported
 * utility function must switch the manager editor to the utility script.
 * Cold manager load (the utility is never opened before navigation).
 *
 * Usage: npm run build && npx tsx test/definition-nav.e2e.ts
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { resolveBrowser } from "./browserSetup";

const EXT_ROOT = path.join(new URL("..", import.meta.url).pathname, "dist");
const profile = mkdtempSync(path.join(tmpdir(), "reso-defnav-"));
const proc = spawn(await resolveBrowser(), [
    "--headless=new",
    `--user-data-dir=${profile}`,
    `--load-extension=${EXT_ROOT}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 5000));

let failed = 0;
const check = (name: string, ok: boolean, extra = ""): void => {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
};
const finish = async (browser?: any): Promise<never> => {
    await browser?.close().catch(() => {});
    proc.kill();
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 }); } catch {}
    process.exit(failed ? 1 : 0);
};

let browser: any;
try {
const [port] = readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n");
browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 90000 });
const ctx = browser.contexts()[0];

const extId = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t: any) => t.type === "background_page").url.split("/")[2];
const openManager = async (): Promise<any> => {
    const p = await ctx.newPage();
    await p.goto(`chrome-extension://${extId}/manager.html`);
    return p;
};

// seed through a throwaway manager page, then cold-load a fresh one
const seed = await openManager();
const save = (id: string, name: string, code: string) =>
    seed.evaluate(({ id, name, code }: any) => new Promise((r) => chrome.runtime.sendMessage({ type: "saveScript", id, name, code }, r)), { id, name, code });
await save("s_main", "main script", 'import { helper } from "./utilities";\nres.declareScript({ match: ["*://example.invalid/*"] });\nfunction local() {}\nhelper(1);\nlocal();\n');
await save("u_util", "utilities", "export function helper(x: number) {\n    return x + 1;\n}\n");
await seed.close();

let dialogs = 0;
let answer = true;
const mgr = await openManager();
mgr.on("dialog", async (d: any) => { dialogs++; await (answer ? d.accept() : d.dismiss()); });
await mgr.waitForFunction(() => (window as any).monaco?.editor.getEditors().length === 1 && document.querySelectorAll(".script-item").length >= 2, null, { timeout: 20000 });

const state = () => mgr.evaluate(() => {
    const ed = (window as any).monaco.editor.getEditors()[0];
    const s = ed.getSelection();
    return {
        uri: ed.getModel()?.uri.toString(),
        sel: s && [s.startLineNumber, s.startColumn, s.endLineNumber, s.endColumn],
        selected: document.querySelector(".script-item.selected")?.textContent ?? "",
    };
});
const clickScript = async (name: string) => {
    await mgr.locator(".script-item", { hasText: name }).click();
    await mgr.waitForTimeout(300);
};
const setCursor = (line: number, column: number) => mgr.evaluate(([l, c]: number[]) => {
    const ed = (window as any).monaco.editor.getEditors()[0];
    ed.setPosition({ lineNumber: l, column: c });
    ed.focus();
}, [line, column]);
// the real user path: F12 runs editor.action.revealDefinition
const goToDefinition = () => mgr.keyboard.press("F12");

// cold: main is the initially auto-selected script; utilities was never displayed
const initial = await state();
check("cold: initial model is main (utilities never opened)", initial.uri === "file:///main_script.ts" && initial.selected.includes("main script"), JSON.stringify(initial));
await setCursor(4, 2);
// on `helper(1)`
const deadline = Date.now() + 15000;
let st = await state();
while (Date.now() < deadline && !st.uri?.endsWith("/utilities.ts")) {
    await goToDefinition();
    await mgr.waitForTimeout(700);
    st = await state();
}
check("cold: Go to Definition switches to utilities model", !!st.uri?.endsWith("/utilities.ts"), st.uri);
check("cold: cursor at definition name (helper)", JSON.stringify(st.sel) === "[1,17,1,17]", JSON.stringify(st.sel));
check("cold: sidebar selects utilities", st.selected.includes("utilities"), st.selected);

// unsaved edit in utilities, then navigate to main: canceled confirm keeps everything
await clickScript("main script");
await setCursor(1, 1);
await mgr.evaluate(() => { (window as any).monaco.editor.getEditors()[0].trigger("t", "type", { text: "// dirty\n" }); });
await setCursor(5, 2); // helper(1) moved down one line
const before = await state();
const beforeText = await mgr.evaluate(() => (window as any).monaco.editor.getEditors()[0].getValue());
answer = false; dialogs = 0;
await goToDefinition();
await mgr.waitForTimeout(1500);
const after = await state();
const afterText = await mgr.evaluate(() => (window as any).monaco.editor.getEditors()[0].getValue());
check("cancel: confirm was shown", dialogs === 1, `dialogs=${dialogs}`);
check("cancel: stays on main, selection untouched", after.uri === before.uri && JSON.stringify(after.sel) === JSON.stringify(before.sel), JSON.stringify(after));
check("cancel: unsaved edit preserved", afterText === beforeText && afterText.includes("// dirty"));

// accepted: navigates (discarding edits)
answer = true; dialogs = 0;
await goToDefinition();
await mgr.waitForTimeout(1500);
const acc = await state();
check("accept: confirm shown and navigation happens", dialogs === 1 && !!acc.uri?.endsWith("/utilities.ts") && JSON.stringify(acc.sel) === "[1,17,1,17]", JSON.stringify(acc) + ` dialogs=${dialogs}`);

// same-file definition: no dialog, selection moves, unsaved edit kept
await clickScript("main script");
await setCursor(1, 1);
await mgr.evaluate(() => { (window as any).monaco.editor.getEditors()[0].trigger("t", "type", { text: "// dirty\n" }); });
await setCursor(6, 2); // local()
dialogs = 0;
await goToDefinition();
await mgr.waitForTimeout(1000);
const same = await state();
const sameText = await mgr.evaluate(() => (window as any).monaco.editor.getEditors()[0].getValue());
check("same-file: stays, selects local, no dialog, edit kept", dialogs === 0 && !!same.uri?.endsWith("/main_script.ts") && JSON.stringify(same.sel) === "[4,10,4,10]" && sameText.includes("// dirty"), JSON.stringify(same) + ` dialogs=${dialogs}`);

} catch (e) {
    failed++;
    console.error("FATAL", e);
} finally {
    await finish(browser);
}
