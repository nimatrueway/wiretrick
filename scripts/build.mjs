/**
 * Build: bundles TS entries with Rolldown, copies static assets.
 * Output → dist/ (load unpacked from here).
 */
import { rolldown } from "rolldown";
import { cp, mkdir, rm, writeFile, copyFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(new URL(".", import.meta.url).pathname, "..");
const dist = path.join(root, "dist");

const WATCH = process.argv.includes("--watch");

/** @type {import('rolldown').InputOptions[]} */
const entries = [
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
        input: path.join(root, "src/proxy/proxy-sw.ts"),
        output: { file: path.join(dist, "sw.js"), format: "iife" },
    },
    {
        input: path.join(root, "src/ui/manager.ts"),
        output: { file: path.join(dist, "manager.js"), format: "iife" },
        external: [/^lib\//],
    },
    {
        input: path.join(root, "src/ui/popup.ts"),
        output: { file: path.join(dist, "popup.js"), format: "iife" },
    },
];

async function buildOnce() {
    for (const entry of entries) {
        const bundle = await rolldown(entry);
        await bundle.write({ file: entry.output.file, format: entry.output.format });
        await bundle.close();
        console.log("built", path.relative(root, entry.output.file));
    }
    await copyStatic();
}

async function copyStatic() {
    await mkdir(path.join(dist, "lib", "monaco"), { recursive: true });

    await cp(path.join(root, "icons"), path.join(dist, "icons"), { recursive: true });
    await copyFile(path.join(root, "manifest.json"), path.join(dist, "manifest.json"));
    await copyFile(path.join(root, "src/background/background.html"), path.join(dist, "background.html"));
    await copyFile(path.join(root, "src/ui/manager.html"), path.join(dist, "manager.html"));
    await copyFile(path.join(root, "src/ui/ui.css"), path.join(dist, "ui.css"));
    await copyFile(path.join(root, "src/ui/popup.html"), path.join(dist, "popup.html"));
    await copyFile(path.join(root, "src/ui/popup.css"), path.join(dist, "popup.css"));

    // TypeScript UMD for in-page transpilation (VS Code bridge)
    const tsLib = path.join(root, "node_modules/typescript/lib/typescript.js");
    if (existsSync(tsLib)) {
        await copyFile(tsLib, path.join(dist, "lib/typescript.js"));
    }

    // Monaco classic AMD build
    const monacoSrc = path.join(root, "node_modules/monaco-editor/min/vs");
    const monacoDst = path.join(dist, "lib/monaco/vs");
    if (existsSync(monacoSrc)) {
        await rm(monacoDst, { recursive: true, force: true });
        await cp(monacoSrc, monacoDst, { recursive: true });
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

    // res-api typings for the editor + VS Code export
    await copyFile(
        path.join(root, "src/types/res-api.d.ts"),
        path.join(dist, "lib/res-api.d.ts")
    );

    const st = await stat(dist);
    void st;
    console.log("static assets copied");
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await buildOnce();

if (WATCH) {
    // lightweight rebuild loop using fs.watch on src + manifest
    const { watch } = await import("node:fs");
    let rebuilding = false;
    const rebuild = async () => {
        if (rebuilding) return;
        rebuilding = true;
        try {
            await buildOnce();
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
