import { describe, it, expect } from "vitest";
import { fireEvent, waitFor } from "@testing-library/preact";
import { mountLogFilter, type LogFilter } from "../src/ui/logFilter";

if (typeof (globalThis as any).localStorage === "undefined") {
    const m = new Map<string, string>();
    (globalThis as any).localStorage = {
        getItem: (k: string) => m.get(k) ?? null,
        setItem: (k: string, v: string) => void m.set(k, String(v)),
        removeItem: (k: string) => void m.delete(k),
        clear: () => m.clear(),
    };
}

describe("Log filter bar", () => {
    it("filters lines from typed Basic text and placeholders name the message", async () => {
        localStorage.clear();
        const host = document.createElement("div");
        document.body.append(host);
        let f: LogFilter | null = null;
        mountLogFilter(host, () => ({ sources: ["pipeline"] }), (x) => (f = x));
        await waitFor(() => expect(f).not.toBeNull());
        expect(f!.test({ message: "anything", level: "info", source: "page" })).toBe(true);
        const box = host.querySelector("input.net-filter") as HTMLInputElement;
        expect(box.placeholder).toMatch(/Filter message/);
        fireEvent.input(box, { target: { value: "level:>=warn" } });
        fireEvent.keyDown(box, { key: "Enter" });
        await waitFor(() => expect(f!.test({ message: "x", level: "info", source: "page" })).toBe(false));
        expect(f!.test({ message: "x", level: "error", source: "page" })).toBe(true);
        expect(host.querySelector(".net-qchip")?.textContent).toMatch(/level/);
        host.remove();
    });
});
