/**
 * Shared E2E check (MV2 + MV3): the `rules` strategy. Handlers become
 * declarativeNetRequest session rules — block, redirect, request and
 * response headers, a full-URLPattern route (optional + named groups) whose
 * captures land in the redirect — and a handler that can't be a rule (it
 * reads ctx.method) gets the red ⚠ while the script's other rules apply.
 *
 * `rulesServerRoute` serves the endpoints; call it first in the suite's
 * test server.
 */
import type http from "node:http";

type Check = (name: string, ok: boolean, extra?: string) => void;

export function rulesServerRoute(req: http.IncomingMessage, res: http.ServerResponse, origin: string): boolean {
    const url = new URL(req.url || "/", origin);
    const json = (body: unknown, headers: Record<string, string> = {}): true => {
        res.writeHead(200, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(body));
        return true;
    };
    if (url.pathname === "/rules-page") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><body>RULES-PAGE</body></html>");
        return true;
    }
    if (url.pathname === "/rules-echo") return json({ query: Object.fromEntries(url.searchParams), headers: req.headers });
    if (url.pathname === "/rules-blocked" || url.pathname === "/rules-method") return json({ reached: true });
    if (url.pathname === "/rules-api") return json({ ok: 1 });
    if (url.pathname.startsWith("/rr/") || url.pathname.startsWith("/rules-redirect-src")) return json({ unredirected: url.pathname });
    return false;
}

