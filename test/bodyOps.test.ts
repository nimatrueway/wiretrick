import { describe, it, expect } from "vitest";
import { resolveFileRef, runOp } from "../src/shared/bodyOps";

describe("replaceResponse { file }", () => {
    it("decodes base64 data: URLs and uses their media type", () => {
        const ref = "data:text/plain;base64," + btoa("served ok");
        expect(resolveFileRef(ref, "https://x.test/robots.txt")).toEqual({ mime: "text/plain", content: "served ok" });
    });

    it("decodes UTF-8 in base64 data: URLs", () => {
        const bytes = new TextEncoder().encode("héllo");
        const ref = "data:text/html;base64," + btoa(String.fromCharCode(...bytes));
        expect(resolveFileRef(ref, "https://x.test/")).toEqual({ mime: "text/html", content: "héllo" });
    });

    it("decodes percent-encoded data: URLs, defaulting the type", () => {
        expect(resolveFileRef("data:,a%20b", "https://x.test/a.js")).toEqual({ mime: "text/plain", content: "a b" });
    });

    it("passes non-data refs through with the URL's mime", () => {
        expect(resolveFileRef("/tmp/lib.js", "https://x.test/lib.js")).toEqual({ mime: "application/javascript", content: "/tmp/lib.js" });
    });

    it("the replace op serves the decoded file", async () => {
        const scripts = [{ id: "s", name: "S", match: ["*://x.test/*"], handlers: { replaceResponse: [() => ({ file: "data:text/plain;base64," + btoa("from file") })] } }];
        const out = await runOp(scripts as any, "replace", { url: "https://x.test/robots.txt", method: "GET" }, { log: () => {} } as any);
        expect(out).toEqual({ mime: "text/plain", content: "from file" });
    });
});
