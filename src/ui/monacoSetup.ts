/**
 * Monaco loader + editor configuration. Uses the classic AMD build (copied
 * into dist/lib/monaco) and wires TS IntelliSense to the `res` API typings.
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

    const resApiDts = await fetch(chrome.runtime.getURL("lib/res-api.d.ts")).then((r) => r.text());

    await new Promise<void>((resolve, reject) => {
        (window as any).require.config({ paths: { vs: "lib/monaco/vs" } });
        (window as any).require(["vs/editor/editor.main"], () => resolve(), reject);
    });

    monacoApi = (window as any).monaco;

    monacoApi.languages.typescript.typescriptDefaults.setExtraLibs([
        {
            content: resApiDts,
            filePath: "file:///res-api.d.ts",
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

export const STARTER_TEMPLATE = `res.declareScript({
    name: "My first script",
    match: ["*://*.example.com/*"],
});
// Declarative meta + adjustable parameters (type-safe; editable from
// the popup's ⚙ dialog without touching this code):
const cfg = res.declareScript({
    match: ["*://*.example.com/*"],
    params: {
        debug: { type: "boolean", default: true, description: "Log every request" },
        headerValue: { type: "string", default: "1", description: "Value of the x-debug header" },
    },
});

// Modify request headers / redirect / cancel:
res.onRequest((ctx) => {
    if (cfg.debug) res.log("request to", ctx.url);
    // return { redirect: "https://example.com/other" };
    // return { cancel: true };
    // return { headers: { set: { "x-debug": cfg.headerValue } } };
});

// Modify response headers:
res.onResponseHeaders((ctx) => {
    // return { headers: { set: { "access-control-allow-origin": "*" } } };
});

// Replace the whole response body:
// res.replaceResponse((ctx) => JSON.stringify({ mocked: true }));

// Stream-modify the response body:
// res.modifyResponse((ctx, body) => body.replace("foo", "bar"));
`;
