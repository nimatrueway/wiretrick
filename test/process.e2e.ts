/**
 * Process-strategy e2e (MV3 bundle + the real wiretrick-helper):
 *   - the helper is installed for a throwaway profile (NativeMessagingHosts
 *     under the user-data-dir) with an isolated HOME (CA + NSS db)
 *   - the user's own proxy (system mode → http_proxy/https_proxy env) is a
 *     counting forward proxy: non-routed traffic AND the helper's upstream
 *     hop must both go through it
 *   - process-owned scripts handle documents, browser-initiated script
 *     loads, redirects, mocks, response headers, and real HTTPS (MITM with
 *     the helper's CA, trusted in the temp NSS db) — no debugger attached
 *
 * Usage: npm run build && npm run build:helper && npx tsx test/process.e2e.ts
 * (Linux: needs certutil from nss tools; E2E_CHROMIUM=/usr/bin/chromium)
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir, networkInterfaces } from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { chromium } from "playwright-core";
import { resolveBrowser } from "./browserSetup";

const ROOT = path.join(new URL("..", import.meta.url).pathname);
const EXT_ROOT = path.join(ROOT, "dist-mv3");
const HELPER = path.join(ROOT, "helper/target/release", process.platform === "win32" ? "wiretrick-helper.exe" : "wiretrick-helper");
const EXT_ID = crypto.createHash("sha256").update(EXT_ROOT, "utf8").digest("hex").split("").map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join("").slice(0, 32);

if (!existsSync(HELPER)) {
    console.log("FAIL  helper not built — run npm run build:helper");
    process.exit(1);
}

// a non-loopback address: Chrome never proxies loopback, so the local
// origin must be reachable on a LAN address to be routed through the PAC
const LAN = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === "IPv4" && !i.internal)?.address;

// ---- origin server ----
const PORT = 8931;
const ORIGIN = `http://${LAN}:${PORT}`;
const seen: string[] = [];
const server = http.createServer((req, res) => {
    seen.push(req.url || "");
    if (req.url === "/doc") {
        res.writeHead(200, { "content-type": "text/html", "cache-control": "max-age=3600" });
        return res.end(`<html><head><title>ORIGINAL</title></head><body><script src="/app.js"></script></body></html>`);
    }
    if (req.url === "/app.js") {
        res.writeHead(200, { "content-type": "text/javascript" });
        return res.end(`window.__marker = "ORIGINAL";`);
    }
    if (req.url === "/target") {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(`<title>TARGET</title>`);
    }
    if (req.url?.split("?")[0] === "/plain") {
        res.writeHead(200, { "content-type": "text/plain" });
        return res.end(`untouched`);
    }
    res.writeHead(404);
    res.end();
});
await new Promise<void>((r) => server.listen(PORT, "0.0.0.0", r));
// same handler on a second port: not routed (latency baseline)
const PORT_B = PORT + 1;
const serverB = http.createServer((req, res) => server.emit("request", req, res));
await new Promise<void>((r) => serverB.listen(PORT_B, "0.0.0.0", r));

// ---- the user's proxy: counting forward proxy (HTTP + CONNECT) ----
const viaUser: string[] = [];
const userProxy = http.createServer((req, res) => {
    viaUser.push(`GET ${req.url}`);
    const u = new URL(req.url!);
    const up = http.request({ host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: req.method, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode || 502, r.headers);
        r.pipe(res);
    });
    up.on("error", () => res.destroy());
    req.pipe(up);
});
userProxy.on("connect", (req, sock: net.Socket, head) => {
    viaUser.push(`CONNECT ${req.url}`);
    const [h, p] = (req.url || "").split(":");
    const up = net.connect(Number(p) || 443, h, () => {
        sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        up.write(head);
        up.pipe(sock);
        sock.pipe(up);
    });
    up.on("error", () => sock.destroy());
    sock.on("error", () => up.destroy());
});
await new Promise<void>((r) => userProxy.listen(0, "127.0.0.1", r));
const PROXY = `http://127.0.0.1:${(userProxy.address() as net.AddressInfo).port}`;

// ---- isolated HOME: helper state, NSS db, native host manifest ----
const home = mkdtempSync(path.join(tmpdir(), "reso-proc-home-"));
const profile = path.join(home, "profile");
mkdirSync(profile);
const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), http_proxy: PROXY, https_proxy: PROXY, no_proxy: "" };
for (const k of Object.keys(env)) if (/^(XDG_CURRENT_DESKTOP|DESKTOP_SESSION|GNOME_|KDE_|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|ALL_PROXY|all_proxy)/.test(k)) delete env[k];
const nssdb = path.join(home, ".pki/nssdb");
mkdirSync(nssdb, { recursive: true });
spawnSync("certutil", ["-N", "--empty-password", "-d", `sql:${nssdb}`], { env, stdio: "inherit" });
const inst = spawnSync(HELPER, ["install", "--extension-id", EXT_ID, "--user-data-dir", profile, "--trust-ca", "--nssdb", nssdb], { env, encoding: "utf8" });
console.log(inst.stdout.trim(), inst.stderr.trim());

let failed = 0;
const check = (name: string, ok: boolean, extra = ""): void => {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
};
check("helper install succeeded", inst.status === 0);

const proc = spawn(await resolveBrowser(), ["--headless=new", `--user-data-dir=${profile}`, `--load-extension=${EXT_ROOT}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore", env });
await new Promise((r) => setTimeout(r, 5000));
const watchdog = setTimeout(() => {
    console.log("FAIL  global watchdog timeout");
    process.exit(1);
}, 150000);

let browser: any;
try {
    const [port] = readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n");
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 90000 });
    const ctx = browser.contexts()[0];
    const mgr = await ctx.newPage();
    await mgr.goto(`chrome-extension://${EXT_ID}/editor.html`);
    const send = (msg: any) => mgr.evaluate((m: any) => new Promise<any>((r) => chrome.runtime.sendMessage(m, r)), msg);

    const st0 = await send({ type: "processStatus" });
    check("helper idle without process scripts", st0.state === "idle", st0.state);

    await send({
        type: "saveScript",
        id: "p_local",
        name: "Proc local",
        code: `wt.onRequest({ url: "${ORIGIN}/*", strategy: "helper" }, (c) => {
    if (c.url.endsWith("/redir")) return { redirect: "${ORIGIN}/target" };
    if (c.url.endsWith("/mock")) return { replaceResponse: { body: { mocked: true, type: c.resourceType }, mime: "application/json" } };
});
wt.onResponseHeaders({ url: "${ORIGIN}/*", strategy: "helper" }, (c) => (c.url.endsWith("/doc") ? { headers: { set: { "x-proc": "yes" } } } : undefined));
wt.onResponseBody({ url: "${ORIGIN}/*", strategy: "helper" }, (c, body) => (c.url.endsWith("/plain") ? undefined : body.replace("ORIGINAL", "PROCESSED")));`,
    });
    await send({
        type: "saveScript",
        id: "p_https",
        name: "Proc https",
        code: `wt.onResponseBody({ url: "https://example.com/*", strategy: "helper" }, (c, body) => body.replace("<title>Example Domain", "<title>Process Domain"));`,
    });

    let st: any = null;
    for (let i = 0; i < 40; i++) {
        st = await send({ type: "processStatus" });
        if (st.state === "ready" && st.routing?.active && st.caTrusted !== null && st.caTrusted !== undefined) break;
        await new Promise((r) => setTimeout(r, 250));
    }
    check("helper connected over native messaging", st.state === "ready", JSON.stringify({ state: st.state, error: st.error }));
    check("PAC routing active", !!st.routing?.active, JSON.stringify(st.routing));
    check("user proxy mode captured (system)", st.routing?.mode === "system", st.routing?.mode);
    check("Chrome trusts the helper CA (probe)", st.caTrusted === true, String(st.caTrusted));

    const page = await ctx.newPage();
    if (LAN) {
        const resp = await page.goto(`${ORIGIN}/doc`);
        await page.waitForFunction(() => (window as any).__marker !== undefined, null, { timeout: 10000 }).catch(() => {});
        check("document body transformed (main frame)", (await page.title()) === "PROCESSED", await page.title());
        check("browser-initiated <script src> transformed", (await page.evaluate(() => (window as any).__marker)) === "PROCESSED");
        check("onResponseHeaders applied to the document", resp?.headers()["x-proc"] === "yes", JSON.stringify(resp?.headers()));
        check("transformed response served no-store", /no-store/.test(resp?.headers()["cache-control"] || ""), resp?.headers()["cache-control"]);

        await page.goto(`${ORIGIN}/redir`);
        check("onRequest redirect (navigation)", page.url() === `${ORIGIN}/target` && (await page.title()) === "TARGET", page.url());

        const before = seen.length;
        await page.goto(`${ORIGIN}/mock`);
        const mock = JSON.parse((await page.textContent("body")) || "{}");
        check("onRequest respond (network never contacted)", mock.mocked === true && !seen.slice(before).includes("/mock"), JSON.stringify(mock));
        check("request ctx: resourceType from webRequest correlation", mock.type === "main_frame", mock.type);

        await page.goto(`${ORIGIN}/plain`);
        check("handler returning undefined leaves body", ((await page.textContent("body")) || "").includes("untouched"));
        const median = async (base: string): Promise<number> => {
            const t: number[] = [];
            for (let i = 0; i < 25; i++) {
                const s0 = Date.now();
                await page.goto(`${base}/plain?i=${i}`);
                t.push(Date.now() - s0);
            }
            return t.sort((a, b) => a - b)[12];
        };
        const direct = await median(`http://${LAN}:${PORT_B}`);
        const routed = await median(ORIGIN);
        check("routing overhead is small (median navigation)", routed - direct < 30, `routed ${routed}ms vs non-routed ${direct}ms`);
        check("helper's upstream hop used the user's proxy", viaUser.some((v) => v.includes(`${LAN}:${PORT}/doc`)), viaUser.slice(0, 5).join(" | "));
    } else {
        console.log("SKIP  local-origin checks (no non-loopback IPv4 address)");
    }

    await page.goto("https://example.com/", { timeout: 30000 });
    check("HTTPS MITM: example.com document transformed", (await page.title()) === "Process Domain", await page.title());
    check("HTTPS upstream through the user's proxy (CONNECT example.com)", viaUser.some((v) => v.startsWith("CONNECT example.com:443")));

    await page.goto("https://example.org/", { timeout: 30000 });
    check("non-routed HTTPS untouched", (await page.title()) === "Example Domain", await page.title());
    check("non-routed traffic still uses the user's proxy", viaUser.some((v) => v.startsWith("CONNECT example.org:443")));

    // disabling the scripts stops the helper and restores the user's proxy
    await send({ type: "setEnabled", id: "p_local", enabled: false }).catch(() => {});
    await send({ type: "deleteScript", id: "p_local" });
    await send({ type: "deleteScript", id: "p_https" });
    let st2: any = null;
    for (let i = 0; i < 20; i++) {
        st2 = await send({ type: "processStatus" });
        if (st2.state === "idle") break;
        await new Promise((r) => setTimeout(r, 250));
    }
    check("no process scripts → helper stopped", st2.state === "idle", st2.state);
    const level = await mgr.evaluate(() => new Promise<any>((r) => (chrome as any).proxy.settings.get({}, (d: any) => r(d))));
    check("PAC removed → browser proxy setting back", level.levelOfControl === "controllable_by_this_extension", JSON.stringify(level));
} catch (e: any) {
    check("e2e ran without exceptions", false, e?.stack || String(e));
} finally {
    clearTimeout(watchdog);
    await browser?.close().catch(() => {});
    proc.kill();
    server.close();
    serverB.close();
    userProxy.close();
    await new Promise((r) => setTimeout(r, 500));
    rmSync(home, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} FAILED` : "\nALL PASSED");
process.exit(failed ? 1 : 0);
