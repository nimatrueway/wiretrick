/**
 * PAC generation for the "process" tier (pure — no chrome.* here).
 *
 * The extension installs ONE PAC that:
 *   - sends hosts the helper may need to intercept (same rule as the
 *     helper's `host_may_match`) to `PROXY 127.0.0.1:<port>`, falling back
 *     to the user's own decision if the helper is gone;
 *   - sends every other host to the user's own decision unchanged.
 *
 * "The user's own decision" (`__resUser(url, host)`) is generated from the
 * proxy setting that was in effect before we took control (direct /
 * fixed_servers / pac_script / system / auto_detect). The same source is
 * evaluated in the extension to answer the helper's `needUpstream`, so
 * intercepted traffic leaves through exactly the proxy Chrome would use.
 */

import { hostGlobOf } from "./matcher";

export const PROBE_HOST = "wiretrick-helper.probe";

/** ES5 port of the helper's `matcher::matches` (first-occurrence splits) */
const MATCH_SRC = `function __resM(p, s) {
  var toks = p.split(/(\\*+)/), rest = s, any = false;
  for (var i = 0; i < toks.length; i++) {
    var t = toks[i];
    if (t === "") continue;
    if (t.charAt(0) === "*") { any = true; continue; }
    var at = rest.indexOf(t);
    if (at < 0 || (!any && at > 0)) return false;
    any = false;
    rest = rest.substring(at + t.length);
  }
  return any || rest === "";
}
function __resPort(url) {
  var m = /^([a-z][a-z0-9+.-]*):\\/\\/(?:[^\\/?#@]*@)?(\\[[^\\]]*\\]|[^:\\/?#]*)(?::(\\d+))?/i.exec(url);
  if (!m) return 0;
  if (m[3]) return parseInt(m[3], 10);
  var s = m[1].toLowerCase();
  return s === "https" || s === "wss" ? 443 : s === "ftp" ? 21 : 80;
}
function __resScheme(url) { return url.substring(0, url.indexOf(":")).toLowerCase(); }`;

/** The host gate of a `match` URLPattern as a star glob (lowercased), or null = "could be any host". */
export const hostPatternOf = hostGlobOf;

/** ---- the user's decision ---- */

export interface ProxyServer {
    scheme?: string;
    host: string;
    port?: number;
}

export interface UserProxyValue {
    mode: "direct" | "auto_detect" | "pac_script" | "fixed_servers" | "system";
    rules?: {
        singleProxy?: ProxyServer;
        proxyForHttp?: ProxyServer;
        proxyForHttps?: ProxyServer;
        proxyForFtp?: ProxyServer;
        fallbackProxy?: ProxyServer;
        bypassList?: string[];
    };
    pacScript?: { url?: string; data?: string; mandatory?: boolean };
}

/** OS proxy snapshot reported by the helper (`system` message) */
export interface SystemProxyInfo {
    http?: string | null;
    https?: string | null;
    socks?: string | null;
    bypass?: string[];
    pacUrl?: string | null;
}

const DEFAULT_PORTS: Record<string, number> = { http: 80, https: 443, quic: 443, socks4: 1080, socks5: 1080 };

export function serverToPac(s: ProxyServer | undefined): string | null {
    if (!s || !s.host) return null;
    const scheme = (s.scheme || "http").toLowerCase();
    const port = s.port || DEFAULT_PORTS[scheme] || 80;
    const host = s.host.includes(":") && !s.host.startsWith("[") ? `[${s.host}]` : s.host;
    const kw = scheme === "https" ? "HTTPS" : scheme === "socks4" ? "SOCKS" : scheme === "socks5" ? "SOCKS5" : scheme === "quic" ? "QUIC" : "PROXY";
    return `${kw} ${host}:${port}`;
}

/**
 * Chrome bypass-rule evaluation (subset): `<local>`, `*` globs, leading-dot
 * suffixes, optional `scheme://` prefix and `:port` suffix, IPv4 CIDR for
 * IP-literal hosts. Loopback is always bypassed (Chrome's implicit rule).
 */
