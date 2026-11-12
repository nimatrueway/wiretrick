/**
 * Generates Chrome Web Store graphic assets into docs/store/ (and updates icons/storeIcon.png):
 *   - store-icon-128x128.png       (128x128, 32-bit RGBA PNG, 112x112 circular mark + 8px padding)
 *   - small-promo-440x280.png      (440x280, 24-bit RGB PNG, no alpha)
 *   - marquee-promo-1400x560.png   (1400x560, 24-bit RGB PNG, no alpha)
 *   - screenshot-1-editor.png      (1280x800, 24-bit RGB PNG, no alpha)
 *   - screenshot-2-network.png     (1280x800, 24-bit RGB PNG, no alpha)
 *   - screenshot-3-overlay.png     (1280x800, 24-bit RGB PNG, no alpha)
 *   - screenshot-4-popup.png       (1280x800, 24-bit RGB PNG, no alpha)
 *   - screenshot-5-samples.png     (1280x800, 24-bit RGB PNG, no alpha)
 *
 * Usage: npm run build && npx tsx scripts/store-assets.ts
 */
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { resolveBrowser } from "../test/browserSetup";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const EXT_ROOT = path.join(ROOT, "dist");
const OUT = path.join(ROOT, "docs/store");
const ICON_SVG = readFileSync(path.join(ROOT, "icons/icon.svg"), "utf8").trim();

const EXT_ID = crypto
    .createHash("sha256")
    .update(EXT_ROOT, "utf8")
    .digest("hex")
    .split("")
    .map((c) => String.fromCharCode(parseInt(c, 16) + 97))
    .join("")
    .slice(0, 32);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT, { recursive: true });
const rawDir = mkdtempSync(path.join(tmpdir(), "tt-store-raw-"));
const profile = mkdtempSync(path.join(tmpdir(), "tt-store-profile-"));

