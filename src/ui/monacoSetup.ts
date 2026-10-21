/**
 * Monaco loader + editor configuration. Uses the classic AMD build (copied
 * into dist/lib/monaco) and wires TS IntelliSense to the `wt` API typings.
 */

import { quickInfoToMarkdown, docsToMarkdown, partsToMarkdown, signatureBlock } from "./hoverMarkdown";

let monacoApi: any = null;

export async function loadMonaco(): Promise<any> {
    if (monacoApi) return monacoApi;

    // Monaco's AMD build wraps workers in a blob URL, which the extension CSP
    // blocks — point it at the real worker file instead.
    (window as any).MonacoEnvironment = {
        getWorkerUrl: () =>
            chrome.runtime.getURL("lib/monaco/vs/base/worker/workerMain.js"),
    };

    const wtApiDts = await fetch(chrome.runtime.getURL("lib/wt-api.d.ts")).then((r) => r.text());

    await new Promise<void>((resolve, reject) => {
        (window as any).require.config({ paths: { vs: "lib/monaco/vs" } });
        (window as any).require(["vs/editor/editor.main"], () => resolve(), reject);
    });

    monacoApi = (window as any).monaco;

    monacoApi.languages.typescript.typescriptDefaults.setExtraLibs([
        {
            content: wtApiDts,
            filePath: "file:///wt-api.d.ts",
        },
    ]);
    const ts = monacoApi.languages.typescript;
    monacoApi.languages.typescript.typescriptDefaults.setCompilerOptions({
        target: ts.ScriptTarget.ES2020,
        // Monaco passes options straight to the TS API (no tsconfig parsing),
        // so libs must be file names — "dom" alone silently loads nothing
        lib: ["lib.es2020.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
        allowNonTsExtensions: true,
        // scripts import each other by relative path ("./utilities")
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler ?? 100,
        allowImportingTsExtensions: true,
        // each script is its own module: top-level names in different
        // scripts (e.g. two \`const cfg\`) must not collide as globals
        moduleDetection: 3, // ts.ModuleDetectionKind.Force
        noEmit: true,
    });
    registerTsHover(monacoApi);

    return monacoApi;
}

// TS ScriptElementKind → Monaco CompletionItemKind name (as tsMode.js maps it)
const KIND: Record<string, string> = {
    "primitive type": "Keyword", keyword: "Keyword",
    var: "Variable", "local var": "Variable", let: "Variable", const: "Variable",
    property: "Field", getter: "Field", setter: "Field",
    function: "Function", "local function": "Function", method: "Function", construct: "Function", call: "Function", index: "Function",
    enum: "Enum", module: "Module", class: "Class", interface: "Interface", warning: "File",
};

/**
 * Replace Monaco's TS hover, completion details and parameter hints (they
 * flatten @example/@param into one paragraph and print signatures on one
 * line) with VS Code-style rendering of the same TS worker data.
 */
function registerTsHover(monaco: any): void {
    const defaults = monaco.languages.typescript.typescriptDefaults;
    defaults.setModeConfiguration({ ...defaults.modeConfiguration, hovers: false, completionItems: false, signatureHelp: false });
    const workerFor = async (uri: any) => (await monaco.languages.typescript.getTypeScriptWorker())(uri);
    const completionKind = (k: string) => monaco.languages.CompletionItemKind[KIND[k] ?? "Property"];

    monaco.languages.registerHoverProvider("typescript", {
        async provideHover(model: any, position: any) {
            const uri = model.uri;
            const worker = await workerFor(uri);
            if (model.isDisposed()) return null;
            const info = await worker.getQuickInfoAtPosition(uri.toString(), model.getOffsetAt(position));
            if (!info || model.isDisposed()) return null;
            const start = model.getPositionAt(info.textSpan.start);
            const end = model.getPositionAt(info.textSpan.start + info.textSpan.length);
            return {
                range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
                contents: quickInfoToMarkdown(info).map((value) => ({ value })),
            };
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

export const STARTER_TEMPLATE = `wt.declareScript({
    match: ["*://*.example.com/*"],
});
// Declarative meta + adjustable parameters (type-safe; editable from
// the popup's ⚙ dialog without touching this code):
const cfg = wt.declareScript({
    match: ["*://*.example.com/*"],
    params: {
        debug: { type: "boolean", default: true, description: "Log every request" },
        headerValue: { type: "string", default: "1", description: "Value of the x-debug header" },
    },
});

// Modify request headers / redirect / cancel:
wt.onRequest((ctx) => {
    if (cfg.debug) wt.log("request to", ctx.url);
    // return { redirect: "https://example.com/other" };
    // return { cancel: true };
    // return { headers: { set: { "x-debug": cfg.headerValue } } };
});

// Modify response headers:
wt.onResponseHeaders((ctx) => {
    // return { headers: { set: { "access-control-allow-origin": "*" } } };
});

// Replace the whole response body:
// wt.replaceResponse((ctx) => JSON.stringify({ mocked: true }));

// Stream-modify the response body:
// wt.modifyResponse((ctx, body) => body.replace("foo", "bar"));
`;
