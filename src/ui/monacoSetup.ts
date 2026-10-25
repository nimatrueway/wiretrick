/**
 * Monaco loader + editor configuration. Uses the classic AMD build (copied
 * into dist/lib/monaco) and wires TS IntelliSense to the `wt` API typings.
 */

import {
    docsToMarkdown,
    partsToMarkdown,
    signatureBlock,
    formatSignature,
    mapToFormatted,
    signatureHtml,
    type ColoredText,
    type LinkResolver,
    type QuickInfoLike,
} from "./hoverMarkdown";
import {
    API_TYPINGS_URI,
    commandUri,
    declarationName,
    flattenNavTree,
    indexTypeDeclarations,
    typeRefs,
    type NavTreeItem,
    type Span,
} from "./apiLinks";
import { JSON_FALLBACK_DTS, jsonDeclPath, jsonModuleDts } from "./jsonTypes";
import { packagePaths, TYPINGS_ROOT } from "../shared/packageImports";

let monacoApi: any = null;
let wtApiDts = "";

/** wt-api.d.ts as loaded into IntelliSense (for the read-only Code view) */
export const apiTypingsText = (): string => wtApiDts;

/** the TS worker's compiler options (`ts`: Monaco's typescript namespace or the typescript package) */
export function editorCompilerOptions(ts: { ScriptTarget: any; ModuleKind: any; ModuleResolutionKind: any }): Record<string, any> {
    return {
        // scripts run in current browsers: offer the newest JS/DOM APIs
        // (wt-api.d.ts adds web APIs newer than the bundled TypeScript)
        target: ts.ScriptTarget.ESNext,
        // Monaco passes options straight to the TS API (no tsconfig parsing),
        // so libs must be file names — "dom" alone silently loads nothing
        lib: ["lib.esnext.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
        allowNonTsExtensions: true,
        // scripts import each other by relative path ("./utilities")
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler ?? 100,
        allowImportingTsExtensions: true,
        // data files: `import x from "./mock/a.json"` resolves to the
        // declaration setDataFileTypings puts next to it (a.d.json.ts)
        resolveJsonModule: true,
        // without it TypeScript ignores a .d.json.ts it resolved to (and falls back to "*.json")
        allowArbitraryExtensions: true,
        // each script is its own module: top-level names in different
        // scripts (e.g. two \`const cfg\`) must not collide as globals
        moduleDetection: 3, // ts.ModuleDetectionKind.Force
        noEmit: true,
        // package imports (`https://unpkg.com/x@1.2.3`) → their typings
        // (setPackageTypings). Monaco passes options raw, so the target is an
        // absolute file:/// path rather than one relative to a baseUrl
        paths: packagePaths(`file:///${TYPINGS_ROOT}`),
    };
}

export async function loadMonaco(): Promise<any> {
    if (monacoApi) return monacoApi;

    // Monaco's AMD build wraps workers in a blob URL, which the extension CSP
    // blocks — point it at the real worker file instead.
    (window as any).MonacoEnvironment = {
        getWorkerUrl: () =>
            chrome.runtime.getURL("lib/monaco/vs/base/worker/workerMain.js"),
    };

    wtApiDts = await fetch(chrome.runtime.getURL("lib/wt-api.d.ts")).then((r) => r.text());

    await new Promise<void>((resolve, reject) => {
        (window as any).require.config({ paths: { vs: "lib/monaco/vs" } });
        (window as any).require(["vs/editor/editor.main"], () => resolve(), reject);
    });

    monacoApi = (window as any).monaco;

    monacoApi.languages.typescript.typescriptDefaults.setExtraLibs([
        {
            content: wtApiDts,
            filePath: API_TYPINGS_URI,
        },
        { content: JSON_FALLBACK_DTS, filePath: "file:///__wt__/json-modules.d.ts" },
    ]);
    monacoApi.languages.typescript.typescriptDefaults.setCompilerOptions(editorCompilerOptions(monacoApi.languages.typescript));
    registerTsHover(monacoApi);

    return monacoApi;
}

const dataFileLibs = new Map<string, { content: string; lib: { dispose(): void } }>();

/**
 * Type the data files for the TS worker (text as in the Code view, unsaved
 * edits included): one declaration per file next to it. TypeScript looks it
 * up by the importer's model path, which is %-encoded when a folder has a
 * space — so a path with one gets both spellings. Returns the URIs whose
 * declaration changed or went away.
 */
export function setDataFileTypings(files: { path: string; text: string }[]): string[] {
    const ts = monacoApi.languages.typescript.typescriptDefaults;
    const want = new Map<string, string>();
    const changed: string[] = [];
    for (const f of files) {
        const decl = jsonDeclPath(f.path);
        const content = jsonModuleDts(f.text);
        want.set("file:///" + decl, content);
        want.set(monacoApi.Uri.file("/" + decl).toString(), content);
    }
    for (const [uri, cur] of dataFileLibs) {
        if (want.get(uri) === cur.content) continue;
        cur.lib.dispose();
        dataFileLibs.delete(uri);
        changed.push(uri);
    }
    for (const [uri, content] of want) if (!dataFileLibs.has(uri)) dataFileLibs.set(uri, { content, lib: ts.addExtraLib(content, uri) });
    return changed;
}

const packageLibs = new Map<string, { content: string; lib: { dispose(): void } }>();

/**
 * Type package imports: the stored package typings (path → text, see
 * background/engine/packageImports) as extra libs under
 * `file:///.wiretrick/types/`, where the `paths` compiler option maps
 * package URLs. Monaco re-checks open models when they change.
 */
export function setPackageTypings(files: Record<string, string>): void {
    const ts = monacoApi.languages.typescript.typescriptDefaults;
    const want = new Map(Object.entries(files).map(([p, text]) => [`file:///${TYPINGS_ROOT}/${p}`, text]));
    for (const [uri, cur] of packageLibs) {
        if (want.get(uri) === cur.content) continue;
        cur.lib.dispose();
        packageLibs.delete(uri);
    }
    for (const [uri, content] of want) if (!packageLibs.has(uri)) packageLibs.set(uri, { content, lib: ts.addExtraLib(content, uri) });
}

// TS ScriptElementKind → Monaco CompletionItemKind name (as tsMode.js maps it)
const KIND: Record<string, string> = {
    "primitive type": "Keyword", keyword: "Keyword",
    var: "Variable", "local var": "Variable", let: "Variable", const: "Variable",
    property: "Field", getter: "Field", setter: "Field",
    function: "Function", "local function": "Function", method: "Function", construct: "Function", call: "Function", index: "Function",
    enum: "Enum", module: "Module", class: "Class", interface: "Interface", warning: "File",
};

/** `#rrggbb` of each `mtkN` token class in the current theme */
function tokenColors(): (cls: string) => string | undefined {
    const probe = document.body.appendChild(document.createElement("span"));
    probe.style.display = "none";
    const cache = new Map<string, string | undefined>();
    const color = (cls: string): string | undefined => {
        if (!cache.has(cls)) {
            probe.className = cls;
            const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(probe).color);
            cache.set(cls, m ? "#" + m.slice(1, 4).map((n) => (+n).toString(16).padStart(2, "0")).join("") : undefined);
        }
        return cache.get(cls);
    };
    queueMicrotask(() => probe.remove());
    return color;
}

