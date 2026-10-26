import { describe, it, expect, afterEach } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/preact";
import { NetworkPanel, pickRows } from "../src/ui/network/NetworkPanel";
import { createNetStore } from "../src/ui/network/netStore";
import type { NetEntry } from "../src/shared/netTypes";

if (typeof (globalThis as any).localStorage === "undefined") {
    const m = new Map<string, string>();
    (globalThis as any).localStorage = {
        getItem: (k: string) => m.get(k) ?? null,
        setItem: (k: string, v: string) => void m.set(k, String(v)),
        removeItem: (k: string) => void m.delete(k),
        clear: () => m.clear(),
    };
}

const base = Date.now();

/** replace the Basic filter with this query (typed, then Enter) */
function filterBy(container: Element, query: string): void {
    for (const x of [...container.querySelectorAll(".net-qbox .net-qchip-x")].reverse()) fireEvent.click(x);
    const box = container.querySelector(".net-qbox .net-filter") as HTMLInputElement;
    fireEvent.input(box, { target: { value: query } });
    fireEvent.keyDown(box, { key: "Enter" });
}
function entry(id: string, over: Partial<NetEntry> = {}): NetEntry {
    return {
        id,
        tabId: 1,
        url: `https://site.test/${id}.js`,
        method: "GET",
        type: "script",
        status: 200,
        statusText: "OK",
        mime: "text/javascript",
        size: 2048,
        fromCache: false,
        startedAt: base,
        endedAt: base + 30,
        state: "done",
        outcomes: [],
        ...over,
    };
}

const rowNames = (c: Element) => [...c.querySelectorAll("tbody .net-name")].map((n) => n.textContent);

