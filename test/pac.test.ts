import { describe, it, expect } from "vitest";
import fixtures from "./fixtures/matcher.json";
import { buildPac, buildUserDecision, compileDecision, compilePac, hostPatternOf, pacMatcher, serverToPac, PROBE_HOST } from "../src/shared/pac";

describe("PAC matcher parity (TS ⇔ PAC ⇔ Rust fixtures)", () => {
    const m = pacMatcher();
    it.each(fixtures as { pattern: string; input: string; matched: boolean }[])("$pattern ~ $input → $matched", ({ pattern, input, matched }) => {
        expect(m(pattern, input)).toBe(matched);
    });
});

describe("hostPatternOf", () => {
    it("extracts the host part", () => {
        expect(hostPatternOf("https://*.Example.com/api/*")).toBe("*.example.com");
        expect(hostPatternOf("*://cdn.x.io:8443/*")).toBe("cdn.x.io:8443");
        expect(hostPatternOf("*")).toBeNull();
        expect(hostPatternOf("<all_urls>")).toBeNull();
    });
});

describe("routing PAC", () => {
    const helper = "PROXY 127.0.0.1:4567";
    const direct = buildUserDecision({ mode: "direct" });

    it("routes only matched hosts to the helper", () => {
        const f = compilePac(buildPac(4567, ["https://*.example.com/*", "http://plain.io/x/*"], direct));
        expect(f("https://api.example.com/", "api.example.com")).toBe(`${helper}; DIRECT`);
        expect(f("https://API.Example.com/", "API.Example.com")).toBe(`${helper}; DIRECT`);
        expect(f("http://plain.io/x/y.js", "plain.io")).toBe(`${helper}; DIRECT`);
        expect(f("https://other.org/", "other.org")).toBe("DIRECT");
        expect(f("https://example.com.evil.org/", "example.com.evil.org")).toBe("DIRECT");
        expect(f("ftp://plain.io/", "plain.io")).toBe("DIRECT");
        expect(f(`https://${PROBE_HOST}/`, PROBE_HOST)).toBe(`${helper}; DIRECT`);
    });

    it("port-qualified patterns match host:port", () => {
        const f = compilePac(buildPac(4567, ["https://dev.local:8443/*"], direct));
        expect(f("https://dev.local:8443/", "dev.local")).toBe(`${helper}; DIRECT`);
        expect(f("https://dev.local/", "dev.local")).toBe("DIRECT");
    });

    it("a host-less pattern routes every http(s) host", () => {
        const f = compilePac(buildPac(4567, ["*"], direct));
        expect(f("https://anything.org/", "anything.org")).toBe(`${helper}; DIRECT`);
        expect(f("ftp://anything.org/", "anything.org")).toBe("DIRECT");
    });
});

