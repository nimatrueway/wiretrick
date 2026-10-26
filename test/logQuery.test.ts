import { describe, it, expect } from "vitest";
import { basicSuggest, compileQuery, complete, parseQuery } from "../src/ui/network/netQuery";
import { LOG, logHighlight, type LogLine } from "../src/ui/logQuery";

const lines: LogLine[] = [
    { message: "pipeline: handled GET https://a.test/x", level: "debug", source: "pipeline" },
    { message: "page loaded", level: "info", source: "page" },
    { message: "upstream timeout after 30s", level: "warn", source: "myScript" },
    { message: "Fetch failed: connection refused", level: "error", source: "myScript", observed: true },
    { message: "see https://docs.test/help", level: "info", source: "page" },
];

function shown(q: string): string[] {
    const { ast, error } = parseQuery(q, LOG);
    expect(error).toBeNull();
    const test = compileQuery<LogLine, null>(ast, null);
    return lines.filter(test).map((l) => l.message.split(" ")[0]);
}

describe("Log query dialect", () => {
    it("bare words and regex search the message", () => {
        expect(shown("timeout")).toEqual(["upstream"]);
        expect(shown("/timeout|refused/")).toEqual(["upstream", "Fetch"]);
        expect(shown("-page")).not.toContain("page");
        expect(shown('"connection refused"')).toEqual(["Fetch"]);
    });

    it("level compares by severity", () => {
        expect(shown("level:>=warn")).toEqual(["upstream", "Fetch"]);
        expect(shown("level:<info")).toEqual(["pipeline:"]);
        expect(shown("level:info")).toEqual(["page", "see"]);
        expect(shown("level:debug,error")).toEqual(["pipeline:", "Fetch"]);
    });

    it("source and is: fields", () => {
        expect(shown("source:pipe")).toEqual(["pipeline:"]);
        expect(shown("-source:page level:<=info")).toEqual(["pipeline:"]);
        expect(shown("is:observed")).toEqual(["Fetch"]);
        expect(shown("is:link")).toEqual(["pipeline:", "see"]);
        expect(shown("level:error OR is:link source:page")).toEqual(["Fetch", "see"]);
    });

    it("reports bad fields and values", () => {
        expect(parseQuery("method:GET", LOG).error?.message).toMatch(/message/);
        const bad = parseQuery("level:loud", LOG).error!;
        expect(bad.message).toMatch(/level: expects/);
        expect("level:loud".slice(bad.start, bad.end)).toBe("loud");
        expect(parseQuery("is:touched", LOG).error?.message).toMatch(/observed, link/);
    });

    it("highlights the message words it looks for, not excluded ones", () => {
        const re = (q: string) => logHighlight(parseQuery(q, LOG).ast)?.source ?? null;
        expect(re("time*out -page level:warn")).toBe("time.*?out");
        expect(re("/a+b/ OR x.y")).toBe("a+b|x\\.y");
        expect(re("level:warn")).toBeNull();
        expect(re("message:=exact")).toBe("exact");
    });

    it("suggests fields and values from the log", () => {
        const data = { sources: ["myScript", "page", "pipeline"] };
        const labels = (t: string) => basicSuggest(t, data, LOG).map((s) => s.label);
        expect(labels("pip")).toContain("source: pipeline");
        expect(labels("err")).toContain("level: error");
        expect(labels("obs")).toContain("is: observed");
        expect(complete("lev", 3, data, LOG)!.items[0]).toMatchObject({ insert: "level:" });
        expect(complete("source:my", 9, data, LOG)!.items.map((i) => i.insert)).toContain("myScript");
    });
});