const BYPASS_SRC = `function __resIp4(h) {
  var m = /^(\\d+)\\.(\\d+)\\.(\\d+)\\.(\\d+)$/.exec(h);
  return m ? ((+m[1] << 24) >>> 0) + (+m[2] << 16) + (+m[3] << 8) + (+m[4]) : null;
}
function __resBypassed(url, host, list) {
  var h = host.toLowerCase();
  if (h === "localhost" || h === "::1" || h === "[::1]" || /^127\\./.test(h)) return true;
  var scheme = __resScheme(url), port = __resPort(url);
  for (var i = 0; i < list.length; i++) {
    var b = String(list[i]).replace(/^\\s+|\\s+$/g, "").toLowerCase();
    if (!b) continue;
    if (b === "<local>") { if (h.indexOf(".") < 0 && h.indexOf(":") < 0) return true; continue; }
    if (b === "<-loopback>") continue;
    var sAt = b.indexOf("://");
    if (sAt >= 0) { if (b.substring(0, sAt) !== scheme) continue; b = b.substring(sAt + 3); }
    var slash = b.indexOf("/");
    if (slash >= 0) {
      var ip = __resIp4(h), net = __resIp4(b.substring(0, slash)), bits = parseInt(b.substring(slash + 1), 10);
      if (ip !== null && net !== null && bits >= 0 && bits <= 32) {
        var mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
        if (((ip & mask) >>> 0) === ((net & mask) >>> 0)) return true;
      }
      continue;
    }
    var pm = /^(.*):(\\d+)$/.exec(b);
    if (pm && (pm[1].indexOf(":") < 0 || pm[1].charAt(pm[1].length - 1) === "]")) { if (parseInt(pm[2], 10) !== port) continue; b = pm[1]; }
    if (b.charAt(0) === ".") b = "*" + b;
    if (__resM(b, h)) return true;
  }
  return false;
}`;

/** `function __resUser(url, host)` for a fixed_servers-like rule set */
function fixedDecision(r: {
    http?: string | null;
    https?: string | null;
    ftp?: string | null;
    fallback?: string | null;
    bypass?: string[];
}): string {
    const j = (v: string | null | undefined) => JSON.stringify(v || null);
    return `var __resFixed = { http: ${j(r.http)}, https: ${j(r.https)}, ftp: ${j(r.ftp)}, fallback: ${j(r.fallback)}, bypass: ${JSON.stringify(r.bypass || [])} };
function __resUser(url, host) {
  if (__resBypassed(url, host, __resFixed.bypass)) return "DIRECT";
  var s = __resScheme(url);
  var p = s === "https" || s === "wss" ? __resFixed.https : s === "http" || s === "ws" ? __resFixed.http : s === "ftp" ? __resFixed.ftp : null;
  p = p || __resFixed.fallback;
  return p ? p + "; DIRECT" : "DIRECT";
}`;
}

/** wrap a user PAC so its FindProxyForURL becomes `__resUserFindProxyForURL` */
function embedUserPac(src: string): string {
    const renamed = src.replace(/\bFindProxyForURL\b/g, "__resUserFindProxyForURL");
    return `${renamed}
;function __resUser(url, host) {
  var r = __resUserFindProxyForURL(url, host);
  return r ? String(r) : "DIRECT";
}`;
}

export interface UserDecision {
    /** JS defining `__resUser(url, host)` (+ helpers it needs) */
    source: string;
    /** helper upstream mode for intercepted requests */
    upstream: "direct" | "ask";
    /** human-readable caveat when the decision is approximate */
    note?: string;
}

/**
 * Build the user's decision. `fetchedPac` is the text of the PAC the user
 * (or the OS, for system/auto_detect) points at, when it had to be fetched.
 */
export function buildUserDecision(value: UserProxyValue | null | undefined, system?: SystemProxyInfo | null, fetchedPac?: string | null): UserDecision {
    const mode = value?.mode || "system";
    if (mode === "direct") return { source: `function __resUser() { return "DIRECT"; }`, upstream: "direct" };
    if (mode === "fixed_servers") {
        const r = value?.rules || {};
        const single = serverToPac(r.singleProxy);
        return {
            source: fixedDecision({
                http: single || serverToPac(r.proxyForHttp),
                https: single || serverToPac(r.proxyForHttps),
                ftp: single || serverToPac(r.proxyForFtp),
                fallback: single ? null : serverToPac(r.fallbackProxy),
                bypass: r.bypassList || [],
            }),
            upstream: "ask",
        };
    }
    if (mode === "pac_script") {
        const src = value?.pacScript?.data || fetchedPac;
        if (src) return { source: embedUserPac(src), upstream: "ask" };
        return { source: `function __resUser() { return "DIRECT"; }`, upstream: "direct", note: `could not load the configured PAC script (${value?.pacScript?.url || "no url"}) — non-intercepted traffic goes DIRECT while the process tier is active` };
    }
    if (mode === "auto_detect") {
        if (fetchedPac) return { source: embedUserPac(fetchedPac), upstream: "ask" };
        return { source: `function __resUser() { return "DIRECT"; }`, upstream: "direct", note: "proxy auto-detect (WPAD) found no PAC — traffic goes DIRECT while the process tier is active" };
    }
    // system
    if (system?.pacUrl && fetchedPac) return { source: embedUserPac(fetchedPac), upstream: "ask" };
    if (system && (system.http || system.https || system.socks)) {
        return {
            source: fixedDecision({
                http: system.http || system.socks,
                https: system.https || system.socks,
                ftp: system.socks,
                fallback: null,
                bypass: system.bypass || [],
            }),
            upstream: "ask",
        };
    }
    return {
        source: `function __resUser() { return "DIRECT"; }`,
        upstream: "direct",
        note: system?.pacUrl ? `could not load the system PAC (${system.pacUrl}) — traffic goes DIRECT while the process tier is active` : undefined,
    };
}

