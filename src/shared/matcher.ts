/**
 * Script `match` patterns are URLPattern strings (matchAny, parseMatchPattern…).
 * The star matcher below (`match`/`matchReplace`) is the older greedy
 * "*"-glob, still used for proxy bypass lists.
 */

function tokenize(str: string): string[] {
    const ans = str.split(/(\*+)/g);
    if (ans[0] === "") {
        ans.shift();
    }
    if (ans[ans.length - 1] === "") {
        ans.pop();
    }
    return ans;
}

export interface MatchResult {
    matched: boolean;
    freeVars: { [group: number]: string[] };
}

export function match(pattern: string, str: string): MatchResult {
    const patternTokens = tokenize(pattern);
    const freeVars: { [group: number]: string[] } = {};
    let varGroup = 1;
    let strParts = str;
    let matchAnything = false;
    let completeMatch = patternTokens.every((token) => {
        if (token.charAt(0) === "*") {
            matchAnything = true;
            varGroup = token.length;
            freeVars[varGroup] = freeVars[varGroup] || [];
        } else {
            const matches = strParts.split(token);
            if (matches.length > 1) {
                const possibleFreeVar = matches.shift() as string;
                if (matchAnything) {
                    freeVars[varGroup].push(possibleFreeVar);
                } else if (possibleFreeVar !== "") {
                    return false;
                }
                matchAnything = false;
                strParts = matches.join(token);
            } else {
                return false;
            }
        }
        return true;
    });

    if (matchAnything) {
        freeVars[varGroup].push(strParts);
    } else if (strParts !== "") {
        completeMatch = false;
    }

    return { matched: completeMatch, freeVars };
}

function replaceAfter(str: string, idx: number, matchStr: string, replace: string): string {
    return str.substring(0, idx) + str.substring(idx).replace(matchStr, replace);
}

export function matchReplace(pattern: string, replacePattern: string, str: string): string;
export function matchReplace(matchData: MatchResult, replacePattern: string, str: string): string;
export function matchReplace(patternOrMatch: string | MatchResult, replacePattern: string, str: string): string {
    let matchData: MatchResult;
    if (
        typeof patternOrMatch === "object" &&
        patternOrMatch !== null &&
        (patternOrMatch as MatchResult).matched !== undefined &&
        (patternOrMatch as MatchResult).freeVars !== undefined
    ) {
        matchData = patternOrMatch as MatchResult;
    } else {
        matchData = match(patternOrMatch as string, str);
    }

    if (!matchData.matched) {
        return str;
    }

    let currentStarGroupIdx = 0;
    const starGroups = replacePattern.match(/\*+/g) || [];
    starGroups.forEach((starGroup) => {
        const freeVarGroup = matchData.freeVars[starGroup.length] || [];
        let freeVar = freeVarGroup.shift();
        if (freeVar === undefined) {
            freeVar = starGroup;
        }
        replacePattern = replaceAfter(replacePattern, currentStarGroupIdx, starGroup, freeVar);
        currentStarGroupIdx = replacePattern.indexOf(freeVar) + freeVar.length;
    });

    return replacePattern;
}

/** "<all_urls>" and "*" match every URL (as in WebExtension match patterns). */
const ALL_URLS = new Set(["<all_urls>", "*"]);

const parsed = new Map<string, URLPattern | null>();

/**
 * A script `match` entry as a URLPattern (constructor-string syntax, see
 * https://developer.mozilla.org/en-US/docs/Web/API/URL_Pattern_API).
 * Throws on invalid syntax.
 */
export function parseMatchPattern(pattern: string): URLPattern {
    return ALL_URLS.has(pattern) ? new URLPattern({}) : new URLPattern(pattern);
}

function cached(pattern: string): URLPattern | null {
    let p = parsed.get(pattern);
    if (p === undefined) {
        try {
            p = parseMatchPattern(pattern);
        } catch {
            p = null;
        }
        if (parsed.size > 1000) parsed.clear();
        parsed.set(pattern, p);
    }
    return p;
}

/** Why a `match` entry is unusable, or null when it's a valid URLPattern. */
export function matchPatternError(pattern: unknown): string | null {
    if (typeof pattern !== "string") return `match entries must be strings, got ${typeof pattern}`;
    try {
        parseMatchPattern(pattern);
        return null;
    } catch {
        return `"${pattern}" is not a valid URLPattern — expected a full URL pattern like "*://example.com/*" (https://developer.mozilla.org/en-US/docs/Web/API/URL_Pattern_API)`;
    }
}

/** Test a url against a list of URLPattern strings (any-match). Empty list or invalid patterns match nothing. */
export function matchAny(patterns: string[], url: string): boolean {
    return patterns.some((p) => {
        try {
            return cached(p)?.test(url) ?? false;
        } catch {
            return false;
        }
    });
}

/** literal text and "*" wildcards only (no groups, regexps, or escapes) */
const PLAIN = /^[^:(){}?+\\]*$/;

/**
 * The host gate of a pattern as a star glob over "host[:port]" (lowercased),
 * or null = could be any host. Over-approximates: used to pick which hosts
 * to route/observe; matchAny re-checks each URL exactly.
 */
export function hostGlobOf(pattern: string): string | null {
    const p = cached(pattern);
    if (!p || !PLAIN.test(p.hostname) || p.hostname === "*") return null;
    const port = p.port === "" ? "" : /^\d+$/.test(p.port) ? `:${p.port}` : ":*";
    return p.hostname.toLowerCase() + port;
}

/** A coarse "*"-glob over the whole URL (e.g. for CDP Fetch patterns); "*" when not expressible. */
export function urlGlobOf(pattern: string): string {
    const p = cached(pattern);
    const host = hostGlobOf(pattern);
    if (!p || host === null) return "*";
    const proto = PLAIN.test(p.protocol) ? p.protocol : "*";
    return `${proto}://${host.replace(/:\*$/, "*")}/*`;
}
