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

/** the strategies a sample's routes name, then "overlay" when it draws one ("onPage" when it has only page handlers) */
export function sampleStrategies(code: string): string[] {
    const out = new Set<string>();
    for (const route of code.matchAll(/strategy:([^}\n]*)/g)) for (const name of route[1].matchAll(/"(\w+)"/g)) out.add(name[1]);
    const list = [...out].sort();
    if (code.includes("wt.onOverlay(")) list.push("overlay");
    if (!list.length && /wt\.on(Page|Site)\(/.test(code)) list.push("onPage");
    return list;
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
wt.metadata({ description: "Cat → Dog on Wikipedia" });

wt.onRequest({ url: "*://en.wikipedia.org/wiki/Cat", strategy: "rules" }, () => ({
    redirect: "https://en.wikipedia.org/wiki/Dog",
}));`,
    },
    {
        name: "Block requests",
        blurb: "Block matching requests — here only images, via the route's resourceTypes filter. Try it: open any Wikipedia article — every image is gone.",
        code: `// Try it: open https://en.wikipedia.org/wiki/Cat
wt.metadata({ description: "Block Wikipedia images" });

wt.onRequest({ url: "*://upload.wikimedia.org/*", resourceTypes: ["image"], strategy: "rules" }, () => ({ block: true }));`,
    },
    {
        name: "Modify request headers",
        blurb: "Set or remove request headers before they leave the browser. Try it: postman-echo.com/headers echoes them back.",
        code: `// Try it: open https://postman-echo.com/headers
wt.metadata({ description: "Add debug headers, drop Accept-Language" });

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
wt.metadata({ description: "Let any origin read example.com" });

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

wt.onPage("*://example.org/*", () => {
    // add it as the page's own <script>
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
wt.metadata({ description: "Replace the users API response" });

// "page" sees the page's own fetch/XHR calls (not the URL typed in the address bar)
wt.replaceResponse({ url: "*://dummyjson.com/users/:id", strategy: "page" }, (ctx) => ({
    id: Number(ctx.groups.id),
    name: "Mocked User",
    role: "admin",
}));

// the demo: a fetch made from dummyjson.com's own JavaScript world (wt.onSite, so the "page" strategy sees it),
// once the DOM is ready (onSite runs before the site's own scripts by default; it draws here)
wt.onSite({ url: "https://dummyjson.com/", when: "document_end" }, async () => {
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
wt.metadata({ description: "Mark every todo completed" });

wt.onResponseBody({ url: "*://dummyjson.com/todos/*", strategy: "page" }, (ctx, body) => {
    const json = JSON.parse(typeof body === "string" ? body : new TextDecoder().decode(body));
    json.completed = true;
    json.todo = "Transformed by Wiretrick";
    return JSON.stringify(json, null, 2);
});

// the demo: a fetch made from dummyjson.com's own JavaScript world (wt.onSite, so the "page" strategy sees it),
// once the DOM is ready (onSite runs before the site's own scripts by default; it draws here)
wt.onSite({ url: "https://dummyjson.com/", when: "document_end" }, async () => {
    const out = document.createElement("pre");
    out.style.cssText = "margin: 0; padding: 8px; font: 14px monospace; color: #fff; background: #27a";
    document.body.prepend(out);
    const todo = await fetch("/todos/1").then((r) => r.json());
    out.textContent = 'fetch("/todos/1") → ' + JSON.stringify(todo);
});`,
    },
    {
        name: "Rewrite page HTML",
        blurb: "Transform the document itself. Needs a strategy that reads page bodies: debugger on Chrome (shows Chrome's \"being debugged\" bar), extension on Firefox — not page. For title/DOM tweaks, onPage needs neither. Try it: open example.com — a red banner appears.",
        code: `// Try it: open https://example.com/
wt.metadata({ description: "Rewrite example.com's HTML" });

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
wt.metadata({ description: "Retitle Wikipedia articles" });

wt.onPage("*://en.wikipedia.org/wiki/*", () => {
    document.title = "🎯 " + document.title;
    const el = document.querySelector("h1");
    if (el) el.textContent = "Hello from Wiretrick";
});`,
    },
    {
        name: "Serve a local file",
        blurb: "Replace a response with file content (path or data: URL). The page loads it itself, so this uses debugger on Chrome (shows Chrome's \"being debugged\" bar), extension on Firefox. Try it: open en.wikipedia.org/robots.txt.",
        code: `// Try it: open https://en.wikipedia.org/robots.txt
wt.metadata({ description: "Serve our own robots.txt" });

// Chrome shows its "being debugged" bar while the debugger strategy is attached
wt.replaceResponse({ url: "*://en.wikipedia.org/robots.txt", strategy: wt.isFirefox ? "extension" : "debugger" }, () => ({
    file: "data:text/plain;base64," + btoa("Served by Wiretrick instead of the real robots.txt"),
}));`,
    },
    {
        name: "Overlay panel (React + wt.globalStore)",
        blurb: "Give a script its own GUI on the page: a React panel in an overlay that flips a mock on and off through a shared wt.globalStore, and asks the page to fetch through it. Try it: open dummyjson.com — use the panel at the bottom right.",
        code: `// Try it: open https://dummyjson.com/ — tick and untick "Mock /users/1" in
// the panel at the bottom right, then click Fetch
import { useState } from "react";
import { useSnapshot } from "valtio";

wt.metadata({ description: "A panel that turns a mock on and off" });

// one live object for the handler and the panel; it survives restarts
const mock = wt.globalStore("mock", { enabled: true });

wt.replaceResponse({ url: "*://dummyjson.com/users/:id", strategy: "page" }, (ctx) =>
    mock.enabled ? { id: Number(ctx.groups.id), firstName: "Mocked", lastName: "User" } : undefined
);

// functions the panel calls in the site's own world (the "page" strategy sees only the site's own fetches)
const site = wt.onSite("https://dummyjson.com/*", () => ({
    user: () => fetch("/users/1").then((r) => r.json()),
}));

// the panel, drawn in this script's overlay: the page can't see or restyle it
wt.onOverlay("https://dummyjson.com/*", (ctx) => {
    function Panel() {
        const snap = useSnapshot(mock);
        const [user, setUser] = useState("");
        const fetchUser = async () => {
            const u = await site.user();
            setUser(u.firstName + " " + u.lastName);
        };
        return (
            <div style={{ position: "fixed", right: 16, bottom: 16, display: "grid", gap: 8, padding: 12, font: "14px system-ui", background: "#fff", border: "1px solid #ccc", borderRadius: 8, boxShadow: "0 2px 8px #0003" }}>
                <label>
                    <input id="wt-mock" type="checkbox" checked={snap.enabled} onChange={() => (mock.enabled = !mock.enabled)} /> Mock /users/1
                </label>
                <button id="wt-fetch" onClick={fetchUser}>Fetch /users/1</button>
                <output id="wt-user">{user}</output>
            </div>
        );
    }
    // one panel, re-rendered in place when you save the script
    ctx.mount(<Panel />);
});`,
    },
    {
        name: "Overlay outline (calls + shortcut)",
        blurb: "An overlay that asks the page for its headings and scrolls it on click — wt.onPage returns functions, the overlay awaits them — with a keyboard shortcut to hide it. Try it: open any Wikipedia article and press Alt+Shift+O.",
        code: `// Try it: open https://en.wikipedia.org/wiki/Cat — press Alt+Shift+O to hide
// or show the outline
wt.metadata({ description: "Floating outline for Wikipedia articles" });

// runs in the page (isolated world); returns the functions the overlay calls
const page = wt.onPage("*://en.wikipedia.org/wiki/*", () => {
    const headings = () => document.querySelectorAll("#mw-content-text h2");
    return {
        titles: () => [...headings()].map((h) => h.textContent ?? ""),
        scrollTo: (i: number) => {
            headings()[i]?.scrollIntoView({ behavior: "smooth" });
        },
    };
});

// runs in this script's overlay; ctx.mount keeps one outline across saves
wt.onOverlay("*://en.wikipedia.org/wiki/*", async (ctx) => {
    const titles = await page.titles(); // string[], typed from the onPage handler
    let hidden = false;
    const render = () =>
        ctx.mount(
            <nav id="wt-outline" hidden={hidden} style={{ position: "fixed", right: 16, top: 80, maxHeight: "70vh", overflow: "auto", padding: "8px 12px", font: "13px system-ui", background: "#fff", border: "1px solid #ccc", borderRadius: 8, boxShadow: "0 2px 8px #0003" }}>
                {titles.map((title, i) => (
                    <a key={i} href="#" style={{ display: "block", padding: "2px 0", color: "#36c", textDecoration: "none" }} onClick={(e) => (e.preventDefault(), void page.scrollTo(i))}>
                        {title}
                    </a>
                ))}
            </nav>
        );
    render();
    ctx.shortcut("Alt+Shift+O", () => {
        hidden = !hidden;
        render();
    });
});`,
    },
    {
        name: "Watch and mock the site's fetch (wt.siteStore)",
        blurb: "Share state with the site's own JavaScript: onSite code wraps the site's fetch, records the last URL and mocks /users/1 when the panel's switch is on — all through a wt.siteStore the overlay sees live. Try it: open dummyjson.com — use the panel at the bottom left.",
        code: `// Try it: open https://dummyjson.com/ — click Fetch, then tick "Mock /users/1"
// in the panel at the bottom left and click Fetch again
import { useState } from "react";
import { useSnapshot } from "valtio";

wt.metadata({ description: "Watch and mock the site's own fetch from a panel" });

// lives in the site's world: onSite code reads it synchronously, the panel gets a
// live copy. It's page data — the site can read and change it too
const shared = wt.siteStore("shared", { mock: false, lastUrl: "" });

const site = wt.onSite("https://dummyjson.com/*", (ctx) => {
    const realFetch = window.fetch;
    window.fetch = (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        shared.lastUrl = url;
        if (shared.mock && url.endsWith("/users/1")) return Promise.resolve(Response.json({ firstName: "Mocked", lastName: "User" }));
        return realFetch(input, init);
    };
    // a save runs this again: put the site's fetch back first
    ctx.signal.addEventListener("abort", () => (window.fetch = realFetch));
    return { user: () => window.fetch("/users/1").then((r) => r.json()) };
});

wt.onOverlay("https://dummyjson.com/*", (ctx) => {
    function Panel() {
        const snap = useSnapshot(shared);
        const [user, setUser] = useState("");
        const fetchUser = async () => {
            const u = await site.user();
            setUser(u.firstName + " " + u.lastName);
        };
        return (
            <div style={{ position: "fixed", left: 16, bottom: 16, display: "grid", gap: 8, padding: 12, font: "14px system-ui", background: "#fff", border: "1px solid #ccc", borderRadius: 8, boxShadow: "0 2px 8px #0003" }}>
                <label>
                    <input id="wt-site-mock" type="checkbox" checked={snap.mock} onChange={() => (shared.mock = !shared.mock)} /> Mock /users/1
                </label>
                <button id="wt-site-fetch" onClick={fetchUser}>Fetch /users/1</button>
                <output id="wt-site-user">{user}</output>
                <small id="wt-site-last">Last fetch: {snap.lastUrl || "none yet"}</small>
            </div>
        );
    }
    ctx.mount(<Panel />);
});`,
    },
    {
        name: "Per-script storage",
        blurb: "Keep state between page loads with wt.storage. Try it: open any Wikipedia article and reload — the counter at the top goes up.",
        code: `// Try it: open https://en.wikipedia.org/wiki/Cat and reload a few times
wt.metadata({ description: "Count Wikipedia article visits" });

wt.onPage("*://en.wikipedia.org/wiki/*", async (ctx) => {
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
wt.metadata({ description: "Send the knobs as request headers" });

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
