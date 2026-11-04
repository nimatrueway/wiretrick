/**
 * Shared E2E check (MV2 + MV3): overlays (wt.onOverlay). A `.tsx` switch
 * with the built-in React and valtio toggles a page-strategy mock live;
 * clicks on empty areas reach the page; a strict-CSP page still shows the
 * overlay; the page can't find the frame or read the overlay's code; the
 * overlay's `fetch` carries the page's cookies; in-place navigation reaches
 * `ctx.onNavigate`; a page-posted call never reaches an overlay; main-world
 * `overlay.fn()` rejects; on save the overlay reloads with its store kept;
 * disabling removes it. With `isolated` (the MV2 builds): an Alt+click in
 * isolated onPage code calls the overlay, which calls back to highlight.
 * With `userScripts` (MV3): while user scripts are off, isolated handlers
 * don't run, the overlay's calls into them reject with the hint, and the
 * Problems error and the Editor's banner say how to turn them on; then
 * `grant()` turns them on and the same round trip runs through them.
 *
 * `overlayServerRoute` serves the pages; call it in the suite's test server.
 */
import type http from "node:http";

type Check = (name: string, ok: boolean, extra?: string) => void;

const hits: string[] = [];
let lastCookie = "";

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

const switchCode = (origin: string, label: string) => `import { createRoot } from "react-dom/client";
import { useSnapshot } from "valtio";

const mock = wt.store("ovmock", { enabled: false });

wt.replaceResponse({ url: "${origin}/ov-me", strategy: "page" }, () =>
    mock.enabled ? JSON.stringify({ name: "MOCKED" }) : undefined);

wt.onOverlay("${origin}/ov-*", () => {
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
    createRoot(document.body.appendChild(document.createElement("div"))).render(<Panel />);
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

wt.onPage("${origin}/ov-app*", () => {
    overlay.hit().then(() => (document.body.dataset.mainCall = "resolved"), (e) => (document.body.dataset.mainCall = "rejected: " + e.message));
});

const iso = wt.onPage({ url: "${origin}/ov-*", world: "isolated" }, () => {
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

    const sw = await save("s_ov_switch", switchCode(origin, "Mock /api/me"), "overlay switch");
    const rpc = await save("s_ov_rpc", rpcCode(origin), "overlay rpc");
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

    const mainCall = await waitFor<string>(() => page.evaluate(() => document.body.dataset.mainCall || ""), (v) => !!v, 5000);
    check(t("main-world overlay.fn() rejects"), /^rejected: .*main-world onPage code can't call the overlay/.test(mainCall), mainCall);
    const mainProblem = await waitFor<any>(async () => ((await send({ type: "listScripts" })) || []).find((s: any) => s.id === "s_ov_rpc")?.runtimeError, (e) => !!e?.ctx, 5000);
    check(
        t("main-world overlay.fn() is a Problems error tagged page › host"),
        !!mainProblem?.message.includes("main-world onPage code can't call the overlay") && mainProblem.ctx === `page › ${new URL(origin).host}`,
        JSON.stringify(mainProblem)
    );

    await page.evaluate((s: string) => {
        const call = { cid: "page-forged-1", h: "overlay:0", fn: "hit", args: [] };
        for (const source of ["res-override-hook", "res-override-bridge"]) {
            window.postMessage({ source, kind: "rpc.call", s, call }, "*");
            window.postMessage({ source, kind: "rpc.call", scriptId: s, call, ...call }, "*");
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
            warnings.some((w) => w.includes(`world: "isolated" code doesn't run: user scripts are off`) && /chrome:\/\/extensions\/\?id=[a-p]{32}/.test(w)),
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

    // save: the overlay reloads with the new code; the store keeps its value
    await save("s_ov_switch", switchCode(origin, "Mock v2"), "overlay switch");
    const v2 = await waitFor(
        async () => {
            const f = await overlayFrame(page, "#sw");
            return f ? await f.evaluate(() => ({ text: document.getElementById("sw")!.textContent || "", on: (document.getElementById("box") as HTMLInputElement).checked })).catch(() => null) : null;
        },
        (v) => !!v?.text.includes("Mock v2"),
        8000
    );
    check(t("on save the overlay reloads and its store survives"), !!v2?.text.includes("Mock v2") && !!v2?.on, JSON.stringify(v2));

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
    const a = await send({ type: "saveScript", id: "s_ov_keys", code: keysCode(origin, "kbox"), name: "keys first" });
    await mgr.waitForTimeout(300);
    const b = await send({ type: "saveScript", id: "s_ov_keys2", code: keysCode(origin, "kbox2"), name: "keys second" });
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
        lines.some((l) => l.includes("[keys second]") && l.includes("Alt+Shift+H") && l.includes('"keys first" (earlier in the list) uses these keys too')),
        lines.filter((l) => l.includes("keys")).join(" | ").slice(0, 300)
    );

    await page.close();
    await send({ type: "deleteScript", id: "s_ov_keys" });
    await send({ type: "deleteScript", id: "s_ov_keys2" });
}
