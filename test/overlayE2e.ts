/**
 * Shared E2E check (MV2 + MV3): overlays (wt.onOverlay). A `.tsx` switch
 * with the built-in React and valtio toggles a page-strategy mock live;
 * clicks on empty areas reach the page; a strict-CSP page still shows the
 * overlay; the page can't find the frame or read the overlay's code; the
 * overlay's `fetch` carries the page's cookies; in-place navigation reaches
 * `ctx.onNavigate`; a page-posted call never reaches an overlay; a handle
 * call in onSite code throws SiteCannotCallError; on save the overlay
 * updates in place with its store kept; disabling removes it. With
 * `isolated` (the MV2 builds): an Alt+click in isolated onPage code calls
 * the overlay, which calls back to highlight. With `userScripts` (MV3):
 * while user scripts are off, isolated handlers don't run, the overlay's
 * calls into them reject with the hint, and the Problems error and the
 * Editor's banner say how to turn them on; then `grant()` turns them on and
 * the same round trip runs through them.
 *
 * `overlayServerRoute` serves the pages; call it in the suite's test server.
 */
import type http from "node:http";

type Check = (name: string, ok: boolean, extra?: string) => void;

const hits: string[] = [];
let lastCookie = "";
/** CSP violation reports the /early?csp page sent */
let cspReports = 0;

const PAGE = (body: string) =>
    `<!doctype html><html><head><title>OV</title></head><body style="margin:0;height:100vh">
<button id="pass" style="position:absolute;left:20px;top:20px;width:160px;height:40px" onclick="document.body.dataset.clicked='1'">PASS-THROUGH</button>
<p id="target" style="position:absolute;left:20px;top:100px;width:200px;height:30px;margin:0">TARGET</p>${body}</body></html>`;

export function overlayServerRoute(req: http.IncomingMessage, res: http.ServerResponse, origin: string): boolean {
    const url = new URL(req.url || "/", origin);
    if (url.pathname === "/ov-app") {
        res.writeHead(200, { "content-type": "text/html", "set-cookie": "ovc=COOKIE-OK; Path=/" });
        res.end(PAGE(""));
        return true;
    }
    if (url.pathname === "/ov-csp") {
        res.writeHead(200, { "content-type": "text/html", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" });
        res.end(PAGE(""));
        return true;
    }
    if (url.pathname === "/ov-keys") {
        res.writeHead(200, { "content-type": "text/html" });
        // the page's own shortcuts: it records every key it sees and handles Alt+P itself
        res.end(
            PAGE(`<input id="field" style="position:absolute;left:20px;top:160px"><script>
window.__keys = [];
window.addEventListener("keydown", (e) => window.__keys.push(e.code), true);
window.addEventListener("keydown", (e) => { if (e.altKey && e.code === "KeyP") e.preventDefault(); });
</script>`)
        );
        return true;
    }
    if (url.pathname === "/ov-layer") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(PAGE(`<script>window.__site = "SITE-7";</script>`));
        return true;
    }
    if (url.pathname === "/ov-life") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(PAGE(`<p id="lifec" class="life-color">c</p>`));
        return true;
    }
    if (url.pathname === "/ov-two" || url.pathname === "/ov-isost" || url.pathname === "/ov-unsafe" || url.pathname === "/ov-site") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(PAGE(""));
        return true;
    }
    if (url.pathname === "/early-csp-report") {
        cspReports++;
        res.writeHead(204);
        res.end();
        return true;
    }
    if (url.pathname === "/early") {
        // ?csp: a strict page CSP (nonced scripts only) that reports violations
        const csp = url.searchParams.has("csp");
        res.writeHead(200, { "content-type": "text/html", ...(csp ? { "content-security-policy": "script-src 'nonce-e4rly'; report-uri /early-csp-report" } : {}) });
        // the page's own requests while it's still parsing: before the hook got the page's scripts
        res.end(`<!doctype html><html><head><script nonce="e4rly">
window.__early = { hooked: !/native code/.test(String(window.fetch)) };
fetch("/early-data?via=fetch").then((r) => r.text()).then((t) => (window.__early.fetch = t), (e) => (window.__early.fetch = "error: " + e));
const x = new XMLHttpRequest();
x.open("GET", "/early-data?via=xhr");
x.onload = () => (window.__early.xhr = x.responseText);
x.onerror = () => (window.__early.xhr = "error");
x.send();
</script></head><body>early</body></html>`);
        return true;
    }
    if (url.pathname === "/early-data") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("REAL");
        return true;
    }
    if (url.pathname === "/ov-ps") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("REAL");
        return true;
    }
    if (url.pathname === "/ov-me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: "REAL" }));
        return true;
    }
    if (url.pathname === "/ov-cookie") {
        lastCookie = String(req.headers.cookie || "");
        res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" });
        res.end("ok");
        return true;
    }
    if (url.pathname === "/ov-hit") {
        hits.push(url.search);
        res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" });
        res.end("ok");
        return true;
    }
    return false;
}

const switchCode = (origin: string, label: string) => `import { useSnapshot } from "valtio";

const mock = wt.globalStore("ovmock", { enabled: false });

wt.replaceResponse({ url: "${origin}/ov-me", strategy: "page" }, () =>
    mock.enabled ? JSON.stringify({ name: "MOCKED" }) : undefined);

wt.onOverlay("${origin}/ov-*", (ctx) => {
    const secret = "OV-SECRET-MARKER";
    void fetch("/ov-cookie");
    function Panel() {
        const snap = useSnapshot(mock);
        return (
            <label id="sw" data-secret={secret} style={{ position: "fixed", right: 16, bottom: 16, background: "white", padding: 8 }}>
                <input id="box" type="checkbox" checked={snap.enabled} onChange={() => (mock.enabled = !mock.enabled)} /> ${label}
            </label>
        );
    }
    ctx.mount(<Panel />);
});
`;

const rpcCode = (origin: string) => `const overlay = wt.onOverlay("${origin}/ov-*", (ctx) => {
    const out = document.body.appendChild(document.createElement("output"));
    out.id = "picked";
    out.style.cssText = "position:fixed;left:16px;bottom:16px;background:white;padding:8px";
    out.value = "none";
    const nav = document.body.appendChild(document.createElement("output"));
    nav.id = "nav";
    nav.style.cssText = "position:fixed;left:16px;bottom:60px;background:white;padding:8px";
    nav.value = ctx.url;
    ctx.onNavigate((u) => (nav.value = u));
    const probe = document.body.appendChild(document.createElement("output"));
    probe.id = "isoprobe";
    probe.value = "pending";
    iso.highlight("#none").then((n) => (probe.value = "ok:" + n), (e) => (probe.value = "rejected: " + e.message));
    return {
        picked(tag: string) {
            out.value = tag;
            iso.highlight(tag.toLowerCase()).then((n) => { out.value = tag + ":" + n; void fetch("/ov-hit?picked=" + n); });
        },
        hit() {
            void fetch("/ov-hit?l4=1");
            return "hit";
        },
    };
});

wt.onSite("${origin}/ov-app*", () => {
    try {
        void overlay.hit();
        document.documentElement.dataset.mainCall = "called";
    } catch (e) {
        document.documentElement.dataset.mainCall = "threw " + (e as Error).name + ": " + (e as Error).message;
    }
});

const iso = wt.onPage("${origin}/ov-*", () => {
    document.addEventListener("click", (e) => {
        if (e.altKey) void overlay.picked((e.target as Element).tagName);
    }, true);
    return {
        highlight(sel: string) {
            const els = [...document.querySelectorAll<HTMLElement>(sel)];
            els.forEach((el) => (el.style.outline = "2px solid red"));
            return els.length;
        },
    };
});
`;

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 10000): Promise<T> {
    const end = Date.now() + ms;
    let v = await fn();
    while (!ok(v) && Date.now() < end) {
        await new Promise((r) => setTimeout(r, 200));
        v = await fn();
    }
    return v;
}

/** the overlay frame holding `sel` (frames are matched by URL; evaluate may fail while they load) */
async function overlayFrame(page: any, sel: string): Promise<any> {
    return waitFor(
        async () => {
            for (const f of page.frames().filter((f: any) => f.url().includes("/overlay.html")))
                if (await f.evaluate((s: string) => !!document.querySelector(s), sel).catch(() => false)) return f;
            return null;
        },
        (f) => !!f
    );
}

