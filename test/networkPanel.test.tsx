import { describe, it, expect, afterEach } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/preact";
import { NetworkPanel } from "../src/ui/network/NetworkPanel";
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

/** open the script-activity menu and click an option */
function pickActivity(container: Element, label: string): void {
    fireEvent.click(container.querySelector(".net-touch-button")!);
    const opt = [...container.querySelectorAll('[role="option"]')].find((o) => o.textContent === label)!;
    fireEvent.click(opt);
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

    /** rendered with the script-activity filter on All (the default is Touched) */
    function setup(list: NetEntry[]) {
        const store = createNetStore();
        store.apply({ type: "netSnapshot", entries: list });
        const r = render(<NetworkPanel store={store} />);
        pickActivity(r.container, "All");
        return { store, ...r };
    }

    it("shows only requests a script touched by default", () => {
        const observed = { scriptId: "s", scriptName: "Watcher", action: "onRequest → observed (no change)", level: "debug" as const, kind: "observed" as const, at: base };
        const store = createNetStore();
        store.apply({ type: "netSnapshot", entries: [entry("plain"), entry("watched", { startedAt: base + 1, outcomes: [observed] })] });
        const { container } = render(<NetworkPanel store={store} />);
        expect(container.querySelector(".net-touch-button")!.getAttribute("aria-label")).toBe("Script activity: Touched");
        expect(rowNames(container)).toEqual(["watched.js"]);
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

    it("filters by text, type chip and script activity (all / observed / modified)", async () => {
        const hit = entry("api", { type: "xmlhttprequest", outcomes: [{ scriptId: "s", scriptName: "Mocker", action: "onRequest → replaceResponse 200", level: "info", kind: "modified", at: base }] });
        const { container, getByText, getByPlaceholderText } = setup([entry("a"), hit]);
        // independent toggles: switching off JS keeps Fetch/XHR on
        fireEvent.click(getByText("JS"));
        expect(rowNames(container)).toEqual(["api.js"]);
        expect(getByText("All", { selector: "button" }).getAttribute("aria-pressed")).toBe("false");
        expect(getByText("Fetch/XHR").getAttribute("aria-pressed")).toBe("true");
        // All (not all on) → everything on
        fireEvent.click(getByText("All", { selector: "button" }));
        expect(rowNames(container)).toEqual(["a.js", "api.js"]);
        // All (all on) → everything off
        fireEvent.click(getByText("All", { selector: "button" }));
        expect(rowNames(container)).toEqual([]);
        expect(container.querySelector(".net-empty")!.textContent).toContain("No request types selected");
        fireEvent.click(getByText("Fetch/XHR"));
        fireEvent.click(getByText("JS"));
        expect(rowNames(container)).toEqual(["a.js", "api.js"]);
        expect(getByText("All", { selector: "button" }).getAttribute("aria-pressed")).toBe("false");
        fireEvent.click(getByText("All", { selector: "button" }));
        expect(getByText("All", { selector: "button" }).getAttribute("aria-pressed")).toBe("true");
        fireEvent.input(getByPlaceholderText(/Filter/), { target: { value: "-api" } });
        expect(rowNames(container)).toEqual(["a.js"]);
        fireEvent.input(getByPlaceholderText(/Filter/), { target: { value: "" } });
        pickActivity(container, "Modified");
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
        pickActivity(container, "Observed");
        expect(rowNames(container)).toEqual(["watched.js"]);
        pickActivity(container, "Touched");
        expect(rowNames(container)).toEqual(["watched.js", "changed.js"]);
        pickActivity(container, "Modified");
        expect(rowNames(container)).toEqual(["changed.js"]);
        // details list: observed entries muted
        fireEvent.click(container.querySelector("tbody tr")!);
        const actions = [...container.querySelectorAll(".net-action")];
        expect(actions.map((a) => a.classList.contains("observed"))).toEqual([true, false]);
    });

    it("script-activity menu: listbox with row markers, keyboard + outside click", () => {
        const { container } = setup([entry("plain")]);
        const button = container.querySelector<HTMLButtonElement>(".net-touch-button")!;
        expect(button.getAttribute("aria-label")).toBe("Script activity: All");
        expect(button.getAttribute("aria-expanded")).toBe("false");
        fireEvent.click(button);
        const list = container.querySelector('[role="listbox"]')!;
        expect(button.getAttribute("aria-expanded")).toBe("true");
        const opts = [...list.querySelectorAll('[role="option"]')];
        expect(opts.map((o) => o.textContent)).toEqual(["All", "Observed", "Modified", "Touched"]);
        expect(opts.map((o) => [...o.querySelectorAll(".net-mark")].map((m) => m.className))).toEqual([
            [],
            ["net-mark observed"],
            ["net-mark modified"],
            ["net-mark observed", "net-mark modified"],
        ]);
        expect(opts.map((o) => o.getAttribute("aria-selected"))).toEqual(["true", "false", "false", "false"]);
        expect(document.activeElement).toBe(list);
        // arrows move the active option, Enter picks it
        fireEvent.keyDown(list, { key: "ArrowDown" });
        fireEvent.keyDown(list, { key: "ArrowDown" });
        expect(list.getAttribute("aria-activedescendant")).toBe("net-touch-opt-modified");
        fireEvent.keyDown(list, { key: "Enter" });
        expect(container.querySelector('[role="listbox"]')).toBeNull();
        expect(button.getAttribute("aria-label")).toBe("Script activity: Modified");
        expect(button.querySelectorAll(".net-mark.modified")).toHaveLength(1);
        expect(document.activeElement).toBe(button);
        // ArrowUp on the button opens at the previous option; Space picks; wraps around
        fireEvent.keyDown(button, { key: "ArrowUp" });
        const list2 = container.querySelector('[role="listbox"]')!;
        expect(list2.getAttribute("aria-activedescendant")).toBe("net-touch-opt-observed");
        fireEvent.keyDown(list2, { key: "End" });
        fireEvent.keyDown(list2, { key: " " });
        expect(button.getAttribute("aria-label")).toBe("Script activity: Touched");
        // Escape closes without changing; outside click closes
        fireEvent.click(button);
        fireEvent.keyDown(container.querySelector('[role="listbox"]')!, { key: "Home" });
        fireEvent.keyDown(container.querySelector('[role="listbox"]')!, { key: "Escape" });
        expect(container.querySelector('[role="listbox"]')).toBeNull();
        expect(button.getAttribute("aria-label")).toBe("Script activity: Touched");
        fireEvent.click(button);
        fireEvent.mouseDown(document.body);
        expect(container.querySelector('[role="listbox"]')).toBeNull();
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

    it("clear empties the table", async () => {
        const { container } = setup([entry("a")]);
        fireEvent.click(container.querySelector(".net-clear")!);
        await waitFor(() => {
            if (container.querySelectorAll("tbody tr").length) throw new Error("not yet");
        });
        expect(container.querySelector(".net-empty")!.textContent).toContain("Recording");
    });

    it("lists tabs that closed but still have requests as closed, until cleared", async () => {
        const store = createNetStore();
        store.apply({
            type: "netSnapshot",
            entries: [entry("a", { tabId: 1 }), entry("doc", { tabId: 7, type: "main_frame", url: "https://gone.test/" }), entry("b", { tabId: 9 })],
        });
        let live = [
            { id: 1, title: "Live tab" },
            { id: 9, title: "Soon closed" },
        ];
        const { container } = render(<NetworkPanel store={store} listTabs={async () => live} />);
        pickActivity(container, "All");
        const sel = container.querySelector("select.net-tab") as HTMLSelectElement;
        const closedLabels = () => [...sel.querySelectorAll("optgroup option")].map((o) => o.textContent);
        await waitFor(() => expect(closedLabels()).toEqual(["✕ https://gone.test/"]));
        expect([...sel.querySelectorAll(":scope > option")].map((o) => o.textContent)).toEqual(["All tabs", "Live tab", "Soon closed"]);

        live = [{ id: 1, title: "Live tab" }];
        fireEvent.focus(sel);
        await waitFor(() => expect(closedLabels()).toEqual(["✕ https://gone.test/", "✕ Soon closed"]));
        fireEvent.change(sel, { target: { value: "9" } });
        await waitFor(() => expect(rowNames(container)).toEqual(["b.js"]));
        expect(sel.classList.contains("closed")).toBe(true);

        fireEvent.click(container.querySelector(".net-clear")!);
        await waitFor(() => expect(closedLabels()).toEqual(["✕ Soon closed"])); // still selected
        fireEvent.change(sel, { target: { value: "" } });
        await waitFor(() => expect(sel.querySelector("optgroup")).toBeNull());
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
            fireEvent.click(getByText("Advanced"));
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
            fireEvent.click(getByText("Advanced"));
            fireEvent.input(q(container), { target: { value: "status:5xx OR host:cdn" } });
            fireEvent.click(getByText("Basic"));
            expect(container.querySelector(".net-qwarn")).toBeNull();
            expect([...container.querySelectorAll(".net-qchip-vals")].map((n) => n.textContent)).toEqual(["5xx", "cdn"]);
            expect(container.querySelector(".net-qconn")!.textContent).toBe("OR");
            expect(rowNames(container)).toEqual(["b.js", "c.js"]);
            fireEvent.click(getAllByLabelText("OR, click to switch")[0]);
            expect(rowNames(container)).toEqual([]);
            fireEvent.click(getByText("Advanced"));
            expect(q(container).value).toBe("status:5xx host:cdn");
            fireEvent.input(q(container), { target: { value: "cdn (method:POST OR host:cdn)" } });
            fireEvent.click(getByText("Basic"));
            expect(box().value).toBe("cdn");
            expect(container.querySelector(".net-qgroup")).not.toBeNull();
            expect(rowNames(container)).toEqual(["c.js"]);
            // only a broken query can't be shown
            fireEvent.click(getByText("Advanced"));
            fireEvent.input(q(container), { target: { value: "(host:x" } });
            fireEvent.click(getByText("Basic"));
            expect(container.querySelector(".net-qwarn")).not.toBeNull();
            fireEvent.click(getByText("Stay in Advanced"));
            expect(q(container).value).toBe("(host:x");
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
            fireEvent.click(getByText("Advanced"));
            fireEvent.input(q(container), { target: { value: "method:POST host:cdn status:5xx" } });
            fireEvent.click(getByText("Basic"));
            const box = container.querySelector(".net-qbox .net-filter") as HTMLInputElement;
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
            fireEvent.input(box, { target: { value: "js" } });
            box.setSelectionRange(0, 2);
            fireEvent.keyDown(box, { key: "a", ctrlKey: true }); // text all selected: Ctrl+A takes the chips too
            expect(selected()).toEqual(["cdn"]);
            fireEvent.keyDown(box, { key: "Backspace" });
            expect(vals()).toEqual([]);
            expect(box.value).toBe("");
        });

        it("Advanced: autocompletes fields then values with the keyboard", () => {
            const { container, getByText } = setup(rows3());
            fireEvent.click(getByText("Advanced"));
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
});