/** `text` split into runs of one token color, as the Code view highlights it */
async function colorize(monaco: any, text: string): Promise<ColoredText[]> {
    try {
        const html: string = await monaco.editor.colorize(text, "typescript", {});
        const color = tokenColors();
        const out: ColoredText[] = [];
        const walk = (node: Node): void => {
            node.childNodes.forEach((n) => {
                if (n.nodeType === Node.TEXT_NODE) {
                    const cls = /\bmtk\d+\b/.exec((n.parentElement?.className as string) ?? "")?.[0];
                    out.push({ text: n.textContent!.replace(/\u00a0/g, " "), color: cls && color(cls) });
                } else if ((n as Element).tagName === "BR") out.push({ text: "\n" });
                else walk(n);
            });
        };
        walk(new DOMParser().parseFromString(html, "text/html").body);
        // colorize() ends every line with <br/>
        if (out.map((s) => s.text).join("").startsWith(text)) {
            let left = text.length;
            return out.flatMap((s) => {
                const t = s.text.slice(0, Math.max(0, left));
                left -= s.text.length;
                return t ? [{ ...s, text: t }] : [];
            });
        }
    } catch {}
    return [{ text }];
}

const SHOW_TYPE_COMMAND = "wt.hoverShowType";
const HOVER_BACK_COMMAND = "wt.hoverBack";