describe("user decision", () => {
    it("fixed_servers singleProxy + bypass", () => {
        const d = buildUserDecision({
            mode: "fixed_servers",
            rules: { singleProxy: { scheme: "http", host: "corp", port: 3128 }, bypassList: ["<local>", "*.intra.net", "10.0.0.0/8", "nope.com:8080"] },
        });
        expect(d.upstream).toBe("ask");
        const f = compileDecision(d.source);
        expect(f("https://a.org/", "a.org")).toBe("PROXY corp:3128; DIRECT");
        expect(f("https://intranet/", "intranet")).toBe("DIRECT");
        expect(f("https://x.intra.net/", "x.intra.net")).toBe("DIRECT");
        expect(f("http://10.2.3.4/", "10.2.3.4")).toBe("DIRECT");
        expect(f("http://11.2.3.4/", "11.2.3.4")).toBe("PROXY corp:3128; DIRECT");
        expect(f("http://nope.com:8080/", "nope.com")).toBe("DIRECT");
        expect(f("http://nope.com/", "nope.com")).toBe("PROXY corp:3128; DIRECT");
        expect(f("http://localhost/", "localhost")).toBe("DIRECT");
        // the whole PAC: routed host → helper, then the user's proxy
        const pac = compilePac(buildPac(9, ["https://a.org/*"], d));
        expect(pac("https://a.org/", "a.org")).toBe("PROXY 127.0.0.1:9; PROXY corp:3128; DIRECT");
        expect(pac("https://b.org/", "b.org")).toBe("PROXY corp:3128; DIRECT");
    });

    it("fixed_servers per scheme with fallback", () => {
        const d = buildUserDecision({
            mode: "fixed_servers",
            rules: { proxyForHttps: { scheme: "socks5", host: "s" }, fallbackProxy: { scheme: "https", host: "fb", port: 8443 } },
        });
        const f = compileDecision(d.source);
        expect(f("https://a.org/", "a.org")).toBe("SOCKS5 s:1080; DIRECT");
        expect(f("wss://a.org/", "a.org")).toBe("SOCKS5 s:1080; DIRECT");
        expect(f("http://a.org/", "a.org")).toBe("HTTPS fb:8443; DIRECT");
    });

    it("pac_script data is embedded and delegated to", () => {
        const user = `function FindProxyForURL(url, host) { if (shExpMatch(host, "*.corp")) return "PROXY c:1"; if (isPlainHostName(host)) return "DIRECT"; return "SOCKS s:2"; }`;
        const d = buildUserDecision({ mode: "pac_script", pacScript: { data: user } });
        const f = compileDecision(d.source);
        expect(f("https://x.corp/", "x.corp")).toBe("PROXY c:1");
        expect(f("https://web/", "web")).toBe("DIRECT");
        expect(f("https://a.org/", "a.org")).toBe("SOCKS s:2");
        const pac = compilePac(buildPac(9, ["https://x.corp/*"], d));
        expect(pac("https://x.corp/", "x.corp")).toBe("PROXY 127.0.0.1:9; PROXY c:1");
        expect(pac("https://a.org/", "a.org")).toBe("SOCKS s:2");
    });

    it("pac_script url uses the fetched text, else degrades to DIRECT with a note", () => {
        const ok = buildUserDecision({ mode: "pac_script", pacScript: { url: "http://x/p.pac" } }, null, `function FindProxyForURL(){return "PROXY f:1";}`);
        expect(compileDecision(ok.source)("https://a/", "a")).toBe("PROXY f:1");
        const bad = buildUserDecision({ mode: "pac_script", pacScript: { url: "http://x/p.pac" } }, null, null);
        expect(bad.upstream).toBe("direct");
        expect(bad.note).toMatch(/PAC/);
    });

    it("system mode mirrors the helper's OS snapshot", () => {
        const d = buildUserDecision({ mode: "system" }, { http: "PROXY h:1", https: "PROXY h:2", bypass: [".local.dev"] });
        const f = compileDecision(d.source);
        expect(f("http://a.org/", "a.org")).toBe("PROXY h:1; DIRECT");
        expect(f("https://a.org/", "a.org")).toBe("PROXY h:2; DIRECT");
        expect(f("https://x.local.dev/", "x.local.dev")).toBe("DIRECT");
        expect(buildUserDecision({ mode: "system" }, {}).upstream).toBe("direct");
        expect(buildUserDecision(null, null).upstream).toBe("direct");
    });

    it("serverToPac", () => {
        expect(serverToPac({ host: "p" })).toBe("PROXY p:80");
        expect(serverToPac({ scheme: "socks4", host: "p" })).toBe("SOCKS p:1080");
        expect(serverToPac({ scheme: "https", host: "::1", port: 9 })).toBe("HTTPS [::1]:9");
        expect(serverToPac(undefined)).toBeNull();
    });
});

describe("chrome.proxy accepts only ASCII PAC data", () => {
    it("generated PAC is ASCII and still evaluates (user PAC with non-ASCII text)", () => {
        const userPac = `function FindProxyForURL(url, host) { var note = "café — proxy"; return note.length === 12 ? "PROXY é.corp:1" : "DIRECT"; }`;
        const pac = buildPac(9000, ["https://x.com/*"], buildUserDecision({ mode: "pac_script", pacScript: { data: userPac } }));
        expect(/^[\x00-\x7f]*$/.test(pac)).toBe(true);
        const find = compilePac(pac);
        expect(find("https://y.com/", "y.com")).toBe("PROXY é.corp:1");
    });
});
