import { describe, it, expect } from "vitest";
import { computeDirty } from "../src/ui/dirtyState";

describe("computeDirty", () => {
    it("clean when content and name match the stored values", () => {
        expect(computeDirty("code", "code", "My Script", "My Script")).toBe(false);
    });

    it("dirty on content or name change", () => {
        expect(computeDirty("code!", "code", "My Script", "My Script")).toBe(true);
        expect(computeDirty("code", "code", "My Script!", "My Script")).toBe(true);
        expect(computeDirty("code!", "code", "My Script!", "My Script")).toBe(true);
    });

    it("reverting content to the exact baseline clears dirty", () => {
        expect(computeDirty("code", "code", "My Script", "My Script")).toBe(false);
    });

    it("reverting the name to the stored one clears dirty", () => {
        expect(computeDirty("code", "code", "Renamed", "My Script")).toBe(true);
        expect(computeDirty("code", "code", "My Script", "My Script")).toBe(false);
    });

    it("name is ignored when not editable or nothing stored (settings view)", () => {
        expect(computeDirty("code", "code", undefined, undefined)).toBe(false);
        expect(computeDirty("code!", "code", undefined, undefined)).toBe(true);
        expect(computeDirty("code", "code", "whatever", undefined)).toBe(false);
    });

    it("unknown baseline (null) is conservatively dirty", () => {
        expect(computeDirty("code", null, "N", "N")).toBe(true);
    });
});
