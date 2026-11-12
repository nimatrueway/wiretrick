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
    if (code.includes("tt.onOverlay(")) list.push("overlay");
    if (!list.length && /tt\.on(Page|Site)\(/.test(code)) list.push("onPage");
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
tt.metadata({ description: "Cat → Dog on Wikipedia" });

tt.onRequest({ url: "*://en.wikipedia.org/wiki/Cat", strategy: "rules" }, () => ({
    redirect: "https://en.wikipedia.org/wiki/Dog",
}));`,
    },
    {
        name: "Block requests",
        blurb: "Block matching requests — here only images, via the route's resourceTypes filter. Try it: open any Wikipedia article — every image is gone.",
        code: `// Try it: open https://en.wikipedia.org/wiki/Cat
tt.metadata({ description: "Block Wikipedia images" });

tt.onRequest({ url: "*://upload.wikimedia.org/*", resourceTypes: ["image"], strategy: "rules" }, () => ({ block: true }));`,
    },
    {
        name: "Modify request headers",
        blurb: "Set or remove request headers before they leave the browser. Try it: postman-echo.com/headers echoes them back.",
        code: `// Try it: open https://postman-echo.com/headers
tt.metadata({ description: "Add debug headers, drop Accept-Language" });

tt.onRequest({ url: "*://postman-echo.com/*", strategy: "rules" }, () => ({
    headers: {
        set: { "x-debug": "1", "x-greeting": "hello from TangiTweak" },
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
tt.metadata({ description: "Let any origin read example.com" });

tt.onResponseHeaders({ url: "*://example.com/*", strategy: "rules" }, () => ({
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
    if (document.getElementById("tt-cors-demo")) return;
    const out = document.createElement("p");
    out.id = "tt-cors-demo";
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

tt.onPage("*://example.org/*", () => {
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
tt.metadata({ description: "Replace the users API response" });

// "page" sees the page's own fetch/XHR calls (not the URL typed in the address bar)
tt.replaceResponse({ url: "*://dummyjson.com/users/:id", strategy: "page" }, (ctx) => ({
    id: Number(ctx.groups.id),
    name: "Mocked User",
    role: "admin",
}));

// the demo: a fetch made from dummyjson.com's own JavaScript world (tt.onSite, so the "page" strategy sees it),
// once the DOM is ready (onSite runs before the site's own scripts by default; it draws here)
tt.onSite({ url: "https://dummyjson.com/", when: "document_end" }, async () => {
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
tt.metadata({ description: "Mark every todo completed" });

tt.onResponseBody({ url: "*://dummyjson.com/todos/*", strategy: "page" }, (ctx, body) => {
    const json = JSON.parse(typeof body === "string" ? body : new TextDecoder().decode(body));
    json.completed = true;
    json.todo = "Transformed by TangiTweak";
    return JSON.stringify(json, null, 2);
});

// the demo: a fetch made from dummyjson.com's own JavaScript world (tt.onSite, so the "page" strategy sees it),
// once the DOM is ready (onSite runs before the site's own scripts by default; it draws here)
tt.onSite({ url: "https://dummyjson.com/", when: "document_end" }, async () => {
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
tt.metadata({ description: "Rewrite example.com's HTML" });

// Chrome shows its "being debugged" bar while the debugger strategy is attached
tt.onResponseBody({ url: "*://example.com/*", resourceTypes: ["main_frame"], strategy: tt.isFirefox ? "extension" : "debugger" }, (ctx, body) => {
    const html = typeof body === "string" ? body : new TextDecoder().decode(body);
    return html
        .replace("<title>Example Domain", "<title>Rewritten Domain")
        .replace(/<body[^>]*>/i, (tag) => tag + '<h1 style="color:#c00">Rewritten by TangiTweak</h1>');
});`,
    },
    {
        name: "DOM / title changes",
        blurb: "Runs at DOM-ready in the page. Best for titles and DOM text — works even when the HTML is service-worker served or hydration re-renders it. Try it: open any Wikipedia article.",
        code: `// Try it: open https://en.wikipedia.org/wiki/Cat
tt.metadata({ description: "Retitle Wikipedia articles" });

tt.onPage("*://en.wikipedia.org/wiki/*", () => {
    document.title = "🎯 " + document.title;
    const el = document.querySelector("h1");
    if (el) el.textContent = "Hello from TangiTweak";
});`,
    },
    {
        name: "Serve a local file",
        blurb: "Replace a response with file content (path or data: URL). The page loads it itself, so this uses debugger on Chrome (shows Chrome's \"being debugged\" bar), extension on Firefox. Try it: open en.wikipedia.org/robots.txt.",
        code: `// Try it: open https://en.wikipedia.org/robots.txt
tt.metadata({ description: "Serve our own robots.txt" });

// Chrome shows its "being debugged" bar while the debugger strategy is attached
tt.replaceResponse({ url: "*://en.wikipedia.org/robots.txt", strategy: tt.isFirefox ? "extension" : "debugger" }, () => ({
    file: "data:text/plain;base64," + btoa("Served by TangiTweak instead of the real robots.txt"),
}));`,
    },
    {
        name: "Overlay panel (React + tt.globalStore)",
        blurb: "Give a script its own GUI on the page: a React panel in an overlay that flips a mock on and off through a shared tt.globalStore, and asks the page to fetch through it. Try it: open dummyjson.com — use the panel at the bottom right.",
        code: `// Try it: open https://dummyjson.com/ — tick and untick "Mock /users/1" in
// the panel at the bottom right, then click Fetch
import { useState } from "react";
import { useSnapshot } from "valtio";

tt.metadata({ description: "A panel that turns a mock on and off" });

// one live object for the handler and the panel; it survives restarts
const mock = tt.globalStore("mock", { enabled: true });

tt.replaceResponse({ url: "*://dummyjson.com/users/:id", strategy: "page" }, (ctx) =>
    mock.enabled ? { id: Number(ctx.groups.id), firstName: "Mocked", lastName: "User" } : undefined
);

// functions the panel calls in the site's own world (the "page" strategy sees only the site's own fetches)
const site = tt.onSite("https://dummyjson.com/*", () => ({
    user: () => fetch("/users/1").then((r) => r.json()),
}));

// the panel, drawn in this script's overlay: the page can't see or restyle it
tt.onOverlay("https://dummyjson.com/*", (ctx) => {
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
                    <input id="tt-mock" type="checkbox" checked={snap.enabled} onChange={() => (mock.enabled = !mock.enabled)} /> Mock /users/1
                </label>
                <button id="tt-fetch" onClick={fetchUser}>Fetch /users/1</button>
                <output id="tt-user">{user}</output>
            </div>
        );
    }
    // one panel, re-rendered in place when you save the script
    ctx.mount(<Panel />);
});`,
    },
    {
        name: "Overlay outline (calls + shortcut)",
        blurb: "An overlay that asks the page for its headings and scrolls it on click — tt.onPage returns functions, the overlay awaits them — with a keyboard shortcut (a param you can re-record in ⚙) to hide it. Try it: open any Wikipedia article and press Alt+Shift+O.",
        code: `// Try it: open https://en.wikipedia.org/wiki/Cat — press Alt+Shift+O to hide
// or show the outline (change the keys in the popup's ⚙)
tt.metadata({ description: "Floating outline for Wikipedia articles" });
const cfg = tt.params({
    toggle: { type: "shortcut", default: "Alt+Shift+O", description: "Hide or show the outline" },
});

// runs in the page (isolated world); returns the functions the overlay calls
const page = tt.onPage("*://en.wikipedia.org/wiki/*", () => {
    const headings = () => document.querySelectorAll("#mw-content-text h2");
    return {
        titles: () => [...headings()].map((h) => h.textContent ?? ""),
        scrollTo: (i: number) => {
            headings()[i]?.scrollIntoView({ behavior: "smooth" });
        },
    };
});

// runs in this script's overlay; ctx.mount keeps one outline across saves
tt.onOverlay("*://en.wikipedia.org/wiki/*", async (ctx) => {
    const titles = await page.titles(); // string[], typed from the onPage handler
    let hidden = false;
    const render = () =>
        ctx.mount(
            <nav id="tt-outline" hidden={hidden} style={{ position: "fixed", right: 16, top: 80, maxHeight: "70vh", overflow: "auto", padding: "8px 12px", font: "13px system-ui", background: "#fff", border: "1px solid #ccc", borderRadius: 8, boxShadow: "0 2px 8px #0003" }}>
                {titles.map((title, i) => (
                    <a key={i} href="#" style={{ display: "block", padding: "2px 0", color: "#36c", textDecoration: "none" }} onClick={(e) => (e.preventDefault(), void page.scrollTo(i))}>
                        {title}
                    </a>
                ))}
            </nav>
        );
    render();
    ctx.shortcut(cfg.toggle, () => {
        hidden = !hidden;
        render();
    });
});`,
    },
    {
        name: "Watch and mock the site's fetch (tt.siteStore)",
        blurb: "Share state with the site's own JavaScript: onSite code wraps the site's fetch, records the last URL and mocks /users/1 when the panel's switch is on — all through a tt.siteStore the overlay sees live. Try it: open dummyjson.com — use the panel at the bottom left.",
        code: `// Try it: open https://dummyjson.com/ — click Fetch, then tick "Mock /users/1"
// in the panel at the bottom left and click Fetch again
import { useState } from "react";
import { useSnapshot } from "valtio";

tt.metadata({ description: "Watch and mock the site's own fetch from a panel" });

// lives in the site's world: onSite code reads it synchronously, the panel gets a
// live copy. It's page data — the site can read and change it too
const shared = tt.siteStore("shared", { mock: false, lastUrl: "" });

const site = tt.onSite("https://dummyjson.com/*", (ctx) => {
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

tt.onOverlay("https://dummyjson.com/*", (ctx) => {
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
                    <input id="tt-site-mock" type="checkbox" checked={snap.mock} onChange={() => (shared.mock = !shared.mock)} /> Mock /users/1
                </label>
                <button id="tt-site-fetch" onClick={fetchUser}>Fetch /users/1</button>
                <output id="tt-site-user">{user}</output>
                <small id="tt-site-last">Last fetch: {snap.lastUrl || "none yet"}</small>
            </div>
        );
    }
    ctx.mount(<Panel />);
});`,
    },
    {
        name: "Per-script storage",
        blurb: "Keep state between page loads with tt.storage. Try it: open any Wikipedia article and reload — the counter at the top goes up.",
        code: `// Try it: open https://en.wikipedia.org/wiki/Cat and reload a few times
tt.metadata({ description: "Count Wikipedia article visits" });

tt.onPage("*://en.wikipedia.org/wiki/*", async (ctx) => {
    const visits = ((await tt.storage.get("visits")) || 0) + 1;
    await tt.storage.set("visits", visits);
    tt.log("visit #" + visits, ctx.url);
    const out = document.createElement("p");
    out.id = "tt-visits";
    out.style.cssText = "margin: 0; padding: 8px; font: bold 16px system-ui; color: #fff; background: #555";
    out.textContent = "Wikipedia articles opened with this script on: " + visits;
    document.body.prepend(out);
});`,
    },
    {
        name: "Parameters (tt.params)",
        blurb: "Adjustable knobs (tt.params) the user changes from the popup's ⚙ dialog — no code edits. Try it: open postman-echo.com/headers — the knobs come back as x-* headers.",
        code: `// Try it: open https://postman-echo.com/headers, then change
// the knobs from the popup's ⚙ dialog and reload
tt.metadata({ description: "Send the knobs as request headers" });

const cfg = tt.params({
    greeting: { type: "string", default: "hello", description: "Sent as x-greeting" },
    mode: { type: "enum", choices: ["dev", "staging", "prod"], default: "dev", description: "Sent as x-mode" },
    retries: { type: "number", default: 3, min: 0, max: 10, description: "Sent as x-retries" },
    debug: { type: "boolean", default: true, description: "Send x-debug: 1" },
    tags: { type: "stringList", default: ["tangitweak"], description: "Sent comma-separated as x-tags" },
});

// "rules" runs the handler once and turns its result into a browser rule;
// changing a knob reloads the script, so the rule picks the new values up
tt.onRequest({ url: "*://postman-echo.com/headers", strategy: "rules" }, () => ({
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
