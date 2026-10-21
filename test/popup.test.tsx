import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/preact";
import { Popup } from "../src/ui/popup/Popup";
import type { PopupApi, ScriptInfo, ScriptParams } from "../src/ui/popup/api";

afterEach(cleanup);

function fakeApi(scripts: ScriptInfo[], params: Record<string, ScriptParams> = {}): PopupApi & { calls: any[] } {
    const calls: any[] = [];
    let list = scripts.map((s) => ({ ...s }));
    return {
        calls,
        listScripts: vi.fn(async () => list.map((s) => ({ ...s }))),
        setEnabled: vi.fn(async (id: string, enabled: boolean) => {
            calls.push(["setEnabled", id, enabled]);
            list = list.map((s) => (s.id === id ? { ...s, enabled } : s));
        }),
        clearError: vi.fn(async (id: string) => {
            calls.push(["clearError", id]);
            list = list.map((s) => (s.id === id ? { ...s, runtimeError: null } : s));
        }),
        getParams: vi.fn(async (id: string) => params[id]),
        setParam: vi.fn(async (...a: any[]) => void calls.push(["setParam", ...a])),
        openManager: vi.fn((id?: string) => void calls.push(["openManager", id])),
        loadSize: vi.fn(async () => null),
        saveSize: vi.fn(),
    };
}

const script = (id: string, name: string, extra: Partial<ScriptInfo> = {}): ScriptInfo => ({
    id,
    enabled: true,
    error: null,
    meta: { name, declared: true },
    ...extra,
});

const names = (c: Element) => [...c.querySelectorAll("#script-list .script-name")].map((n) => n.textContent);