export async function checkRulesStrategy(ctx: any, mgr: any, origin: string, check: Check, label = ""): Promise<void> {
    const t = (s: string) => `rules${label}: ${s}`;
    const send = (msg: any): Promise<any> => mgr.evaluate((m: any) => new Promise((r) => chrome.runtime.sendMessage(m, (x: any) => r(x ?? null))), msg);
    const O = JSON.stringify(origin);
    const code = [
        `wt.onRequest({ url: ${O} + "/rules-blocked", strategy: "rules" }, () => ({ block: true }));`,
        `wt.onRequest({ url: ${O} + "/rules-method", strategy: "rules" }, (ctx) => (ctx.method === "POST" ? { block: true } : undefined));`,
        `wt.onRequest({ url: ${O} + "/rules-redirect-src", strategy: "rules" }, () => ({ redirect: ${O} + "/rules-echo?from=static" }));`,
        `wt.onRequest({ url: ${O} + "/rules-echo*", strategy: "rules" }, () => ({ headers: { set: { "x-wt-rules": "req" } } }));`,
        `wt.onResponseHeaders({ url: ${O} + "/rules-api", strategy: "rules" }, () => ({ headers: { set: { "x-wt-rules-res": "res" } } }));`,
        `wt.onRequest({ url: ${O} + "/rr{/v:ver}?/:name", strategy: "rules" }, (ctx) => ({ redirect: ${O} + "/rules-echo?name=" + ctx.groups.name + "&ver=" + (ctx.groups.ver ?? "") }));`,
    ].join("\n");
    const saved = await send({ type: "saveScript", id: "s_rules", name: "rules probe", code });
    check(t("script saves (one handler is not a rule, the script still loads)"), !!saved && !saved.error && saved.meta?.active === true, JSON.stringify({ error: saved?.error?.split("\n")[0], active: saved?.meta?.active }));

    const hasDnr: boolean = await mgr.evaluate(() => !!(chrome as any).declarativeNetRequest);
    if (!hasDnr) {
        const warned = await mgr.waitForFunction(() => [...document.querySelectorAll("#log-entries .log-line")].some((l) => /rules.*not available in this browser \(no declarativeNetRequest\)/.test((l as HTMLElement).dataset.text || l.textContent || "")), null, { timeout: 8000 }).then(() => true, () => false);
        check(t("no declarativeNetRequest here → the unavailable warning"), warned);
        await send({ type: "deleteScript", id: "s_rules" });
        return;
    }

    // the red ⚠ names the handler and the reason
    const indSel = '#script-list li[data-id="s_rules"] .err-ind.rules';
    await mgr.waitForSelector(indSel, { timeout: 10000 }).catch(() => {});
    const ind = await mgr.evaluate((sel: string) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        return el ? { title: el.title, aria: el.getAttribute("aria-label"), color: getComputedStyle(el).color } : null;
    }, indSel);
    check(t("a handler reading ctx.method → red ⚠ naming the handler and reason"), !!ind && ind.aria === "rules error" && /onRequest #2: rules are fixed.*ctx\.method/.test(ind.title), JSON.stringify(ind));
    const logged = await mgr.waitForFunction(() => [...document.querySelectorAll("#log-entries .log-line")].some((l) => /\[rules probe\] rules error: onRequest #2: .*ctx\.method/.test((l as HTMLElement).dataset.text || l.textContent || "")), null, { timeout: 8000 }).then(() => true, () => false);
    check(t("ERROR line in the Log view, attributed to the script"), logged);
    const listed = (await send({ type: "listScripts" })).find((s: any) => s.id === "s_rules");
    check(t("listScripts carries the per-handler rule error"), listed?.ruleErrors?.length === 1 && /^onRequest #2:/.test(listed.ruleErrors[0]), JSON.stringify(listed?.ruleErrors));

    const page = await ctx.newPage();
    await page.goto(`${origin}/rules-page`, { waitUntil: "domcontentloaded" });
    // rules are applied asynchronously after the save — poll until the block is live
    const probe = () => page.evaluate(async () => {
        const out: any = {};
        out.blocked = await fetch("/rules-blocked").then(() => "reached", () => "blocked");
        out.method = await fetch("/rules-method").then((r) => r.status, () => "blocked");
        const red = await fetch("/rules-redirect-src");
        out.redirect = { url: red.url, body: await red.json() };
        out.header = (await (await fetch("/rules-echo?h=1")).json()).headers["x-wt-rules"];
        out.resHeader = (await fetch("/rules-api")).headers.get("x-wt-rules-res");
        const long = await fetch("/rr/v2/abc");
        out.rrLong = { url: long.url, query: (await long.json()).query };
        const short = await fetch("/rr/abc");
        out.rrShort = { url: short.url, query: (await short.json()).query };
        return out;
    });
    let r: any = {};
    for (let i = 0; i < 20; i++) {
        r = await probe().catch((e: any) => ({ error: String(e) }));
        if (r.blocked === "blocked" && r.rrShort?.query?.name) break;
        await page.waitForTimeout(250);
    }
    check(t("block"), r.blocked === "blocked", JSON.stringify(r.blocked));
    check(t("the erroring handler doesn't run (its request isn't blocked)"), r.method === 200, JSON.stringify(r.method));
    check(t("redirect"), r.redirect?.url === `${origin}/rules-echo?from=static` && r.redirect?.body?.query?.from === "static", JSON.stringify(r.redirect));
    check(t("request header set, seen by the server"), r.header === "req", JSON.stringify(r.header));
    check(t("response header set, visible to the page"), r.resHeader === "res", JSON.stringify(r.resHeader));
    check(t("optional + named group: /rr/v2/abc → captures substituted"), r.rrLong?.query?.name === "abc" && r.rrLong?.query?.ver === "2", JSON.stringify(r.rrLong));
    check(t("optional + named group: /rr/abc → captures substituted (missing optional → empty)"), r.rrShort?.query?.name === "abc" && r.rrShort?.query?.ver === "", JSON.stringify(r.rrShort));
    await page.close();

    // the Network view marks requests a rule changed as Modified
    const net: any[] = await mgr.evaluate(() => new Promise((resolve) => {
        const port = chrome.runtime.connect({ name: "network" });
        port.onMessage.addListener((m: any) => { if (m.type === "netSnapshot") { port.disconnect(); resolve(m.entries); } });
    }));
    const marked = net.filter((e) => e.url === `${origin}/rules-blocked` && e.outcomes?.some((i: any) => i.kind === "modified" && /block/.test(i.action || "")));
    check(t("Network: a blocked request is marked Modified (rules: block)"), marked.length > 0, JSON.stringify(net.filter((e) => e.url?.includes("/rules-")).map((e) => [e.url.replace(origin, ""), e.outcomes?.map((i: any) => [i.kind, i.action])])).slice(0, 400));

    // saving a fixed script clears the error
    await send({ type: "saveScript", id: "s_rules", name: "rules probe", code: code.replace(`(ctx) => (ctx.method === "POST" ? { block: true } : undefined)`, `() => ({ block: true })`) });
    const cleared = await mgr.waitForFunction(() => !document.querySelector('#script-list li[data-id="s_rules"] .err-ind'), null, { timeout: 8000 }).then(() => true, () => false);
    check(t("saving the fixed script clears the ⚠"), cleared);

    // disabling the script removes its rules
    await send({ type: "setEnabled", id: "s_rules", enabled: false });
    const page2 = await ctx.newPage();
    await page2.goto(`${origin}/rules-page`, { waitUntil: "domcontentloaded" });
    let after = "";
    for (let i = 0; i < 20; i++) {
        after = await page2.evaluate(() => fetch("/rules-blocked").then(() => "reached", () => "blocked"));
        if (after === "reached") break;
        await page2.waitForTimeout(250);
    }
    check(t("disabling the script removes its rules"), after === "reached", after);
    await page2.close();
    await send({ type: "deleteScript", id: "s_rules" });
}