/** ---- the installed PAC ---- */

export function buildPac(port: number, matchPatterns: string[], user: UserDecision): string {
    const hosts = [...new Set(matchPatterns.map(hostPatternOf))];
    const any = hosts.includes(null);
    const list = hosts.filter((h): h is string => h !== null);
    return asciiOnly(`// Wiretrick — process tier routing (generated)
${MATCH_SRC}
${BYPASS_SRC}
${user.source}
var __resHosts = ${JSON.stringify(list)};
var __resAny = ${any};
var __resHelper = "PROXY 127.0.0.1:${port}";
function __resRouted(url, h) {
  if (h === ${JSON.stringify(PROBE_HOST)}) return true;
  var s = __resScheme(url);
  if (s !== "http" && s !== "https" && s !== "ws" && s !== "wss") return false;
  if (__resAny) return true;
  var port = __resPort(url);
  for (var i = 0; i < __resHosts.length; i++) {
    var p = __resHosts[i];
    if (__resM(p, h) || __resM(p, h + ":" + port) || __resM(p, "[" + h + "]:" + port)) return true;
  }
  return false;
}
function FindProxyForURL(url, host) {
  if (__resRouted(url, host.toLowerCase())) return __resHelper + "; " + __resUser(url, host);
  return __resUser(url, host);
}
`);
}

/** chrome.proxy rejects non-ASCII PAC data: \uXXXX is valid in JS strings, comments and identifiers alike */
export function asciiOnly(src: string): string {
    return src.replace(/[^\x00-\x7f]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

/** ---- in-extension evaluation (needUpstream, tests) ---- */

/** standard PAC builtins Chrome provides; DNS-dependent ones are best effort */
export const PAC_SHIMS = `function isPlainHostName(h) { return String(h).indexOf(".") < 0; }
function dnsDomainIs(h, d) { h = String(h); d = String(d); return h.length >= d.length && h.substring(h.length - d.length) === d; }
function localHostOrDomainIs(h, hd) { return h === hd || (String(h).indexOf(".") < 0 && String(hd).indexOf(h + ".") === 0); }
function dnsResolve(h) { return /^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(h) ? h : (h === "localhost" ? "127.0.0.1" : null); }
function dnsResolveEx(h) { return dnsResolve(h) || ""; }
function isResolvable(h) { return dnsResolve(h) !== null; }
function isResolvableEx(h) { return isResolvable(h); }
function myIpAddress() { return "127.0.0.1"; }
function myIpAddressEx() { return "127.0.0.1"; }
function convert_addr(ip) { var p = String(ip).split("."); return (((+p[0]) << 24) >>> 0) + ((+p[1]) << 16) + ((+p[2]) << 8) + (+p[3]); }
function isInNet(h, pat, mask) { var ip = dnsResolve(h); if (!ip) return false; var m = convert_addr(mask); return ((convert_addr(ip) & m) >>> 0) === ((convert_addr(pat) & m) >>> 0); }
function isInNetEx(h, cidr) { var p = String(cidr).split("/"); var b = parseInt(p[1], 10); var m = b === 0 ? 0 : (0xffffffff << (32 - b)) >>> 0; var ip = dnsResolve(h); return !!ip && ((convert_addr(ip) & m) >>> 0) === ((convert_addr(p[0]) & m) >>> 0); }
function dnsDomainLevels(h) { return String(h).split(".").length - 1; }
function shExpMatch(s, p) { var re = "^" + String(p).replace(/[.+^\${}()|[\\]\\\\]/g, "\\\\$&").replace(/\\*/g, ".*").replace(/\\?/g, ".") + "$"; return new RegExp(re).test(s); }
function weekdayRange() { return true; }
function dateRange() { return true; }
function timeRange() { return true; }
function alert() {}
`;

/** compile a decision source into `(url, host) => pacResult` (needs eval) */
export function compileDecision(source: string): (url: string, host: string) => string {
    const fn = new Function(`${PAC_SHIMS}\n${MATCH_SRC}\n${BYPASS_SRC}\n${source}\nreturn __resUser;`)();
    return (url, host) => {
        try {
            const r = fn(url, host);
            return r ? String(r) : "DIRECT";
        } catch {
            return "DIRECT";
        }
    };
}

/** compile a whole PAC into `FindProxyForURL` (tests) */
export function compilePac(pac: string): (url: string, host: string) => string {
    return new Function(`${PAC_SHIMS}\n${pac}\nreturn FindProxyForURL;`)();
}

/** the PAC's ES5 matcher as a function (tests: parity with matcher.ts / Rust) */
export function pacMatcher(): (pattern: string, input: string) => boolean {
    return new Function(`${MATCH_SRC}\nreturn __resM;`)();
}