describe("Popup", () => {
    it("lists declared scripts and hides libraries", async () => {
        const { container } = render(<Popup api={fakeApi([script("a", "Alpha"), script("l", "lib", { meta: { name: "lib", declared: false } })])} />);
        await waitFor(() => expect(names(container)).toEqual(["Alpha"]));
        expect(container.querySelector("#empty")).toBeNull();
    });

    it("shows the empty state", async () => {
        render(<Popup api={fakeApi([])} />);
        await screen.findByText(/No scripts yet/);
    });

    it("shows a reach error when listing fails", async () => {
        const api = fakeApi([]);
        api.listScripts = async () => {
            throw new Error("Receiving end does not exist");
        };
        render(<Popup api={api} />);
        await screen.findByText(/Could not reach the extension/);
    });

    it("toggles a script and re-renders from the extension's state", async () => {
        const api = fakeApi([script("a", "Alpha")]);
        const { container } = render(<Popup api={api} />);
        await waitFor(() => expect(container.querySelector(".switch.on")).not.toBeNull());
        fireEvent.click(container.querySelector(".switch")!);
        await waitFor(() => expect(container.querySelector(".switch.on")).toBeNull());
        expect(api.calls).toContainEqual(["setEnabled", "a", false]);
    });

    it("refreshes the list and an open param fold when storage changes elsewhere", async () => {
        const defs = { port: { type: "string", default: "1" } } as any;
        let values: any = { port: "1" };
        const api = fakeApi([script("a", "Alpha", { paramDefs: defs })]);
        api.getParams = vi.fn(async () => ({ defs, values }));
        let fire = () => {};
        api.onChange = (fn) => ((fire = fn), () => {});
        const { container } = render(<Popup api={api} />);
        await waitFor(() => expect(names(container)).toEqual(["Alpha"]));
        fireEvent.click(await screen.findByLabelText("Toggle parameters"));
        await waitFor(() => expect((container.querySelector(".param-fold input") as HTMLInputElement)?.value).toBe("1"));
        values = { port: "9" };
        (api.listScripts as any).mockImplementation(async () => [script("a", "Alpha", { paramDefs: defs }), script("b", "Beta")]);
        fire();
        await waitFor(() => expect(names(container)).toEqual(["Alpha", "Beta"]));
        await waitFor(() => expect((container.querySelector(".param-fold input") as HTMLInputElement).value).toBe("9"));
    });

    it("marks scripts with compile errors", async () => {
        const { container } = render(<Popup api={fakeApi([script("a", "Alpha", { error: "boom" })])} />);
        await waitFor(() => expect(container.querySelector(".err-ind.compile")?.getAttribute("title")).toContain("boom"));
        expect(container.querySelector(".script-name.error")).not.toBeNull();
    });

    it("marks scripts with runtime errors; clicking dismisses", async () => {
        const api = fakeApi([script("a", "Alpha", { runtimeError: { message: "[Alpha] onRequest threw: x", at: Date.now(), count: 3 } }), script("b", "Beta")]);
        const { container } = render(<Popup api={api} />);
        await waitFor(() => expect(container.querySelector(".err-ind.runtime")?.getAttribute("title")).toContain("onRequest threw"));
        expect(container.querySelector(".err-ind")!.getAttribute("title")).toContain("3×");
        expect(container.querySelectorAll(".err-ind").length).toBe(1);
        fireEvent.click(container.querySelector(".err-ind")!);
        await waitFor(() => expect(container.querySelector(".err-ind")).toBeNull());
        expect(api.calls).toContainEqual(["clearError", "a"]);
    });

    it("marks scripts with TypeScript errors", async () => {
        const api = fakeApi([script("a", "Alpha", { typeErrors: ["line 3: Type 'string' is not assignable to type 'number'."] })]);
        const { container } = render(<Popup api={api} />);
        await waitFor(() => expect(container.querySelector(".err-ind.types")?.getAttribute("title")).toContain("line 3: Type 'string'"));
        expect(container.querySelector(".err-ind")!.getAttribute("aria-label")).toBe("type error");
    });

    it("opens the manager (all, and on a script)", async () => {
        const api = fakeApi([script("a", "Alpha")]);
        render(<Popup api={api} />);
        fireEvent.click(await screen.findByLabelText("Edit"));
        fireEvent.click(screen.getByText("Manage all"));
        expect(api.calls).toEqual([["openManager", "a"], ["openManager", undefined]]);
    });

    it("folds parameters open, edits each type, and folds closed", async () => {
        const params: ScriptParams = {
            defs: {
                flag: { type: "boolean", description: "A flag" },
                count: { type: "number", min: 1, max: 10 },
                mode: { type: "enum", choices: ["a", "b"] },
                hosts: { type: "stringList" },
                note: { type: "string" },
            },
            values: { flag: false, count: 5, mode: "a", hosts: ["x"], note: "hi" },
        };
        const api = fakeApi([script("a", "Alpha", { paramDefs: params.defs })], { a: params });
        const { container } = render(<Popup api={api} />);
        const fold = await screen.findByLabelText("Toggle parameters");
        expect(container.querySelector(".param-fold")).toBeNull();
        fireEvent.click(fold);
        await screen.findByText("A flag");
        expect(fold.textContent).toBe("▾");

        fireEvent.click(container.querySelector(".param-fold .switch")!);
        const num = container.querySelector<HTMLInputElement>('.param-fold input[type="number"]')!;
        num.value = "99";
        fireEvent.change(num);
        expect(num.value).toBe("10");
        const sel = container.querySelector<HTMLSelectElement>(".param-fold select")!;
        sel.value = "b";
        fireEvent.change(sel);
        const ta = container.querySelector<HTMLTextAreaElement>(".param-fold textarea")!;
        ta.value = " one \n\n two ";
        fireEvent.change(ta);
        const txt = container.querySelector<HTMLInputElement>('.param-fold input[type="text"]')!;
        txt.value = "bye";
        fireEvent.change(txt);

        expect(api.calls).toEqual([
            ["setParam", "a", "flag", true],
            ["setParam", "a", "count", 10],
            ["setParam", "a", "mode", "b"],
            ["setParam", "a", "hosts", ["one", "two"]],
            ["setParam", "a", "note", "bye"],
        ]);
        expect(container.querySelector(".param-fold .switch.on")).not.toBeNull();

        fireEvent.click(fold);
        expect(container.querySelector(".param-fold")).toBeNull();
    });

    it("keeps edited param values when the list re-renders", async () => {
        const params: ScriptParams = { defs: { note: { type: "string" } }, values: { note: "hi" } };
        const api = fakeApi([script("a", "Alpha", { paramDefs: params.defs })], { a: params });
        const { container } = render(<Popup api={api} />);
        fireEvent.click(await screen.findByLabelText("Toggle parameters"));
        const txt = await waitFor(() => {
            const el = container.querySelector<HTMLInputElement>('.param-fold input[type="text"]');
            if (!el) throw new Error("fold not loaded");
            return el;
        });
        txt.value = "edited";
        fireEvent.change(txt);
        fireEvent.click(container.querySelector(".script-item .switch")!); // triggers a list refresh
        await waitFor(() => expect(api.calls.some((c) => c[0] === "setEnabled")).toBe(true));
        await new Promise((r) => setTimeout(r, 20));
        expect(container.querySelector<HTMLInputElement>('.param-fold input[type="text"]')!.value).toBe("edited");
    });
});
