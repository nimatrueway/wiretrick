import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/shared/folderSync", () => ({
    loadSavedHandle: vi.fn(async () => null),
    clearSavedHandle: vi.fn(async () => {}),
    saveHandle: vi.fn(async () => {}),
}));

const g = globalThis as any;
let sent: string[];

beforeEach(() => {
    sent = [];
    g.chrome = {
        runtime: {
            sendMessage: (msg: any, cb: (r: any) => void) => {
                sent.push(msg.type);
                cb(msg.type === "folderSyncStart" ? { ok: true } : msg.type === "folderSyncPreview" ? { conflicts: [] } : {});
            },
        },
    };
    g.window = g;
});
afterEach(() => {
    delete g.chrome;
    delete g.showDirectoryPicker;
});

describe("fsBridge.openFolder", () => {
    it("a cancelled pick keeps the folder synced so far", async () => {
        const fsBridge = await import("../src/ui/fsBridge");
        fsBridge.setCachedActive(true);
        g.showDirectoryPicker = vi.fn(async () => {
            throw new DOMException("The user aborted a request.", "AbortError");
        });
        await expect(fsBridge.openFolder()).rejects.toMatchObject({ name: "AbortError" });
        expect(sent).toEqual([]);
    });

    it("a picked folder replaces the synced one: the old stops just before the new starts", async () => {
        const fsBridge = await import("../src/ui/fsBridge");
        fsBridge.setCachedActive(true);
        g.showDirectoryPicker = vi.fn(async () => ({ name: "new" }));
        await fsBridge.openFolder();
        expect(sent).toEqual(["folderSyncPreview", "folderSyncStop", "folderSyncStart"]);
    });

    it("nothing synced yet: nothing to stop", async () => {
        const fsBridge = await import("../src/ui/fsBridge");
        fsBridge.setCachedActive(false);
        g.showDirectoryPicker = vi.fn(async () => ({ name: "new" }));
        await fsBridge.openFolder();
        expect(sent).toEqual(["folderSyncPreview", "folderSyncStart"]);
    });
});
