/**
 * Shared E2E check (MV2 + MV3): installing a package by opening its
 * `.tangitweak.ts` URL. The tab goes to the install page, which lists what
 * the package can do; installing writes the entry, its library and its
 * JSON file into the package's folder and the entry runs. An update that
 * adds a route waits for review (the Explorer marks it; clicking the mark
 * reviews it in the Editor's Install dialog), applying it installs it, and
 * rolling back restores the first version. The Explorer's Install Script…
 * button opens the dialog, which takes a dropped file; a link dropped on the
 * Explorer opens the dialog on it. A bundle (a metadata.json listing two
 * scripts) installs both together. Make Package…
 * and Export Package… in the Explorer.
 *
 * `packagesServerRoute` serves the package; call it in the suite's test server.
 */
import type http from "node:http";
import { readZip } from "../src/shared/zip";

type Check = (name: string, ok: boolean, extra?: string) => void;

let version = 1;

const entry = (origin: string) => `import { shout } from "./lib";
import cfg from "./cfg.json";
tt.metadata({ name: "Demo package", version: "1.${version - 1}.0" });
tt.replaceResponse({ url: "${origin}/pkg-api", strategy: "page" }, () => shout(cfg.word));
${version > 1 ? `tt.replaceResponse({ url: "${origin}/pkg-other", strategy: "page" }, () => "OTHER");\n` : ""}`;

export function packagesServerRoute(req: http.IncomingMessage, res: http.ServerResponse, origin: string): boolean {
    const url = new URL(req.url || "/", origin);
    const send = (ct: string, body: string) => {
        res.writeHead(200, { "content-type": ct, "cache-control": "no-store" });
        res.end(body);
    };
    if (url.pathname === "/pkg/demo.tangitweak.ts") return send("text/plain", entry(origin)), true;
    if (url.pathname === "/pkg/lib.ts") return send("text/plain", 'export const shout = (s: string) => s.toUpperCase() + "!";\n'), true;
    if (url.pathname === "/pkg/cfg.json") return send("application/json", '{ "word": "pkg-ok" }'), true;
    if (url.pathname === "/kit/metadata.json") return send("application/json", JSON.stringify({ name: "Kit", version: "3.0.0", description: "Two scripts", scripts: ["a.ts", "tools/b.ts"] })), true;
    if (url.pathname === "/kit/a.ts") return send("text/plain", `import { tag } from "./shared";\ntt.replaceResponse({ url: "${origin}/kit-a", strategy: "page" }, () => tag("A"));\n`), true;
    if (url.pathname === "/kit/tools/b.ts") return send("text/plain", `import { tag } from "../shared";\ntt.replaceResponse({ url: "${origin}/kit-b", strategy: "page" }, () => tag("B"));\n`), true;
    if (url.pathname === "/kit/shared.ts") return send("text/plain", 'export const tag = (s: string) => "KIT-" + s;\n'), true;
    if (url.pathname === "/pkg-page") return send("text/html", "<html><body>PKG</body></html>"), true;
    if (url.pathname === "/pkg-api") return send("text/plain", "REAL"), true;
    return false;
}

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 10000): Promise<T> {
    const end = Date.now() + ms;
    let v = await fn();
    while (!ok(v) && Date.now() < end) {
        await new Promise((r) => setTimeout(r, 200));
        v = await fn();
    }
    return v;
}