const centerOf = (frame: any, sel: string): Promise<{ x: number; y: number }> =>
    frame.evaluate((s: string) => {
        const r = document.querySelector(s)!.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, sel);

export async function checkOverlays(ctx: any, mgr: any, origin: string, check: Check, opts: { label?: string; isolated: boolean; userScripts?: { grant(): Promise<void> } }): Promise<void> {
    const t = (s: string) => `overlay${opts.label ?? ""}: ${s}`;
    const send = (msg: any): Promise<any> => mgr.evaluate((m: any) => new Promise((r) => chrome.runtime.sendMessage(m, (x: any) => r(x ?? null))), msg);
    const save = (id: string, code: string, name: string) => send({ type: "saveScript", id, code, name });

    const sw = await save("s_ov_switch", switchCode(origin, "Mock /api/me"), "overlay switch.wiretrick");
    const rpc = await save("s_ov_rpc", rpcCode(origin), "overlay rpc.wiretrick");
    check(t("tsx overlay + RPC scripts save without errors"), !sw?.error && !rpc?.error, JSON.stringify({ sw: sw?.error?.split("\n")[0], rpc: rpc?.error?.split("\n")[0] }));
    await mgr.waitForTimeout(800);

    const page = await ctx.newPage();
    page.on("console", (m: any) => console.log("  [ov-app]", m.text().slice(0, 160)));
    // everything the page's own window sees posted (the hook's traffic included)
    await page.addInitScript(() => {
        (window as any).__wtMsgs = [];
        addEventListener("message", (e) => {
            try {
                (window as any).__wtMsgs.push(JSON.stringify(e.data));
            } catch {}
        }, true);
    });
    const loadedAt = Date.now();
    await page.goto(`${origin}/ov-app`, { waitUntil: "load", timeout: 15000 });

    const swFrame = await overlayFrame(page, "#box");
    check(t("the React switch renders in an overlay frame"), !!swFrame);
    const fetchMe = (): Promise<string> => page.evaluate(() => fetch("/ov-me").then((r) => r.text()));
    const before = await fetchMe();
    if (swFrame) {
        const at = await centerOf(swFrame, "#box");
        // the frame takes clicks once it reported where it draws (clip-path)
        await waitFor<string>(() => page.evaluate(({ x, y }: { x: number; y: number }) => document.elementFromPoint(x, y)?.tagName ?? "", at), (v) => v === "WIRETRICK-UI", 5000);
        await page.mouse.click(at.x, at.y);
    }
    const checked = swFrame ? await waitFor<boolean>(() => swFrame.evaluate(() => (document.getElementById("box") as HTMLInputElement).checked), (v) => v, 5000) : false;
    const after = await waitFor<string>(fetchMe, (v) => v.includes("MOCKED"), 5000);
    check(t("clicking the switch toggles the mock live"), before.includes("REAL") && checked && after.includes("MOCKED"), JSON.stringify({ before, checked, after }));

    // Network: the document row names the scripts whose page handlers ran on it; the overlay's fetch names its script
    // (no Network tab recording: rows are synthetic)
    type NetRow = { url: string; type: string; synthetic?: boolean; startedAt: number; outcomes: { scriptName: string; action: string; kind: string }[] };
    const netRows = (): Promise<NetRow[]> =>
        mgr.evaluate(() => new Promise((resolve) => {
            const port = chrome.runtime.connect({ name: "network" });
            port.onMessage.addListener((m: any) => { if (m.type === "netSnapshot") { port.disconnect(); resolve(m.entries); } });
        }));
    const tagsOf = (rows: NetRow[], path: string) => rows.filter((e) => e.url === origin + path && e.startedAt >= loadedAt - 50).flatMap((e) => e.outcomes.map((o) => `${o.scriptName}: ${o.action}`));
    const net = await waitFor<NetRow[]>(netRows, (rows) => tagsOf(rows, "/ov-app").length >= 3 && tagsOf(rows, "/ov-cookie").length >= 1, 5000);
    const docTags = tagsOf(net, "/ov-app");
    const docRow = net.find((e) => e.url === `${origin}/ov-app` && e.startedAt >= loadedAt - 50 && e.outcomes.length);
    check(
        t("Network: the page's document row names the scripts whose onSite/onOverlay handlers ran on it"),
        (docRow?.type === "main_frame" || !!docRow?.synthetic) && ["overlay switch.wiretrick: overlay shown", "overlay rpc.wiretrick: overlay shown", "overlay rpc.wiretrick: onSite ran"].every((x) => docTags.includes(x)) && docRow.outcomes.every((o) => o.kind === "observed"),
        JSON.stringify({ type: docRow?.type, synthetic: docRow?.synthetic, docTags })
    );
    check(t("Network: the overlay's fetch names its script"), tagsOf(net, "/ov-cookie").includes("overlay switch.wiretrick: fetched by its overlay"), JSON.stringify(tagsOf(net, "/ov-cookie")));

    const pass = await page.evaluate(() => {
        const r = document.getElementById("pass")!.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.click(pass.x, pass.y);
    const clicked = await waitFor<string>(() => page.evaluate(() => document.body.dataset.clicked || ""), (v) => v === "1", 3000);
    check(t("clicks on empty areas reach the page"), clicked === "1");

    const cookie = await waitFor(async () => lastCookie, (v) => v.includes("ovc=COOKIE-OK"), 5000);
    check(t("the overlay's fetch sends the page's cookies"), cookie.includes("ovc=COOKIE-OK"), cookie);

    const seen = await page.evaluate(() => {
        const all = [...document.querySelectorAll("*")];
        let frameDoc: string;
        try {
            frameDoc = String(!!(window.frames[0] as any)?.document);
        } catch {
            frameDoc = "blocked";
        }
        return {
            iframes: document.querySelectorAll("iframe").length,
            shadows: all.filter((e) => e.shadowRoot).length,
            html: document.documentElement.outerHTML.includes("OV-SECRET-MARKER"),
            timing: performance.getEntries().filter((e) => e.name.includes("overlay.html")).map((e) => e.name),
            posted: ((window as any).__wtMsgs as string[]).filter((m) => m.includes("OV-SECRET-MARKER") || m.includes("overlay.html")).length,
            frameDoc,
        };
    });
    check(
        t("the page can't find the frame or read the overlay's code"),
        seen.iframes === 0 && seen.shadows === 0 && !seen.html && !seen.timing.length && !seen.posted && seen.frameDoc !== "true",
        JSON.stringify(seen)
    );

    const mainCall = await waitFor<string>(() => page.evaluate(() => document.documentElement.dataset.mainCall || ""), (v) => !!v, 5000);
    check(t("overlay.fn() in onSite code throws SiteCannotCallError"), /^threw SiteCannotCallError: onSite code can't call handles/.test(mainCall), mainCall);
    const mainProblem = await waitFor<any>(async () => ((await send({ type: "listScripts" })) || []).find((s: any) => s.id === "s_ov_rpc")?.runtimeError, (e) => !!e?.ctx, 5000);
    check(
        t("overlay.fn() in onSite code is a Problems error tagged page › host"),
        !!mainProblem?.message.includes("onSite code can't call handles") && mainProblem.ctx === `page › ${new URL(origin).host}`,
        JSON.stringify(mainProblem)
    );

    await page.evaluate((s: string) => {
        for (const h of ["onOverlay:0", "overlay:0"]) {
            const call = { cid: "page-forged-" + h, h, fn: "hit", args: [] };
            for (const source of ["res-override-hook", "res-override-bridge"]) {
                window.postMessage({ source, kind: "rpc.call", s, call }, "*");
                window.postMessage({ source, kind: "rpc.call", scriptId: s, call, ...call }, "*");
            }
        }
    }, "s_ov_rpc");
    await page.waitForTimeout(1500);
    check(t("a page-posted call never reaches the overlay"), !hits.some((h) => h.includes("l4=1")), JSON.stringify(hits));

    let navFrame = await overlayFrame(page, "#nav");
    await page.evaluate(() => history.pushState({}, "", "/ov-app?nav=1"));
    const navUrl = navFrame ? await waitFor<string>(() => navFrame.evaluate(() => (document.getElementById("nav") as HTMLOutputElement).value), (v) => v.includes("nav=1"), 5000) : "";
    check(t("ctx.onNavigate sees history.pushState"), navUrl.endsWith("/ov-app?nav=1"), navUrl);

    const probeOf = (f: any) => (f ? waitFor<string>(() => f.evaluate(() => (document.getElementById("isoprobe") as HTMLOutputElement).value).catch(() => "pending"), (v) => v !== "pending", 8000) : Promise.resolve(""));
    const altClickTarget = async () => {
        const target = await page.evaluate(() => {
            const r = document.getElementById("target")!.getBoundingClientRect();
            return { x: r.x + 30, y: r.y + r.height / 2 };
        });
        await page.keyboard.down("Alt");
        await page.mouse.click(target.x, target.y);
        await page.keyboard.up("Alt");
    };
    if (opts.userScripts) {
        const probe = await probeOf(navFrame);
        check(t("user scripts off: the overlay's call into isolated code rejects with the hint"), probe.startsWith("rejected:") && probe.includes("user scripts are off"), probe);
        await altClickTarget();
        await page.waitForTimeout(1500);
        const picked = navFrame ? await navFrame.evaluate(() => (document.getElementById("picked") as HTMLOutputElement).value) : "";
        const outline = await page.evaluate(() => document.getElementById("target")!.style.outline);
        check(t("user scripts off: isolated onPage handlers don't run"), picked === "none" && !outline, JSON.stringify({ picked, outline }));
        const warnings: string[] = ((await send({ type: "listScripts" })) || []).find((s: any) => s.id === "s_ov_rpc")?.routeWarnings ?? [];
        check(
            t("user scripts off: a Problems error says how to turn them on"),
            warnings.some((w) => w.includes(`isolated onPage code doesn't run: user scripts are off`) && /chrome:\/\/extensions\/\?id=[a-p]{32}/.test(w)),
            JSON.stringify(warnings)
        );
        const banner = await mgr.waitForSelector("#userscripts-banner[data-status=no-permission] #userscripts-grant", { timeout: 8000 }).then(
            () => true,
            () => false
        );
        check(t("user scripts off: the Editor's banner offers the permission"), banner);
        await opts.userScripts.grant();
        const gone = await mgr.waitForSelector("#userscripts-banner", { state: "detached", timeout: 8000 }).then(
            () => true,
            () => false
        );
        const listed: string[] = await waitFor<string[]>(
            async () => ((await send({ type: "listScripts" })) || []).find((s: any) => s.id === "s_ov_rpc")?.routeWarnings ?? [],
            (w) => !w.some((x) => x.includes("user scripts are off")),
            8000
        );
        check(t("granting user scripts clears the banner and the Problems error"), gone && !listed.some((x) => x.includes("user scripts are off")), JSON.stringify({ gone, listed }));
        // a newly registered user script runs from the next page load
        await page.reload({ waitUntil: "load", timeout: 15000 });
        navFrame = await overlayFrame(page, "#nav");
    }
    if (opts.isolated || opts.userScripts) {
        const probe = await probeOf(navFrame);
        check(t("the overlay calls isolated code"), probe === "ok:0", probe);
        await altClickTarget();
        const picked = navFrame ? await waitFor<string>(() => navFrame.evaluate(() => (document.getElementById("picked") as HTMLOutputElement).value), (v) => v.startsWith("P:"), 5000) : "";
        const outline = await page.evaluate(() => document.getElementById("target")!.style.outline);
        await waitFor(async () => hits.includes("?picked=1"), (v) => v, 3000);
        check(t("isolated onPage → overlay → isolated round trip (element picker)"), picked === "P:1" && outline.includes("red") && hits.includes("?picked=1"), JSON.stringify({ picked, outline, hits }));
    }

    // save: the overlay updates in place (the same frame: a mark on its window stays) with the new code; the store keeps its value
    const marked = await overlayFrame(page, "#sw");
    await marked?.evaluate(() => ((window as any).__wtSameFrame = 1)).catch(() => null);
    const frameCount = () => page.frames().filter((f: any) => f.url().includes("/overlay.html")).length;
    const framesBefore = frameCount();
    await save("s_ov_switch", switchCode(origin, "Mock v2"), "overlay switch.wiretrick");
    const v2 = await waitFor(
        async () => {
            const f = await overlayFrame(page, "#sw");
            return f
                ? await f
                      .evaluate(() => ({
                          text: document.getElementById("sw")!.textContent || "",
                          on: (document.getElementById("box") as HTMLInputElement).checked,
                          mounts: document.querySelectorAll("#sw").length,
                          same: (window as any).__wtSameFrame === 1,
                      }))
                      .catch(() => null)
                : null;
        },
        (v) => !!v?.text.includes("Mock v2"),
        8000
    );
    check(t("on save the overlay updates in place: the same frame, new content, one mount, its store kept"), !!v2?.text.includes("Mock v2") && !!v2?.on && v2?.mounts === 1 && !!v2?.same && frameCount() === framesBefore, JSON.stringify({ ...v2, framesBefore, framesAfter: frameCount() }));

    const csp = await ctx.newPage();
    await csp.goto(`${origin}/ov-csp`, { waitUntil: "load", timeout: 15000 });
    const cspFrame = await overlayFrame(csp, "#box");
    check(t("a strict-CSP page still shows the overlay"), !!cspFrame);
    await csp.close();

    await send({ type: "setEnabled", id: "s_ov_switch", enabled: false });
    const left = await waitFor(
        async () => {
            let n = 0;
            for (const f of page.frames().filter((f: any) => f.url().includes("/overlay.html"))) if (await f.evaluate(() => !!document.getElementById("box")).catch(() => false)) n++;
            return n;
        },
        (n) => n === 0,
        5000
    );
    check(t("disabling a script removes its overlay"), left === 0, `frames with the switch: ${left}`);

    await page.close();
    await send({ type: "deleteScript", id: "s_ov_switch" });
    await send({ type: "deleteScript", id: "s_ov_rpc" });
}

const keysCode = (origin: string, id: string) => `wt.onOverlay("${origin}/ov-keys", (ctx) => {
    const box = document.body.appendChild(document.createElement("div"));
    box.id = "${id}";
    box.textContent = "Hello";
    box.style.cssText = "position:fixed;right:16px;top:16px;background:white;padding:8px";
    box.hidden = true;
    ctx.shortcut("Alt+Shift+H", () => (box.hidden = !box.hidden));
    const log = document.body.appendChild(document.createElement("output"));
    log.id = "${id}-log";
    ctx.shortcut("Alt+P", () => (log.value += "P"), { priority: "after-page" });
    ctx.shortcut("Alt+O", () => (log.value += "O"), { priority: "after-page" });
});
`;

/**
 * `ctx.shortcut`: a shortcut toggles the GUI and the page never sees a
 * `before-page` key; `after-page` yields to a page that handles the key;
 * keys typed in a page field and page-made key events don't count; the
 * same keys in a script later in the list stay with the first (a Log warning).
 */
export async function checkOverlayShortcuts(ctx: any, mgr: any, origin: string, check: Check, opts: { label?: string } = {}): Promise<void> {
    const t = (s: string) => `overlay shortcuts${opts.label ?? ""}: ${s}`;
    const send = (msg: any): Promise<any> => mgr.evaluate((m: any) => new Promise((r) => chrome.runtime.sendMessage(m, (x: any) => r(x ?? null))), msg);
    const a = await send({ type: "saveScript", id: "s_ov_keys", code: keysCode(origin, "kbox"), name: "keys first.wiretrick" });
    await mgr.waitForTimeout(300);
    const b = await send({ type: "saveScript", id: "s_ov_keys2", code: keysCode(origin, "kbox2"), name: "keys second.wiretrick" });
    check(t("scripts save without errors"), !a?.error && !b?.error, JSON.stringify({ a: a?.error, b: b?.error }));
    await mgr.waitForTimeout(800);

    const page = await ctx.newPage();
    await page.goto(`${origin}/ov-keys`, { waitUntil: "load", timeout: 15000 });
    const f1 = await overlayFrame(page, "#kbox");
    const f2 = await overlayFrame(page, "#kbox2");
    const state = async () => ({
        shown: f1 ? await f1.evaluate(() => !document.getElementById("kbox")!.hidden) : null,
        shown2: f2 ? await f2.evaluate(() => !document.getElementById("kbox2")!.hidden) : null,
        log: f1 ? await f1.evaluate(() => (document.getElementById("kbox-log") as HTMLOutputElement).value) : null,
        pageKeys: (await page.evaluate(() => (window as any).__keys)) as string[],
    });
    // the overlays register their shortcuts once their handlers ran
    await page.waitForTimeout(500);
    await page.bringToFront();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());

    await page.keyboard.press("Alt+Shift+KeyH");
    const on = await waitFor(state, (v) => !!v.shown, 3000);
    check(t("a shortcut toggles the GUI"), !!on.shown, JSON.stringify(on));
    check(t("the page doesn't see a before-page key"), !on.pageKeys.includes("KeyH"), JSON.stringify(on.pageKeys));
    check(t("the same keys in a second script stay with the first"), on.shown2 === false, JSON.stringify(on));
    await page.keyboard.press("Alt+Shift+KeyH");
    const off = await waitFor(state, (v) => !v.shown, 3000);
    check(t("pressing it again toggles back"), off.shown === false, JSON.stringify(off));

    await page.keyboard.press("Alt+KeyP");
    await page.keyboard.press("Alt+KeyO");
    const after = await waitFor(state, (v) => !!v.log?.includes("O"), 3000);
    check(t("after-page yields to a page that handles the key, fires otherwise"), after.log === "O" && after.pageKeys.includes("KeyP") && after.pageKeys.includes("KeyO"), JSON.stringify(after));

    await page.focus("#field");
    await page.keyboard.press("Alt+Shift+KeyH");
    await page.evaluate(() => {
        (document.activeElement as HTMLElement).blur();
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "H", code: "KeyH", altKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(500);
    const typed = await state();
    check(t("keys typed in a page field and page-made key events don't trigger it"), typed.shown === false, JSON.stringify(typed));

    const lines: string[] = await mgr.evaluate(() => [...document.querySelectorAll("#log-entries .log-line")].map((l) => (l as HTMLElement).dataset.text || ""));
    check(
        t("a Log warning names the script that keeps the keys"),
        lines.some((l) => l.includes("[keys second.wiretrick]") && l.includes("Alt+Shift+H") && l.includes('"keys first.wiretrick" (earlier in the list) uses these keys too')),
        lines.filter((l) => l.includes("keys")).join(" | ").slice(0, 300)
    );

    // another extension (Playwriter's debugger attach) removes a frame from the closed shadow root
    const kboxFrames = async () => {
        let n = 0;
        for (const f of page.frames().filter((f: any) => f.url().includes("/overlay.html"))) if (await f.evaluate(() => !!document.getElementById("kbox")).catch(() => false)) n++;
        return n;
    };
    await (await f1.frameElement()).evaluate((el: Element) => el.remove());
    const evictLines = () => mgr.evaluate(() => [...document.querySelectorAll("#log-entries .log-line")].map((l) => (l as HTMLElement).dataset.text || "").filter((l) => l.includes("removed by another extension")));
    const evicted: string[] = await waitFor(evictLines, (v) => v.length > 0, 5000);
    check(t("a frame removed by another extension logs a warning naming the script"), evicted.length === 1 && evicted[0].includes("[keys first.wiretrick]"), JSON.stringify(evicted));
    await page.keyboard.press("Alt+Shift+KeyH");
    const shown2 = () => f2.evaluate(() => !document.getElementById("kbox2")!.hidden).catch(() => null);
    const freed = await waitFor(shown2, (v) => v === true, 3000);
    check(t("its shortcuts are dropped (the next script gets the keys)"), freed === true, String(freed));
    await send({ type: "saveScript", id: "s_ov_keys2", code: keysCode(origin, "kbox2") + "\n// v2", name: "keys second.wiretrick" });
    await page.waitForTimeout(1500);
    check(t("it isn't re-created when another script changes"), (await kboxFrames()) === 0, String(await kboxFrames()));
    await send({ type: "saveScript", id: "s_ov_keys", code: keysCode(origin, "kbox") + "\n// v2", name: "keys first.wiretrick" });
    const back = await waitFor(kboxFrames, (n) => n === 1, 8000);
    check(t("changing its code starts it again"), back === 1, String(back));
    check(t("the warning is logged once"), (await evictLines()).length === 1, JSON.stringify(await evictLines()));

    await page.close();
    await send({ type: "deleteScript", id: "s_ov_keys" });
    await send({ type: "deleteScript", id: "s_ov_keys2" });
}

/**
 * The Editor's Preview tab: the open script's overlay runs in a frame in
 * the Editor, with real store replicas — its switch flips the mock for a
 * page in a tab — and updates on save.
 */
export async function checkOverlayPreview(ctx: any, mgr: any, origin: string, check: Check, opts: { label?: string } = {}): Promise<void> {
    const t = (s: string) => `overlay preview${opts.label ?? ""}: ${s}`;
    const send = (msg: any): Promise<any> => mgr.evaluate((m: any) => new Promise((r) => chrome.runtime.sendMessage(m, (x: any) => r(x ?? null))), msg);
    const saved = await send({ type: "saveScript", id: "s_ov_prev", code: switchCode(origin, "Preview switch"), name: "overlay preview.wiretrick" });
    check(t("the script saves"), !saved?.error, saved?.error);
    await mgr.bringToFront();
    await mgr.waitForSelector('#script-list li[data-id="s_ov_prev"]', { timeout: 8000 });
    await mgr.evaluate(() => (document.querySelector('#script-list li[data-id="s_ov_prev"]') as HTMLElement).click());
    if (await mgr.evaluate(() => !document.getElementById("preview-tab")?.offsetParent)) await mgr.click("#sb-log");
    await mgr.click("#preview-tab");

    const frame = await overlayFrame(mgr, "#box");
    const url = await mgr.evaluate(() => (document.getElementById("preview-url") as HTMLInputElement | null)?.value ?? "");
    check(t("the Preview tab shows the open script's overlay at its route's URL"), !!frame && url === `${origin}/ov-`, JSON.stringify({ frame: !!frame, url }));

    const page = await ctx.newPage();
    await page.goto(`${origin}/ov-app`, { waitUntil: "load", timeout: 15000 });
    const fetchMe = (): Promise<string> => page.evaluate(() => fetch("/ov-me").then((r) => r.text()));
    const before = await fetchMe();
    await mgr.bringToFront();
    if (frame) await frame.click("#box", { timeout: 5000 }).catch(() => {});
    const checked = frame ? await waitFor<boolean>(() => frame.evaluate(() => (document.getElementById("box") as HTMLInputElement).checked).catch(() => false), (v) => v, 5000) : false;
    const after = await waitFor<string>(fetchMe, (v) => v.includes("MOCKED"), 5000);
    const pageFrame = await overlayFrame(page, "#box");
    const onPage = pageFrame ? await waitFor<boolean>(() => pageFrame.evaluate(() => (document.getElementById("box") as HTMLInputElement).checked).catch(() => false), (v) => v, 5000) : false;
    check(t("its switch flips the store: a request in a tab gets mocked, the page's overlay follows"), before.includes("REAL") && checked && after.includes("MOCKED") && onPage, JSON.stringify({ before, checked, after, onPage }));

    await send({ type: "saveScript", id: "s_ov_prev", code: switchCode(origin, "Preview v2"), name: "overlay preview.wiretrick" });
    const v2 = await waitFor(
        async () => {
            const f = await overlayFrame(mgr, "#sw");
            return f ? await f.evaluate(() => ({ text: document.getElementById("sw")!.textContent || "", on: (document.getElementById("box") as HTMLInputElement).checked })).catch(() => null) : null;
        },
        (v) => !!v?.text.includes("Preview v2"),
        8000
    );
    check(t("it updates on save, the store kept"), !!v2?.text.includes("Preview v2") && !!v2?.on, JSON.stringify(v2));

    await page.close();
    await mgr.click("#log-header-title");
    await send({ type: "deleteScript", id: "s_ov_prev" });
}

const twoTabCode = (origin: string) => `const ps = wt.pageStore("ps", { n: 0 });

wt.replaceResponse({ url: "${origin}/ov-ps", strategy: "page" }, () => {
    try {
        ps.n++;
        return String(ps.n);
    } catch (e) {
        return "ERR: " + (e as Error).message;
    }
});

wt.onOverlay("${origin}/ov-two*", () => {
    const out = document.body.appendChild(document.createElement("output"));
    out.id = "two";
    out.value = "pending";
    const ask = () =>
        pg.whoami().then(
            (w) => (out.value = JSON.stringify({ ...w, n: ps.n })),
            (e) => (out.value = "rejected: " + e.message)
        );
    (window as any).ask = ask;
    void ask();
});

const pg = wt.onSite("${origin}/ov-two*", () => ({
    whoami: () => ({ q: location.search }),
}));
`;

/**
 * Two tabs, one overlay + onSite script: each overlay's calls reach
 * its own tab's page, and each page has its own wt.pageStore copy (a
 * reload starts over; a pushState doesn't).
 */
export async function checkPageStores(ctx: any, mgr: any, origin: string, check: Check, opts: { label?: string } = {}): Promise<void> {
    const t = (s: string) => `pageStore${opts.label ?? ""}: ${s}`;
    const send = (msg: any): Promise<any> => mgr.evaluate((m: any) => new Promise((r) => chrome.runtime.sendMessage(m, (x: any) => r(x ?? null))), msg);
    const saved = await send({ type: "saveScript", id: "s_two", code: twoTabCode(origin), name: "two tabs.wiretrick" });
    check(t("the script saves"), !saved?.error, saved?.error);
    await mgr.waitForTimeout(800);
    const open = async (q: string) => {
        const p = await ctx.newPage();
        await p.goto(`${origin}/ov-two?t=${q}`, { waitUntil: "load", timeout: 15000 });
        return p;
    };
    const a = await open("A");
    const b = await open("B");
    const hit = (p: any): Promise<string> => p.evaluate(() => fetch("/ov-ps").then((r) => r.text())).catch((e: any) => String(e));
    const asked = async (p: any, want: (v: any) => boolean) => {
        const f = await overlayFrame(p, "#two");
        if (!f) return null;
        return waitFor<any>(
            async () => {
                const v = await f.evaluate(async () => {
                    await (window as any).ask();
                    return (document.getElementById("two") as HTMLOutputElement).value;
                }).catch(() => "");
                try {
                    return JSON.parse(v);
                } catch {
                    return v;
                }
            },
            want,
            8000
        );
    };
    const counts = [await hit(a), await hit(a), await hit(b)];
    check(t("each page counts its own requests"), counts.join() === "1,2,1", counts.join());
    const wa = await asked(a, (v) => v?.n === 2);
    const wb = await asked(b, (v) => v?.n === 1);
    check(t("each tab's overlay reaches its own page (onSite + its page's store)"), wa?.q === "?t=A" && wa?.n === 2 && wb?.q === "?t=B" && wb?.n === 1, JSON.stringify({ wa, wb }));
    await a.evaluate(() => history.pushState({}, "", "/ov-two?t=A2"));
    const spa = await hit(a);
    check(t("a pushState keeps the page's copy"), spa === "3", spa);
    await a.reload({ waitUntil: "load", timeout: 15000 });
    const fresh = [await hit(a), await hit(b)];
    check(t("a reload starts the page's copy over (the other tab keeps its own)"), fresh.join() === "1,2", fresh.join());
    const wa2 = await asked(a, (v) => v?.n === 1);
    check(t("after a reload the overlay reaches the new page"), wa2?.q === "?t=A2" && wa2?.n === 1, JSON.stringify(wa2));
    await a.close();
    await b.close();
    await send({ type: "deleteScript", id: "s_two" });
}

const placeCode = (origin: string) => `const site = wt.onSite({ url: "${origin}/ov-layer*", when: "document_end" }, (ctx) => {
    document.body.dataset.siteRan = String((window as any).__site);
    return { site: () => (window as any).__site + ":" + ctx.url };
});

wt.onOverlay("${origin}/ov-layer*", async () => {
    const o = document.body.appendChild(document.createElement("output"));
    o.id = "domov";
    o.value = "frame";
    o.value = await site.site();
});

wt.onPage("${origin}/ov-layer*", async () => {
    document.body.dataset.pageSaw = typeof (window as any).__site + "|" + (await site.site());
});
`;

/**
 * The three places a page handler runs: wt.onSite (the site's own world),
 * wt.onPage (the isolated world) and wt.onOverlay (the overlay frame) — and
 * what each can reach.
 */
export async function checkPlaces(ctx: any, mgr: any, origin: string, check: Check, opts: { label?: string } = {}): Promise<void> {
    const t = (s: string) => `onSite/onPage/onOverlay${opts.label ?? ""}: ${s}`;
    const send = (msg: any): Promise<any> => mgr.evaluate((m: any) => new Promise((r) => chrome.runtime.sendMessage(m, (x: any) => r(x ?? null))), msg);
    const saved = await send({ type: "saveScript", id: "s_layer", code: placeCode(origin), name: "places.wiretrick" });
    check(t("the script saves"), !saved?.error, saved?.error);
    await mgr.waitForTimeout(800);
    const page = await ctx.newPage();
    page.on("console", (m: any) => console.log("  [ov-layer]", m.text().slice(0, 160)));
    await page.goto(`${origin}/ov-layer`, { waitUntil: "load", timeout: 15000 });
    const frame = await overlayFrame(page, "#domov");
    check(t("onOverlay renders in the overlay frame"), !!frame);
    const answer = frame ? await waitFor<string>(() => frame.evaluate(() => (document.getElementById("domov") as HTMLOutputElement).value).catch(() => ""), (v) => v !== "frame", 8000) : "";
    check(t("the overlay calls onSite code, which sees the site's globals"), answer === `SITE-7:${origin}/ov-layer`, answer);
    const siteRan = await waitFor<string>(() => page.evaluate(() => document.body.dataset.siteRan || ""), (v) => !!v, 5000);
    check(t("onSite code runs in the site's world"), siteRan === "SITE-7", siteRan);
    const pageSaw = await waitFor<string>(() => page.evaluate(() => document.body.dataset.pageSaw || ""), (v) => !!v, 8000);
    check(t("onPage code doesn't see the site's globals, but reads them through the onSite handle"), pageSaw === `undefined|SITE-7:${origin}/ov-layer`, pageSaw);
    await page.close();
    await send({ type: "deleteScript", id: "s_layer" });
}

const isoStoreCode = (origin: string) => `import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { useSnapshot } from "valtio";

const g = wt.globalStore("isog", { n: 0 }, { persist: false });
const ps = wt.pageStore("isops", { hits: 0 });

wt.replaceResponse({ url: "${origin}/ov-isops", strategy: "page" }, () => String(++ps.hits));

wt.onOverlay("${origin}/ov-isost*", () => {
    const out = document.body.appendChild(document.createElement("output"));
    out.id = "isost-ov";
    out.value = "overlay";
    (window as any).readG = () => g.n;
    (window as any).bump = () => ++g.n;
});

const site = wt.onSite("${origin}/ov-isost*", (ctx) => {
    (window as any).__isoSecret = "PAGE-GLOBAL-42";
    try {
        document.documentElement.dataset.mainStore = "read " + ps.hits;
    } catch (e) {
        document.documentElement.dataset.mainStore = (e as Error).message;
    }
    const pings: string[] = [], waiting: ((v: string) => void)[] = [];
    addEventListener("wt-e2e-ping", (e: any) => {
        const v = e.detail + ":" + (window as any).__isoSecret;
        (waiting.shift() ?? ((v: string) => pings.push(v)))(v);
    }, { signal: ctx.signal });
    return {
        read: (k: string) => new Promise((r) => {
            const t0 = Date.now();
            const poll = () => ((window as any)[k] || Date.now() - t0 > 2000 ? r((window as any)[k] + "|" + location.pathname) : setTimeout(poll, 20));
            poll();
        }),
        nextPing: () => (pings.length ? Promise.resolve(pings.shift()!) : new Promise<string>((r) => waiting.push(r))),
    };
});

wt.onPage("${origin}/ov-isost*", async (ctx) => {
    document.body.dataset.isoGlobal = String(typeof (window as any).__isoSecret);
    document.body.dataset.evaluated = await site.read("__isoSecret").then(String, (e) => "rejected: " + e.message);
    document.body.dataset.subscribed = "1";
    for await (const v of ctx.each(site.nextPing)) document.body.dataset.pinged = v + ":" + typeof (window as any).__isoSecret + ":" + g.n;
})

wt.onPage("${origin}/ov-isost*", () => {
    const Hits = () => createElement("b", null, "react:" + useSnapshot(ps).hits);
    createRoot(document.body.appendChild(document.createElement("div"))).render(createElement(Hits));
    const out = document.body.appendChild(document.createElement("output"));
    out.id = "isost";
    const show = () => (out.value = JSON.stringify({ g: g.n, ps: ps.hits }));
    show();
    setInterval(show, 50);
    const add = document.body.appendChild(document.createElement("button"));
    add.id = "isost-add";
    add.onclick = () => {
        g.n += 10;
        ps.hits += 100;
    };
});
`;

/**
 * Stores in isolated-world onPage code: primed, live both ways with the
 * overlay and the background, this page's wt.pageStore copy only; onSite
 * code can't use them, and onPage code reads the site through an onSite
 * handle (promise-returning functions, and a ctx.each loop).
 */
export async function checkIsoStores(ctx: any, mgr: any, origin: string, check: Check, opts: { label?: string } = {}): Promise<void> {
    const t = (s: string) => `isolated stores${opts.label ?? ""}: ${s}`;
    const send = (msg: any): Promise<any> => mgr.evaluate((m: any) => new Promise((r) => chrome.runtime.sendMessage(m, (x: any) => r(x ?? null))), msg);
    const saved = await send({ type: "saveScript", id: "s_isost", code: isoStoreCode(origin), name: "iso stores.wiretrick" });
    check(t("the script saves"), !saved?.error, saved?.error);
    const warns = await waitFor<string[]>(async () => ((await send({ type: "listScripts" })) || []).find((s: any) => s.id === "s_isost")?.routeWarnings ?? [], (w) => w.length > 0, 5000);
    check(t("Problems flags the store use in onSite code"), warns.some((w) => w.includes("uses `ps`") && w.includes("aren't available in onSite code")), JSON.stringify(warns));
    await mgr.waitForTimeout(800);
    const open = async (q: string) => {
        const p = await ctx.newPage();
        await p.goto(`${origin}/ov-isost?t=${q}`, { waitUntil: "load", timeout: 15000 });
        return p;
    };
    const read = (p: any) => p.evaluate(() => JSON.parse((document.getElementById("isost") as HTMLOutputElement | null)?.value || "null")).catch(() => null);
    const until = (p: any, ok: (v: any) => boolean) => waitFor<any>(() => read(p), (v) => !!v && ok(v), 8000);
    const hit = (p: any): Promise<string> => p.evaluate(() => fetch("/ov-isops").then((r) => r.text())).catch((e: any) => String(e));

    const a = await open("A");
    const v0 = await until(a, () => true);
    check(t("isolated code reads its stores (primed)"), v0?.ps === 0 && typeof v0?.g === "number", JSON.stringify(v0));
    const g0 = v0?.g ?? 0;
    const mainErr = await waitFor<string>(() => a.evaluate(() => document.documentElement.dataset.mainStore || ""), (v) => !!v, 8000);
    check(t("onSite code can't use them, and is told to use them in wt.onPage"), mainErr.includes("aren't available in onSite code") && mainErr.includes("use them in wt.onPage"), mainErr);
    const evaluated = await waitFor<string>(() => a.evaluate(() => document.body.dataset.evaluated || ""), (v) => !!v, 8000);
    const isoGlobal = await a.evaluate(() => document.body.dataset.isoGlobal || "");
    check(t("onPage code is isolated: no page globals; an onSite handle reads them (promise-returning)"), isoGlobal === "undefined" && evaluated === "PAGE-GLOBAL-42|/ov-isost", JSON.stringify({ isoGlobal, evaluated }));
    await waitFor<string>(() => a.evaluate(() => document.body.dataset.subscribed || ""), (v) => !!v, 8000);
    await a.evaluate(() => dispatchEvent(new CustomEvent("wt-e2e-ping", { detail: "hi" })));
    const pinged = await waitFor<string>(() => a.evaluate(() => document.body.dataset.pinged || ""), (v) => !!v, 8000);
    check(t("ctx.each over an onSite function: a page event reaches isolated code (page global there, store here)"), pinged === `hi:PAGE-GLOBAL-42:undefined:${g0}`, pinged);
    const first = await hit(a);
    const v1 = await until(a, (v) => v.ps === 1);
    const reactText = await waitFor<string>(() => a.evaluate(() => [...document.querySelectorAll("b")].map((b) => b.textContent).join()), (v) => v === "react:1", 8000);
    check(t("isolated code renders with the built-in React and valtio (live)"), reactText === "react:1", reactText);
    check(t("a background handler's write to the page's copy shows up live"), first === "1" && v1?.ps === 1, JSON.stringify({ first, v1 }));
    await a.evaluate(() => (document.getElementById("isost-add") as HTMLButtonElement).click());
    const f = await overlayFrame(a, "#isost-ov");
    const seenByOverlay = f ? await waitFor<any>(() => f.evaluate(() => (window as any).readG()).catch(() => null), (n) => n === g0 + 10, 8000) : null;
    const next = await hit(a);
    check(t("isolated code's writes reach the overlay and the background"), seenByOverlay === g0 + 10 && next === "102", JSON.stringify({ seenByOverlay, next }));
    await f?.evaluate(() => (window as any).bump()).catch(() => null);
    const v2 = await until(a, (v) => v.g === g0 + 11);
    check(t("the overlay's writes show up live"), v2?.g === g0 + 11, JSON.stringify(v2));
    const b = await open("B");
    const vb = await until(b, () => true);
    check(t("another tab: the same global store, its own page copy"), vb?.g === g0 + 11 && vb?.ps === 0, JSON.stringify(vb));
    await a.reload({ waitUntil: "load", timeout: 15000 });
    const va = await until(a, () => true);
    check(t("a reload starts the page's copy over"), va?.ps === 0 && va?.g === g0 + 11, JSON.stringify(va));
    await a.close();
    await b.close();
    await send({ type: "deleteScript", id: "s_isost" });
}

const siteHandlesCode = (origin: string) => `const g = wt.globalStore("unsg", { n: 0 }, { persist: false });

const overlay = wt.onOverlay("${origin}/ov-unsafe*", () => {
    const out = document.body.appendChild(document.createElement("output"));
    out.id = "uns-ov";
    (window as any).bump = () => ++g.n;
    (window as any).askSite = async () => {
        const where = await site.where();
        const later = await site.later(30);
        const boom = await site.boom().then((v) => "resolved " + v, (e) => (e as Error).message);
        return JSON.stringify({ where, later, boom });
    };
    return { greet: (who: string) => "hi " + who + " " + g.n };
});

const site = wt.onSite("${origin}/ov-unsafe*", () => {
    (window as any).__unsafeSite = "SITE-UNS";
    try {
        void overlay.greet("site");
        document.documentElement.dataset.siteCall = "called";
    } catch (e) {
        document.documentElement.dataset.siteCall = (e as Error).name + ": " + (e as Error).message;
    }
    return {
        where: () => (window as any).__unsafeSite + ":" + location.pathname,
        later: (ms: number) => new Promise<string>((r) => setTimeout(() => r("later:" + ms), ms)),
        boom: (): string => {
            throw new Error("site boom");
        },
    };
});

wt.onPage("${origin}/ov-unsafe*", (ctx) => {
    addEventListener("wt-uns-call", async () => {
        const where = await site.where();
        const greet = await overlay.greet("page").catch((e) => "rejected: " + e.message);
        document.body.dataset.fromPage = JSON.stringify({ where, greet });
    }, { signal: ctx.signal });
});
`;

/**
 * onSite handles: the overlay and onPage code call onSite functions (plain,
 * promise-returning, throwing); onSite code can't call any handle, and the
 * page can't reach the script's stores by forging the hook's messages.
 */
export async function checkSiteHandles(ctx: any, mgr: any, origin: string, check: Check, opts: { label?: string } = {}): Promise<void> {
    const t = (s: string) => `onSite handles${opts.label ?? ""}: ${s}`;
    const send = (msg: any): Promise<any> => mgr.evaluate((m: any) => new Promise((r) => chrome.runtime.sendMessage(m, (x: any) => r(x ?? null))), msg);
    const saved = await send({ type: "saveScript", id: "s_uns", code: siteHandlesCode(origin), name: "site handles.wiretrick" });
    check(t("the script saves"), !saved?.error, saved?.error);
    const warns = await waitFor<string[]>(async () => ((await send({ type: "listScripts" })) || []).find((s: any) => s.id === "s_uns")?.routeWarnings ?? [], (w) => w.length > 0, 5000);
    check(t("Problems flags the handle call in onSite code"), warns.some((w) => w.includes("uses `overlay`") && w.includes("onSite code can't call handles")), JSON.stringify(warns));
    await mgr.waitForTimeout(800);
    const a = await ctx.newPage();
    await a.goto(`${origin}/ov-unsafe?t=A`, { waitUntil: "load", timeout: 15000 });
    const siteCall = await waitFor<string>(() => a.evaluate(() => document.documentElement.dataset.siteCall || ""), (v) => !!v, 8000);
    check(t("a handle call in onSite code throws SiteCannotCallError"), siteCall.startsWith("SiteCannotCallError: onSite code can't call handles"), siteCall);
    const f = await overlayFrame(a, "#uns-ov");
    const asked = f ? await f.evaluate(() => (window as any).askSite()).catch((e: any) => "rejected: " + e) : "";
    check(
        t("the overlay calls onSite functions: plain, promise-returning (awaited) and throwing (rejects with its message)"),
        asked === JSON.stringify({ where: "SITE-UNS:/ov-unsafe", later: "later:30", boom: "site boom" }),
        asked
    );
    const g0 = f ? await f.evaluate(() => (window as any).bump()).catch(() => null) : null;
    await a.evaluate(() => dispatchEvent(new CustomEvent("wt-uns-call")));
    const fromPage = await waitFor<string>(() => a.evaluate(() => document.body.dataset.fromPage || ""), (v) => !!v, 8000);
    check(t("onPage code calls onSite functions and the overlay"), fromPage === JSON.stringify({ where: "SITE-UNS:/ov-unsafe", greet: `hi page ${g0}` }), fromPage);
    // the page forges the hook's link: page-world messages never reach trusted code
    const forged = await a.evaluate(
        () =>
            new Promise<string>((r) => {
                const id = 987654321;
                addEventListener("message", (e) => {
                    const d = e.data;
                    if (d?.source !== "res-override-bridge" || d.kind !== "wire") return;
                    for (const m of Array.isArray(d.msg) ? d.msg : [d.msg]) if (m?.t === "res" && m.id === id) r(m.ok ? "granted" : m.e.message);
                });
                postMessage({ source: "res-override-hook", kind: "wire", msg: { v: 1, t: "req", id, op: "store.sub", s: "s_uns", a: { name: "unsg" } } }, location.origin);
                setTimeout(() => r("no answer"), 2000);
            })
    );
    check(t("a forged store op from the page goes unanswered"), forged === "no answer", forged);
    await a.close();
    await send({ type: "deleteScript", id: "s_uns" });
}

const siteStoreCode = (origin: string, v: number) => `import { subscribe } from "valtio";
import { useSnapshot } from "valtio";

// v${v}
const ss = wt.siteStore("ss", { n: 0, on: false });

wt.onSite("${origin}/ov-site*", () => {
    (window as any).__ss = { read: () => JSON.stringify({ n: ss.n, on: ss.on }), bump: () => ++ss.n };
});

wt.onPage("${origin}/ov-site*", (ctx) => {
    const show = () => (document.body.dataset.ssPage = String(ss.n));
    show();
    ctx.signal.addEventListener("abort", subscribe(ss, show));
});

wt.onOverlay("${origin}/ov-site*", (ctx) => {
    (window as any).toggleSS = () => (ss.on = !ss.on);
    function N() {
        const snap = useSnapshot(ss);
        return <b id="ss-n">{snap.n}</b>;
    }
    ctx.mount(<N />);
});
`;

/**
 * wt.siteStore: onSite code's writes re-render the overlay and reach onPage
 * code; the overlay's write is read synchronously in the site's world; ten
 * saves keep the values and one subscription per mirror; a forged message
 * for an unknown subscription changes nothing.
 */
export async function checkSiteStores(ctx: any, mgr: any, origin: string, check: Check, opts: { label?: string } = {}): Promise<void> {
    const t = (s: string) => `site stores${opts.label ?? ""}: ${s}`;
    const send = (msg: any): Promise<any> => mgr.evaluate((m: any) => new Promise((r) => chrome.runtime.sendMessage(m, (x: any) => r(x ?? null))), msg);
    const saved = await send({ type: "saveScript", id: "s_site", code: siteStoreCode(origin, 0), name: "site stores.wiretrick" });
    check(t("the script saves"), !saved?.error, saved?.error);
    await mgr.waitForTimeout(800);
    const warns = ((await send({ type: "listScripts" })) || []).find((s: any) => s.id === "s_site")?.routeWarnings ?? [];
    check(t("no Problems"), !warns.length, JSON.stringify(warns));
    const a = await ctx.newPage();
    await a.goto(`${origin}/ov-site`, { waitUntil: "load", timeout: 15000 });
    const siteRead = (): Promise<any> => a.evaluate(() => JSON.parse((window as any).__ss?.read() ?? "null")).catch(() => null);
    await waitFor(siteRead, (v) => !!v, 8000);
    const f = await overlayFrame(a, "#ss-n");
    const shown = (): Promise<string> => f?.evaluate(() => document.getElementById("ss-n")?.textContent ?? "").catch(() => "") ?? Promise.resolve("");
    const onPage = (): Promise<string> => a.evaluate(() => document.body.dataset.ssPage ?? "");
    await a.evaluate(() => (window as any).__ss.bump());
    await a.evaluate(() => (window as any).__ss.bump());
    const n2 = await waitFor(shown, (v) => v === "2", 8000);
    const p2 = await waitFor(onPage, (v) => v === "2", 8000);
    check(t("onSite code's writes re-render the overlay and reach onPage code"), n2 === "2" && p2 === "2", JSON.stringify({ n2, p2 }));
    await f?.evaluate(() => (window as any).toggleSS());
    const on = await waitFor(siteRead, (v) => v?.on === true, 8000);
    check(t("the overlay's write is read synchronously in the site's world"), on?.on === true && on?.n === 2, JSON.stringify(on));
    for (let v = 1; v <= 10; v++) {
        const r = await send({ type: "saveScript", id: "s_site", code: siteStoreCode(origin, v), name: "site stores.wiretrick" });
        if (r?.error) check(t(`save ${v}`), false, r.error);
        await mgr.waitForTimeout(150);
    }
    await mgr.waitForTimeout(1200);
    // the page sees every answer the site's world sends: count the subscriptions one write reaches
    const subs = await a.evaluate(
        () =>
            new Promise<string[]>((r) => {
                const seen = new Set<string>();
                addEventListener("message", (e) => {
                    if (e.data?.source === "res-override-hook" && e.data.kind === "site.ops") seen.add(e.data.sub);
                });
                (window as any).__ss.bump();
                setTimeout(() => r([...seen]), 1500);
            })
    );
    const after = await siteRead();
    const n3 = await waitFor(shown, (v) => v === "3", 8000);
    const p3 = await waitFor(onPage, (v) => v === "3", 8000);
    check(t("ten saves keep the values and one subscription per mirror (overlay, onPage)"), after?.n === 3 && after?.on === true && n3 === "3" && p3 === "3" && subs.length === 2, JSON.stringify({ after, n3, p3, subs }));
    await a.evaluate(() => {
        postMessage({ source: "res-override-hook", kind: "site.snapshot", sub: "forged.1", value: { n: 999, on: false } }, location.origin);
        postMessage({ source: "res-override-hook", kind: "site.ops", sub: "forged.1", ops: [["set", ["n"], 999]], acks: [] }, location.origin);
    });
    await mgr.waitForTimeout(800);
    const still = { overlay: await shown(), page: await onPage() };
    check(t("a forged message for an unknown subscription changes no mirror"), still.overlay === "3" && still.page === "3", JSON.stringify(still));
    await a.close();
    await send({ type: "deleteScript", id: "s_site" });
}

const lifeCode = (origin: string, v: string, red: number, boom = false) => `const site = wt.onSite("${origin}/ov-life*", (ctx) => {
    if (${boom}) throw new Error("site boom ${v}");
    document.documentElement.dataset.siteVersion = "${v}";
    const queue: string[] = [], waiting: ((x: string) => void)[] = [];
    addEventListener("life-tick", (e: any) => {
        const val = "${v}:" + e.detail;
        // every waiter: a reloaded caller's abandoned call may still be waiting
        const ws = waiting.splice(0);
        if (ws.length) ws.forEach((w) => w(val));
        else queue.push(val);
    }, { signal: ctx.signal });
    return {
        next: () => (queue.length ? Promise.resolve(queue.shift()!) : new Promise<string>((r) => waiting.push(r))),
        version: () => "${v}",
    };
});

wt.onPage("${origin}/ov-life*", (ctx) => {
    if (${boom}) throw new Error("page boom ${v}");
    const d = document.documentElement.dataset;
    const w = window as any;
    const api = w.__lifeApi || (w.__lifeApi = { greet: (x: string) => "orig:" + x });
    ctx.patch(api, "greet", (orig: (x: string) => string) => (x: string) => {
        d.patchCalls = String(Number(d.patchCalls || 0) + 1);
        return "${v}:" + orig(x);
    });
    document.addEventListener("life-call", () => (d.greeted = api.greet("a")), { signal: ctx.signal });
    ctx.style(".life-color { color: rgb(${red}, 0, 0) }");
    ctx.mount(<b>mount ${v}</b>);
});

wt.onPage("${origin}/ov-life*", async (ctx) => {
    const d = document.documentElement.dataset;
    d.loopVersion = "${v}";
    d.siteAnswer = "${v}>" + (await site.version());
    for await (const val of ctx.each(site.next)) d.lifeLog = (d.lifeLog || "") + "|${v}<" + val + ">";
});
`;

/** the text inside each <wiretrick-mount> host (closed shadow roots included: read over CDP) */
async function mountTexts(page: any): Promise<string[]> {
    const cdp = await page.context().newCDPSession(page);
    try {
        const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
        const kids = (n: any): any[] => [...(n.shadowRoots || []), ...(n.children || [])];
        const text = (n: any): string => (n.nodeName === "STYLE" || n.nodeName === "SCRIPT" ? "" : n.nodeType === 3 ? n.nodeValue : kids(n).map(text).join(""));
        const out: string[] = [];
        const walk = (n: any): void => {
            if (String(n.nodeName).toUpperCase() === "WIRETRICK-MOUNT") out.push(text(n));
            else kids(n).forEach(walk);
        };
        walk(root);
        return out;
    } finally {
        await cdp.detach().catch(() => {});
    }
}

/**
 * Hot apply on a page: saving re-runs a script's handlers in place —
 * ctx.mount / ctx.style / ctx.patch don't pile up, an onSite promise loop
 * (ctx.each) carries on with the new run, and a handler that throws on
 * save keeps its old run.
 */
export async function checkHotReload(ctx: any, mgr: any, origin: string, check: Check, opts: { label?: string } = {}): Promise<void> {
    const t = (s: string) => `hot apply${opts.label ?? ""}: ${s}`;
    const send = (msg: any): Promise<any> => mgr.evaluate((m: any) => new Promise((r) => chrome.runtime.sendMessage(m, (x: any) => r(x ?? null))), msg);
    const save = (v: string, red: number, boom = false) => send({ type: "saveScript", id: "s_life", code: lifeCode(origin, v, red, boom), name: "life.wiretrick" });
    const saved = await save("v1", 10);
    check(t("the script saves"), !saved?.error, saved?.error);
    await mgr.waitForTimeout(800);
    const page = await ctx.newPage();
    page.on("console", (m: any) => console.log("  [ov-life]", m.text().slice(0, 160)));
    await page.goto(`${origin}/ov-life`, { waitUntil: "load", timeout: 15000 });
    const data = (): Promise<Record<string, string>> => page.evaluate(() => ({ ...document.documentElement.dataset }) as Record<string, string>).catch(() => ({}));
    const ready = (v: string, site = v) => waitFor(data, (d) => d.siteAnswer === `${v}>${site}`, 8000);
    const tick = (x: string) => page.evaluate((detail: string) => dispatchEvent(new CustomEvent("life-tick", { detail })), x);
    const logIs = (want: string) => waitFor(data, (d) => d.lifeLog === want, 5000).then((d) => d.lifeLog ?? "");
    const state = async () => ({
        mounts: await mountTexts(page),
        styles: await page.evaluate(() => [...document.head.querySelectorAll("style")].filter((s) => s.textContent!.includes("life-color")).length),
        color: await page.evaluate(() => getComputedStyle(document.getElementById("lifec")!).color),
    });
    const call = async () => {
        const before = Number((await data()).patchCalls || 0);
        await page.evaluate(() => {
            delete document.documentElement.dataset.greeted;
            document.dispatchEvent(new CustomEvent("life-call"));
        });
        const d = await waitFor(data, (d) => !!d.greeted, 5000);
        await page.waitForTimeout(200);
        return { greeted: d.greeted, calls: Number((await data()).patchCalls || 0) - before };
    };

    await ready("v1");
    await tick("a");
    const log1 = await logIs("|v1<v1:a>");
    check(t("an onPage loop over an onSite function (ctx.each) gets the site's values"), log1 === "|v1<v1:a>", log1);

    await save("v2", 20);
    await ready("v2");
    await save("v3", 30);
    await ready("v3");
    await page.waitForTimeout(500);
    const s3 = await waitFor(state, (s) => s.mounts.length === 1 && s.mounts[0] === "mount v3" && s.styles === 1, 5000);
    check(t("after two saves: one ctx.mount host, showing the newest run's UI"), s3.mounts.length === 1 && s3.mounts[0] === "mount v3", JSON.stringify(s3.mounts));
    check(t("after two saves: one ctx.style element, the newest css applied"), s3.styles === 1 && s3.color === "rgb(30, 0, 0)", JSON.stringify(s3));
    const c3 = await call();
    check(t("after two saves: ctx.patch wraps once (one call each), with the newest wrapper"), c3.greeted === "v3:orig:a" && c3.calls === 1, JSON.stringify(c3));
    await tick("b");
    await logIs("|v1<v1:a>|v3<v3:b>");
    await tick("c");
    const log3 = await logIs("|v1<v1:a>|v3<v3:b>|v3<v3:c>");
    check(t("the onSite promise loop survives the saves: later values reach the new run, each once"), log3 === "|v1<v1:a>|v3<v3:b>|v3<v3:c>", log3);

    const boom = await save("v4", 40, true);
    check(t("a script whose handlers throw still saves"), !boom?.error, boom?.error);
    const d4 = await ready("v4", "v3");
    check(t("an onSite handler that throws on save keeps its old run: its handle still answers"), d4.siteAnswer === "v4>v3" && d4.siteVersion === "v3", JSON.stringify(d4));
    await page.waitForTimeout(500);
    const s4 = await state();
    check(
        t("an onPage handler that throws on save keeps its old run: its mount and style stay"),
        s4.mounts.length === 1 && s4.mounts[0] === "mount v3" && s4.styles === 1 && s4.color === "rgb(30, 0, 0)",
        JSON.stringify(s4)
    );
    const c4 = await call();
    check(t("…and its patch and listener stay"), c4.greeted === "v3:orig:a" && c4.calls === 1, JSON.stringify(c4));
    await tick("d");
    const log4 = await logIs("|v1<v1:a>|v3<v3:b>|v3<v3:c>|v4<v3:d>");
    check(t("the new onPage loop reads the kept onSite run"), log4 === "|v1<v1:a>|v3<v3:b>|v3<v3:c>|v4<v3:d>", log4);

    await send({ type: "deleteScript", id: "s_life" });
    const gone = await waitFor(state, (s) => !s.mounts.length && !s.styles, 5000);
    check(t("deleting the script removes its mount and style"), !gone.mounts.length && !gone.styles, JSON.stringify(gone));
    await page.close();
}

/**
 * The page's first requests — fetch and XHR from an inline script while
 * the HTML still parses, and a fetch the moment `load` fires — reach a
 * page-strategy handler: the hook holds them until it knows the page's
 * scripts instead of letting them through unmodified.
 */
export async function checkEarlyRequests(ctx: any, mgr: any, origin: string, check: Check, opts: { label?: string } = {}): Promise<void> {
    const t = (s: string) => `early requests${opts.label ?? ""}: ${s}`;
    const send = (msg: any): Promise<any> => mgr.evaluate((m: any) => new Promise((r) => chrome.runtime.sendMessage(m, (x: any) => r(x ?? null))), msg);
    const code = `wt.replaceResponse({ url: "${origin}/early-data*", strategy: "page" }, (ctx) => "MOD:" + new URL(ctx.url).searchParams.get("via"));\n`;
    const saved = await send({ type: "saveScript", id: "s_early", code, name: "early.wiretrick" });
    check(t("the script saves"), !saved?.error, saved?.error);
    await mgr.waitForTimeout(800);
    const p = await ctx.newPage();
    const seen = async () => {
        const atLoad = await p.evaluate(() => fetch("/early-data?via=load").then((r) => r.text())).catch((e: any) => String(e));
        const parse = await waitFor<any>(() => p.evaluate(() => (window as any).__early), (v) => v?.fetch && v?.xhr, 8000);
        return { ...parse, load: atLoad };
    };
    const want = (v: any) => v?.fetch === "MOD:fetch" && v?.xhr === "MOD:xhr" && v?.load === "MOD:load";
    await p.goto(`${origin}/early`, { waitUntil: "load", timeout: 15000 });
    const first = await seen();
    check(t("a fresh page's first fetch/XHR (while parsing, and at load) are handled"), want(first), JSON.stringify(first));
    await p.reload({ waitUntil: "load", timeout: 15000 });
    const again = await seen();
    check(t("after a reload too"), want(again), JSON.stringify(again));
    cspReports = 0;
    await p.goto(`${origin}/early?csp`, { waitUntil: "load", timeout: 15000 });
    const strict = await seen();
    await p.waitForTimeout(500);
    check(t("on a page whose CSP forbids inline scripts — without a CSP violation report"), want(strict) && cspReports === 0, JSON.stringify({ ...strict, cspReports }));
    await p.close();
    await send({ type: "deleteScript", id: "s_early" });
}
