/**
 * Build: bundles TS entries with Rolldown, copies static assets.
 *
 * Two targets:
 *   dist/    + dist-mv2/ — MV2 (manifest_version 2, blocking webRequest,
 *                          persistent background page) — the primary build
 *   dist-mv3/            — MV3 (service worker, sandbox-based compile,
 *                          hook tier carries interception — webRequest/
 *                          cdp tiers disabled at runtime)
 *
 * The MV3 manifest is derived from manifest.json at build time.
 */
import { rolldown } from "rolldown";
import { cp, mkdir, rm, writeFile, copyFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WATCH = process.argv.includes("--watch");

/** @type {import('rolldown').InputOptions[]} */
function entriesFor(dist, mv3) {
    const list = [
        {
            input: path.join(root, "src/background/background.ts"),
            output: { file: path.join(dist, "background.js"), format: "iife" },
        },
        {
            input: path.join(root, "src/hook/hook.ts"),
            output: { file: path.join(dist, "hook.js"), format: "iife" },
        },
        {
            input: path.join(root, "src/hook/bridge.ts"),
            output: { file: path.join(dist, "bridge.js"), format: "iife" },
        },
        {
            input: path.join(root, "src/ui/manager.ts"),
            output: { file: path.join(dist, "manager.js"), format: "iife" },
            external: [/^lib\//],
        },
        {
            input: path.join(root, "src/ui/popup.tsx"),
            output: { file: path.join(dist, "popup.js"), format: "iife" },
        },
    ];
    if (!mv3) {
        list.push(
            {
                input: path.join(root, "src/ui/serve.ts"),
                output: { file: path.join(dist, "serve.js"), format: "iife" },
            }
        );
    } else {
        list.push(
            {
                // offscreen document: bridges the SW ⇄ sandbox iframe
                input: path.join(root, "src/background/offscreen.ts"),
                output: { file: path.join(dist, "offscreen.js"), format: "iife" },
            },
            {
                // sandbox page: the only MV3 context where eval is allowed
                input: path.join(root, "src/background/sandbox.ts"),
                output: { file: path.join(dist, "sandbox.js"), format: "iife" },
            }
        );
    }
    for (const e of list) {
        e.transform = {
            define: { __MV3__: mv3 ? "true" : "false" },
            jsx: { runtime: "automatic", importSource: "preact" },
        };
    }
    return list;
}

/** manifest.json → MV3 manifest object */
function mv3Manifest(mv2) {
    return {
        name: mv2.name,
        version: mv2.version,
        description: mv2.description,
        icons: mv2.icons,
        action: {
            default_title: mv2.browser_action.default_title,
            default_popup: mv2.browser_action.default_popup,
            default_icon: mv2.browser_action.default_icon,
        },
        options_ui: mv2.options_ui,
        background: { service_worker: "background.js" },
        content_scripts: mv2.content_scripts,
        permissions: ["storage", "unlimitedStorage", "tabs", "debugger", "offscreen", "webNavigation", "webRequest", "alarms", "proxy", "nativeMessaging", "browsingData"],
        host_permissions: ["<all_urls>"],
        web_accessible_resources: [{ resources: ["hook.js"], matches: ["<all_urls>"] }],
        // the sandbox page is exempt from the extension CSP — it hosts the
        // script compiler/runner (see src/background/sandbox.ts)
        sandbox: { pages: ["sandbox.html"] },
        minimum_chrome_version: "116",
        manifest_version: 3,
    };
}

async function buildOnce(dist, mv3) {
    for (const entry of entriesFor(dist, mv3)) {
        const bundle = await rolldown(entry);
        await bundle.write({ file: entry.output.file, format: entry.output.format });
        await bundle.close();
        console.log("built", path.relative(root, entry.output.file));
    }
    await copyStatic(dist, mv3);
}

async function copyStatic(dist, mv3) {
    await mkdir(path.join(dist, "lib", "monaco"), { recursive: true });

    await cp(path.join(root, "icons"), path.join(dist, "icons"), { recursive: true });
    if (mv3) {
        const mv2 = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
        await writeFile(path.join(dist, "manifest.json"), JSON.stringify(mv3Manifest(mv2), null, 4) + "\n");
        await copyFile(path.join(root, "src/background/offscreen.html"), path.join(dist, "offscreen.html"));
        await copyFile(path.join(root, "src/background/sandbox.html"), path.join(dist, "sandbox.html"));
    } else {
        await copyFile(path.join(root, "manifest.json"), path.join(dist, "manifest.json"));
        await copyFile(path.join(root, "src/background/background.html"), path.join(dist, "background.html"));
        await copyFile(path.join(root, "src/ui/serve.html"), path.join(dist, "serve.html"));
    }
    await copyFile(path.join(root, "src/ui/manager.html"), path.join(dist, "manager.html"));
    await copyFile(path.join(root, "src/ui/ui.css"), path.join(dist, "ui.css"));
    await copyFile(path.join(root, "src/ui/popup.html"), path.join(dist, "popup.html"));
    await copyFile(path.join(root, "src/ui/popup.css"), path.join(dist, "popup.css"));
    await copyFile(path.join(root, "src/ui/theme.css"), path.join(dist, "theme.css"));
    await copyFile(path.join(root, "src/ui/theme-boot.js"), path.join(dist, "theme-boot.js"));

    // Monaco classic AMD build
    const monacoSrc = path.join(root, "node_modules/monaco-editor/min/vs");
    const monacoDst = path.join(dist, "lib/monaco/vs");
    if (existsSync(monacoSrc)) {
        await rm(monacoDst, { recursive: true, force: true });
        await cp(monacoSrc, monacoDst, { recursive: true });
        await pruneTsWorkerLibs(path.join(monacoDst, "language/typescript/tsWorker.js"));
    }

    // loader shim for manager.html
    await writeFile(
        path.join(dist, "lib/monaco-loader.js"),
        `// Monaco AMD loader entry\n`
    );
    // manager.html loads lib/monaco-loader.js before manager.js; the actual
    // loader script is monaco's own loader.js. Point require at it:
    const loaderSrc = path.join(monacoDst, "loader.js");
    if (existsSync(loaderSrc)) {
        await copyFile(loaderSrc, path.join(dist, "lib/monaco-loader.js"));
    }

    // wt-api typings for the editor + VS Code export
    await copyFile(
        path.join(root, "src/types/wt-api.d.ts"),
        path.join(dist, "lib/wt-api.d.ts")
    );

    console.log("static assets copied →", path.relative(root, dist));
}

async function buildAll() {
    // MV2: dist/ (existing output, unchanged behavior) + dist-mv2/ copy
    await rm(path.join(root, "dist"), { recursive: true, force: true });
    await mkdir(path.join(root, "dist"), { recursive: true });
    await buildOnce(path.join(root, "dist"), false);
    await rm(path.join(root, "dist-mv2"), { recursive: true, force: true });
    await cp(path.join(root, "dist"), path.join(root, "dist-mv2"), { recursive: true });
    console.log("dist-mv2/ (copy of dist/) written");

    // MV3: service worker + sandbox compile host
    await rm(path.join(root, "dist-mv3"), { recursive: true, force: true });
    await mkdir(path.join(root, "dist-mv3"), { recursive: true });
    await buildOnce(path.join(root, "dist-mv3"), true);
}

await buildAll();

if (WATCH) {
    // lightweight rebuild loop using fs.watch on src + manifest
    const { watch } = await import("node:fs");
    let rebuilding = false;
    const rebuild = async () => {
        if (rebuilding) return;
        rebuilding = true;
        try {
            await buildAll();
            console.log("── rebuilt");
        } catch (e) {
            console.error(e);
        } finally {
            rebuilding = false;
        }
    };
    watch(path.join(root, "src"), { recursive: true }, rebuild);
    watch(path.join(root, "manifest.json"), rebuild);
    console.log("watching for changes…");
}

/**
 * Drop the TS lib .d.ts files the editor never loads from Monaco's
 * tsWorker.js (webworker, esnext, …). Keeps it under AMO's 5 MB
 * per-file limit so the Firefox build can be signed. The kept set is the
 * `lib:` list in monacoSetup.ts plus everything it `/// <reference lib>`s.
 */
async function pruneTsWorkerLibs(file) {
    if (!existsSync(file)) return;
    const setup = await readFile(path.join(root, "src/ui/monacoSetup.ts"), "utf8");
    const roots = [...(setup.match(/lib:\s*\[([^\]]*)\]/)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    if (!roots.length) throw new Error("pruneTsWorkerLibs: no lib list in monacoSetup.ts");
    const src = await readFile(file, "utf8");
    const libs = new Map(); // name → [start, end) of `X["name"]=`…`;`
    for (const m of src.matchAll(/\w+\["(lib\.[\w.]+\.d\.ts)"\]=`/g)) {
        let i = m.index + m[0].length;
        while (src[i] !== "`") i += src[i] === "\\" ? 2 : 1;
        libs.set(m[1], [m.index, src[i + 1] === ";" ? i + 2 : i + 1, src.slice(m.index + m[0].length, i)]);
    }
    const keep = new Set();
    const queue = [...roots];
    while (queue.length) {
        const n = queue.pop();
        if (keep.has(n) || !libs.has(n)) continue;
        keep.add(n);
        for (const r of libs.get(n)[2].matchAll(/<reference lib=\\?"([\w.]+)\\?"/g)) queue.push(`lib.${r[1].toLowerCase()}.d.ts`);
    }
    if (roots.some((r) => !keep.has(r))) throw new Error(`pruneTsWorkerLibs: missing ${roots.filter((r) => !keep.has(r))}`);
    let out = src;
    const drop = [...libs].filter(([n]) => !keep.has(n)).sort((a, b) => b[1][0] - a[1][0]);
    for (const [, [start, end]] of drop) out = out.slice(0, start) + out.slice(end);
    await writeFile(file, out);
    console.log(`tsWorker.js: kept ${keep.size} TS libs, dropped ${drop.length} (${(src.length / 1e6).toFixed(2)} → ${(out.length / 1e6).toFixed(2)} MB)`);
}
