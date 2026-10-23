/**
 * Shared E2E check (MV2 + MV3 Editor): types in a hover's signature are
 * links that swap the same hover for the type's hover (with Back), never
 * leaving the script; F12 opens the read-only API typings (wt-api.d.ts) in
 * the Code view and Go Back returns to the script with its cursor and
 * unsaved edit intact.
 * Set E2E_SHOT_DIR to save screenshots of the hovers and of the typings.
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

    // the visible content hover: signature <pre>, its links, the Back link
    const hoverInfo = () => mgr.evaluate(() => {
        const shown = [...document.querySelectorAll(".monaco-hover-content")].filter((el) => el.getClientRects().length && (el as HTMLElement).offsetHeight > 0);
        const root = shown[0];
        const pre = root?.querySelector("pre");
        const colors = [...(pre?.querySelectorAll("span[style]") ?? [])].map((s) => (s as HTMLElement).style.color);
        return {
            visible: !!root,
            sig: pre?.textContent ?? "",
            links: [...(pre?.querySelectorAll("a") ?? [])].map((a) => [a.textContent, a.getAttribute("data-href") ?? ""]),
            colors: [...new Set(colors)],
            back: [...(root?.querySelectorAll("a") ?? [])].find((a) => a.textContent!.startsWith("← Back"))?.textContent ?? "",
            text: root?.textContent ?? "",
            count: shown.length,
            // set on the hover widget before a click: still there → same hover
            marked: (root?.closest(".monaco-hover") as HTMLElement | null)?.dataset.e2eMark === "1",
            preFont: pre ? getComputedStyle(pre).fontFamily : "",
        };
    });
    const waitHover = async (pred: (h: any) => boolean, ms = 5000): Promise<any> => {
        let h = await hoverInfo();
        for (const end = Date.now() + ms; !pred(h) && Date.now() < end; h = await hoverInfo()) await mgr.waitForTimeout(100);
        return h;
    };
    // ⌘K ⌘I-style hover, retried until it's ours (not a stale one from an earlier check)
    const showHover = async (): Promise<any> => {
        let h = await hoverInfo();
        for (let i = 0; i < 40 && !(h.visible && /onRequest\(/.test(h.sig) && !h.back); i++) {
            await mgr.evaluate(() => (window as any).monaco.editor.getEditors()[0].trigger("t", "editor.action.showHover", {}));
            h = await waitHover((x) => x.visible && /onRequest\(/.test(x.sig), 250);
        }
        return h;
    };
    const sigLink = (name: string) => mgr.locator(".monaco-hover-content pre a:visible", { hasText: new RegExp(`^${name}$`) }).first();
    const backLink = () => mgr.locator(".monaco-hover-content a:visible", { hasText: /^← Back/ }).first();
    // off the links but still on the hover: leaving it would close it
    const parkMouse = async (): Promise<void> => {
        const r = await mgr.evaluate(() => {
            const pre = [...document.querySelectorAll(".monaco-hover-content pre")].find((el) => (el as HTMLElement).offsetHeight > 0);
            const b = pre?.getBoundingClientRect();
            return b && { x: b.left + 3, y: b.top + 5 };
        });
        if (r) await mgr.mouse.move(r.x, r.y);
    };
    const isRoute = (h: any): boolean => /type (Wiretrick\.)?Route = /.test(h.sig);
    const setTheme = async (pref: string): Promise<string> => {
        const old = await mgr.evaluate((p: string) => {
            const sel = document.getElementById("settings-theme") as HTMLSelectElement;
            const was = sel.value;
            sel.value = p;
            sel.dispatchEvent(new Event("change"));
            return was;
        }, pref);
        await mgr.waitForFunction((p: string) => p === "system" || document.documentElement.dataset.theme === p, pref, { timeout: 5000 }).catch(() => {});
        await mgr.waitForTimeout(200);
        return old;
    };
    const themeWas = await setTheme("light");

    const root = await showHover();
    const linkNames = root.links.map((l: string[]) => l[0]);
    check("api typings: hover signature on wt.onRequest is highlighted, its API types are links",
        root.visible && linkNames.includes("Route") && linkNames.includes("RequestCtx") && root.links.every((l: string[]) => l[1].startsWith("command:wt.hoverShowType?")) &&
            root.colors.length >= 3 && /mono/i.test(root.preFont) && root.sig.includes("\n    route: Wiretrick.Route,"),
        JSON.stringify({ ...root, text: undefined }).slice(0, 400) + ` uri=${opened.uri}`);
    check("api typings: no separate Go to definition / Types line", !/Go to definition|Types:/.test(root.text), root.text.slice(0, 200));
    await mgr.waitForTimeout(300); // fade-in
    await shot("hover-inline-types");

    await mgr.evaluate(() => {
        const h = [...document.querySelectorAll(".monaco-hover")].find((el) => (el as HTMLElement).offsetHeight > 0) as HTMLElement | undefined;
        if (h) h.dataset.e2eMark = "1";
    });
    await sigLink("Route").click();
    const drilled = await waitHover((h) => isRoute(h));
    const here = await state();
    check("api typings: clicking Route swaps the same hover for Route's, no navigation",
        drilled.visible && isRoute(drilled) && drilled.text.includes("Where a network handler applies") && drilled.back === "← Back to onRequest" &&
            drilled.marked && drilled.count === 1 && here.uri === "file:///api%20nav.ts" && !here.note,
        JSON.stringify({ ...drilled, text: drilled.text.slice(0, 160), uri: here.uri }));
    await parkMouse(); // no hover-underline in the screenshot
    await shot("hover-drilled");

    // a {@link} in the docs drills in too
    await mgr.locator(".monaco-hover-content .hover-contents:not(:has(pre)) a:visible", { hasText: /^RouteOptions$/ }).first().click();
    const deeper = await waitHover((h) => /interface (Wiretrick\.)?RouteOptions/.test(h.sig));
    check("api typings: a {@link RouteOptions} in the docs drills in, Back names Route",
        /interface (Wiretrick\.)?RouteOptions/.test(deeper.sig) && deeper.back === "← Back to Route", JSON.stringify({ sig: deeper.sig.slice(0, 80), back: deeper.back }));
    await backLink().click();
    const up1 = await waitHover((h) => isRoute(h));
    await backLink().click();
    const up2 = await waitHover((h) => /onRequest\(/.test(h.sig));
    check("api typings: Back walks up to Route, then to the onRequest hover",
        isRoute(up1) && up1.back === "← Back to onRequest" && /onRequest\(/.test(up2.sig) && up2.back === "" && up2.links.length === root.links.length && up2.visible,
        JSON.stringify([up1.sig.slice(0, 40), up1.back, up2.sig.slice(0, 40), up2.back]));

    // mouse hover: drill in, Back, and a new hover starts at the top
    await mgr.keyboard.press("Escape");
    const at = await mgr.evaluate(() => {
        const ed = (window as any).monaco.editor.getEditors()[0];
        const p = ed.getScrolledVisiblePosition({ lineNumber: 1, column: 7 });
        const r = ed.getDomNode().getBoundingClientRect();
        return { x: r.left + p.left + 4, y: r.top + p.top + p.height / 2 };
    });
    await mgr.mouse.move(at.x - 30, at.y + 40);
    await mgr.mouse.move(at.x, at.y, { steps: 3 });
    const mouseRoot = await waitHover((h) => h.visible && /onRequest\(/.test(h.sig) && !h.back, 8000);
    await sigLink("Route").click();
    const mouseDrilled = await waitHover((h) => isRoute(h));
    await backLink().click();
    const mouseUp = await waitHover((h) => /onRequest\(/.test(h.sig));
    check("api typings: mouse hover drills into Route and Back returns",
        mouseRoot.visible && isRoute(mouseDrilled) && mouseDrilled.visible && /onRequest\(/.test(mouseUp.sig) && !mouseUp.back,
        JSON.stringify([mouseRoot.sig.slice(0, 40), mouseDrilled.sig.slice(0, 40), mouseUp.sig.slice(0, 40)]));
    await sigLink("Route").click();
    await waitHover((h) => isRoute(h));
    await mgr.keyboard.press("Escape");
    await mgr.mouse.move(5, 5);
    await setCursor(1, 6);
    const reopened = await showHover();
    check("api typings: a new hover after closing starts at the top again", /onRequest\(/.test(reopened.sig) && !reopened.back, reopened.sig.slice(0, 60));

    // dark theme: the signature keeps the theme's token colors
    await mgr.keyboard.press("Escape");
    await setTheme("dark");
    const darkRoot = await showHover();
    await sigLink("Route").click();
    const dark = await waitHover((h) => isRoute(h));
    check("api typings: dark theme hover drills in with dark token colors",
        isRoute(dark) && dark.colors.length >= 2 && darkRoot.colors.join() !== root.colors.join(), JSON.stringify([root.colors, darkRoot.colors]));
    await parkMouse();
    await shot("hover-drilled-dark");
    await mgr.keyboard.press("Escape");
    await setTheme(themeWas);
    const still = await state();
    check("api typings: still in the script after all the hover clicks", still.uri === "file:///api%20nav.ts" && still.text.includes("// unsaved") && !still.note, still.uri);

    await setCursor(1, 6);
    let f12 = await state();
    for (const end = Date.now() + 15000; f12.uri !== "file:///wt-api.d.ts" && Date.now() < end; f12 = await waitFor((s) => s.uri === "file:///wt-api.d.ts", 1000)) {
        await mgr.keyboard.press("F12");
    }
    check("api typings: F12 on wt.onRequest opens its declaration read-only",
        f12.uri === "file:///wt-api.d.ts" && f12.readOnly === true && f12.note && f12.saveDisabled && f12.selected === "" && f12.line.includes("onRequest(route"),
        JSON.stringify({ ...f12, text: undefined }));
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
    check(`api typings: ${forward} goes forward to the declaration`, fwd.uri === "file:///wt-api.d.ts" && fwd.line.includes("onRequest(route") && fwd.text === f12.text, JSON.stringify({ ...fwd, text: undefined }));

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
