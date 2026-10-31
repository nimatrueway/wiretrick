/** Bundled sample scripts, offered as one-click inserts. */

export interface SampleScript {
    name: string;
    blurb: string;
    code: string;
}

/** the page a sample's "// Try it: open https://…" line names */
export function sampleTryUrl(code: string): string | null {
    return code.match(/\/\/ Try it: open (https:\/\/\S+)/)?.[1] ?? null;
}

/** the strategies a sample's routes name ("onDocument" when it has only DOM handlers) */
export function sampleStrategies(code: string): string[] {
    const out = new Set<string>();
    for (const route of code.matchAll(/strategy:([^}\n]*)/g)) for (const name of route[1].matchAll(/"(\w+)"/g)) out.add(name[1]);
    if (!out.size && code.includes("wt.onDocument(")) out.add("onDocument");
    return [...out].sort();
}

/** a sample's blurb without its "Try it: …" sentence */
export function sampleSummary(blurb: string): string {
    return blurb.replace(/\s*Try it:.*$/s, "");
}

// Every sample targets a long-lived public site and names a URL to open so
// the effect is visible right away. None needs the local helper: each handler
// names a built-in strategy ("rules", "page", or "debugger"/"extension" for the
// two that must change the page itself).
export const SAMPLES: SampleScript[] = [
    {
        name: "Redirect a URL",
        blurb: "Send any request to a different URL — a browser-native rule (strategy \"rules\"): no banner, nothing to install. Try it: open en.wikipedia.org/wiki/Cat — you land on Dog.",
        code: `// Try it: open https://en.wikipedia.org/wiki/Cat
wt.about("Cat → Dog on Wikipedia");

wt.onRequest({ url: "*://en.wikipedia.org/wiki/Cat", strategy: "rules" }, () => ({
    redirect: "https://en.wikipedia.org/wiki/Dog",
}));`,
    },
    {
        name: "Block requests",
        blurb: "Block matching requests — here only images, via the route's resourceTypes filter. Try it: open any Wikipedia article — every image is gone.",
        code: `// Try it: open https://en.wikipedia.org/wiki/Cat
wt.about("Block Wikipedia images");

wt.onRequest({ url: "*://upload.wikimedia.org/*", resourceTypes: ["image"], strategy: "rules" }, () => ({ block: true }));`,
    },
    {
        name: "Modify request headers",
        blurb: "Set or remove request headers before they leave the browser. Try it: postman-echo.com/headers echoes them back.",
        code: `// Try it: open https://postman-echo.com/headers
wt.about("Add debug headers, drop Accept-Language");

wt.onRequest({ url: "*://postman-echo.com/*", strategy: "rules" }, () => ({
    headers: {
        set: { "x-debug": "1", "x-greeting": "hello from Wiretrick" },
        remove: ["accept-language"],
    },
}));`,
    },
    {
        name: "CORS unlock",
        blurb: "Add permissive response headers so other pages can consume a resource. Try it: open example.org — a line at the top shows whether it could read example.com.",
        code: `// Try it: open https://example.org/ — a line at the top says whether the
// page could read https://example.com/. Comment out the onResponseHeaders
// handler, save and reload to see the browser block it with a CORS error.
wt.about("Let any origin read example.com");

wt.onResponseHeaders({ url: "*://example.com/*", strategy: "rules" }, () => ({
    headers: {
        set: {
            "access-control-allow-origin": "*",
            "access-control-allow-headers": "*",
        },
    },
}));

// the demo: example.org's own page code fetches example.com
// (plain JS only: it runs as page code, without the script compiler's helpers)
function demo() {
    if (document.getElementById("wt-cors-demo")) return;
    const out = document.createElement("p");
    out.id = "wt-cors-demo";
    out.style.cssText = "font: bold 16px system-ui; padding: 8px; color: #fff; background: #555";
    out.textContent = "Reading https://example.com/ …";
    document.body.prepend(out);
    fetch("https://example.com/")
        .then((r) => r.text())
        .then((html) => {
            const title = html.match(/<title>(.*?)<\\/title>/);
            out.textContent = "✓ Read example.com: " + (title ? title[1] : html.length + " bytes");
            out.style.background = "#2a7";
        })
        .catch(() => {
            out.textContent = "✗ Blocked by CORS (see the console)";
            out.style.background = "#c33";
        });
}

wt.onDocument("*://example.org/*", () => {
    // run in the page itself (an onDocument handler runs beside it, in the extension)
    const s = document.createElement("script");
    s.textContent = \`(\${demo})()\`;
    document.head.append(s);
});`,
    },
    {
        name: "Replace a fetch/XHR response",
        blurb: "Replace a JSON API response the page's own code fetches (strategy \"page\": no banner, nothing to install); :id in the route is read back as ctx.groups.id. Try it: open dummyjson.com — a box at the top shows what /users/1 returned.",
        code: `// Try it: open https://dummyjson.com/ — a box at the top shows what the
// page got from /users/1. Disable the script and reload to see the real user.
wt.about("Replace the users API response");

// "page" sees the page's own fetch/XHR calls (not the URL typed in the address bar)
wt.replaceResponse({ url: "*://dummyjson.com/users/:id", strategy: "page" }, (ctx) => ({
    id: Number(ctx.groups.id),
    name: "Mocked User",
    role: "admin",
}));

// the demo: a fetch made from dummyjson.com's own page
wt.onDocument("https://dummyjson.com/", async () => {
    const out = document.createElement("pre");
    out.style.cssText = "margin: 0; padding: 8px; font: 14px monospace; color: #fff; background: #2a7";
    document.body.prepend(out);
    const user = await fetch("/users/1").then((r) => r.json());
    out.textContent = 'fetch("/users/1") → ' + JSON.stringify(user);
});`,
    },
    {
        name: "Transform an API response",
        blurb: "Modify a JSON body the page's own code fetches — flip fields, inject values (strategy \"page\"). Try it: open dummyjson.com — a box at the top shows what /todos/1 returned.",
        code: `// Try it: open https://dummyjson.com/ — a box at the top shows what the
// page got from /todos/1. Disable the script and reload to see the real todo.
wt.about("Mark every todo completed");

wt.onResponseBody({ url: "*://dummyjson.com/todos/*", strategy: "page" }, (ctx, body) => {
    const json = JSON.parse(typeof body === "string" ? body : new TextDecoder().decode(body));
    json.completed = true;
    json.todo = "Transformed by Wiretrick";
    return JSON.stringify(json, null, 2);
});

// the demo: a fetch made from dummyjson.com's own page
wt.onDocument("https://dummyjson.com/", async () => {
    const out = document.createElement("pre");
    out.style.cssText = "margin: 0; padding: 8px; font: 14px monospace; color: #fff; background: #27a";
    document.body.prepend(out);
    const todo = await fetch("/todos/1").then((r) => r.json());
    out.textContent = 'fetch("/todos/1") → ' + JSON.stringify(todo);
});`,
    },
    {
        name: "Rewrite page HTML",
        blurb: "Transform the document itself. Needs a strategy that reads page bodies: debugger on Chrome (shows Chrome's \"being debugged\" bar), extension on Firefox — not page. For title/DOM tweaks, onDocument needs neither. Try it: open example.com — a red banner appears.",
        code: `// Try it: open https://example.com/
wt.about("Rewrite example.com's HTML");

// Chrome shows its "being debugged" bar while the debugger strategy is attached
wt.onResponseBody({ url: "*://example.com/*", resourceTypes: ["main_frame"], strategy: wt.isFirefox ? "extension" : "debugger" }, (ctx, body) => {
    const html = typeof body === "string" ? body : new TextDecoder().decode(body);
    return html
        .replace("<title>Example Domain", "<title>Rewritten Domain")
        .replace(/<body[^>]*>/i, (tag) => tag + '<h1 style="color:#c00">Rewritten by Wiretrick</h1>');
});`,
    },
    {
        name: "DOM / title changes",
        blurb: "Runs at DOM-ready in the page. Best for titles and DOM text — works even when the HTML is service-worker served or hydration re-renders it. Try it: open any Wikipedia article.",
        code: `// Try it: open https://en.wikipedia.org/wiki/Cat
wt.about("Retitle Wikipedia articles");

wt.onDocument("*://en.wikipedia.org/wiki/*", () => {
    document.title = "🎯 " + document.title;
    const el = document.querySelector("h1");
    if (el) el.textContent = "Hello from Wiretrick";
});`,
    },
    {
        name: "Serve a local file",
        blurb: "Replace a response with file content (path or data: URL). The page loads it itself, so this uses debugger on Chrome (shows Chrome's \"being debugged\" bar), extension on Firefox. Try it: open en.wikipedia.org/robots.txt.",
        code: `// Try it: open https://en.wikipedia.org/robots.txt
wt.about("Serve our own robots.txt");

// Chrome shows its "being debugged" bar while the debugger strategy is attached
wt.replaceResponse({ url: "*://en.wikipedia.org/robots.txt", strategy: wt.isFirefox ? "extension" : "debugger" }, () => ({
    file: "data:text/plain;base64," + btoa("Served by Wiretrick instead of the real robots.txt"),
}));`,
    },
    {
        name: "Per-script storage",
        blurb: "Keep state between page loads with wt.storage. Try it: open any Wikipedia article and reload — the counter at the top goes up.",
        code: `// Try it: open https://en.wikipedia.org/wiki/Cat and reload a few times
wt.about("Count Wikipedia article visits");

wt.onDocument("*://en.wikipedia.org/wiki/*", async (ctx) => {
    const visits = ((await wt.storage.get("visits")) || 0) + 1;
    await wt.storage.set("visits", visits);
    wt.log("visit #" + visits, ctx.url);
    const out = document.createElement("p");
    out.id = "wt-visits";
    out.style.cssText = "margin: 0; padding: 8px; font: bold 16px system-ui; color: #fff; background: #555";
    out.textContent = "Wikipedia articles opened with this script on: " + visits;
    document.body.prepend(out);
});`,
    },
    {
        name: "Parameters (wt.params)",
        blurb: "Adjustable knobs (wt.params) the user changes from the popup's ⚙ dialog — no code edits. Try it: open postman-echo.com/headers — the knobs come back as x-* headers.",
        code: `// Try it: open https://postman-echo.com/headers, then change
// the knobs from the popup's ⚙ dialog and reload
wt.about("Send the knobs as request headers");

const cfg = wt.params({
    greeting: { type: "string", default: "hello", description: "Sent as x-greeting" },
    mode: { type: "enum", choices: ["dev", "staging", "prod"], default: "dev", description: "Sent as x-mode" },
    retries: { type: "number", default: 3, min: 0, max: 10, description: "Sent as x-retries" },
    debug: { type: "boolean", default: true, description: "Send x-debug: 1" },
    tags: { type: "stringList", default: ["wiretrick"], description: "Sent comma-separated as x-tags" },
});

// "rules" runs the handler once and turns its result into a browser rule;
// changing a knob reloads the script, so the rule picks the new values up
wt.onRequest({ url: "*://postman-echo.com/headers", strategy: "rules" }, () => ({
    headers: {
        set: {
            "x-greeting": cfg.greeting,
            "x-mode": cfg.mode,
            "x-retries": String(cfg.retries),
            ...(cfg.tags.length ? { "x-tags": cfg.tags.join(",") } : {}),
            ...(cfg.debug ? { "x-debug": "1" } : {}),
        },
    },
}));`,
    },
];
