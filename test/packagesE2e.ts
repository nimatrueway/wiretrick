/**
 * Shared E2E check (MV2 + MV3): installing a package by opening its
 * `.wiretrick.ts` URL. The tab goes to the install page, which lists what
 * the package can do; installing writes the entry, its library and its
 * JSON file into the package's folder and the entry runs. An update that
 * adds a route waits for review (the Explorer marks it), the review page
 * applies it, and rolling back restores the first version.
 *
 * `packagesServerRoute` serves the package; call it in the suite's test server.
 */
import type http from "node:http";
import { readZip } from "../src/shared/zip";

type Check = (name: string, ok: boolean, extra?: string) => void;

let version = 1;

const entry = (origin: string) => `/**
 * @name Demo package
 * @version 1.${version - 1}.0
 */
import { shout } from "./lib";
import cfg from "./cfg.json";
wt.replaceResponse({ url: "${origin}/pkg-api", strategy: "page" }, () => shout(cfg.word));
${version > 1 ? `wt.replaceResponse({ url: "${origin}/pkg-other", strategy: "page" }, () => "OTHER");\n` : ""}`;

export function packagesServerRoute(req: http.IncomingMessage, res: http.ServerResponse, origin: string): boolean {
    const url = new URL(req.url || "/", origin);
    const send = (ct: string, body: string) => {
        res.writeHead(200, { "content-type": ct, "cache-control": "no-store" });
        res.end(body);
    };
    if (url.pathname === "/pkg/demo.wiretrick.ts") return send("text/plain", entry(origin)), true;
    if (url.pathname === "/pkg/lib.ts") return send("text/plain", 'export const shout = (s: string) => s.toUpperCase() + "!";\n'), true;
    if (url.pathname === "/pkg/cfg.json") return send("application/json", '{ "word": "pkg-ok" }'), true;
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
    const src = `${origin}/pkg/demo.wiretrick.ts`;

    // opening the entry's URL lands on the install page
    const tab = await ctx.newPage();
    await tab.goto(src, { timeout: 15000 }).catch(() => {});
    const landed = await waitFor<string>(async () => tab.url(), (u) => u.includes("install.html"), 10000);
    check(t("opening a .wiretrick.ts URL opens the install page"), landed.includes("install.html?url=") && landed.includes(encodeURIComponent(src)), landed);

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
        done && !!pkg && JSON.stringify(names) === '["demo/demo.wiretrick","demo/lib"]' && data.some((d) => d.path === "demo/cfg.json") && pkg.autoUpdate === true,
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

    const rv = await ctx.newPage();
    await rv.goto(`chrome-extension://${new URL(mgr.url()).host}/install.html?update=${encodeURIComponent(pkg.id)}`, { timeout: 15000 });
    const applyShown = await rv.waitForSelector("#update-apply", { timeout: 15000 }).then(() => true, () => false);
    const rvText = await rv.evaluate(() => document.body.innerText);
    check(t("the review page shows what the update adds"), applyShown && rvText.includes("1.1.0") && rvText.includes("/pkg-other"), rvText.slice(0, 400));
    if (applyShown) await rv.click("#update-apply");
    await rv.waitForSelector("text=Open in the Editor", { timeout: 15000 }).catch(() => {});
    await rv.close();
    const updated = (await send({ type: "listPackages" }))?.[pkg.id];
    const other = await waitFor(() => page.evaluate(() => fetch("/pkg-other").then((r) => r.text())).catch(() => ""), (v) => v === "OTHER", 10000);
    check(t("applying the update installs it"), updated?.header?.version === "1.1.0" && !updated.pending && other === "OTHER", JSON.stringify({ version: updated?.header?.version, other }));

    const back = await send({ type: "packageRollback", id: pkg.id });
    check(t("rolling back restores the previous version and turns auto-update off"), back?.header?.version === "1.0.0" && back.autoUpdate === false, JSON.stringify({ version: back?.header?.version, autoUpdate: back?.autoUpdate, error: back?.error }));
    await page.close();

    for (const s of (await send({ type: "listScripts" })) || []) if (s.meta.name.startsWith("demo/")) await send({ type: "deleteScript", id: s.id });
    for (const d of (await send({ type: "listDataFiles" })) || []) if (d.path.startsWith("demo/")) await send({ type: "deleteDataFile", id: d.id });
    await send({ type: "packageForget", id: pkg.id });

    // Explorer → Make Package…: the entry and what it imports move into a folder (a file another script uses is copied)
    await send({ type: "saveScript", id: "mkpkg-lib", code: "export const v = 1;\n", name: "mklib" });
    await send({ type: "saveScript", id: "mkpkg-user", code: 'import { v } from "./mklib";\nexport const w = v;\n', name: "mkuser" });
    await send({ type: "saveDataFile", path: "mkcfg.json", text: '{ "a": 1 }\n' });
    await send({ type: "saveScript", id: "mkpkg-entry", code: 'import { v } from "./mklib";\nimport cfg from "./mkcfg.json";\nconsole.log(v, cfg);\n', name: "mkpkg.wiretrick" });
    const dialogs: string[] = [];
    const onDialog = (d: any): void => void (dialogs.push(d.message()), d.accept());
    mgr.on("dialog", onDialog);
    const entryRow = '#script-list li.script-item[data-id="mkpkg-entry"] .script-name';
    await mgr.waitForSelector(entryRow, { timeout: 8000 }).catch(() => {});
    await mgr.click(entryRow, { button: "right" });
    await mgr.click('.ctx-menu li:has-text("Make Package…")');
    const made = await waitFor(
        async () => ({ scripts: ((await send({ type: "listScripts" })) || []) as any[], data: ((await send({ type: "listDataFiles" })) || []) as any[] }),
        ({ scripts, data }) => scripts.some((x) => x.id === "mkpkg-entry" && x.meta.name === "mkpkg/mkpkg.wiretrick") && data.some((d) => d.path === "mkpkg/mkcfg.json"),
    );
    mgr.off("dialog", onDialog);
    const entry = made.scripts.find((x) => x.id === "mkpkg-entry");
    const mkNames = made.scripts.map((x) => x.meta.name);
    check(
        t("Make Package… moves the entry and what it imports into a folder, copying what others use, and adds a header"),
        /Copies[\s\S]*mklib\.ts → mkpkg\/mklib\.ts/.test(dialogs[0] || "") &&
            entry?.code.includes("@name mkpkg") &&
            entry?.code.includes('from "./mklib"') &&
            mkNames.includes("mkpkg/mklib") &&
            mkNames.includes("mklib") &&
            !made.data.some((d) => d.path === "mkcfg.json"),
        JSON.stringify({ dialog: dialogs[0], mkNames, entry: entry?.code.slice(0, 200), data: made.data.map((d) => d.path) }),
    );

    // the folder is a package now: its icon, and Export Package… downloads a zip of it
    const pkgRow = '#script-list li.script-item[data-id="dir:mkpkg"]';
    const icon = await mgr.waitForSelector(`${pkgRow} .file-icon.package`, { timeout: 8000 }).then(() => true, () => false);
    await mgr.evaluate(() => {
        const w = window as any;
        w.__wtDownload = null;
        w.__wtClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
            if (!this.download) return w.__wtClick.call(this);
            const name = this.download;
            void fetch(this.href)
                .then((r) => r.arrayBuffer())
                .then((b) => (w.__wtDownload = { name, bytes: Array.from(new Uint8Array(b)) }));
        };
    });
    await mgr.click(`${pkgRow} .script-name`, { button: "right" });
    await mgr.click('.ctx-menu li:has-text("Export Package…")');
    const dl = await waitFor(() => mgr.evaluate(() => (window as any).__wtDownload), (v: any) => !!v, 8000);
    await mgr.evaluate(() => void (HTMLAnchorElement.prototype.click = (window as any).__wtClick));
    const zipped = dl ? await readZip(new Uint8Array(dl.bytes).buffer) : {};
    check(
        t("a package folder has the package icon, and Export Package… downloads its files as a zip"),
        icon && dl?.name === "mkpkg.zip" && Object.keys(zipped).sort().join() === "mkpkg/mkcfg.json,mkpkg/mklib.ts,mkpkg/mkpkg.wiretrick.ts",
        JSON.stringify({ icon, name: dl?.name, files: Object.keys(zipped) })
    );
    await send({ type: "deleteFolder", path: "mkpkg" });
    for (const id of ["mkpkg-lib", "mkpkg-user"]) await send({ type: "deleteScript", id });
}
