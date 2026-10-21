import { describe, it, expect } from "vitest";
import { resolveTheme } from "../src/ui/theme";

describe("resolveTheme", () => {
    it("explicit choice wins; system follows the OS", () => {
        expect(resolveTheme("light", false)).toBe("light");
        expect(resolveTheme("dark", true)).toBe("dark");
        expect(resolveTheme("system", true)).toBe("light");
        expect(resolveTheme(undefined, false)).toBe("dark");
    });
});