// Local HTTP proxy server so clean hostnames (acme-cloud.io) resolve without port numbers
const server = http.createServer((req, res) => {
    const host = req.headers.host || "acme-cloud.io";
    const u = new URL(req.url || "/", `http://${host}`);
    const cors = {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
    };
    if (req.method === "OPTIONS") {
        res.writeHead(204, cors);
        res.end();
        return;
    }
    if (u.pathname.startsWith("/api/")) {
        const json = (status: number, data: unknown) => {
            res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...cors });
            res.end(JSON.stringify(data));
        };
        if (u.pathname.startsWith("/api/v1/users/")) {
            return json(200, { id: 42, name: "Alex Rivera", role: "viewer", plan: "free", region: "us-east" });
        }
        if (u.pathname === "/api/v1/orders") {
            return json(200, {
                orders: [
                    { id: "ord_9041", status: "pending", total: 149.0, currency: "USD" },
                    { id: "ord_9042", status: "shipped", total: 84.5, currency: "USD" },
                ],
                cached: false,
            });
        }
        if (u.pathname === "/api/v1/feature-flags") {
            return json(200, { newCheckout: false, betaAnalytics: true, maxSeats: 25 });
        }
        if (u.pathname === "/api/v1/health") {
            return json(200, { ok: true, region: "us-east-1", latencyMs: 18 });
        }
        return json(200, { ok: true });
    }

    // http://acme-cloud.io/dashboard
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Acme Console — Staging</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #141416;
    color: #e4e4ea;
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  header {
    height: 48px;
    padding: 0 24px;
    display: flex;
    align-items: center;
    gap: 14px;
    background: #1b1b1e;
    border-bottom: 1px solid #2d2d33;
  }
  .brand { font-weight: 700; font-size: 14px; color: #f5f5f7; letter-spacing: -0.01em; }
  .env-pill {
    padding: 2px 8px;
    border-radius: 4px;
    background: #232b24;
    border: 1px solid #355239;
    color: #8bc05a;
    font: 600 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .url-pill {
    color: #8e8e98;
    font: 12px ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  main {
    padding: 24px;
    max-width: 740px;
    display: grid;
    gap: 16px;
  }
  .card {
    background: #1b1b1e;
    border: 1px solid #2d2d33;
    border-radius: 6px;
    overflow: hidden;
  }
  .card-head {
    padding: 10px 14px;
    background: #202024;
    border-bottom: 1px solid #2d2d33;
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-weight: 600;
    font-size: 12px;
    color: #c8c8d0;
  }
  .method {
    padding: 2px 6px;
    border-radius: 3px;
    background: #1d3247;
    color: #6cb6ff;
    font: 600 11px ui-monospace, SFMono-Regular, Menlo, monospace;
    margin-right: 8px;
  }
  .tag-mod {
    padding: 2px 7px;
    border-radius: 3px;
    background: #332419;
    border: 1px solid #593b24;
    color: #ff8e49;
    font: 500 11px ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  pre {
    margin: 0;
    padding: 12px 14px;
    font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #d4d4dc;
    white-space: pre-wrap;
  }
</style>
</head>
<body>
  <header>
    <span class="brand">Acme API Playground</span>
    <span class="env-pill">http://acme-cloud.io/dashboard</span>
    <span class="url-pill">Live responses intercepted by TangiTweak</span>
  </header>
  <main>
    <section class="card">
      <div class="card-head">
        <span><span class="method">GET</span>/api/v1/users/42</span>
        <span class="tag-mod">replaced by api-kit/mock-users</span>
      </div>
      <pre id="out-user">Loading…</pre>
    </section>
    <section class="card">
      <div class="card-head">
        <span><span class="method">GET</span>/api/v1/orders</span>
        <span class="tag-mod">transformed by api-kit/transform-orders</span>
      </div>
      <pre id="out-orders">Loading…</pre>
    </section>
    <section class="card">
      <div class="card-head">
        <span><span class="method">GET</span>/api/v1/feature-flags</span>
        <span class="tag-mod">headers by cors-unlock</span>
      </div>
      <pre id="out-flags">Loading…</pre>
    </section>
  </main>
  <script>
    (async () => {
      const u = await fetch("/api/v1/users/42").then((r) => r.json());
      document.getElementById("out-user").textContent = JSON.stringify(u, null, 2);
      const o = await fetch("/api/v1/orders").then((r) => r.json());
      document.getElementById("out-orders").textContent = JSON.stringify(o, null, 2);
      const f = await fetch("/api/v1/feature-flags").then((r) => r.json());
      document.getElementById("out-flags").textContent = JSON.stringify(f, null, 2);
      await fetch("/api/v1/health").then((r) => r.json());
    })();
  </script>
</body>
</html>`);
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const serverPort = (server.address() as { port: number }).port;

const API_ICON_SVG = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="16" height="16" rx="4" fill="#20344A"/>
  <path d="M5.5 5.5L3 8l2.5 2.5M10.5 5.5L13 8l-2.5 2.5M8.8 4.5l-1.6 7" stroke="#6CB6FF" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const CORS_ICON_SVG = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="16" height="16" rx="4" fill="#213624"/>
  <path d="M8 3.2L12.2 5v3.2c0 2.6-1.8 4.3-4.2 5-2.4-.7-4.2-2.4-4.2-5V5L8 3.2z" stroke="#8BC05A" stroke-width="1.4" stroke-linejoin="round"/>
  <path d="M6.2 8.1l1.3 1.3 2.5-2.6" stroke="#8BC05A" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const OVERLAY_ICON_SVG = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="16" height="16" rx="4" fill="#3B2518"/>
  <rect x="3" y="3.5" width="10" height="9" rx="1.5" stroke="#FF8E49" stroke-width="1.4"/>
  <path d="M3 6.5h10" stroke="#FF8E49" stroke-width="1.3"/>
  <rect x="8.2" y="8.2" width="3.3" height="2.8" rx="0.6" fill="#FF8E49"/>
</svg>`;

const MOCK_USERS_CODE = `import limits from "./rate-limits.json";

tt.metadata({
    description: "Mock user profiles and rate-limit headers across environments",
    icon: "./icon.svg",
});

const cfg = tt.params({
    environment: {
        target: { type: "enum", choices: ["local", "staging", "prod"], default: "staging" },
        role: { type: "enum", choices: ["admin", "staff", "viewer"], default: "admin" },
    },
    faults: {
        injectLatency: { type: "boolean", default: false, description: "Add synthetic delay" },
        delayMs: { type: "number", default: 180, min: 0, max: 5000 },
    },
});

tt.replaceResponse({ url: "*://acme-cloud.io/api/v1/users/:id", strategy: "page" }, (ctx) => ({
    id: Number(ctx.groups.id),
    name: "Alex Rivera",
    role: cfg.environment.role,
    environment: cfg.environment.target,
    rateLimitRpm: limits.rpm,
}));

tt.onRequest(
    { url: ["*://acme-cloud.io/api/v1/orders", "*://acme-cloud.io/api/v1/feature-flags", "*://acme-cloud.io/api/v1/health"], strategy: "rules" },
    () => ({
        headers: { set: { "x-tangitweak-env": cfg.environment.target } },
    }),
);
`;

const TRANSFORM_ORDERS_CODE = `tt.metadata({
    description: "Rewrite /api/v1/orders JSON payloads in flight",
    icon: "./icon.svg",
});

tt.onResponseBody({ url: "*://acme-cloud.io/api/v1/orders", strategy: "page" }, (_ctx, body) => {
    const text = typeof body === "string" ? body : new TextDecoder().decode(body);
    const data = JSON.parse(text);
    return JSON.stringify(
        {
            ...data,
            orders: data.orders.map((o: { id: string; total: number }) => ({
                ...o,
                status: "prioritized",
                mockedBy: "TangiTweak",
            })),
            cached: true,
        },
        null,
        2,
    );
});
`;

const CORS_CODE = `tt.metadata({
    description: "Add permissive CORS headers to acme-cloud.io API responses",
    icon: "./icons/cors.svg",
});

tt.onResponseHeaders(
    { url: ["*://acme-cloud.io/api/v1/orders", "*://acme-cloud.io/api/v1/feature-flags", "*://acme-cloud.io/api/v1/health"], strategy: "rules" },
    () => ({
        headers: {
            set: {
                "access-control-allow-origin": "*",
                "access-control-allow-headers": "*",
            },
        },
    }),
);
`;

const OVERLAY_CODE = `import { useSnapshot } from "valtio";

tt.metadata({
    description: "Floating React inspector on acme-cloud.io",
    icon: "./icons/overlay.svg",
});

const state = tt.globalStore("acme-inspector", {
    mockActive: true,
    env: "staging" as "local" | "staging" | "prod",
    hits: 4,
});

tt.onOverlay("*://acme-cloud.io/*", (ctx) => {
    function Inspector() {
        const snap = useSnapshot(state);
        return (
            <div style={{
                position: "fixed", right: 20, bottom: 20, width: 296,
                background: "#1b1b1e", color: "#e8e8ee",
                border: "1px solid #34343c", borderRadius: 8,
                font: "12px/1.45 -apple-system, sans-serif",
            }}>
                <div style={{
                    padding: "9px 12px", background: "#232328",
                    borderBottom: "1px solid #34343c",
                    borderRadius: "7px 7px 0 0",
                    display: "flex", alignItems: "center",
                    justifyContent: "space-between",
                }}>
                    <strong style={{ color: "#f5f5f7" }}>
                        TangiTweak Inspector
                    </strong>
                    <span style={{
                        padding: "1px 6px", borderRadius: 4,
                        background: "#213624", color: "#8bc05a",
                        border: "1px solid #35593a", fontWeight: 600,
                    }}>{snap.hits} matched</span>
                </div>
                <div style={{ padding: 12, display: "grid", gap: 10 }}>
                    <div style={{
                        display: "flex", alignItems: "center",
                        justifyContent: "space-between",
                    }}>
                        <span style={{ color: "#a8a8b2" }}>Mock API</span>
                        <button
                            onClick={() => (state.mockActive = !state.mockActive)}
                            style={{
                                padding: "3px 10px", borderRadius: 4,
                                border: "1px solid #593b24",
                                background: snap.mockActive ? "#ff8e49" : "#2a2a30",
                                color: snap.mockActive ? "#141416" : "#c8c8d0",
                                fontWeight: 600, fontSize: 11,
                            }}
                        >{snap.mockActive ? "Enabled" : "Bypassed"}</button>
                    </div>
                    <div style={{ display: "grid", gap: 5 }}>
                        <span style={{ color: "#a8a8b2" }}>Environment</span>
                        <div style={{
                            display: "grid", gap: 6,
                            gridTemplateColumns: "1fr 1fr 1fr",
                        }}>
                            {(["local", "staging", "prod"] as const).map((e) => (
                                <button
                                    key={e}
                                    onClick={() => (state.env = e)}
                                    style={{
                                        padding: "5px 0", borderRadius: 4,
                                        border: snap.env === e
                                            ? "1px solid #6cb6ff"
                                            : "1px solid #34343c",
                                        background: snap.env === e
                                            ? "#1d3247"
                                            : "#232328",
                                        color: snap.env === e
                                            ? "#6cb6ff"
                                            : "#b8b8c2",
                                        font: "600 11px ui-monospace, monospace",
                                    }}
                                >{e}</button>
                            ))}
                        </div>
                    </div>
                    <div style={{
                        padding: "7px 9px", borderRadius: 4,
                        background: "#141416", border: "1px solid #2b2b32",
                        font: "11px ui-monospace, monospace", color: "#9cdcfe",
                    }}>GET /api/v1/users/42 → 200 ({snap.env})</div>
                </div>
            </div>
        );
    }
    ctx.mount(<Inspector />);
});
`;

const proc = spawn(
    await resolveBrowser(),
    [
        "--headless=new",
        "--force-device-scale-factor=2",
        "--force-dark-mode",
        `--user-data-dir=${profile}`,
        `--load-extension=${EXT_ROOT}`,
        `--proxy-server=127.0.0.1:${serverPort}`,
        "--proxy-bypass-list=<-loopback>",
        "--remote-debugging-port=0",
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
    ],
    { stdio: "ignore" },
);

await sleep(3500);
let browser: any;
try {
    const [cdpPort] = readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n");
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 90000 });
    const ctx = browser.contexts()[0];

    const setRetinaViewport = async (page: any, width: number, height: number) => {
        await page.setViewportSize({ width, height });
        await page.emulateMedia({ colorScheme: "dark" });
    };

    // ---- 1. Render Store Icon, Small Promo Tile & Marquee Promo Tile ----
    const art = await ctx.newPage();

    // 1a. Store Icon: 128x128 RGBA with 112x112 circle centered (8px transparent padding per CWS circular icon spec)
    await setRetinaViewport(art, 512, 512);
    await art.setContent(`<!doctype html>
<html><head><style>
  html, body { margin: 0; width: 512px; height: 512px; background: transparent; display: grid; place-items: center; }
  .mark { width: 448px; height: 448px; display: block; }
  .mark svg { width: 100%; height: 100%; display: block; }
</style></head>
<body><div class="mark">${ICON_SVG}</div></body></html>`);
    await art.screenshot({ path: path.join(rawDir, "store-icon-raw.png"), omitBackground: true });

    // 1b. Small Promo Tile: 440x280 (flat, clean, zero shadows/gradients)
    await setRetinaViewport(art, 440, 280);
    await art.setContent(`<!doctype html>
<html><head><style>
  * { box-sizing: border-box; }
  html, body {
    margin: 0; width: 440px; height: 280px;
    background: #161618; color: #f5f5f7;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    overflow: hidden;
  }
  .wrap {
    width: 440px; height: 280px;
    padding: 36px 34px;
    display: flex; align-items: center; gap: 26px;
    border: 1px solid #28282e;
  }
  .logo { width: 92px; height: 92px; flex-shrink: 0; }
  .logo svg { width: 100%; height: 100%; display: block; }
  .copy { display: flex; flex-direction: column; align-items: flex-start; }
  .bar { width: 30px; height: 4px; border-radius: 2px; background: #ff8e49; margin-bottom: 12px; }
  h1 { margin: 0 0 8px; font-size: 33px; line-height: 1.05; font-weight: 700; letter-spacing: -0.025em; color: #ffffff; }
  p { margin: 0 0 16px; font-size: 14.5px; line-height: 1.38; color: #a8a8b3; font-weight: 450; }
  .chips { display: flex; gap: 6px; }
  .chip {
    padding: 3px 8px; border-radius: 4px;
    background: #212126; border: 1px solid #32323a;
    color: #d4d4dc; font-size: 11px; font-weight: 600; letter-spacing: 0.01em;
  }
</style></head>
<body>
  <div class="wrap">
    <div class="logo">${ICON_SVG}</div>
    <div class="copy">
      <div class="bar"></div>
      <h1>TangiTweak</h1>
      <p>Programmable network<br>&amp; page overrides</p>
      <div class="chips">
        <span class="chip">TypeScript</span>
        <span class="chip">Hot reload</span>
        <span class="chip">MV3</span>
      </div>
    </div>
  </div>
</body></html>`);
    await art.screenshot({ path: path.join(rawDir, "small-promo-raw.png") });

    // 1c. Marquee Promo Tile: 1400x560 (flat, clean, zero shadows/gradients/em-dashes)
    await setRetinaViewport(art, 1400, 560);
    await art.setContent(`<!doctype html>
<html><head><style>
  * { box-sizing: border-box; }
  html, body {
    margin: 0; width: 1400px; height: 560px;
    background: #161618; color: #f5f5f7;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    overflow: hidden;
  }
  .canvas {
    width: 1400px; height: 560px;
    padding: 64px 76px;
    display: grid;
    grid-template-columns: 560px 1fr;
    gap: 56px;
    align-items: center;
    border: 1px solid #28282e;
  }
  .brand-row { display: flex; align-items: center; gap: 20px; margin-bottom: 22px; }
  .logo { width: 76px; height: 76px; flex-shrink: 0; }
  .logo svg { width: 100%; height: 100%; display: block; }
  .bar { width: 38px; height: 5px; border-radius: 2.5px; background: #ff8e49; margin-bottom: 10px; }
  h1 { margin: 0; font-size: 58px; line-height: 1.02; font-weight: 700; letter-spacing: -0.03em; color: #ffffff; }
  .lead {
    margin: 0 0 30px;
    font-size: 20px; line-height: 1.45; color: #a8a8b3; font-weight: 450;
    white-space: nowrap;
  }
  .features {
    display: grid; grid-template-columns: 1fr 1fr; gap: 10px;
    max-width: 510px;
  }
  .feat {
    padding: 10px 14px;
    background: #1e1e22; border: 1px solid #2f2f37; border-radius: 6px;
    display: flex; align-items: center; gap: 10px;
    font-size: 14px; font-weight: 500; color: #e4e4ec;
  }
  .dot { width: 8px; height: 8px; border-radius: 2px; flex-shrink: 0; }
  .code-window {
    background: #1e1e20;
    border: 1px solid #32323a;
    border-radius: 8px;
    overflow: hidden;
  }
  .cw-head {
    height: 40px; padding: 0 16px;
    background: #252529; border-bottom: 1px solid #32323a;
    display: flex; align-items: center; justify-content: space-between;
    font-size: 13px; color: #ccccd4;
  }
  .cw-file { display: flex; align-items: center; gap: 8px; font-weight: 600; }
  .ts-badge {
    padding: 1px 5px; border-radius: 3px;
    background: #1d3247; color: #6cb6ff;
    font: 700 10px ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .saved-pill {
    padding: 2px 9px; border-radius: 4px;
    background: #1f3326; border: 1px solid #33543d;
    color: #8bc05a; font-size: 11.5px; font-weight: 600;
  }
  pre {
    margin: 0; padding: 20px 22px;
    font: 14px/1.62 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #d4d4d4;
  }
  .kw { color: #569cd6; }
  .fn { color: #dcdcaa; }
  .str { color: #ce9178; }
  .prop { color: #9cdcfe; }
  .num { color: #b5cea8; }
  .cm { color: #6a9955; }
  .cw-foot {
    height: 36px; padding: 0 16px;
    background: #252529; border-top: 1px solid #32323a;
    display: flex; align-items: center; justify-content: space-between;
    font: 12px ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #9a9aa6;
  }
  .ok { color: #4ec9b0; font-weight: 600; }
  .script-tag {
    padding: 1px 7px; border-radius: 3px;
    background: #332419; border: 1px solid #593b24; color: #ff8e49;
  }
</style></head>
<body>
  <div class="canvas">
    <div>
      <div class="brand-row">
        <div class="logo">${ICON_SVG}</div>
        <div>
          <div class="bar"></div>
          <h1>TangiTweak</h1>
        </div>
      </div>
      <p class="lead">Rewrite requests, responses, and pages in TypeScript.</p>
      <div class="features">
        <div class="feat"><span class="dot" style="background:#ff8e49"></span>Mock &amp; transform APIs</div>
        <div class="feat"><span class="dot" style="background:#8bc05a"></span>Edit headers &amp; CORS</div>
        <div class="feat"><span class="dot" style="background:#6cb6ff"></span>React + valtio overlays</div>
        <div class="feat"><span class="dot" style="background:#4ec9b0"></span>Two-way folder sync</div>
      </div>
    </div>
    <div class="code-window">
      <div class="cw-head">
        <span class="cw-file"><span class="ts-badge">TS</span>api-kit/mock-users.ts</span>
        <span class="saved-pill">✓ Saved · Hot reload</span>
      </div>
      <pre><span class="kw">const</span> cfg = tt.<span class="fn">params</span>({
  <span class="prop">env</span>: {
    <span class="prop">type</span>: <span class="str">"enum"</span>,
    <span class="prop">choices</span>: [<span class="str">"staging"</span>, <span class="str">"local"</span>, <span class="str">"prod"</span>],
    <span class="prop">default</span>: <span class="str">"staging"</span>,
  },
});

tt.<span class="fn">replaceResponse</span>(<span class="str">"*://acme-cloud.io/api/v1/users/:id"</span>, (ctx) =&gt; ({
  <span class="prop">id</span>: <span class="fn">Number</span>(ctx.groups.id),
  <span class="prop">name</span>: <span class="str">"Alex Rivera"</span>,
  <span class="prop">role</span>: <span class="str">"admin"</span>,
  <span class="prop">environment</span>: cfg.env,
}));</pre>
      <div class="cw-foot">
        <span><span class="ok">200 OK</span> &nbsp;GET acme-cloud.io/api/v1/users/42</span>
        <span class="script-tag">api-kit/mock-users</span>
      </div>
    </div>
  </div>
</body></html>`);
    await art.screenshot({ path: path.join(rawDir, "marquee-promo-raw.png") });
    await art.close();

    // ---- 2. Seed Extension Workspace & Capture 5 Real UI Screenshots (1280x800) ----
    const mgr = await ctx.newPage();
    await setRetinaViewport(mgr, 1280, 800);
    const ensureMgrViewport = async () => {
        await mgr.setViewportSize({ width: 1280, height: 800 });
        await mgr.evaluate(() => window.dispatchEvent(new Event("resize")));
    };
    await mgr.goto(`chrome-extension://${EXT_ID}/editor.html`);
    await mgr.waitForFunction(() => (window as any).monaco?.editor?.getEditors?.().length === 1);

    const send = (msg: unknown) => mgr.evaluate((m: unknown) => new Promise<any>((r) => chrome.runtime.sendMessage(m, r)), msg);

    // Force dark theme across extension pages
    await mgr.evaluate(() => new Promise<void>((r) => chrome.storage.local.set({ resTheme: "dark" }, () => r())));

    // Seed package metadata, SVG icon, Markdown doc, JSON data file, and scripts
    await send({
        type: "saveDataFile",
        path: "api-kit/metadata.json",
        text: JSON.stringify(
            {
                name: "Acme API Kit",
                description: "Mock user endpoints and rewrite order payloads",
                icon: "icon.svg",
                scripts: ["mock-users.ts", "transform-orders.ts"],
            },
            null,
            2,
        ),
    });
    await send({ type: "saveDataFile", path: "api-kit/icon.svg", text: API_ICON_SVG });
    await send({ type: "saveDataFile", path: "icons/cors.svg", text: CORS_ICON_SVG });
    await send({ type: "saveDataFile", path: "icons/overlay.svg", text: OVERLAY_ICON_SVG });
    await send({
        type: "saveDataFile",
        path: "api-kit/rate-limits.json",
        text: JSON.stringify({ tier: "enterprise", rpm: 5000, burst: 250 }, null, 2),
    });
    await send({
        type: "saveDataFile",
        path: "api-kit/README.md",
        text: "# Acme API Kit\n\nLocal overrides and response mocks for `acme-cloud.io`.\n",
    });

    const sMock = await send({ type: "saveScript", id: "s_mock_users", name: "api-kit/mock-users", code: MOCK_USERS_CODE });
    await send({ type: "saveScript", id: "s_transform_orders", name: "api-kit/transform-orders", code: TRANSFORM_ORDERS_CODE });
    await send({ type: "saveScript", id: "s_cors_unlock", name: "cors-unlock", code: CORS_CODE });
    await send({ type: "saveScript", id: "s_dev_overlay", name: "dev-overlay.tsx", code: OVERLAY_CODE });

    await sleep(1200);

    // Set initial Editor layout & open on api-kit/mock-users BEFORE loading liveTab so Network keeps its port open and captures bodies
    await mgr.evaluate(() => {
        localStorage.setItem("resCollapsedFolders", JSON.stringify(["icons"]));
        localStorage.setItem("resPanelDock", JSON.stringify({ dock: "bottom", side: "left", size: { bottom: 250, right: 440 } }));
        localStorage.setItem("wt.network.layout", JSON.stringify({ hidden: [], widths: {}, detailsWidth: 540 }));
    });
    await mgr.goto(`chrome-extension://${EXT_ID}/editor.html?script=${encodeURIComponent(sMock.id || "s_mock_users")}`);
    await ensureMgrViewport();
    await mgr.waitForFunction(() => (window as any).monaco?.editor?.getEditors?.().length === 1);
    await sleep(2200);
    await send({ type: "clearLogs" }).catch(() => {});

    // Open live acme-cloud.io/dashboard tab while Editor's network port is active so bodies & sizes are recorded
    const liveTab = await ctx.newPage();
    await setRetinaViewport(liveTab, 1280, 800);
    await liveTab.goto("http://acme-cloud.io/dashboard", { waitUntil: "networkidle" });
    await liveTab.waitForFunction(() => {
        const u = document.getElementById("out-user");
        const o = document.getElementById("out-orders");
        return u?.textContent?.includes("admin") && o?.textContent?.includes("prioritized");
    });
    await sleep(1000);
    await liveTab.screenshot({ path: path.join(rawDir, "live-page-raw.png") });

    const liveTabId: number = await mgr.evaluate(
        () =>
            new Promise<number>((resolve) => {
                chrome.tabs.query({ url: "*://acme-cloud.io/*" }, (tabs) => resolve(tabs[0]?.id ?? -1));
            }),
    );

    await mgr.bringToFront();
    await ensureMgrViewport();
    await sleep(600);

    // Screenshot 1: Script Editor + Explorer + Clean Zero-Warning Live Log
    await mgr.screenshot({ path: path.join(rawDir, "screenshot-1-raw.png") });

    // Screenshot 2: Network Inspector + Modified vs Original Response Body
    await mgr.evaluate(() => {
        const panel = document.getElementById("panel-dock");
        if (panel) panel.style.height = "460px";
        window.dispatchEvent(new Event("resize"));
    });
    await mgr.click("#network-tab");
    await sleep(300);
    // Clear pre-recording idle rows and reload liveTab while the Network recording port is active!
    await mgr.evaluate(() => {
        document.querySelector<HTMLButtonElement>('button[title*="Clear network"]')?.click();
    });
    await liveTab.reload({ waitUntil: "networkidle" });
    await liveTab.waitForFunction(() => document.getElementById("out-orders")?.textContent?.includes("prioritized"));
    await sleep(600);
    await mgr.bringToFront();
    await ensureMgrViewport();
    await mgr.waitForSelector(".net-table tbody tr");
    await sleep(400);
    // Find and select the orders row that has the captured Modified (served) | Original response body
    const rowsCount = await mgr.locator(".net-table tbody tr").count();
    for (let i = 0; i < rowsCount; i++) {
        const row = mgr.locator(".net-table tbody tr").nth(i);
        const txt = (await row.textContent()) || "";
        if (!txt.includes("orders") && !txt.includes("42")) continue;
        await row.click();
        await sleep(150);
        await mgr.evaluate(() => {
            const btns = [...document.querySelectorAll<HTMLButtonElement>(".net-details-tabs button")];
            btns.find((b) => b.textContent?.trim() === "Response")?.click();
        });
        await sleep(150);
        if ((await mgr.locator(".net-body-switch").count()) > 0) break;
    }
    await sleep(300);
    await ensureMgrViewport();
    await sleep(200);
    await mgr.screenshot({ path: path.join(rawDir, "screenshot-2-raw.png") });

    // Screenshot 3: React + valtio Overlay Code + Live Side-by-Side Preview Dock
    await mgr.evaluate(() => {
        localStorage.setItem("resPanelDock", JSON.stringify({ dock: "right", side: "left", size: { bottom: 260, right: 440 } }));
    });
    await mgr.goto(`chrome-extension://${EXT_ID}/editor.html?script=s_dev_overlay`);
    await ensureMgrViewport();
    await mgr.waitForFunction(() => (window as any).monaco?.editor?.getEditors?.().length === 1);
    await sleep(1500);
    await mgr.click("#preview-tab");
    await sleep(1800);
    await ensureMgrViewport();
    await mgr.screenshot({ path: path.join(rawDir, "screenshot-3-raw.png") });

    // Screenshot 4 Popup capture (live-page-raw.png already captured above)

    const pop = await ctx.newPage();
    await setRetinaViewport(pop, 400, 520);
    await pop.addInitScript((tabId: number) => {
        const orig = chrome.tabs.query.bind(chrome.tabs);
        (chrome.tabs as any).query = (queryInfo: chrome.tabs.QueryInfo, cb?: (tabs: chrome.tabs.Tab[]) => void) => {
            if (queryInfo && queryInfo.active && queryInfo.currentWindow) {
                const fake = [{ id: tabId, active: true, windowId: 1 } as chrome.tabs.Tab];
                if (cb) {
                    cb(fake);
                    return;
                }
                return Promise.resolve(fake);
            }
            return cb ? orig(queryInfo, cb) : orig(queryInfo);
        };
    }, liveTabId);
    await pop.goto(`chrome-extension://${EXT_ID}/popup.html`);
    await pop.waitForSelector("#script-list .script-item");
    await sleep(600);
    // Expand nested parameters on api-kit/mock-users
    await pop.evaluate(() => {
        const foldBtn = document.querySelector<HTMLButtonElement>("#script-list .btn-fold");
        foldBtn?.click();
    });
    await sleep(600);
    await pop.evaluate(() => {
        document.body.style.width = "380px";
        document.body.style.height = "auto";
    });
    await sleep(200);
    await pop.locator("body").screenshot({ path: path.join(rawDir, "popup-card-raw.png") });
    await pop.close();

    // Screenshot 5: Built-in One-Click Samples Dialog over Clean Dark Editor
    await mgr.bringToFront();
    await mgr.evaluate(() => {
        localStorage.setItem("resPanelDock", JSON.stringify({ dock: "bottom", side: "left", size: { bottom: 230, right: 440 } }));
    });
    await mgr.goto(`chrome-extension://${EXT_ID}/editor.html?script=s_mock_users`);
    await ensureMgrViewport();
    await mgr.waitForFunction(() => (window as any).monaco?.editor?.getEditors?.().length === 1);
    await mgr.click("#log-header-title");
    await sleep(1000);
    await mgr.click("#btn-help");
    await mgr.click('[data-help-tab="samples"]');
    await sleep(700);
    await ensureMgrViewport();
    await mgr.screenshot({ path: path.join(rawDir, "screenshot-5-raw.png") });

    // Downsample @2x captures to crisp target resolutions & enforce exact PNG color modes (RGBA for icon, 24-bit RGB for store tiles/screenshots)
    const py = `
import os
from PIL import Image, ImageDraw

raw = ${JSON.stringify(rawDir)}
out = ${JSON.stringify(OUT)}

# 1. Store icon: 128x128 RGBA
ico = Image.open(os.path.join(raw, "store-icon-raw.png")).convert("RGBA")
ico = ico.resize((128, 128), Image.Resampling.LANCZOS)
ico.save(os.path.join(out, "store-icon-128x128.png"), format="PNG", optimize=True)

def save_rgb(src_name, dst_name, size):
    im = Image.open(os.path.join(raw, src_name)).convert("RGB")
    if im.size != size:
        im = im.resize(size, Image.Resampling.LANCZOS)
    im.save(os.path.join(out, dst_name), format="PNG", optimize=True)

# 2. Small promo tile (440x280 RGB) & Marquee promo tile (1400x560 RGB)
save_rgb("small-promo-raw.png", "small-promo-440x280.png", (440, 280))
save_rgb("marquee-promo-raw.png", "marquee-promo-1400x560.png", (1400, 560))

# 3. Screenshots 1, 2, 3, 5 (1280x800 RGB)
save_rgb("screenshot-1-raw.png", "screenshot-1-editor.png", (1280, 800))
save_rgb("screenshot-2-raw.png", "screenshot-2-network.png", (1280, 800))
save_rgb("screenshot-3-raw.png", "screenshot-3-overlay.png", (1280, 800))
save_rgb("screenshot-5-raw.png", "screenshot-5-samples.png", (1280, 800))

# 4. Screenshot 4: Composite crisp Popup (with flat 1px border, zero shadow) onto Live Page at top-right
bg = Image.open(os.path.join(raw, "live-page-raw.png")).convert("RGB")
pop = Image.open(os.path.join(raw, "popup-card-raw.png")).convert("RGB")
# At @2x (2560x1600), place popup cleanly below header at right=36px, top=28px with flat 2px (#3c3c44) hairline border
px = bg.width - pop.width - 40
py_top = 28
draw = ImageDraw.Draw(bg)
draw.rectangle([px - 2, py_top - 2, px + pop.width + 1, py_top + pop.height + 1], fill=(60, 60, 68))
bg.paste(pop, (px, py_top))
bg = bg.resize((1280, 800), Image.Resampling.LANCZOS)
bg.save(os.path.join(out, "screenshot-4-popup.png"), format="PNG", optimize=True)
`;
    execFileSync("python3", ["-c", py], { stdio: "inherit" });
    copyFileSync(path.join(OUT, "small-promo-440x280.png"), path.join(ROOT, "icons/storeIcon.png"));
    console.log("Generated all Chrome Web Store assets in", OUT);
} finally {
    await browser?.close().catch(() => {});
    proc.kill();
    server.close();
    await sleep(400);
    try {
        rmSync(rawDir, { recursive: true, force: true, maxRetries: 3 });
        rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    } catch {
        /* best effort */
    }
}
process.exit(0);
