/**
 * Star-pattern matcher, ported from the original match.js.
 * Patterns like "https://*.example.com/api/*" with greedy star groups.
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

/** Test a url against a list of patterns (any-match semantics). Empty list matches nothing. */
export function matchAny(patterns: string[], url: string): boolean {
    return patterns.some((p) => match(p, url).matched);
}