describe("NetworkPanel", () => {
    afterEach(cleanup);

    /** rendered with no filter (the default is is:touched) */
    function setup(list: NetEntry[]) {
        const store = createNetStore();
        store.apply({ type: "netSnapshot", entries: list });
        const r = render(<NetworkPanel store={store} />);
        filterBy(r.container, "");
        return { store, ...r };
    }

    it("shows only requests a script touched by default", () => {
        const observed = { scriptId: "s", scriptName: "Watcher", action: "onRequest → observed (no change)", level: "debug" as const, kind: "observed" as const, at: base };
        const store = createNetStore();
        store.apply({ type: "netSnapshot", entries: [entry("plain"), entry("watched", { startedAt: base + 1, outcomes: [observed] })] });
        const { container } = render(<NetworkPanel store={store} />);
        expect([...container.querySelectorAll(".net-qchip")].map((c) => c.textContent?.replace("×", ""))).toEqual(["is:touched"]);
        expect(rowNames(container)).toEqual(["watched.js"]);
        fireEvent.click(container.querySelector(".net-qchip-x")!); // removing the chip shows everything
        expect(rowNames(container)).toEqual(["plain.js", "watched.js"]);
    });

    it("renders rows devtools-style, with status, size and time", () => {
        const { container } = setup([entry("a"), entry("b", { status: 404, statusText: "Not Found", startedAt: base + 1 })]);
        expect(rowNames(container)).toEqual(["a.js", "b.js"]);
        const rows = container.querySelectorAll("tbody tr");
        expect(rows[0].querySelector(".c-status")!.textContent).toBe("200");
        expect(rows[0].querySelector(".c-size")!.textContent).toBe("2.0 kB");
        expect(rows[0].querySelector(".c-time")!.textContent).toBe("30 ms");
        expect(rows[1].classList.contains("err")).toBe(true);
        expect(container.querySelector(".net-status")!.textContent).toContain("2 requests");
    });

    it("right-click on the header hides/shows columns (persisted); columns resize by drag", async () => {
        localStorage.clear();
        const { container } = setup([entry("a")]);
        fireEvent.contextMenu(container.querySelector("thead th")!);
        const item = [...container.querySelectorAll(".net-colmenu li")].find((li) => li.textContent?.includes("Method"))!;
        expect(item.getAttribute("aria-checked")).toBe("true");
        fireEvent.click(item);
        await waitFor(() => expect(container.querySelector("thead .c-method")).toBeNull());
        expect(container.querySelector("tbody .c-method")).toBeNull();
        expect(JSON.parse(localStorage.getItem("wt.network.layout")!).hidden).toEqual(["method"]);
        fireEvent.keyDown(document, { key: "Escape" });
        await waitFor(() => expect(container.querySelector(".net-colmenu")).toBeNull());
        // drag the Status column's right edge
        const handle = container.querySelector("thead .c-status .net-col-resize")!;
        fireEvent.mouseDown(handle, { clientX: 100 });
        fireEvent.mouseMove(document, { clientX: 180 });
        fireEvent.mouseUp(document);
        await waitFor(() => expect((container.querySelector("thead .c-status") as HTMLElement).style.width).toBe("80px"));
        // the last visible column (Waterfall) flexes and has no handle
        expect(container.querySelector("thead .c-wf .net-col-resize")).toBeNull();
        cleanup();
        // a fresh panel restores the layout
        const again = setup([entry("a")]).container;
        expect(again.querySelector("thead .c-method")).toBeNull();
        localStorage.clear();
    });

    it("the details pane resizes with a splitter", async () => {
        localStorage.clear();
        const { container } = setup([entry("a")]);
        fireEvent.click(container.querySelector("tbody tr")!);
        const splitter = await waitFor(() => container.querySelector(".net-splitter")!);
        fireEvent.mouseDown(splitter, { clientX: 500 });
        fireEvent.mouseMove(document, { clientX: 300 });
        fireEvent.mouseUp(document);
        await waitFor(() => expect((container.querySelector(".net-details") as HTMLElement).style.flex).toContain("px"));
        localStorage.clear();
    });

    it("streams updates from the store", async () => {
        const { store, container } = setup([entry("a", { status: null, state: "pending", endedAt: null })]);
        expect(container.querySelector("tbody .c-status")!.textContent).toBe("(pending)");
        store.apply({ type: "netUpdate", entries: [entry("a"), entry("c", { startedAt: base + 2 })] });
        await waitFor(() => {
            if (rowNames(container).length !== 2) throw new Error("not yet");
        });
        expect(container.querySelector("tbody .c-status")!.textContent).toBe("200");
    });

    it("filters by text, type and script activity", () => {
        const hit = entry("api", { type: "xmlhttprequest", outcomes: [{ scriptId: "s", scriptName: "Mocker", action: "onRequest → replaceResponse 200", level: "info", kind: "modified", at: base }] });
        const { container, getByPlaceholderText } = setup([entry("a"), hit]);
        // only the filter bar sits in the toolbar now: no type toggles, script/tab dropdowns or activity menu
        expect(container.querySelectorAll(".net-toolbar select, .net-chips, .net-touch")).toHaveLength(0);
        filterBy(container, "type:fetch");
        expect(rowNames(container)).toEqual(["api.js"]);
        filterBy(container, "");
        fireEvent.input(getByPlaceholderText(/Filter/), { target: { value: "-api" } });
        expect(rowNames(container)).toEqual(["a.js"]);
        filterBy(container, "is:modified");
        expect(rowNames(container)).toEqual(["api.js"]);
        expect(container.querySelector(".net-badge")!.textContent).toBe("Mocker");
        expect(container.querySelector("tbody tr")!.classList.contains("modified")).toBe(true);
    });

    it("marks observed vs modified rows; Observed = observed-only, Modified, Touched = either; footer counts", () => {
        const observed = { scriptId: "s", scriptName: "Watcher", action: "onRequest → observed (no change)", level: "debug" as const, kind: "observed" as const, at: base };
        const modified = { scriptId: "m", scriptName: "Mocker", action: "onResponseBody applied (1b → 2b)", level: "info" as const, kind: "modified" as const, at: base };
        const { container } = setup([
            entry("plain"),
            entry("watched", { startedAt: base + 1, outcomes: [observed] }),
            entry("changed", { startedAt: base + 2, outcomes: [observed, modified] }),
        ]);
        const rows = [...container.querySelectorAll("tbody tr")];
        expect(rows.map((r) => (r.classList.contains("modified") ? "modified" : r.classList.contains("observed") ? "observed" : "none"))).toEqual(["none", "observed", "modified"]);
        expect(container.querySelector(".net-status")!.textContent).toContain("1 observed · 1 modified");
        expect(container.querySelector(".net-status .net-hl")!.textContent).toBe("1 modified");
        // per-script badges: hollow for a script that only looked
        expect([...rows[2].querySelectorAll(".net-badge")].map((b) => b.className)).toEqual(["net-badge observed", "net-badge modified"]);
        filterBy(container, "is:observed");
        expect(rowNames(container)).toEqual(["watched.js"]);
        filterBy(container, "is:touched");
        expect(rowNames(container)).toEqual(["watched.js", "changed.js"]);
        filterBy(container, "is:modified");
        expect(rowNames(container)).toEqual(["changed.js"]);
        // details list: observed entries muted
        fireEvent.click(container.querySelector("tbody tr")!);
        const actions = [...container.querySelectorAll(".net-action")];
        expect(actions.map((a) => a.classList.contains("observed"))).toEqual([true, false]);
    });

    it("sorts by a column header, toggling direction", () => {
        const { container, getByText } = setup([entry("a", { size: 10 }), entry("b", { size: 99, startedAt: base + 1 }), entry("c", { size: 50, startedAt: base + 2 })]);
        fireEvent.click(getByText("Size"));
        expect(rowNames(container)).toEqual(["a.js", "c.js", "b.js"]);
        fireEvent.click(getByText("Size"));
        expect(rowNames(container)).toEqual(["b.js", "c.js", "a.js"]);
    });

    it("opens details with headers and Wiretrick actions", () => {
        const hit = entry("api", {
            responseHeaders: [["content-type", "application/json"]],
            requestHeaders: [["accept", "*/*"]],
            outcomes: [{ scriptId: "s", scriptName: "Mocker", action: "onResponseBody applied", level: "info", kind: "modified", at: base }],
        });
        const { container, getByText } = setup([hit]);
        fireEvent.click(container.querySelector("tbody tr")!);
        // a script ran on it → opens on the Wiretrick tab
        expect(container.querySelector(".net-action")!.textContent).toContain("onResponseBody applied");
        fireEvent.click(getByText("Headers"));
        const text = container.querySelector(".net-details-body")!.textContent!;
        expect(text).toContain("Response Headers");
        expect(text).toContain("application/json");
        expect(text).toContain("https://site.test/api.js");
        fireEvent.click(container.querySelector(".net-details-close")!);
        expect(container.querySelector(".net-details")).toBeNull();
    });

    it("shows payload and response bodies, with original vs modified", () => {
        const hit = entry("todo", {
            method: "POST",
            mime: "application/json",
            requestBody: { text: '{"q":1}', size: 7, truncated: false, binary: false },
            responseBody: { text: '{"completed":true}', size: 18, truncated: false, binary: false },
            originalResponseBody: { text: '{"completed":false}', size: 19, truncated: false, binary: false },
        });
        const { container, getByText } = setup([hit, entry("plain", { startedAt: base + 1 })]);
        fireEvent.click(container.querySelector("tbody tr")!);
        fireEvent.click(getByText("Payload"));
        expect(container.querySelector(".net-payload")!.textContent).toBe('{\n  "q": 1\n}');
        fireEvent.click(getByText("Response"));
        expect(container.querySelector(".net-payload")!.textContent).toContain('"completed": true');
        fireEvent.click(getByText("Original"));
        expect(container.querySelector(".net-payload")!.textContent).toContain('"completed": false');
        // a request nobody handled: no body, and says why
        fireEvent.click(container.querySelectorAll("tbody tr")[1]);
        expect(container.querySelector(".net-details-tabs")!.textContent).not.toContain("Payload");
        fireEvent.click(getByText("Response"));
        expect(container.querySelector(".net-details-body")!.textContent).toContain("not available");
    });

    it("arrow keys, PageUp/PageDown and Home/End move the selection; Shift extends; Enter opens details", () => {
        const { container } = setup(["a", "b", "c", "d", "e"].map((n, i) => entry(n, { startedAt: base + i })));
        const wrap = container.querySelector(".net-table-wrap")!;
        const picked = () => [...container.querySelectorAll("tbody tr")].map((r) => (r.classList.contains("selected") ? 1 : 0)).join("");
        const key = (k: string, o: object = {}) => fireEvent.keyDown(wrap, { key: k, ...o });
        key("ArrowDown");
        expect(picked()).toBe("10000");
        expect(container.querySelector(".net-details")).toBeNull();
        key("ArrowDown");
        key("ArrowDown");
        expect(picked()).toBe("00100");
        key("ArrowUp");
        expect(picked()).toBe("01000");
        key("ArrowDown", { shiftKey: true });
        key("ArrowDown", { shiftKey: true });
        expect(picked()).toBe("01110");
        key("End");
        expect(picked()).toBe("00001");
        key("Home");
        expect(picked()).toBe("10000");
        key("PageDown");
        expect(picked()).toBe("00001"); // no layout in happy-dom: a page is 10 rows
        key("PageUp");
        expect(picked()).toBe("10000");
        key("Enter");
        expect(container.querySelector(".net-details")).not.toBeNull();
        // the details pane follows the moved-to row
        key("ArrowDown");
        expect(picked()).toBe("01000");
        expect(container.querySelector(".net-details")).not.toBeNull();
        // from a clicked row
        fireEvent.click(container.querySelectorAll("tbody tr")[3]);
        key("ArrowUp");
        expect(picked()).toBe("00100");
    });

    it("copies the shown body; a cut body points to the Settings cap", async () => {
        const hit = entry("todo", {
            mime: "application/json",
            responseBody: { text: '{"a":1}', size: 4096, truncated: true, binary: false },
        });
        const { container, getByText } = setup([hit]);
        fireEvent.click(container.querySelector("tbody tr")!);
        fireEvent.click(getByText("Response"));
        expect(container.querySelector(".net-body-bar")!.textContent).toContain("Settings › Network");
        let copied = "";
        Object.defineProperty(navigator, "clipboard", { value: { writeText: async (t: string) => void (copied = t) }, configurable: true });
        fireEvent.click(container.querySelector(".net-copy")!);
        await waitFor(() => expect(copied).toBe('{\n  "a": 1\n}'));
    });

    it("clear empties the table", async () => {
        const { container } = setup([entry("a")]);
        fireEvent.click(container.querySelector(".net-clear")!);
        await waitFor(() => {
            if (container.querySelectorAll("tbody tr").length) throw new Error("not yet");
        });
        expect(container.querySelector(".net-empty")!.textContent).toContain("Recording");
    });

    it("filters by tab title, also for a tab seen earlier", async () => {
        const store = createNetStore();
        store.apply({ type: "netSnapshot", entries: [entry("a", { tabId: 1 }), entry("b", { tabId: 9, startedAt: base + 1 })] });
        const { container } = render(<NetworkPanel store={store} listTabs={async () => [{ id: 1, title: "Live tab" }, { id: 9, title: "Other tab" }]} />);
        filterBy(container, 'tab:"Other tab"');
        await waitFor(() => expect(rowNames(container)).toEqual(["b.js"]));
    });

    describe("filter bar", () => {
        const rows3 = () => [entry("a"), entry("b", { method: "POST", status: 500, startedAt: base + 1 }), entry("c", { url: "https://cdn.test/c.js", startedAt: base + 2 })];
        const q = (c: Element) => c.querySelector(".net-query") as HTMLInputElement;
        afterEach(() => localStorage.removeItem("wt.network.filterMode"));

        it("Basic: the text box filters by URL, '-' excludes", () => {
            const { container } = setup(rows3());
            const box = container.querySelector(".net-qbox .net-filter") as HTMLInputElement;
            fireEvent.input(box, { target: { value: "cdn" } });
            expect(rowNames(container)).toEqual(["c.js"]);
            fireEvent.input(box, { target: { value: "-cdn" } });
            expect(rowNames(container)).toEqual(["a.js", "b.js"]);
        });

        it("Basic: + Filter adds a chip (field → operator → value); repeated picks OR; × removes", () => {
            const { container, getByText, getByLabelText } = setup(rows3());
            const add = (field: string, value: string) => {
                fireEvent.click(getByText("+ Filter"));
                fireEvent.click([...container.querySelectorAll(".net-qadd-pop .net-qlist-main")].find((n) => n.textContent === field)!);
                fireEvent.click([...container.querySelectorAll(".net-qadd-pop .net-qlist-main")].find((n) => n.textContent === value)!);
            };
            add("method", "POST");
            expect(container.querySelector(".net-qchip")!.textContent).toContain("method:POST");
            expect(rowNames(container)).toEqual(["b.js"]);
            add("method", "GET");
            expect(container.querySelectorAll(".net-qchip").length).toBe(1);
            expect(container.querySelector(".net-qchip-vals")!.textContent).toBe("POST, GET");
            expect(rowNames(container)).toEqual(["a.js", "b.js", "c.js"]);
            fireEvent.click(container.querySelector(".net-qchip-op")!); // negate
            expect(rowNames(container)).toEqual([]);
            fireEvent.click(getByLabelText("Remove method filter"));
            expect(container.querySelector(".net-qchip")).toBeNull();
            expect(rowNames(container)).toEqual(["a.js", "b.js", "c.js"]);
        });

        it("Basic: + Filter value suggestions follow Up/Down from the text box; Enter picks", () => {
            const { container, getByText, getByLabelText } = setup(rows3());
            fireEvent.click(getByText("+ Filter"));
            fireEvent.click([...container.querySelectorAll(".net-qadd-pop .net-qlist-main")].find((n) => n.textContent === "method")!);
            const input = getByLabelText("Value") as HTMLInputElement;
            const opts = () => [...container.querySelectorAll('.net-qadd-pop [role="option"] .net-qlist-main')].map((n) => n.textContent);
            const active = () => container.querySelector('.net-qadd-pop [role="option"].active .net-qlist-main')?.textContent;
            expect(active()).toBeUndefined();
            fireEvent.keyDown(input, { key: "ArrowDown" });
            expect(active()).toBe(opts()[0]);
            fireEvent.keyDown(input, { key: "ArrowUp" }); // wraps
            expect(active()).toBe(opts()[opts().length - 1]);
            fireEvent.keyDown(input, { key: "ArrowDown" });
            fireEvent.keyDown(input, { key: "ArrowDown" });
            const picked = active();
            expect(input.value).toBe(picked); // the text box shows the highlighted value
            expect(opts().length).toBeGreaterThan(1);
            expect(input.getAttribute("aria-activedescendant")).toBe("net-qadd-opt-1");
            fireEvent.keyDown(input, { key: "Enter" });
            expect(container.querySelector(".net-qchip")!.textContent).toContain(`method:${picked}`);
            expect(document.activeElement).toBe(container.querySelector(".net-qbox .net-filter")); // back in the filter box
        });

        it("Basic: + Filter adds the ↑/↓-highlighted value with Add or Tab", () => {
            for (const how of ["add", "tab"]) {
                const { container, getByText, getByLabelText, unmount } = setup(rows3());
                fireEvent.click(getByText("+ Filter"));
                fireEvent.click([...container.querySelectorAll(".net-qadd-pop .net-qlist-main")].find((n) => n.textContent === "method")!);
                const input = getByLabelText("Value") as HTMLInputElement;
                fireEvent.keyDown(input, { key: "ArrowDown" });
                const picked = input.value;
                expect(picked).not.toBe("");
                if (how === "add") fireEvent.click(getByText("Add"));
                else fireEvent.keyDown(input, { key: "Tab" });
                expect(container.querySelector(".net-qchip")!.textContent).toContain(`method:${picked}`);
                unmount();
            }
        });

        it("Basic: + Filter on a text field: ↑/↓ switch the operator, Tab adds", () => {
            const { container, getByText, getByLabelText } = setup(rows3());
            fireEvent.click(getByText("+ Filter"));
            fireEvent.click([...container.querySelectorAll(".net-qadd-pop .net-qlist-main")].find((n) => n.textContent === "url")!);
            const input = getByLabelText("Value") as HTMLInputElement;
            const op = () => container.querySelector(".net-qadd-ops .on")!.textContent;
            expect(op()).toBe("contains");
            fireEvent.keyDown(input, { key: "ArrowUp" }); // wraps
            expect(op()).toBe("matches regex");
            fireEvent.keyDown(input, { key: "ArrowDown" });
            fireEvent.keyDown(input, { key: "ArrowDown" });
            expect(op()).toBe("does not contain");
            fireEvent.input(input, { target: { value: "b.js" } });
            fireEvent.keyDown(input, { key: "Tab" });
            expect(container.querySelector(".net-qchip")!.textContent).toContain("url ≠b.js");
            expect(rowNames(container)).toEqual(["a.js", "c.js"]);
        });

        it("Basic: + Filter on a text field with suggestions: ↑/↓ move through them, Alt+↑/↓ switch the operator", async () => {
            const store = createNetStore();
            store.apply({ type: "netSnapshot", entries: [entry("a", { tabId: 1 }), entry("b", { tabId: 9, startedAt: base + 1 })] });
            const { container, getByText, getByLabelText } = render(<NetworkPanel store={store} listTabs={async () => [{ id: 1, title: "Live tab" }, { id: 9, title: "Other tab" }]} />);
            fireEvent.click(getByText("+ Filter"));
            fireEvent.click([...container.querySelectorAll(".net-qadd-pop .net-qlist-main")].find((n) => n.textContent === "tab")!);
            const input = getByLabelText("Value") as HTMLInputElement;
            const op = () => container.querySelector(".net-qadd-ops .on")!.textContent;
            const active = () => container.querySelector('.net-qadd-pop [role="option"].active .net-qlist-main')?.textContent;
            await waitFor(() => expect(container.querySelectorAll('.net-qadd-pop [role="option"]').length).toBeGreaterThan(1));
            fireEvent.keyDown(input, { key: "ArrowDown" });
            fireEvent.keyDown(input, { key: "ArrowDown" });
            expect(op()).toBe("contains");
            expect(active()).toBeTruthy();
            expect(input.value).toBe(active());
            fireEvent.keyDown(input, { key: "ArrowDown", altKey: true });
            expect(op()).toBe("does not contain");
        });

        it("Basic: typed values are validated before adding", () => {
            const { container, getByText, getByLabelText } = setup(rows3());
            fireEvent.click(getByText("+ Filter"));
            fireEvent.click([...container.querySelectorAll(".net-qadd-pop .net-qlist-main")].find((n) => n.textContent === "size")!);
            fireEvent.input(getByLabelText("Value"), { target: { value: "lots" } });
            fireEvent.click(getByText("Add"));
            expect(container.querySelector(".net-qadd-err")!.textContent).toContain("size:");
            fireEvent.input(getByLabelText("Value"), { target: { value: "1kb" } });
            fireEvent.click(getByText("Add"));
            expect(container.querySelector(".net-qchip")!.textContent).toContain("size:>1kb");
        });

        it("Advanced: carries the Basic query over, filters as you type, keeps the last valid filter on errors", () => {
            const { container, getByText } = setup(rows3());
            fireEvent.input(container.querySelector(".net-qbox .net-filter")!, { target: { value: "site" } });
            fireEvent.click(container.querySelector("[aria-label=\"Advanced query\"]")!);
            expect(localStorage.getItem("wt.network.filterMode")).toBe("advanced");
            expect(q(container).value).toBe("site");
            fireEvent.input(q(container), { target: { value: "status:5xx OR host:cdn" } });
            expect(rowNames(container)).toEqual(["b.js", "c.js"]);
            fireEvent.input(q(container), { target: { value: "status:5xx OR (host:x" } });
            expect(container.querySelector(".net-qbox")!.classList.contains("error")).toBe(true);
            expect(container.querySelector(".net-qerr-msg")!.textContent).toBe("Missing )");
            expect(container.querySelector(".net-qerr")).not.toBeNull();
            expect(rowNames(container)).toEqual(["b.js", "c.js"]);
        });

        it("AND / OR / groups carry over between Advanced and Basic; connectors toggle in Basic", () => {
            const { container, getByText, getAllByLabelText } = setup(rows3());
            const box = () => container.querySelector(".net-qbox .net-filter") as HTMLInputElement;
            fireEvent.click(container.querySelector("[aria-label=\"Advanced query\"]")!);
            fireEvent.input(q(container), { target: { value: "status:5xx OR host:cdn" } });
            fireEvent.click(container.querySelector("[aria-label=\"Advanced query\"]")!);
            expect(container.querySelector(".net-qwarn")).toBeNull();
            expect([...container.querySelectorAll(".net-qchip-vals")].map((n) => n.textContent)).toEqual(["5xx", "cdn"]);
            expect(container.querySelector(".net-qconn")!.textContent).toBe("OR");
            expect(rowNames(container)).toEqual(["b.js", "c.js"]);
            fireEvent.click(getAllByLabelText("OR, click to switch")[0]);
            expect(rowNames(container)).toEqual([]);
            fireEvent.click(container.querySelector("[aria-label=\"Advanced query\"]")!);
            expect(q(container).value).toBe("status:5xx host:cdn");
            fireEvent.input(q(container), { target: { value: "cdn (method:POST OR host:cdn)" } });
            fireEvent.click(container.querySelector("[aria-label=\"Advanced query\"]")!);
            expect(box().value).toBe("cdn");
            expect(container.querySelector(".net-qgroup")).not.toBeNull();
            expect(rowNames(container)).toEqual(["c.js"]);
            // only a broken query can't be shown
            fireEvent.click(container.querySelector("[aria-label=\"Advanced query\"]")!);
            fireEvent.input(q(container), { target: { value: "(host:x" } });
            fireEvent.click(container.querySelector("[aria-label=\"Advanced query\"]")!);
            expect(container.querySelector(".net-qwarn")).not.toBeNull();
            fireEvent.click(getByText("Stay in Advanced"));
            expect(q(container).value).toBe("(host:x");
        });

        it("Basic: ↑/↓ show the highlighted suggestion in the text box; Esc puts back what was typed", () => {
            const { container } = setup(rows3());
            const box = container.querySelector(".net-qbox .net-filter") as HTMLInputElement;
            box.value = "api pos";
            box.setSelectionRange(7, 7);
            fireEvent.input(box);
            const first = container.querySelector("#net-bsuggest li .net-qlist-main")!.textContent;
            expect(first).toBe("method: POST");
            fireEvent.mouseEnter(container.querySelector("#net-bsuggest li")!);
            expect(box.value).toBe("api pos"); // hover highlights without touching the text
            fireEvent.keyDown(box, { key: "ArrowUp" });
            fireEvent.keyDown(box, { key: "ArrowDown" });
            expect(box.value).toBe("api method:POST");
            fireEvent.keyDown(box, { key: "Escape" });
            expect(box.value).toBe("api pos");
            expect(container.querySelector("#net-bsuggest")).not.toBeNull();
            fireEvent.keyDown(box, { key: "Escape" });
            expect(container.querySelector("#net-bsuggest")).toBeNull();
        });

        it("Ctrl+Space: suggestions for the word, else the field list; ↑/↓ + Enter/Tab pick a field", async () => {
            const { container } = setup(rows3());
            const box = container.querySelector(".net-qbox .net-filter") as HTMLInputElement;
            const fields = () => [...container.querySelectorAll(".net-qadd-pop .net-qfields [role=option]")];
            const active = () => container.querySelector(".net-qfields [role=option].active .net-qlist-main")?.textContent;
            fireEvent.keyDown(box, { key: " ", code: "Space", ctrlKey: true });
            expect(fields().length).toBeGreaterThan(3);
            expect(active()).toBe("url");
            const list = container.querySelector(".net-qfields") as HTMLElement;
            await waitFor(() => expect(document.activeElement).toBe(list));
            fireEvent.keyDown(list, { key: "ArrowUp" }); // wraps
            expect(active()).toBe(fields()[fields().length - 1].querySelector(".net-qlist-main")!.textContent);
            fireEvent.keyDown(list, { key: "Home" });
            fireEvent.keyDown(list, { key: "ArrowDown" });
            expect(active()).toBe("host");
            fireEvent.keyDown(list, { key: "m" }); // type-ahead
            expect(active()).toBe("method");
            fireEvent.keyDown(list, { key: "Enter" });
            expect(container.querySelector(".net-qadd-pop b")!.textContent).toBe("method");
            fireEvent.keyDown(document, { key: "Escape" });
            expect(container.querySelector(".net-qadd-pop")).toBeNull();
            await waitFor(() => expect(document.activeElement).toBe(box)); // Esc: back to the filter box
            fireEvent.click(container.querySelector(".net-qadd-btn")!); // the button's list takes keys too
            fireEvent.keyDown(container.querySelector(".net-qfields")!, { key: "ArrowDown" });
            fireEvent.keyDown(container.querySelector(".net-qfields")!, { key: "Tab" });
            expect(container.querySelector(".net-qadd-pop b")!.textContent).toBe("host");
            fireEvent.keyDown(document, { key: "Escape" });
            box.value = "pos";
            box.setSelectionRange(3, 3);
            fireEvent.input(box);
            fireEvent.keyDown(box, { key: "Escape" });
            expect(container.querySelector("#net-bsuggest")).toBeNull();
            fireEvent.keyDown(box, { key: " ", ctrlKey: true }); // a word with suggestions: those, first one highlighted
            expect(container.querySelector("#net-bsuggest li.active .net-qlist-main")!.textContent).toBe("method: POST");
            expect(container.querySelector(".net-qadd-pop")).toBeNull();
            fireEvent.keyDown(box, { key: "Enter" });
            expect(container.querySelector(".net-qchip")!.textContent).toContain("method:POST");
        });

        it("Advanced: Ctrl+Space lists the fields on an empty query", () => {
            const { container } = setup(rows3());
            for (const x of [...container.querySelectorAll(".net-qbox .net-qchip-x")]) fireEvent.click(x);
            fireEvent.click(container.querySelector('[aria-label="Advanced query"]')!);
            const input = q(container);
            expect(input.value).toBe("");
            fireEvent.keyDown(input, { key: " ", code: "Space", ctrlKey: true });
            expect(container.querySelector("#net-qsuggest li.active .net-qlist-main")!.textContent).toBe("url:");
            fireEvent.keyDown(input, { key: "ArrowDown" });
            fireEvent.keyDown(input, { key: "Tab" });
            expect(input.value).toBe("host:");
        });

        it("Basic: typing suggests fields and values like + Filter", () => {
            const { container, getByLabelText } = setup(rows3());
            const box = container.querySelector(".net-qbox .net-filter") as HTMLInputElement;
            const type = (v: string) => {
                box.value = v;
                box.setSelectionRange(v.length, v.length);
                fireEvent.input(box);
            };
            type("api pos");
            const opts = () => [...container.querySelectorAll("#net-bsuggest li")].map((n) => n.querySelector(".net-qlist-main")!.textContent);
            expect(opts()).toContain("method: POST");
            fireEvent.keyDown(box, { key: "Tab" });
            expect(box.value).toBe("api");
            expect(container.querySelector(".net-qchip")!.textContent).toContain("method:POST");
            type("api sta");
            expect(opts()[0]).toBe("status:");
            fireEvent.keyDown(box, { key: "Enter" }); // nothing highlighted: Enter just commits text
            expect(container.querySelector(".net-qadd-pop")).toBeNull();
            type("api sta");
            fireEvent.keyDown(box, { key: "ArrowDown" });
            fireEvent.keyDown(box, { key: "Enter" });
            expect(box.value).toBe("api");
            expect(container.querySelector(".net-qadd-pop b")!.textContent).toBe("status"); // + Filter opened at the field
            expect((getByLabelText("Value") as HTMLInputElement).value).toBe("");
            // typed field terms turn into chips on Enter
            fireEvent.keyDown(document, { key: "Escape" });
            type("host:cdn");
            fireEvent.keyDown(box, { key: "Escape" });
            fireEvent.keyDown(box, { key: "Enter" });
            expect(box.value).toBe("");
            expect([...container.querySelectorAll(".net-qchip-vals")].map((n) => n.textContent)).toEqual(["POST", "cdn"]);
        });

        it("Basic: chips select and delete like text", () => {
            const { container, getByText } = setup(rows3());
            fireEvent.click(container.querySelector("[aria-label=\"Advanced query\"]")!);
            fireEvent.input(q(container), { target: { value: "method:POST host:cdn status:5xx" } });
            fireEvent.click(container.querySelector("[aria-label=\"Advanced query\"]")!);
            let box = container.querySelector(".net-qbox .net-filter") as HTMLInputElement;
            const qbox = container.querySelector(".net-qbox") as HTMLElement;
            const vals = () => [...container.querySelectorAll(".net-qchip-vals")].map((n) => n.textContent);
            const selected = () => [...container.querySelectorAll(".net-qchip.sel .net-qchip-vals")].map((n) => n.textContent);
            box.focus();
            fireEvent.keyDown(box, { key: "Backspace" }); // at the start: removes the chip before, like a character
            expect(vals()).toEqual(["POST", "cdn"]);
            fireEvent.keyDown(box, { key: "ArrowLeft" });
            expect(selected()).toEqual(["cdn"]);
            fireEvent.keyDown(qbox, { key: "ArrowLeft", shiftKey: true });
            expect(selected()).toEqual(["POST", "cdn"]);
            fireEvent.keyDown(qbox, { key: "ArrowRight" });
            expect(selected()).toEqual([]);
            fireEvent.mouseDown(container.querySelectorAll(".net-qchip-vals")[0]);
            expect(selected()).toEqual(["POST"]);
            fireEvent.keyDown(qbox, { key: "Delete" });
            expect(vals()).toEqual(["cdn"]);
            expect(container.querySelector(".net-qtext.gap")).not.toBeNull(); // the caret is where POST was
            fireEvent.keyDown(container.querySelector(".net-qbox .net-filter")!, { key: "End" });
            expect(container.querySelector(".net-qtext.gap")).toBeNull();
            box = container.querySelector(".net-qbox .net-filter") as HTMLInputElement;
            fireEvent.input(box, { target: { value: "js" } });
            box.setSelectionRange(0, 2);
            fireEvent.keyDown(box, { key: "a", ctrlKey: true }); // text all selected: Ctrl+A takes the chips too
            expect(selected()).toEqual(["cdn"]);
            fireEvent.keyDown(box, { key: "Backspace" });
            expect(vals()).toEqual([]);
            expect(box.value).toBe("");
        });

        it("Basic: the caret stops on both sides of each capsule; text typed there goes there", () => {
            const { container, getByText } = setup(rows3());
            fireEvent.click(container.querySelector("[aria-label=\"Advanced query\"]")!);
            fireEvent.input(q(container), { target: { value: "method:POST OR host:cdn" } });
            fireEvent.click(container.querySelector("[aria-label=\"Advanced query\"]")!);
            const qbox = container.querySelector(".net-qbox") as HTMLElement;
            const input = () => container.querySelector(".net-qbox .net-filter") as HTMLInputElement;
            const caps = () => [...qbox.querySelectorAll(".net-qchip-vals, .net-qconn, .net-qtext")].map((n) => (n.classList.contains("net-qtext") ? "|" : n.textContent));
            const selected = () => [...container.querySelectorAll(".net-qchip.sel .net-qchip-vals")].map((n) => n.textContent);
            input().focus();
            expect(caps()).toEqual(["POST", "OR", "cdn", "|"]);
            fireEvent.keyDown(input(), { key: "ArrowLeft" });
            expect(selected()).toEqual(["cdn"]);
            fireEvent.keyDown(qbox, { key: "ArrowLeft" });
            expect(caps()).toEqual(["POST", "OR", "|", "cdn"]); // before cdn
            fireEvent.keyDown(input(), { key: "ArrowLeft" });
            expect(selected()).toEqual(["POST"]);
            fireEvent.keyDown(qbox, { key: "ArrowRight" });
            expect(caps()).toEqual(["POST", "OR", "|", "cdn"]);
            fireEvent.input(input(), { target: { value: "a.js" } });
            expect(rowNames(container)).toEqual(["b.js"]); // live, in place: POST OR (a.js AND cdn)
            fireEvent.keyDown(input(), { key: "Enter" });
            expect(caps()).toEqual(["POST", "OR", "a.js", "AND", "|", "cdn"]);
            fireEvent.keyDown(input(), { key: "Backspace" }); // the capsule before the caret
            expect(caps()).toEqual(["POST", "OR", "|", "cdn"]);
            fireEvent.keyDown(input(), { key: "End" });
            expect(caps()).toEqual(["POST", "OR", "cdn", "|"]);
        });

        it("Basic: ( typed among the capsules, ) typed further on", () => {
            const { container, getByText } = setup(rows3());
            fireEvent.click(container.querySelector("[aria-label=\"Advanced query\"]")!);
            fireEvent.input(q(container), { target: { value: "method:POST OR host:cdn status:500" } });
            fireEvent.click(container.querySelector("[aria-label=\"Advanced query\"]")!);
            const qbox = container.querySelector(".net-qbox") as HTMLElement;
            const input = () => container.querySelector(".net-qbox .net-filter") as HTMLInputElement;
            const caps = () => [...qbox.querySelectorAll(".net-qchip-vals, .net-qconn, .net-qtext, .net-qgroup-op")].map((n) => (n.classList.contains("net-qtext") ? "|" : n.textContent));
            expect(rowNames(container)).toEqual(["b.js"]);
            input().focus();
            fireEvent.keyDown(input(), { key: "Home" });
            fireEvent.input(input(), { target: { value: "(" } });
            expect(caps()).toEqual(["(", "|", "POST", "OR", "cdn", "AND", "500"]);
            for (let i = 0; i < 4; i++) fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
            expect(caps()).toEqual(["(", "POST", "OR", "cdn", "AND", "|", "500"]);
            fireEvent.input(input(), { target: { value: ")" } });
            expect(caps()).toEqual(["(", "POST", "OR", "cdn", ")", "AND", "|", "500"]);
            expect(rowNames(container)).toEqual(["b.js"]); // (POST OR cdn) AND 500
            fireEvent.keyDown(input(), { key: "Backspace" }); // the ")" goes: the group runs to the end again
            expect(caps()).toEqual(["(", "POST", "OR", "cdn", "AND", "|", "500"]);
            fireEvent.keyDown(input(), { key: "End" });
            fireEvent.input(input(), { target: { value: ")" } });
            expect(caps()).toEqual(["(", "POST", "OR", "cdn", "AND", "500", ")", "|"]);
        });

        it("Basic: OR / AND typed among the capsules set the connector there", () => {
            const { container, getByText } = setup(rows3());
            fireEvent.click(container.querySelector("[aria-label=\"Advanced query\"]")!);
            fireEvent.input(q(container), { target: { value: "method:POST host:cdn" } });
            fireEvent.click(container.querySelector("[aria-label=\"Advanced query\"]")!);
            const qbox = container.querySelector(".net-qbox") as HTMLElement;
            const input = () => container.querySelector(".net-qbox .net-filter") as HTMLInputElement;
            const caps = () => [...qbox.querySelectorAll(".net-qchip-vals, .net-qconn, .net-qtext")].map((n) => (n.classList.contains("net-qtext") ? "|" : n.textContent));
            input().focus();
            fireEvent.keyDown(input(), { key: "ArrowLeft" });
            fireEvent.keyDown(qbox, { key: "ArrowLeft" });
            expect(caps()).toEqual(["POST", "AND", "|", "cdn"]);
            fireEvent.input(input(), { target: { value: "OR " } });
            expect(caps()).toEqual(["POST", "OR", "|", "cdn"]);
            expect(input().value).toBe("");
            expect(rowNames(container)).toEqual(["b.js", "c.js"]);
            fireEvent.input(input(), { target: { value: "a.js AND " } }); // what came before it is committed first
            expect(caps()).toEqual(["POST", "OR", "a.js", "AND", "|", "cdn"]);
            fireEvent.keyDown(input(), { key: "Backspace" }); // an AND stays: the capsule goes
            fireEvent.keyDown(input(), { key: "Backspace" }); // an OR goes back to AND
            expect(caps()).toEqual(["POST", "AND", "|", "cdn"]);
        });

        it("Basic: Shift+arrows, Shift+click and dragging select from the caret", () => {
            const { container, getByText } = setup(rows3());
            fireEvent.click(container.querySelector("[aria-label=\"Advanced query\"]")!);
            fireEvent.input(q(container), { target: { value: "method:POST host:cdn status:500" } });
            fireEvent.click(container.querySelector("[aria-label=\"Advanced query\"]")!);
            const qbox = container.querySelector(".net-qbox") as HTMLElement;
            const input = () => container.querySelector(".net-qbox .net-filter") as HTMLInputElement;
            const chips = () => container.querySelectorAll(".net-qchip-vals");
            const selected = () => [...container.querySelectorAll(".net-qchip.sel .net-qchip-vals")].map((n) => n.textContent);
            input().focus();
            fireEvent.keyDown(input(), { key: "Home" });
            fireEvent.keyDown(input(), { key: "ArrowRight" });
            fireEvent.keyDown(qbox, { key: "ArrowRight" }); // caret between POST and cdn
            expect(container.querySelector(".net-qtext.gap")).not.toBeNull();
            fireEvent.keyDown(input(), { key: "ArrowRight", shiftKey: true });
            expect(selected()).toEqual(["cdn"]);
            fireEvent.keyDown(qbox, { key: "ArrowRight", shiftKey: true });
            expect(selected()).toEqual(["cdn", "500"]);
            fireEvent.keyDown(qbox, { key: "ArrowLeft", shiftKey: true });
            fireEvent.keyDown(qbox, { key: "ArrowLeft", shiftKey: true }); // back to nothing: the caret is where it was
            expect(selected()).toEqual([]);
            expect(container.querySelector(".net-qtext.gap")).not.toBeNull();
            fireEvent.keyDown(input(), { key: "ArrowLeft", shiftKey: true });
            expect(selected()).toEqual(["POST"]);
            // from the end of the box
            fireEvent.keyDown(qbox, { key: "End" });
            input().focus();
            fireEvent.keyDown(input(), { key: "ArrowLeft", shiftKey: true });
            expect(selected()).toEqual(["500"]);
            fireEvent.keyDown(qbox, { key: "ArrowRight", shiftKey: true });
            expect(selected()).toEqual([]);
            expect(container.querySelector(".net-qtext.gap")).toBeNull();
            // Shift+click from the caret
            input().focus();
            fireEvent.mouseDown(chips()[1], { shiftKey: true });
            expect(selected()).toEqual(["cdn", "500"]);
            // drag from the text box over the capsules
            fireEvent.keyDown(qbox, { key: "End" });
            fireEvent.mouseDown(input());
            fireEvent.mouseEnter(chips()[0].closest(".net-qchip")!, { buttons: 1 });
            expect(selected()).toEqual(["POST", "cdn", "500"]);
            fireEvent.mouseUp(document);
        });

        it("Basic: Enter / Space on a capsule edits it in place", () => {
            const { container, getByText } = setup(rows3());
            fireEvent.click(container.querySelector("[aria-label=\"Advanced query\"]")!);
            fireEvent.input(q(container), { target: { value: "method:POST host:cdn" } });
            fireEvent.click(container.querySelector("[aria-label=\"Advanced query\"]")!);
            const qbox = container.querySelector(".net-qbox") as HTMLElement;
            const input = () => container.querySelector(".net-qbox .net-filter") as HTMLInputElement;
            const vals = () => [...container.querySelectorAll(".net-qchip-vals")].map((n) => n.textContent);
            fireEvent.mouseDown(container.querySelectorAll(".net-qchip-vals")[0]);
            fireEvent.keyDown(qbox, { key: "Enter" });
            expect(vals()).toEqual(["cdn"]);
            expect(input().value).toBe("method:POST");
            expect(container.querySelector(".net-qtext.gap")).not.toBeNull();
            fireEvent.input(input(), { target: { value: "method:GET" } });
            fireEvent.keyDown(input(), { key: "Enter" });
            expect(vals()).toEqual(["GET", "cdn"]); // still first
            // Esc drops an edit
            fireEvent.mouseDown(container.querySelectorAll(".net-qchip-vals")[1]);
            fireEvent.keyDown(qbox, { key: " " });
            fireEvent.input(input(), { target: { value: "host:zzz" } });
            fireEvent.keyDown(input(), { key: "Escape" }); // closes the suggestions
            fireEvent.keyDown(input(), { key: "Escape" });
            expect(vals()).toEqual(["GET", "cdn"]);
            expect(container.querySelector(".net-qtext.gap")).toBeNull();
        });

        it("Basic: typed OR / AND / ( / ) become capsules", () => {
            const { container } = setup(rows3());
            const box = container.querySelector(".net-qbox .net-filter") as HTMLInputElement;
            const type = (t: string) => [...t].forEach((ch) => fireEvent.input(box, { target: { value: box.value + ch } }));
            const caps = () => [...container.querySelectorAll(".net-qbox .net-qchip-vals, .net-qbox .net-qconn, .net-qbox .net-qgroup-op")].map((n) => n.textContent);
            type("method:POST OR ");
            expect(box.value).toBe("");
            expect(caps()).toEqual(["POST", "OR"]);
            expect(container.querySelector(".net-qconn.pending")).not.toBeNull();
            expect(rowNames(container)).toEqual(["b.js"]);
            type("(");
            expect(container.querySelector(".net-qgroup.open")).not.toBeNull();
            expect(caps()).toEqual(["POST", "OR", "("]);
            type("cdn");
            expect(rowNames(container)).toEqual(["b.js", "c.js"]); // live: counts inside the group already
            type(")");
            expect(box.value).toBe("");
            expect(caps()).toEqual(["POST", "OR", "cdn"]); // a one-chip group needs no parentheses
            expect(rowNames(container)).toEqual(["b.js", "c.js"]);
            fireEvent.keyDown(box, { key: "z", ctrlKey: true }); // each capsule is its own undo step
            expect(caps()).toEqual(["POST", "OR", "("]);
            expect(box.value).toBe("cdn");
            fireEvent.input(box, { target: { value: "" } });
            fireEvent.keyDown(box, { key: "Backspace" }); // the empty group, then the OR
            expect(caps()).toEqual(["POST", "OR"]);
            fireEvent.keyDown(box, { key: "Backspace" });
            expect(caps()).toEqual(["POST"]);
        });

        it("Basic: Ctrl+Z / Ctrl+Shift+Z undo and redo chip and text changes", () => {
            const { container, getByText } = setup(rows3());
            fireEvent.click(container.querySelector("[aria-label=\"Advanced query\"]")!);
            fireEvent.input(q(container), { target: { value: "method:POST host:cdn" } });
            fireEvent.click(container.querySelector("[aria-label=\"Advanced query\"]")!);
            const box = container.querySelector(".net-qbox .net-filter") as HTMLInputElement;
            const vals = () => [...container.querySelectorAll(".net-qchip-vals")].map((n) => n.textContent);
            fireEvent.click(container.querySelectorAll(".net-qchip-x")[0] as HTMLElement); // × on a chip
            expect(vals()).toEqual(["cdn"]);
            expect(document.activeElement).toBe(box); // focus stays in the bar, so Ctrl+Z reaches it
            fireEvent.input(box, { target: { value: "j" } });
            fireEvent.input(box, { target: { value: "js" } }); // typing joins one step
            fireEvent.keyDown(box, { key: "z", ctrlKey: true });
            expect(box.value).toBe("");
            expect(vals()).toEqual(["cdn"]);
            fireEvent.keyDown(box, { key: "z", ctrlKey: true });
            expect(vals()).toEqual(["POST", "cdn"]);
            fireEvent.keyDown(box, { key: "z", ctrlKey: true }); // nothing older: no-op
            expect(vals()).toEqual(["POST", "cdn"]);
            fireEvent.keyDown(box, { key: "z", ctrlKey: true, shiftKey: true });
            expect(vals()).toEqual(["cdn"]);
            fireEvent.keyDown(box, { key: "y", ctrlKey: true });
            expect(box.value).toBe("js");
            box.setSelectionRange(0, 2);
            fireEvent.keyDown(box, { key: "a", ctrlKey: true });
            fireEvent.keyDown(box, { key: "Backspace" });
            expect(vals()).toEqual([]);
            fireEvent.keyDown(box, { key: "z", metaKey: true });
            expect(vals()).toEqual(["cdn"]);
            expect(box.value).toBe("js");
        });

        it("Advanced: autocompletes fields then values with the keyboard", () => {
            const { container, getByText } = setup(rows3());
            fireEvent.click(container.querySelector("[aria-label=\"Advanced query\"]")!);
            const input = q(container);
            input.value = "meth";
            input.setSelectionRange(4, 4);
            fireEvent.input(input);
            expect(container.querySelector(".net-qsuggest li.active")!.textContent).toContain("method:");
            fireEvent.keyDown(input, { key: "Tab" });
            expect(input.value).toBe("method:");
            expect(container.querySelector(".net-qsuggest")).not.toBeNull(); // straight on to values
            fireEvent.keyDown(input, { key: "ArrowDown" });
            fireEvent.keyDown(input, { key: "Enter" });
            expect(input.value).toBe("method:POST ");
            expect(container.querySelector(".net-qsuggest")).toBeNull();
            expect(rowNames(container)).toEqual(["b.js"]);
        });

        it("? lists the syntax and clicking an example uses it", () => {
            const { container, getByLabelText, getByText } = setup(rows3());
            fireEvent.click(getByLabelText("Filter syntax"));
            fireEvent.click(getByText("status:>=400"));
            expect(q(container).value).toBe("status:>=400");
            expect(rowNames(container)).toEqual(["b.js"]);
        });
    });

    describe("row selection and menu", () => {
        it("picks rows explorer-style", () => {
            const order = ["a", "b", "c", "d"];
            const none = { ids: new Set<string>(), anchor: null, primary: null };
            const ids = (s: { ids: ReadonlySet<string> }) => [...s.ids].sort();
            let s = pickRows(none, order, "b", { shift: false, toggle: false });
            expect([ids(s), s.primary]).toEqual([["b"], "b"]);
            s = pickRows(s, order, "d", { shift: true, toggle: false });
            expect([ids(s), s.anchor, s.primary]).toEqual([["b", "c", "d"], "b", "d"]);
            s = pickRows(s, order, "c", { shift: false, toggle: true });
            expect([ids(s), s.primary]).toEqual([["b", "d"], "d"]);
            s = pickRows(s, order, "a", { shift: false, toggle: true });
            expect(ids(s)).toEqual(["a", "b", "d"]);
            s = pickRows(s, order, "c", { shift: false, toggle: false });
            expect(ids(s)).toEqual(["c"]);
            expect(ids(pickRows(s, order, "c", { shift: false, toggle: false }))).toEqual([]); // again: deselects
        });

        it("right-click offers open and copy for the selection", async () => {
            const { container } = setup([entry("a"), entry("b", { startedAt: base + 1 }), entry("c", { startedAt: base + 2 })]);
            const rows = () => [...container.querySelectorAll("tbody tr")];
            fireEvent.click(rows()[0]);
            fireEvent.click(rows()[2], { shiftKey: true });
            expect(rows().map((r) => r.classList.contains("selected"))).toEqual([true, true, true]);
            expect(container.querySelector(".net-status")!.textContent).toContain("3 selected");
            fireEvent.contextMenu(rows()[1]);
            const items = () => [...container.querySelectorAll(".net-rowmenu li[role=menuitem]")].map((li) => li.firstChild!.textContent);
            expect(items()).toEqual(["Open 3 in new tabs", "Copy", "Copy 3 URLs", "Copy all as cURL", "Copy all as fetch", "Copy all as HAR"]);
            let copied = "";
            Object.defineProperty(navigator, "clipboard", { value: { writeText: async (t: string) => void (copied = t) }, configurable: true });
            fireEvent.click([...container.querySelectorAll(".net-submenu li")][0]);
            await waitFor(() => expect(copied).toBe("https://site.test/a.js\nhttps://site.test/b.js\nhttps://site.test/c.js"));
            expect(container.querySelector(".net-rowmenu")).toBeNull();
            // right-click outside the selection picks just that row
            fireEvent.click(rows()[0], { ctrlKey: true });
            fireEvent.contextMenu(rows()[0]);
            expect(rows().map((r) => r.classList.contains("selected"))).toEqual([true, false, false]);
            expect(items()[0]).toBe("Open in new tab");
            expect(rows()[0].getAttribute("title")).toBeNull();
        });
    });
});
