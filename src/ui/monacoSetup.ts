/**
 * Monaco loader + editor configuration. Uses the classic AMD build (copied
 * into dist/lib/monaco) and wires TS IntelliSense to the `wt` API typings.
 */

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
        lib: ["es2020", "dom"],
        allowNonTsExtensions: true,
        // scripts import each other by relative path ("./utilities")
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler ?? 100,
        allowImportingTsExtensions: true,
        noEmit: true,
    });

    return monacoApi;
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