export async function checkPackages(ctx: any, mgr: any, origin: string, check: Check, opts: { label?: string } = {}): Promise<void> {
    const t = (s: string) => `packages${opts.label ?? ""}: ${s}`;
    const send = (msg: any): Promise<any> => mgr.evaluate((m: any) => new Promise((r) => chrome.runtime.sendMessage(m, (x: any) => r(x ?? null))), msg);
    version = 1;
    const src = `${origin}/pkg/demo.tangitweak.ts`;

    // opening the entry's URL lands on the install page
    const tab = await ctx.newPage();
    await tab.goto(src, { timeout: 15000 }).catch(() => {});
    const landed = await waitFor<string>(async () => tab.url(), (u) => u.includes("install.html"), 10000);
    check(t("opening a .tangitweak.ts URL opens the install page"), landed.includes("install.html?url=") && landed.includes(encodeURIComponent(src)), landed);

    const confirm = await tab.waitForSelector("#install-confirm:not([disabled])", { timeout: 15000 }).then(() => true, () => false);
    const review = await tab.evaluate(() => document.body.innerText);
    check(
        t("the review shows the name, version, what it can do and its files"),
        confirm && review.includes("Demo package") && review.includes("1.0.0") && review.includes(`${origin}/pkg-api`) && review.includes("lib.ts") && review.includes("cfg.json"),
        review.slice(0, 400)
    );
    if (confirm) await tab.click("#install-confirm");
    const done = await tab.waitForSelector("text=Open in the Editor", { timeout: 15000 }).then(() => true, () => false);

    const pkgs = (await send({ type: "listPackages" })) || {};
    const pkg: any = Object.values(pkgs).find((p: any) => p.source === src);
    const scripts: any[] = (await send({ type: "listScripts" })) || [];
    const data: any[] = (await send({ type: "listDataFiles" })) || [];
    const names = scripts.filter((s) => s.meta.name.startsWith("demo/")).map((s) => s.meta.name).sort();
    check(
        t("installing writes the entry, its library and its JSON into the package's folder"),
        done && !!pkg && JSON.stringify(names) === '["demo/demo.tangitweak","demo/lib"]' && data.some((d) => d.path === "demo/cfg.json") && pkg.autoUpdate === true,
        JSON.stringify({ done, names, data: data.map((d) => d.path), pkg: pkg && { folder: pkg.folder, autoUpdate: pkg.autoUpdate } })
    );
    await tab.close();
    if (!pkg) return;

    const page = await ctx.newPage();
    await page.goto(`${origin}/pkg-page`, { waitUntil: "load", timeout: 15000 });
    const fetchApi = (): Promise<string> => page.evaluate(() => fetch("/pkg-api").then((r) => r.text())).catch(() => "");
    const out = await waitFor(fetchApi, (v) => v === "PKG-OK!", 10000);
    check(t("the installed entry runs with its library and JSON"), out === "PKG-OK!", out);

    await mgr.bringToFront();
    const badge = await mgr.waitForSelector('#script-list li.script-item[data-id="dir:demo"] .file-icon.package', { timeout: 8000 }).then(() => true, () => false);
    check(t("the Explorer shows the package's folder with the package icon"), badge);

    // an update that adds a route waits for review
    version = 2;
    const checked = await send({ type: "packageCheck", id: pkg.id });
    const held = checked?.[pkg.id];
    check(
        t("an update that can do more waits for review"),
        !!held?.pending && held.revision === pkg.revision && held.pending.added.some((a: string) => a.includes("/pkg-other")),
        JSON.stringify({ pending: held?.pending && { added: held.pending.added, reasons: held.pending.reasons }, error: held?.lastError })
    );
    const pendingBadge = await mgr.waitForSelector("#script-list .pkg-ind.pending", { timeout: 8000 }).then(() => true, () => false);
    check(t("the Explorer marks the waiting update"), pendingBadge);

    // clicking the mark reviews the update in the Install dialog
    await mgr.click("#script-list .pkg-ind.pending").catch(() => {});
    const applyShown = await mgr.waitForSelector("#install-dialog #update-apply", { timeout: 15000 }).then(() => true, () => false);
    const rvText = await mgr.evaluate(() => (document.querySelector("#install-dialog") as HTMLElement | null)?.innerText || "");
    check(t("the update review (a dialog in the Editor) shows what the update adds"), applyShown && rvText.includes("Review Update") && rvText.includes("1.1.0") && rvText.includes("/pkg-other"), rvText.slice(0, 400));
    if (applyShown) await mgr.click("#update-apply");
    await mgr.waitForSelector("#install-dialog >> text=Open in the Editor", { timeout: 15000 }).catch(() => {});
    await mgr.keyboard.press("Escape");
    const updated = (await send({ type: "listPackages" }))?.[pkg.id];
    const other = await waitFor(() => page.evaluate(() => fetch("/pkg-other").then((r) => r.text())).catch(() => ""), (v) => v === "OTHER", 10000);
    check(t("applying the update installs it"), updated?.metadata?.version === "1.1.0" && !updated.pending && other === "OTHER", JSON.stringify({ version: updated?.metadata?.version, other }));

    const back = await send({ type: "packageRollback", id: pkg.id });
    check(t("rolling back restores the previous version and turns auto-update off"), back?.metadata?.version === "1.0.0" && back.autoUpdate === false, JSON.stringify({ version: back?.metadata?.version, autoUpdate: back?.autoUpdate, error: back?.error }));
    await page.close();

    for (const s of (await send({ type: "listScripts" })) || []) if (s.meta.name.startsWith("demo/")) await send({ type: "deleteScript", id: s.id });
    for (const d of (await send({ type: "listDataFiles" })) || []) if (d.path.startsWith("demo/")) await send({ type: "deleteDataFile", id: d.id });
    await send({ type: "packageForget", id: pkg.id });

    // the Explorer's Install Script… button opens the dialog on the picker; a script file dropped on it goes to its review
    await mgr.click("#btn-install");
    const picker = await mgr.waitForSelector("#install-dialog #install-drop", { timeout: 8000 }).then(() => true, () => false);
    const dropOn = (sel: string, what: { file?: [string, string]; link?: string }) =>
        mgr.evaluate(
            async ([sel, what]: [string, any]) => {
                const dt = new DataTransfer();
                if (what.file) dt.items.add(new File([what.file[1]], what.file[0]));
                if (what.link) dt.setData("text/uri-list", what.link);
                const el = document.querySelector(sel)!;
                el.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
                await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 50)));
                const lit = !!document.querySelector("#sidebar.install-drop, .install-dialog.dropping");
                el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
                return lit;
            },
            [sel, what]
        );
    const fileLit = await dropOn("#install-drop", { file: ["dropped.tangitweak.ts", 'tt.metadata({ name: "Dropped", version: "0.1.0" });\n'] });
    const fileReview = await mgr.waitForSelector("#install-dialog #install-confirm", { timeout: 8000 }).then(() => true, () => false);
    const fileText = await mgr.evaluate(() => (document.querySelector("#install-dialog") as HTMLElement | null)?.innerText || "");
    check(t("Install Script… opens a dialog; a file dropped on it is reviewed"), picker && fileLit && fileReview && fileText.includes("Dropped") && fileText.includes("0.1.0"), JSON.stringify({ picker, fileLit, fileReview, text: fileText.slice(0, 300) }));
    await mgr.click("#install-dialog .btn-close");
    const closed = await mgr.waitForSelector("#install-dialog", { state: "detached", timeout: 5000 }).then(() => true, () => false);
    check(t("the Install dialog closes"), closed);

    // a bundle: metadata.json lists two scripts; they install (and run) together. Its link dropped on the Explorer opens the dialog on it.
    const kitSrc = `${origin}/kit/metadata.json`;
    const linkLit = await dropOn("#script-list", { link: kitSrc });
    const kitConfirm = await mgr.waitForSelector("#install-dialog #install-confirm:not([disabled])", { timeout: 15000 }).then(() => true, () => false);
    const kitReview = await mgr.evaluate(() => (document.querySelector("#install-dialog") as HTMLElement | null)?.innerText || "");
    check(
        t("a link dropped on the Explorer opens its review: a bundle's name, version and scripts"),
        linkLit && kitConfirm && kitReview.includes("Kit") && kitReview.includes("3.0.0") && kitReview.includes("A bundle of 2 scripts") && kitReview.includes(`${origin}/kit-a`) && kitReview.includes(`${origin}/kit-b`),
        JSON.stringify({ linkLit, review: kitReview.slice(0, 400) })
    );
    if (kitConfirm) await mgr.click("#install-confirm");
    const kitDone = await mgr.waitForSelector("#install-dialog >> text=Open in the Editor", { timeout: 15000 }).then(() => true, () => false);
    if (kitDone) await mgr.click("#install-dialog >> text=Open in the Editor");
    const kitOpened = await mgr.waitForSelector("#install-dialog", { state: "detached", timeout: 8000 }).then(() => true, () => false);
    const kitIds = (((await send({ type: "listScripts" })) || []) as any[]).filter((s) => s.meta.name.startsWith("Kit/")).map((s) => s.id);
    const kitSel = await waitFor(() => mgr.evaluate(() => document.querySelector("#script-list li.script-item.selected")?.getAttribute("data-id") || ""), (v: string) => kitIds.includes(v), 8000);
    check(t("Open in the Editor closes the dialog and selects the installed script"), kitOpened && kitIds.includes(kitSel), JSON.stringify({ kitDone, kitOpened, kitSel, kitIds }));
    const kit: any = Object.values((await send({ type: "listPackages" })) || {}).find((p: any) => p.source === kitSrc);
    const kitNames = (((await send({ type: "listScripts" })) || []) as any[]).filter((s) => s.meta.name.startsWith("Kit/")).map((s) => s.meta.name).sort();
    const kp = await ctx.newPage();
    await kp.goto(`${origin}/pkg-page`, { waitUntil: "load", timeout: 15000 });
    const kitOut = await waitFor(() => kp.evaluate(() => Promise.all(["/kit-a", "/kit-b"].map((u) => fetch(u).then((r) => r.text()))).then((x) => x.join())).catch(() => ""), (v) => v === "KIT-A,KIT-B", 10000);
    await kp.close();
    check(
        t("installing a bundle writes and runs all its scripts"),
        !!kit && kit.entries?.length === 2 && kit.metadata?.version === "3.0.0" && JSON.stringify(kitNames) === '["Kit/a","Kit/shared","Kit/tools/b"]' && kitOut === "KIT-A,KIT-B",
        JSON.stringify({ kit: kit && { folder: kit.folder, entries: kit.entries }, kitNames, kitOut })
    );
    await send({ type: "deleteFolder", path: "Kit" });
    if (kit) await send({ type: "packageForget", id: kit.id });

    // Explorer → Make Package…: the script and what it imports move into a folder with a metadata.json (a file another script uses is copied)
    await send({ type: "saveScript", id: "mkpkg-lib", code: "export const v = 1;\n", name: "mklib" });
    await send({ type: "saveScript", id: "mkpkg-user", code: 'import { v } from "./mklib";\nexport const w = v;\n', name: "mkuser" });
    await send({ type: "saveDataFile", path: "mkcfg.json", text: '{ "a": 1 }\n' });
    await send({ type: "saveScript", id: "mkpkg-entry", code: 'import { v } from "./mklib";\nimport cfg from "./mkcfg.json";\nconsole.log(v, cfg);\n', name: "mkpkg.tangitweak" });
    const dialogs: string[] = [];
    const onDialog = (d: any): void => void (dialogs.push(d.message()), d.accept());
    mgr.on("dialog", onDialog);
    const entryRow = '#script-list li.script-item[data-id="mkpkg-entry"] .script-name';
    await mgr.waitForSelector(entryRow, { timeout: 8000 }).catch(() => {});
    await mgr.click(entryRow, { button: "right" });
    await mgr.click('.ctx-menu li:has-text("Make Package…")');
    const made = await waitFor(
        async () => ({ scripts: ((await send({ type: "listScripts" })) || []) as any[], data: ((await send({ type: "listDataFiles" })) || []) as any[] }),
        ({ scripts, data }) => scripts.some((x) => x.id === "mkpkg-entry" && x.meta.name === "mkpkg/mkpkg.tangitweak") && data.some((d) => d.path === "mkpkg/mkcfg.json") && data.some((d) => d.path === "mkpkg/metadata.json"),
    );
    mgr.off("dialog", onDialog);
    const entry = made.scripts.find((x) => x.id === "mkpkg-entry");
    const mkNames = made.scripts.map((x) => x.meta.name);
    const manifest = JSON.parse(made.data.find((d) => d.path === "mkpkg/metadata.json")?.text || "{}");
    check(
        t("Make Package… moves the script and what it imports into a folder, copying what others use, and adds a metadata.json"),
        /Copies[\s\S]*mklib\.ts → mkpkg\/mklib\.ts/.test(dialogs[0] || "") &&
            manifest.name === "mkpkg" &&
            JSON.stringify(manifest.scripts) === '["mkpkg.tangitweak.ts"]' &&
            entry?.code.includes('from "./mklib"') &&
            mkNames.includes("mkpkg/mklib") &&
            mkNames.includes("mklib") &&
            !made.data.some((d) => d.path === "mkcfg.json"),
        JSON.stringify({ dialog: dialogs[0], mkNames, manifest, entry: entry?.code.slice(0, 200), data: made.data.map((d) => d.path) }),
    );

    // its metadata.json: "scripts" completes the .ts/.tsx files in the package's folder
    const manifestId = made.data.find((d) => d.path === "mkpkg/metadata.json")?.id;
    const manifestRow = `#script-list li.script-item[data-id="${manifestId}"]`;
    await mgr.bringToFront();
    if (!(await mgr.$(manifestRow))) await mgr.click('#script-list li.script-item[data-id="dir:mkpkg"]').catch(() => {});
    await mgr.click(manifestRow, { timeout: 5000 }).catch(() => {});
    await mgr.waitForFunction(() => { const m = (window as any).monaco.editor.getEditors()[0].getModel(); return m?.uri.path.endsWith("/metadata.json") && m.getValue().includes('"mkpkg.tangitweak.ts"'); }, null, { timeout: 8000 }).catch(() => {});
    // the Explorer lists the moved scripts (the completions come from its list)
    await mgr.waitForSelector('#script-list li.script-item[data-id="mkpkg-entry"]', { timeout: 8000 }).catch(() => {});
    // a late refresh of the open file cancels a pending suggest, so trigger again until the list shows
    for (let i = 0; i < 6; i++) {
        await mgr.evaluate(() => {
            const ed = (window as any).monaco.editor.getEditors()[0];
            const model = ed.getModel();
            ed.setPosition(model.getPositionAt(model.getValue().indexOf('"mkpkg.tangitweak.ts"') + 1));
            ed.focus();
            ed.trigger("t", "editor.action.triggerSuggest", {});
        });
        if (await mgr.waitForSelector(".suggest-widget.visible .monaco-list-row", { timeout: 4000 }).then(() => true, () => false)) break;
    }
    const manifestSugg = await mgr.evaluate(() => [...document.querySelectorAll(".suggest-widget.visible .monaco-list-row .label-name")].map((e) => e.textContent));
    const manifestAt = await mgr.evaluate(() => { const m = (window as any).monaco.editor.getEditors()[0].getModel(); return [m?.uri.path, document.hasFocus(), document.querySelector(".suggest-widget")?.className, document.querySelector(".suggest-widget .message")?.textContent]; });
    await mgr.keyboard.press("Escape");
    check(t('metadata.json\'s "scripts" completes the scripts in the package\'s folder'), manifestSugg.includes("mklib.ts") && manifestSugg.includes("mkpkg.tangitweak.ts") && !manifestSugg.includes("mkuser.ts"), JSON.stringify({ manifestSugg, manifestAt, manifestId }));

    // ...and a listed script that doesn't exist is an error, in the file and in Problems
    const manifestOrig = await mgr.evaluate(() => {
        const m = (window as any).monaco.editor.getEditors()[0].getModel();
        const v = m.getValue();
        m.setValue(v.replace('"mkpkg.tangitweak.ts"', '"mkpkg.tangitweak.ts", "gone.ts"'));
        return v;
    });
    const missingMarker = await waitFor(
        () => mgr.evaluate(() => { const w = window as any; const m = w.monaco.editor.getEditors()[0].getModel(); return w.monaco.editor.getModelMarkers({ resource: m.uri, owner: "tt-manifest" }).map((x: any) => [x.message, m.getValueInRange(x)]); }),
        (v: any[]) => v.length > 0,
        5000
    );
    const missingInProblems = await waitFor(() => mgr.evaluate(() => document.querySelector("#problems-list, .problems")?.textContent || ""), (v: string) => v.includes("No script at mkpkg/gone.ts"), 5000);
    await mgr.evaluate((v: string) => (window as any).monaco.editor.getEditors()[0].getModel().setValue(v), manifestOrig);
    const missingCleared = await waitFor(() => mgr.evaluate(() => { const w = window as any; return w.monaco.editor.getModelMarkers({ resource: w.monaco.editor.getEditors()[0].getModel().uri, owner: "tt-manifest" }).length; }), (n: number) => n === 0, 5000);
    check(
        t('metadata.json: a "scripts" entry that names no script is an error, in the file and in Problems'),
        JSON.stringify(missingMarker) === JSON.stringify([["No script at mkpkg/gone.ts", '"gone.ts"']]) && (missingInProblems || "").includes("gone.ts") && missingCleared === 0,
        JSON.stringify({ missingMarker, missingInProblems: (missingInProblems || "").slice(0, 300), missingCleared })
    );

    // the folder is a package now: its icon, and Export Package… downloads a zip of it
    const pkgRow = '#script-list li.script-item[data-id="dir:mkpkg"]';
    const icon = await mgr.waitForSelector(`${pkgRow} .file-icon.package`, { timeout: 8000 }).then(() => true, () => false);
    await mgr.evaluate(() => {
        const w = window as any;
        w.__ttDownload = null;
        w.__ttClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
            if (!this.download) return w.__ttClick.call(this);
            const name = this.download;
            void fetch(this.href)
                .then((r) => r.arrayBuffer())
                .then((b) => (w.__ttDownload = { name, bytes: Array.from(new Uint8Array(b)) }));
        };
    });
    await mgr.click(`${pkgRow} .script-name`, { button: "right" });
    await mgr.click('.ctx-menu li:has-text("Export Package…")');
    const dl = await waitFor(() => mgr.evaluate(() => (window as any).__ttDownload), (v: any) => !!v, 8000);
    await mgr.evaluate(() => void (HTMLAnchorElement.prototype.click = (window as any).__ttClick));
    const zipped = dl ? await readZip(new Uint8Array(dl.bytes).buffer) : {};
    check(
        t("a package folder has the package icon, and Export Package… downloads its files as a zip"),
        icon && dl?.name === "mkpkg.zip" && Object.keys(zipped).sort().join() === "mkpkg/metadata.json,mkpkg/mkcfg.json,mkpkg/mklib.ts,mkpkg/mkpkg.tangitweak.ts",
        JSON.stringify({ icon, name: dl?.name, files: Object.keys(zipped) })
    );
    await send({ type: "deleteFolder", path: "mkpkg" });
    for (const id of ["mkpkg-lib", "mkpkg-user"]) await send({ type: "deleteScript", id });
}