/** a type the hover drilled into: its name's offset in wt-api.d.ts */
interface Drill {
    label: string;
    start: number;
}
/** kept on each hover we return; Monaco hands it back on the next verbosity request */
interface DrillState {
    root: string;
    range: any;
    stack: Drill[];
}

/**
 * Replace Monaco's TS hover, completion details and parameter hints (they
 * flatten @example/@param into one paragraph and print signatures on one
 * line) with VS Code-style rendering of the same TS worker data.
 *
 * Types from wt-api.d.ts in a hover's signature (and its {@link}s to them)
 * are links that swap the same hover's content for that type's hover, with
 * a Back link. That rides on Monaco's hover verbosity mechanism, the one
 * API that re-asks a provider and redraws a hover part in place; its +/−
 * buttons are hidden in ui.css.
 */
function registerTsHover(monaco: any): void {
    const defaults = monaco.languages.typescript.typescriptDefaults;
    defaults.setModeConfiguration({ ...defaults.modeConfiguration, hovers: false, completionItems: false, signatureHelp: false });
    const workerFor = async (uri: any) => (await monaco.languages.typescript.getTypeScriptWorker())(uri);
    const completionKind = (k: string) => monaco.languages.CompletionItemKind[KIND[k] ?? "Property"];

    // the typings never change at runtime: index their declarations once
    type Declarations = { index: Map<string, Span>; items: NavTreeItem[] };
    let navigation: Promise<Declarations> | null = null;
    const declarations = (worker: any): Promise<Declarations> =>
        (navigation ??= worker
            .getNavigationTree(API_TYPINGS_URI)
            .then((tree: NavTreeItem | undefined) => ({ index: tree ? indexTypeDeclarations(tree) : new Map(), items: tree ? flattenNavTree(tree) : [] }))
            .catch(() => {
                navigation = null;
                return { index: new Map(), items: [] };
            }));

    // ---- drilling into a type inside the open hover ----
    let pending: Drill | "back" | null = null;
    let clickedLink: Element | null = null;
    const rememberLink = (e: Event): void => {
        const a = (e.target as Element | null)?.closest?.(".monaco-hover a");
        if (a) clickedLink = a;
    };
    for (const type of ["click", "auxclick", "keydown"]) document.addEventListener(type, rememberLink, true);
    const redrawHover = (op: Drill | "back"): void => {
        const link = clickedLink;
        clickedLink = null;
        const editors: any[] = monaco.editor.getEditors();
        const hoverOf = (ed: any) => ed.getContribution("editor.contrib.contentHover");
        const ed = (link && editors.find((e) => e.getDomNode()?.contains(link))) ?? editors.find((e) => hoverOf(e)?.isHoverVisible?.());
        if (!ed) return;
        // which part of the hover (diagnostics may come first) holds the link
        const row = link?.closest(".monaco-hover-content > *");
        const index = row ? Array.from(row.parentElement!.children).indexOf(row) : -1;
        pending = op;
        ed.trigger("wt", "editor.action.increaseHoverVerbosityLevel", index >= 0 ? { index, focus: true } : { focus: true });
    };
    monaco.editor.registerCommand(SHOW_TYPE_COMMAND, (_accessor: unknown, to: Drill) => {
        if (to && typeof to.start === "number") redrawHover({ label: String(to.label), start: to.start });
    });
    monaco.editor.registerCommand(HOVER_BACK_COMMAND, () => redrawHover("back"));
    const trusted = { enabledCommands: [SHOW_TYPE_COMMAND, HOVER_BACK_COMMAND] };
    const showType = (label: string, start: number): string => commandUri(SHOW_TYPE_COMMAND, { label, start });

    /** hover contents for quick info: highlighted signature with type links, then docs */
    const hoverContents = async (info: QuickInfoLike, nav: Declarations, inTypings: boolean, self: Span | null, back?: string): Promise<any[]> => {
        const resolveLink: LinkResolver = (name, part) => {
            if (part.target?.fileName !== API_TYPINGS_URI) return undefined;
            const span = declarationName(nav.items, part.target.textSpan);
            // a link title, or Monaco shows the command URI as the tooltip
            return span && `${showType(name, span.start)} "Show ${name.replace(/"/g, "")} here"`;
        };
        const sig = partsToMarkdown(info.displayParts);
        const parts: string[] = [];
        if (back) parts.push(`[← Back to ${back.replace(/[\\[\]*_`<>]/g, "\\$&")}](command:${HOVER_BACK_COMMAND} "Back to the previous hover")`);
        if (sig) {
            const formatted = formatSignature(sig);
            const links = typeRefs(info.displayParts, nav.index, inTypings, self).map((r) => {
                const [start, end] = mapToFormatted(sig, formatted, r.start, r.end);
                return { start, end, href: showType(r.name.slice(r.name.lastIndexOf(".") + 1), r.span.start), title: `Show ${r.name} here` };
            });
            parts.push(signatureHtml(await colorize(monaco, formatted), links));
        }
        const docs = docsToMarkdown(info.documentation, info.tags, undefined, resolveLink);
        return [{ value: parts.join("\n\n"), supportHtml: true, isTrusted: trusted }, ...(docs ? [{ value: docs, isTrusted: trusted }] : [])];
    };

    monaco.languages.registerHoverProvider("typescript", {
        async provideHover(model: any, position: any, _token: unknown, context?: { verbosityRequest?: { previousHover?: any } }) {
            const uri = model.uri;
            const worker = await workerFor(uri);
            if (model.isDisposed()) return null;
            // the signature <pre> takes the Code view's font, like a code block
            const ed = monaco.editor.getEditors().find((e: any) => e.getModel() === model);
            const font = ed?.getOption(monaco.editor.EditorOption.fontInfo)?.fontFamily;
            if (font) document.documentElement.style.setProperty("--wt-hover-code-font", font);

            let stack: Drill[] = [];
            const previous: DrillState | undefined = context?.verbosityRequest?.previousHover?.wtDrill;
            if (context?.verbosityRequest) {
                const op = pending;
                pending = null;
                if (!op || !previous) return null;
                stack = op === "back" ? previous.stack.slice(0, -1) : [...previous.stack, op];
            }
            const nav = await declarations(worker);
            const top = stack[stack.length - 1];
            if (top && previous) {
                const info = await worker.getQuickInfoAtPosition(API_TYPINGS_URI, top.start);
                if (!info || model.isDisposed()) return null;
                const back = stack.length > 1 ? stack[stack.length - 2].label : previous.root;
                const contents = await hoverContents(info, nav, true, { start: top.start, length: 0 }, back);
                return { range: previous.range, contents, canIncreaseVerbosity: true, wtDrill: { ...previous, stack } };
            }

            const offset = model.getOffsetAt(position);
            const [info, defs] = await Promise.all([
                worker.getQuickInfoAtPosition(uri.toString(), offset),
                worker.getDefinitionAtPosition(uri.toString(), offset).catch(() => null),
            ]);
            if (!info || model.isDisposed()) return null;
            const inTypings = uri.toString() === API_TYPINGS_URI;
            // hovering a wt-api.d.ts type: don't link it to itself
            const def = (defs ?? []).find((d: any) => d.fileName === API_TYPINGS_URI);
            const start = model.getPositionAt(info.textSpan.start);
            const end = model.getPositionAt(info.textSpan.start + info.textSpan.length);
            const range = new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column);
            const contents = await hoverContents(info, nav, inTypings, def?.textSpan ?? null);
            if (model.isDisposed()) return null;
            const state: DrillState = { root: previous?.root ?? model.getValueInRange(range), range: previous?.range ?? range, stack: [] };
            return { range, contents, canIncreaseVerbosity: true, wtDrill: state };
        },
    });

    monaco.languages.registerCompletionItemProvider("typescript", {
        triggerCharacters: ["."],
        async provideCompletionItems(model: any, position: any) {
            const word = model.getWordUntilPosition(position);
            const wordRange = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
            const uri = model.uri;
            const offset = model.getOffsetAt(position);
            const worker = await workerFor(uri);
            if (model.isDisposed()) return undefined;
            const info = await worker.getCompletionsAtPosition(uri.toString(), offset);
            if (!info || model.isDisposed()) return undefined;
            return {
                suggestions: info.entries.map((e: any) => {
                    let range = wordRange;
                    if (e.replacementSpan) {
                        const p1 = model.getPositionAt(e.replacementSpan.start);
                        const p2 = model.getPositionAt(e.replacementSpan.start + e.replacementSpan.length);
                        range = new monaco.Range(p1.lineNumber, p1.column, p2.lineNumber, p2.column);
                    }
                    return {
                        uri, offset, range,
                        label: e.name,
                        insertText: e.name,
                        sortText: e.sortText,
                        kind: completionKind(e.kind),
                        tags: e.kindModifiers?.includes("deprecated") ? [monaco.languages.CompletionItemTag.Deprecated] : [],
                    };
                }),
            };
        },
        async resolveCompletionItem(item: any) {
            const worker = await workerFor(item.uri);
            const d = await worker.getCompletionEntryDetails(item.uri.toString(), item.offset, item.label);
            if (!d) return item;
            const docs = docsToMarkdown(d.documentation, d.tags);
            return {
                ...item,
                // signature goes into the docs as a highlighted, wrapped code block
                detail: undefined,
                documentation: { value: [signatureBlock(partsToMarkdown(d.displayParts)), docs].filter(Boolean).join("\n\n") },
            };
        },
    });

    monaco.languages.registerSignatureHelpProvider("typescript", {
        signatureHelpTriggerCharacters: ["(", ","],
        async provideSignatureHelp(model: any, position: any, _token: any, context: any) {
            const uri = model.uri;
            const worker = await workerFor(uri);
            if (model.isDisposed()) return undefined;
            const K = monaco.languages.SignatureHelpTriggerKind;
            const triggerReason =
                context.triggerKind === K.TriggerCharacter && context.triggerCharacter
                    ? { kind: context.isRetrigger ? "retrigger" : "characterTyped", triggerCharacter: context.triggerCharacter }
                    : context.triggerKind === K.ContentChange && context.isRetrigger
                      ? { kind: "retrigger" }
                      : { kind: "invoked" };
            const info = await worker.getSignatureHelpItems(uri.toString(), model.getOffsetAt(position), { triggerReason });
            if (!info || model.isDisposed()) return undefined;
            const text = partsToMarkdown;
            return {
                value: {
                    activeSignature: info.selectedItemIndex,
                    activeParameter: info.argumentIndex,
                    signatures: info.items.map((it: any) => {
                        const sep = text(it.separatorDisplayParts);
                        const parameters = it.parameters.map((p: any) => ({
                            label: text(p.displayParts),
                            documentation: { value: text(p.documentation) },
                        }));
                        return {
                            label: text(it.prefixDisplayParts) + parameters.map((p: any) => p.label).join(sep) + text(it.suffixDisplayParts),
                            parameters,
                            // @param text is already shown per parameter
                            documentation: { value: docsToMarkdown(it.documentation, it.tags, (t) => t.name === "param") },
                        };
                    }),
                },
                dispose() {},
            };
        },
    });
}

export const STARTER_TEMPLATE = `wt.about("What this script does");

// Adjustable parameters (editable in settings.yaml / the popup ⚙ dialog):
const cfg = wt.params({
    host: { type: "string", default: "*.example.com", description: "Host pattern to intercept" },
    debug: { type: "boolean", default: true, description: "Log every request" },
});

// Each handler takes its own URL pattern (string, string[] or a route object).
// Modify request headers / redirect / cancel:
wt.onRequest(\`*://\${cfg.host}/*\`, (ctx) => {
    if (cfg.debug) wt.log("request to", ctx.url);
    // return { redirect: "https://example.com/other" };
    // return { block: true };
    // return { headers: { set: { "x-debug": "1" } } };
});

// Modify response headers:
// wt.onResponseHeaders(\`*://\${cfg.host}/*\`, (ctx) => ({ headers: { set: { "access-control-allow-origin": "*" } } }));

// Replace the whole response body:
// wt.replaceResponse(\`*://\${cfg.host}/api/*\`, (ctx) => ({ mocked: true }));

// Modify the response body (route object: exclude / methods / types / strategy):
// wt.onResponseBody({ url: \`*://\${cfg.host}/*\`, exclude: "*://*/*.png", strategy: "page" }, (ctx, body) => body.replace("foo", "bar"));
`;
