/**
 * Shared E2E check (MV2 + MV3 Editor): hover type links and F12 open the
 * read-only API typings (wt-api.d.ts) in the Code view; Go Back returns to
 * the script with its cursor and unsaved edit intact.
 * Set E2E_SHOT_DIR to save a screenshot of the hover and of the typings.
 */
import path from "node:path";

type Check = (name: string, ok: boolean, extra?: string) => void;

export async function checkApiTypingsNav(mgr: any, check: Check, label = ""): Promise<void> {
    const shotDir = process.env.E2E_SHOT_DIR;
    const shot = async (name: string): Promise<void> => {
        if (shotDir) await mgr.screenshot({ path: path.join(shotDir, `${name}${label}.png`) });
    };
    const state = () => mgr.evaluate(() => {
        const m = (window as any).monaco;
        const ed = m.editor.getEditors()[0];
        const model = ed.getModel();
        const s = ed.getSelection();
        return {
            uri: model?.uri.toString(),
            sel: s && [s.startLineNumber, s.startColumn, s.endLineNumber, s.endColumn],
            selText: s && model ? model.getValueInRange(s) : "",
            readOnly: ed.getOption(m.editor.EditorOption.readOnly),
            note: !(document.getElementById("typings-note") as HTMLElement).hidden,
            selected: document.querySelector(".script-item.selected")?.textContent ?? "",
            saveDisabled: document.getElementById("btn-save")!.hasAttribute("disabled"),
            text: model?.getValue() ?? "",
            line: s && model ? model.getLineContent(s.startLineNumber) : "",
        };
    });
    const setCursor = (line: number, column: number) => mgr.evaluate(([l, c]: number[]) => {
        const ed = (window as any).monaco.editor.getEditors()[0];
        ed.setPosition({ lineNumber: l, column: c });
        ed.focus();
    }, [line, column]);
    const waitFor = async (pred: (s: any) => boolean, ms = 5000): Promise<any> => {
        let s = await state();
        for (const end = Date.now() + ms; !pred(s) && Date.now() < end; s = await state()) await mgr.waitForTimeout(150);
        return s;
    };
    // Monaco binds Go Back to Ctrl+- on macOS, Alt+← elsewhere
    const back = process.platform === "darwin" ? "Control+Minus" : "Alt+ArrowLeft";
    const forward = process.platform === "darwin" ? "Control+Shift+Minus" : "Alt+ArrowRight";

    await mgr.bringToFront();
    // roomier screenshots; the window size is put back afterwards
    const cdp = shotDir ? await mgr.context().newCDPSession(mgr) : null;
    await cdp?.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 800, deviceScaleFactor: 1, mobile: false });
    await mgr.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({
        type: "saveScript", id: "s_api_nav", name: "api nav",
        code: 'wt.onRequest("*://api-nav.invalid/*", (ctx) => {\n    console.log(ctx.url);\n});\n',
    }, r)));
    await mgr.keyboard.press("Escape"); // close a hover left by an earlier check
    // an earlier check may leave the current script dirty: discard it
    const dialogs: string[] = [];
    let accept = true;
    const onDialog = (d: any): void => { dialogs.push(d.message()); void (accept ? d.accept() : d.dismiss()); };
    mgr.on("dialog", onDialog);
    await mgr.locator(".script-item", { hasText: "api nav" }).click();
    const opened = await waitFor((s) => s.uri === "file:///api%20nav.ts");
    accept = false;
    dialogs.length = 0;
    await setCursor(3, 1);
    await mgr.evaluate(() => (window as any).monaco.editor.getEditors()[0].trigger("t", "type", { text: "// unsaved\n" }));
    await setCursor(1, 6); // on `onRequest`

    const link = 'a[data-href*="command:wt.openApiDeclaration"], a[href*="command:wt.openApiDeclaration"]';
    const hover = await mgr.evaluate(async (sel: string) => {
        const ed = (window as any).monaco.editor.getEditors()[0];
        for (let i = 0; i < 40; i++) {
            ed.trigger("t", "editor.action.showHover", {});
            await new Promise((r) => setTimeout(r, 250));
            const links = [...document.querySelectorAll(`.monaco-hover-content ${sel.split(", ").join(", .monaco-hover-content ")}`)];
            const texts = links.map((a) => a.textContent);
            if (texts.includes("Route")) return texts; // not a stale hover from an earlier check
        }
        return document.querySelector(".monaco-hover-content")?.textContent ?? null;
    }, link);
    check("api typings: hover on wt.onRequest has Go to definition + type links",
        Array.isArray(hover) && hover.includes("Go to definition") && hover.includes("Route") && hover.includes("RequestCtx"), JSON.stringify(hover)?.slice(0, 200) + ` uri=${opened.uri}`);
    await shot("hover-type-links");

    await mgr.locator(".monaco-hover-content a", { hasText: /^Route$/ }).first().click();
    const dts = await waitFor((s) => s.uri === "file:///wt-api.d.ts" && s.selText === "Route");
    check("api typings: type link opens wt-api.d.ts read-only at the declaration",
        dts.uri === "file:///wt-api.d.ts" && dts.selText === "Route" && dts.readOnly === true && dts.note && dts.saveDisabled && dts.selected === "",
        JSON.stringify({ ...dts, text: undefined }));
    await mgr.waitForTimeout(300);
    await shot("api-typings-readonly");

    await mgr.keyboard.type("x"); // read-only: ignored
    await mgr.keyboard.press(back);
    const ret = await waitFor((s) => s.uri === "file:///api%20nav.ts");
    check(`api typings: ${back} returns to the script, cursor restored, unsaved edit kept`,
        ret.uri === "file:///api%20nav.ts" && JSON.stringify(ret.sel) === "[1,6,1,6]" && ret.text.includes("// unsaved") && !ret.readOnly && !ret.note && ret.selected.includes("api nav") && !ret.saveDisabled,
        JSON.stringify({ ...ret, text: ret.text.slice(0, 80) }));

    await mgr.keyboard.press(forward);
    const fwd = await waitFor((s) => s.uri === "file:///wt-api.d.ts");
    check(`api typings: ${forward} goes forward to the declaration`, fwd.uri === "file:///wt-api.d.ts" && fwd.selText === "Route" && fwd.text === dts.text, JSON.stringify({ ...fwd, text: undefined }));
    await mgr.keyboard.press(back);
    await waitFor((s) => s.uri === "file:///api%20nav.ts");

    await setCursor(1, 6);
    let f12 = await state();
    for (const end = Date.now() + 15000; f12.uri !== "file:///wt-api.d.ts" && Date.now() < end; f12 = await waitFor((s) => s.uri === "file:///wt-api.d.ts", 1000)) {
        await mgr.keyboard.press("F12");
    }
    check("api typings: F12 on wt.onRequest opens its declaration read-only",
        f12.uri === "file:///wt-api.d.ts" && f12.readOnly === true && f12.line.includes("onRequest(route"), JSON.stringify({ ...f12, text: undefined }));

    // keep digging: F12 inside the typings on `Route` moves within the file
    await mgr.evaluate(() => {
        const ed = (window as any).monaco.editor.getEditors()[0];
        const line = ed.getPosition().lineNumber;
        const col = ed.getModel().getLineContent(line).indexOf("Wiretrick.Route") + "Wiretrick.".length + 2;
        ed.setPosition({ lineNumber: line, column: col });
        ed.focus();
    });
    let inner = await state();
    const atRoute = (s: any): boolean => /type Route =/.test(s.line);
    for (const end = Date.now() + 10000; !atRoute(inner) && Date.now() < end; inner = await waitFor(atRoute, 1000)) {
        await mgr.keyboard.press("F12");
    }
    check("api typings: F12 inside wt-api.d.ts jumps to Route", inner.uri === "file:///wt-api.d.ts" && atRoute(inner), JSON.stringify({ ...inner, text: undefined, line: undefined }));
    await mgr.keyboard.press(back);
    const back1 = await waitFor((s) => !atRoute(s));
    await mgr.keyboard.press(back);
    const back2 = await waitFor((s) => s.uri === "file:///api%20nav.ts");
    check("api typings: back twice → onRequest declaration, then the script",
        back1.uri === "file:///wt-api.d.ts" && back1.line.includes("onRequest(route") && back2.uri === "file:///api%20nav.ts" && back2.text.includes("// unsaved"),
        JSON.stringify([back1.sel, back2.uri]));

    check("api typings: no discard-changes prompt along the way", dialogs.length === 0, JSON.stringify(dialogs));
    await cdp?.send("Emulation.clearDeviceMetricsOverride");
    await cdp?.detach();
    mgr.off("dialog", onDialog);

    // clean up: drop the unsaved edit and the script
    await mgr.evaluate(() => {
        const ed = (window as any).monaco.editor.getEditors()[0];
        ed.trigger("t", "undo", {});
    });
    await mgr.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "deleteScript", id: "s_api_nav" }, r)));
}
