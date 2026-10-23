/**
 * Samples e2e (MV3 bundle, needs internet): installs each bundled sample on
 * its own, opens the URL from its "Try it" comment, and checks that the
 * visible effect is there — keeps the one-click samples working against the
 * real public sites they target.
 *
 * Usage: npm run build && E2E_CHROMIUM=/usr/bin/chromium npx tsx test/samples.e2e.ts
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { chromium, type Page } from "playwright-core";
import { resolveBrowser } from "./browserSetup";
import { SAMPLES } from "../src/ui/samples";

const EXT_ROOT = path.join(new URL("..", import.meta.url).pathname, "dist-mv3");
const EXT_ID = crypto.createHash("sha256").update(EXT_ROOT, "utf8").digest("hex").split("").map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join("").slice(0, 32);

const text = (p: Page) => p.evaluate(() => document.body?.innerText || "");
// the first navigation in a fresh tab can beat the debugger attach (see
// README "MV3 readiness") — load once to warm it, then load for real
const open = async (p: Page, url: string) => {
    await p.goto(url).catch(() => {});
    await p.goto(url);
};

// sample name → how to see its effect (opens the page itself)
const VERIFY: Record<string, (p: Page) => Promise<[boolean, string]>> = {
    "Redirect a URL": async (p) => {
        // settings.defaultStrategy = cdp: the request is rewritten in place — the
        // Dog article is served while the address bar keeps /wiki/Cat
        await open(p, "https://en.wikipedia.org/wiki/Cat");
        const h1 = await p.evaluate(() => document.querySelector("h1")?.textContent || "");
        return [h1 === "Dog", h1];
    },
    "Block requests": async (p) => {
        await open(p, "https://en.wikipedia.org/wiki/Cat");
        const loaded = await p.evaluate(() => [...document.images].filter((i) => i.src.includes("upload.wikimedia.org") && i.complete && i.naturalWidth > 0).length);
        return [loaded === 0, `${loaded} images loaded`];
    },
    "Modify request headers": async (p) => {
        await open(p, "https://postman-echo.com/headers");
        const t = await text(p);
        return [t.includes("hello from Wiretrick"), t.slice(0, 120)];
    },
    "CORS unlock": async (p) => {
        await open(p, "https://example.org/");
        const r = await p.evaluate(() => fetch("https://example.com/").then((r) => r.text()).catch((e) => "ERR " + e));
        return [r.includes("Example Domain"), r.slice(0, 80)];
    },
    "Replace a fetch/XHR response": async (p) => {
        await open(p, "https://dummyjson.com/users/1");
        const t = await text(p);
        return [t.includes("Mocked User"), t.slice(0, 80)];
    },
    "Transform an API response": async (p) => {
        await open(p, "https://dummyjson.com/todos/1");
        const t = await text(p);
        return [t.includes("Transformed by Wiretrick") && t.includes("true"), t.slice(0, 120)];
    },
    "Rewrite page HTML": async (p) => {
        await open(p, "https://example.com/");
        const t = await text(p);
        return [t.includes("Rewritten by Wiretrick") && (await p.title()) === "Rewritten Domain", await p.title()];
    },
    "DOM / title changes": async (p) => {
        await open(p, "https://en.wikipedia.org/wiki/Cat");
        await p.waitForTimeout(1000);
        const h1 = await p.evaluate(() => document.querySelector("h1")?.textContent || "");
        return [h1 === "Hello from Wiretrick" && (await p.title()).startsWith("🎯"), h1];
    },
    "Serve a local file": async (p) => {
        await open(p, "https://en.wikipedia.org/robots.txt");
        const t = await text(p);
        return [t.includes("Served by Wiretrick"), t.slice(0, 80)];
    },
    "Per-script storage": async (p) => {
        const hits = async () => Number((await text(p)).match(/"x-hits":\s*"(\d+)"/i)?.[1] || 0);
        await open(p, "https://postman-echo.com/headers");
        const a = await hits();
        await p.reload();
        const b = await hits();
        return [a > 0 && b === a + 1, `${a} → ${b}`];
    },
    "Parameters (wt.params)": async (p) => {
        await open(p, "https://dummyjson.com/posts/1");
        const t = await text(p);
        return [t.includes("forced failure"), t.slice(0, 80)];
    },
};

let failed = 0;
const check = (name: string, ok: boolean, extra = ""): void => {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
};

const profile = mkdtempSync(path.join(tmpdir(), "reso-samples-"));
const proc = spawn(await resolveBrowser(), ["--headless=new", `--user-data-dir=${profile}`, `--load-extension=${EXT_ROOT}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 5000));
const watchdog = setTimeout(() => {
    console.log("FAIL  global watchdog timeout");
    process.exit(1);
}, 300000);

let browser: any;
try {
    const [port] = readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n");
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 90000 });
    const ctx = browser.contexts()[0];
    const mgr = await ctx.newPage();
    await mgr.goto(`chrome-extension://${EXT_ID}/editor.html`);
    const send = (msg: any) => mgr.evaluate((m: any) => new Promise<any>((r) => chrome.runtime.sendMessage(m, r)), msg);
    // no local helper here: run the samples on the debugger tier (settings.defaultStrategy)
    await mgr.evaluate(() => new Promise<void>((r) => chrome.storage.local.set({ resStrategy: "debugger" }, () => r())));

    for (const n of SAMPLES.map((s) => s.name)) check(`"${n}" has a verifier`, n in VERIFY);
    for (const s of SAMPLES) check(`"${s.name}" names a URL to try`, /Try it: .*https:\/\//.test(s.code));

    for (const sample of SAMPLES) {
        const verify = VERIFY[sample.name];
        if (!verify) continue;
        const id = "sample_" + sample.name.replace(/\W+/g, "_");
        const saved = await send({ type: "saveScript", id, code: sample.code, name: sample.name });
        await new Promise((r) => setTimeout(r, 1500)); // pipeline reload → tiers armed
        const page = await ctx.newPage();
        try {
            const [ok, detail] = await verify(page);
            check(sample.name, ok && !saved?.error, saved?.error || detail.replace(/\s+/g, " "));
        } catch (e) {
            check(sample.name, false, String(e).split("\n")[0]);
        }
        await page.close();
        await send({ type: "deleteScript", id });
        await new Promise((r) => setTimeout(r, 300));
    }
} catch (e) {
    check("run", false, String(e));
} finally {
    clearTimeout(watchdog);
    await browser?.close().catch(() => {});
    proc.kill();
    await new Promise((r) => setTimeout(r, 500));
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 5 }); } catch { /* best effort */ }
}
console.log(failed ? `\n${failed} FAILED` : "\nALL PASSED");
process.exit(failed ? 1 : 0);
