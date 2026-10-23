/**
 * Shared E2E check (MV2 + MV3): folders and JSON data files, driven by the
 * background messages the Explorer uses. A folder `mock` holds a data file
 * `mock/rate-limits.json` and a script; a root script imports
 * `./mock/rate-limits.json` (rules strategy: a request header from the
 * JSON), the script in the folder imports `./rate-limits.json` (page
 * strategy: a replaced body from the JSON). Editing the JSON hot-applies
 * both; invalid JSON is a problem of its importers.
 *
 * `foldersServerRoute` serves the endpoints; call it in the suite's test
 * server.
 */
import type http from "node:http";

type Check = (name: string, ok: boolean, extra?: string) => void;

export function foldersServerRoute(req: http.IncomingMessage, res: http.ServerResponse, origin: string): boolean {
    const url = new URL(req.url || "/", origin);
    const json = (body: unknown): true => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
        return true;
    };
    if (url.pathname === "/folders-page") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><body>FOLDERS-PAGE</body></html>");
        return true;
    }
    if (url.pathname === "/folders-echo") return json({ headers: req.headers });
    if (url.pathname === "/folders-api") return json({ original: true });
    return false;
}

export async function checkFoldersAndDataFiles(ctx: any, mgr: any, origin: string, check: Check, label = ""): Promise<void> {
    const t = (s: string) => `folders${label}: ${s}`;
    const send = (msg: any): Promise<any> => mgr.evaluate((m: any) => new Promise((r) => chrome.runtime.sendMessage(m, (x: any) => r(x ?? null))), msg);
    const O = JSON.stringify(origin);

    const made = await send({ type: "createFolder", path: "mock" });
    check(t("createFolder"), !!made && !made.error && (await send({ type: "listFolders" })).includes("mock"), JSON.stringify(made));
    const data = await send({ type: "saveDataFile", path: "mock/rate-limits.json", text: '{ "max": 5 }' });
    check(t("saveDataFile in the folder"), !!data?.id && data.path === "mock/rate-limits.json", JSON.stringify(data));
    const listed = await send({ type: "listDataFiles" });
    check(t("listDataFiles lists it"), listed?.some((d: any) => d.id === data?.id && d.text === '{ "max": 5 }'), JSON.stringify(listed));

    const root = await send({
        type: "saveScript",
        id: "s_folders_root",
        name: "rate limiter",
        code: [`import limits from "./mock/rate-limits.json";`, `wt.onRequest({ url: ${O} + "/folders-echo*", strategy: "rules" }, () => ({ headers: { set: { "x-wt-limit": String(limits.max) } } }));`].join("\n"),
    });
    check(t("a root script importing ./mock/rate-limits.json saves"), !!root && !root.error && root.meta?.active === true, JSON.stringify({ error: root?.error, active: root?.meta?.active }));
    const inner = await send({
        type: "saveScript",
        id: "s_folders_inner",
        name: "mock/api mock",
        code: [`import { max } from "./rate-limits.json";`, `wt.onRequest({ url: ${O} + "/folders-api", strategy: "page" }, () => ({ replaceResponse: { body: { max, from: "mock/api mock" } } }));`].join("\n"),
    });
    check(t("a script inside the folder saves under its path"), !!inner && !inner.error && inner.meta?.name === "mock/api mock", JSON.stringify({ error: inner?.error, name: inner?.meta?.name }));

    const probe = async (want: number): Promise<any> => {
        let r: any = {};
        for (let i = 0; i < 24; i++) {
            const page = await ctx.newPage();
            await page.goto(`${origin}/folders-page`, { waitUntil: "load" });
            await page.waitForTimeout(300); // the page hook gets its scripts asynchronously
            r = await page
                .evaluate(async () => ({
                    header: (await (await fetch("/folders-echo?x=1")).json()).headers["x-wt-limit"],
                    api: await (await fetch("/folders-api")).json(),
                }))
                .catch((e: any) => ({ error: String(e) }));
            await page.close();
            if (r.header === String(want) && r.api?.max === want) break;
            await new Promise((res) => setTimeout(res, 250));
        }
        return r;
    };
    let r = await probe(5);
    check(t("the root script's effect comes from the JSON (rules: header)"), r.header === "5", JSON.stringify(r));
    check(t("the script inside the folder runs, with the JSON (page: replaced body)"), r.api?.max === 5 && r.api?.from === "mock/api mock", JSON.stringify(r));

    const edited = await send({ type: "saveDataFile", id: data.id, text: '{ "max": 9 }' });
    check(t("editing the data file saves"), edited?.text === '{ "max": 9 }', JSON.stringify(edited));
    r = await probe(9);
    check(t("editing the JSON hot-applies to its importers"), r.header === "9" && r.api?.max === 9, JSON.stringify(r));

    await send({ type: "saveDataFile", id: data.id, text: '{ "max": }' });
    const problem = await mgr
        .waitForFunction(
            () => [...document.querySelectorAll<HTMLElement>("#problems-list .pb-item.error")].filter((l) => /\brate limiter\.ts \[Ln 1\b/.test(l.title)).map((l) => l.textContent || "").find((x) => /mock\/rate-limits\.json:1:\d+ is not valid JSON/.test(x)),
            null,
            { timeout: 10000 }
        )
        .then((h: any) => h.jsonValue(), () => null);
    const shown = problem ? "" : await mgr.evaluate(() => [...document.querySelectorAll<HTMLElement>("#problems-list .pb-row")].map((l) => `${l.textContent} | ${l.title}`).join("\n"));
    check(t("invalid JSON → a problem of its importer, naming the file and position, at the import line"), !!problem, String(problem ?? shown));
    const errs = (await send({ type: "listScripts" })).filter((s: any) => s.id.startsWith("s_folders_")).map((s: any) => !!s.error);
    check(t("both importers show the error"), errs.length === 2 && errs.every(Boolean), JSON.stringify(errs));

    await send({ type: "saveDataFile", id: data.id, text: '{ "max": 5 }' });
    const cleared = await mgr.waitForFunction(() => ![...document.querySelectorAll("#problems-list .pb-item.error")].some((l) => /rate-limits\.json/.test(l.textContent || "")), null, { timeout: 10000 }).then(() => true, () => false);
    const left = cleared ? "" : await mgr.evaluate(() => [...document.querySelectorAll<HTMLElement>("#problems-list .pb-row")].map((l) => `${l.textContent} | ${l.title}`).join("\n"));
    check(t("fixing the JSON clears the problem"), cleared, left);

    const renamed = await send({ type: "renameFolder", from: "mock", to: "fixtures" });
    const names = (await send({ type: "listScripts" })).map((s: any) => s.meta.name);
    const paths = (await send({ type: "listDataFiles" })).map((d: any) => d.path);
    check(t("renaming the folder moves its scripts and data files"), !renamed?.error && names.includes("fixtures/api mock") && paths.includes("fixtures/rate-limits.json") && !paths.includes("mock/rate-limits.json"), JSON.stringify({ renamed, names, paths }));
    const unresolved = (await send({ type: "listScripts" })).find((s: any) => s.id === "s_folders_root");
    check(t("an import specifier isn't rewritten: the root importer now fails"), /no data file "mock\/rate-limits\.json"/.test(unresolved?.error || ""), String(unresolved?.error));

    await send({ type: "deleteScript", id: "s_folders_root" });
    const del = await send({ type: "deleteFolder", path: "fixtures" });
    check(t("deleting the folder deletes what's inside"), del?.scripts === 1 && del?.dataFiles === 1 && !(await send({ type: "listFolders" })).includes("fixtures"), JSON.stringify(del));
}
