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
        interventions: [],
        ...over,
    };
}

const rowNames = (c: Element) => [...c.querySelectorAll("tbody .net-name")].map((n) => n.textContent);

describe("NetworkPanel", () => {
    afterEach(cleanup);

    function setup(list: NetEntry[]) {
        const store = createNetStore();
        store.apply({ type: "netSnapshot", entries: list });
        return { store, ...render(<NetworkPanel store={store} />) };
    }

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

    it("filters by text, type chip and intercepted-only", async () => {
        const hit = entry("api", { type: "xmlhttprequest", interventions: [{ scriptId: "s", scriptName: "Mocker", action: "respond 200", level: "info", at: base }] });
        const { container, getByText, getByPlaceholderText, getByLabelText } = setup([entry("a"), hit]);
        fireEvent.click(getByText("Fetch/XHR"));
        expect(rowNames(container)).toEqual(["api.js"]);
        fireEvent.click(getByText("All"));
        fireEvent.input(getByPlaceholderText(/Filter/), { target: { value: "-api" } });
        expect(rowNames(container)).toEqual(["a.js"]);
        fireEvent.input(getByPlaceholderText(/Filter/), { target: { value: "" } });
        fireEvent.click(getByLabelText("Intercepted only"));
        expect(rowNames(container)).toEqual(["api.js"]);
        expect(container.querySelector(".net-badge")!.textContent).toBe("Mocker");
        expect(container.querySelector("tbody tr")!.classList.contains("intercepted")).toBe(true);
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
            interventions: [{ scriptId: "s", scriptName: "Mocker", action: "modifyResponse applied", level: "info", at: base }],
        });
        const { container, getByText } = setup([hit]);
        fireEvent.click(container.querySelector("tbody tr")!);
        // intercepted → opens on the Wiretrick tab
        expect(container.querySelector(".net-action")!.textContent).toContain("modifyResponse applied");
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
});
