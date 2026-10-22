import { describe, it, expect } from "vitest";
import { addUiPort, clearLogHistory, log } from "../src/background/engine/logs";

const port = () => {
    const got: any[] = [];
    return { got, p: { postMessage: (m: any) => got.push(m), onDisconnect: { addListener: () => {} } } as any };
};

describe("clearing the log", () => {
    it("a manager that reconnects after clear gets no old lines back", () => {
        log(3, "[S] type error: Cannot find name 'x'", "error");
        const a = port();
        addUiPort(a.p);
        expect(a.got.some((m) => m.entry.message.includes("type error"))).toBe(true);
        clearLogHistory();
        const b = port();
        addUiPort(b.p);
        expect(b.got).toEqual([]);
    });
});
