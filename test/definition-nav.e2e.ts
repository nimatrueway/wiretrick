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
await save("s_main", "main script", 'import { helper } from "./utilities";\nwt.declareScript({ match: ["*://example.invalid/*"] });\nfunction local() {}\nhelper(1);\nlocal();\n');
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

// view-state memory: park the cursor in main, switch away and back → restored
await clickScript("main script");
await setCursor(5, 2);
await clickScript("utilities");
await setCursor(2, 1);
await clickScript("main script");
const vsRestored = await state();
check("view state: cursor restored after switching back", vsRestored.uri === "file:///main_script.ts" && JSON.stringify(vsRestored.sel) === "[5,2,5,2]", JSON.stringify(vsRestored));
await clickScript("utilities");
const vsUtil = await state();
check("view state: utilities cursor restored too", vsUtil.uri === "file:///utilities.ts" && JSON.stringify(vsUtil.sel) === "[2,1,2,1]", JSON.stringify(vsUtil));

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

// view-state restore must not litter the log with Monaco's benign Canceled
// rejections — filter proof first (a real rejection must still be logged)
const logHas = (needle: string) => mgr.evaluate((n: string) => [...document.querySelectorAll("#log-entries .log-line")].some((l) => (l.textContent || "").includes(n)), needle);
await mgr.evaluate(() => { void Promise.reject(Object.assign(new Error("Canceled"), { name: "Canceled" })); });
await mgr.waitForTimeout(400);
check("Canceled rejection is filtered from the log", !(await logHas("unhandled rejection: Canceled")));
await mgr.evaluate(() => { void Promise.reject(new Error("real boom")); });
await mgr.waitForTimeout(400);
check("real rejections still log", (await logHas("real boom")) === true);

// rapid switching (as with quick Cmd+P jumps): no Canceled litter surfaces
await mgr.evaluate(() => {
    const items = [...document.querySelectorAll(".script-item")];
    for (let i = 0; i < 12; i++) items[i % items.length].dispatchEvent(new MouseEvent("click"));
});
await mgr.waitForTimeout(1500);
check("rapid switching: no Canceled litter", !(await logHas("Canceled")));

// dirty-state: reverting to the exact original clears the prompt
await clickScript("main script"); // re-select resets the editor to stored code
const orig = await mgr.evaluate(() => (window as any).monaco.editor.getEditors()[0].getValue());
await mgr.evaluate(() => (window as any).monaco.editor.getEditors()[0].trigger("t", "type", { text: "// dirty\n" }));
answer = false; dialogs = 0;
await mgr.evaluate((o: string) => (window as any).monaco.editor.getEditors()[0].setValue(o), orig);
await clickScript("utilities");
check("revert to original: no discard prompt", dialogs === 0, `dialogs=${dialogs}`);
// truly dirty → prompt still appears
await mgr.evaluate(() => (window as any).monaco.editor.getEditors()[0].trigger("t", "type", { text: "// dirty\n" }));
dialogs = 0;
await clickScript("main script");
check("truly dirty: prompt appears", dialogs === 1, `dialogs=${dialogs}`);

// inline rename of the open script keeps its content (editor + storage),
// including unsaved edits
const listScripts = () => mgr.evaluate(() => new Promise<any[]>((r) => chrome.runtime.sendMessage({ type: "listScripts" }, r)));
await clickScript("utilities");
await mgr.waitForTimeout(500);
const savedCode = (await listScripts()).find((s: any) => s.id === "u_util")?.code;
const utilText = await mgr.evaluate(() => (window as any).monaco.editor.getEditors()[0].getValue());
await mgr.evaluate(() => {
    const label = [...document.querySelectorAll<HTMLElement>(".script-item .script-name")].find((e) => e.textContent?.includes("utilities"))!;
    label.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
});
await mgr.waitForSelector(".script-rename");
await mgr.fill(".script-rename", "utils renamed");
await mgr.press(".script-rename", "Enter");
await mgr.waitForTimeout(1500);
const renamedText = await mgr.evaluate(() => (window as any).monaco.editor.getEditors()[0].getValue());
const util = (await listScripts()).find((s: any) => s.id === "u_util");
check("rename: editor keeps content", renamedText === utilText && utilText.length > 0, JSON.stringify(renamedText.slice(0, 40)));
check("rename: stored name changed, code intact", util?.meta.name === "utils renamed" && util?.code === savedCode, `${util?.meta.name}`);
await mgr.evaluate(() => (window as any).monaco.editor.getEditors()[0].focus());
await mgr.keyboard.press("Control+s");
await mgr.waitForTimeout(800);
check("rename then save: editor content saved", (await listScripts()).find((s: any) => s.id === "u_util")?.code === utilText);

// rename only accepts file-name-safe characters; clashing names are refused
const renameTo = async (from: string, typed: string): Promise<void> => {
    await mgr.evaluate((from: string) => {
        const label = [...document.querySelectorAll<HTMLElement>(".script-item .script-name")].find((e) => e.textContent?.includes(from))!;
        label.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    }, from);
    await mgr.waitForSelector(".script-rename");
    await mgr.fill(".script-rename", "");
    await mgr.type(".script-rename", typed);
    await mgr.press(".script-rename", "Enter");
    await mgr.waitForTimeout(1200);
};
await renameTo("utils renamed", "my/util: v2.x  (beta)");
check("rename: unsafe characters dropped", (await listScripts()).find((s: any) => s.id === "u_util")?.meta.name === "myutil v2x beta", (await listScripts()).find((s: any) => s.id === "u_util")?.meta.name);
await renameTo("myutil v2x beta", "Main Script");
check("rename: clashing name refused", (await listScripts()).find((s: any) => s.id === "u_util")?.meta.name === "myutil v2x beta");

} catch (e) {
    failed++;
    console.error("FATAL", e);
} finally {
    await finish(browser);
}
