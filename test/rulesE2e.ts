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
    if (url.pathname.startsWith("/rr/") || url.pathname.startsWith("/deep/") || url.pathname.startsWith("/rules-redirect-src")) return json({ unredirected: url.pathname });
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
        const warned = await mgr.waitForFunction(() => [...document.querySelectorAll("#problems-list .pb-item.warn")].some((l) => /rules.*not available in this browser \(no declarativeNetRequest\)/.test(l.textContent || "")), null, { timeout: 8000 }).then(() => true, () => false);
        check(t("no declarativeNetRequest here → the unavailable warning in Problems"), warned);
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
    const problem = await mgr.waitForFunction(() => [...document.querySelectorAll("#problems-list .pb-item.error")].some((l) => /onRequest #2: .*ctx\.method/.test(l.textContent || "") && /\[Ln 2\b/.test(l.textContent || "")), null, { timeout: 8000 }).then(() => true, () => false);
    const logged = await mgr.evaluate(() => [...document.querySelectorAll("#log-entries .log-line")].some((l) => /rules error/.test((l as HTMLElement).dataset.text || l.textContent || "")));
    check(t("a rules error in the Problems view at its handler's line, not in the Log"), problem && !logged, JSON.stringify({ problem, logged }));
    const listed = (await send({ type: "listScripts" })).find((s: any) => s.id === "s_rules");
    check(t("listScripts carries the per-handler rule error"), listed?.ruleErrors?.length === 1 && /^onRequest #2:/.test(listed.ruleErrors[0]), JSON.stringify(listed?.ruleErrors));

    // a URL pattern too complex for a rule: the problem points at the pattern
    // itself (line 3, where the string starts), and the editor squiggles it
    const cx = `https://cx{-(dev)}.example.test/{mms/}?static/:path+/:a/:b/:c/:d/:e/:f/:g/:h/:i/:j/:k/:name{.:hash([0-9a-f]{20,})}?{.min}?.:ext(js|css|json)`;
    await send({ type: "saveScript", id: "s_rules_cx", name: "rules complex", code: ["// too complex", "wt.onRequest({", `    url: ${JSON.stringify(cx)},`, '    strategy: "rules",', `}, (ctx) => ({ redirect: ${O} + "/rules-echo?" + ctx.groups.k + ctx.groups.name + ctx.groups.ext }));`].join("\n") });
    const cxProblem = await mgr.waitForFunction(() => [...document.querySelectorAll("#problems-list .pb-item.error")].map((l) => l.textContent || "").find((t) => t.includes("too complex for a rule")), null, { timeout: 10000 }).then((h: any) => h.jsonValue(), () => null);
    check(t("a too-complex pattern → a problem at the pattern's line and column"), !!cxProblem && /\[Ln 3, Col 11\]/.test(cxProblem), String(cxProblem).slice(-80));
    await mgr.evaluate(() => (document.querySelector('#script-list li[data-id="s_rules_cx"]') as HTMLElement).click());
    const squiggle = await mgr.waitForFunction((len: number) => {
        const monaco = (window as any).monaco;
        const m = monaco?.editor.getModels().find((x: any) => x.getValue().includes("// too complex"));
        const r = m && monaco.editor.getModelMarkers({ resource: m.uri, owner: "wiretrick" }).find((x: any) => x.severity === monaco.MarkerSeverity.Error && /too complex/.test(x.message));
        return r && r.startLineNumber === 3 && r.startColumn === 11 && r.endColumn === 11 + len ? JSON.stringify(r) : false;
    }, cx.length, { timeout: 10000 }).then((h: any) => h.jsonValue(), () => null);
    check(t("the editor squiggles the too-complex pattern"), !!squiggle, String(squiggle));
    const nextProblem = await mgr.evaluate(async () => {
        const ed = (window as any).monaco.editor.getEditors().find((e: any) => e.getModel()?.getValue().includes("// too complex"));
        ed.focus();
        ed.setPosition({ lineNumber: 1, column: 1 });
        await ed.getAction("editor.action.marker.next").run();
        const p = ed.getPosition();
        const widget = document.querySelector(".marker-widget")?.textContent || "";
        await new Promise((r) => setTimeout(r, 50));
        ed.trigger("e2e", "closeMarkersNavigation", {});
        return { line: p.lineNumber, column: p.column, shown: /too complex/.test(widget) };
    });
    check(t("Go to Next Problem (F8) lands on it"), nextProblem.line === 3 && nextProblem.column === 11 && nextProblem.shown, JSON.stringify(nextProblem));
    await send({ type: "deleteScript", id: "s_rules_cx" });

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

    // a regex near the browser's memory limit: a many-group capturing route
    // fits; a far bigger one is reported per handler, not silently dropped
    const deep = [
        `wt.onRequest({ url: ${O} + "/deep{/v:ver}?/users/:id/posts/:post/comments/:c", strategy: "rules" }, (ctx) => ({ redirect: ${O} + "/rules-echo?id=" + ctx.groups.id + "&post=" + ctx.groups.post + "&c=" + ctx.groups.c + "&ver=" + (ctx.groups.ver ?? "") }));`,
        `wt.onRequest({ url: ${O} + "/huge/:a/:b/:c/:d/:e/:f/:g/:h/:i/:j/:k/:l/:m/:n/:o/:p/:q/:r", strategy: "rules" }, () => ({ block: true }));`,
        `wt.onRequest({ url: ${O} + "/cap/:a/:b/:c/:d/:e/:f/:g/:h/:i/:j/:k", strategy: "rules" }, (ctx) => ({ redirect: ${O} + "/rules-echo?v=" + ctx.groups.a + ctx.groups.b + ctx.groups.c + ctx.groups.d + ctx.groups.e + ctx.groups.f + ctx.groups.g + ctx.groups.h + ctx.groups.i }));`,
    ].join("\n");
    await send({ type: "saveScript", id: "s_rules_deep", name: "rules deep", code: deep });
    const page3 = await ctx.newPage();
    await page3.goto(`${origin}/rules-page`, { waitUntil: "domcontentloaded" });
    let q: any = {};
    for (let i = 0; i < 20; i++) {
        q = await page3.evaluate(async () => (await (await fetch("/deep/v1/users/5/posts/6/comments/7")).json()).query ?? {}).catch(() => ({}));
        if (q.id) break;
        await page3.waitForTimeout(250);
    }
    await page3.close();
    check(t("a 4-capture route with an optional group fits the regex memory limit"), q.id === "5" && q.post === "6" && q.c === "7" && q.ver === "1", JSON.stringify(q));
    const deepErrors = (await send({ type: "listScripts" })).find((s: any) => s.id === "s_rules_deep")?.ruleErrors;
    check(t("an over-limit route → its handler's error says it's too complex, with the regex and its size"), deepErrors?.length === 2 && /^onRequest #2: .*too complex.*Regex: \^http.*\(\d+ chars, \d+ character classes, \d+ groups\) — use fewer groups/.test(deepErrors[0]), JSON.stringify(deepErrors));
    check(t("a route that only overflows with the redirect's captures → the error says so"), /^onRequest #3: .*9 captured for the redirect\) — it fits without captures/.test(deepErrors?.[1] ?? ""), JSON.stringify(deepErrors));
    await send({ type: "deleteScript", id: "s_rules_deep" });
}
