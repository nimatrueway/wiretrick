//! Port of `src/shared/matcher.ts` (`match(...).matched` / `matchAny`).
//! Star groups are greedy-from-the-left exactly like the TS version: each
//! literal token is split at its FIRST occurrence in the remaining input.

fn tokenize(pattern: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let bytes = pattern.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'*' {
            if i > start {
                out.push(&pattern[start..i]);
            }
            let s = i;
            while i < bytes.len() && bytes[i] == b'*' {
                i += 1;
            }
            out.push(&pattern[s..i]);
            start = i;
        } else {
            i += 1;
        }
    }
    if start < pattern.len() {
        out.push(&pattern[start..]);
    }
    out
}

pub fn matches(pattern: &str, input: &str) -> bool {
    let mut rest = input;
    let mut match_anything = false;
    for token in tokenize(pattern) {
        if token.starts_with('*') {
            match_anything = true;
            continue;
        }
        match rest.split_once(token) {
            Some((before, after)) => {
                if !match_anything && !before.is_empty() {
                    return false;
                }
                match_anything = false;
                rest = after;
            }
            None => return false,
        }
    }
    match_anything || rest.is_empty()
}

pub fn match_any(patterns: &[String], input: &str) -> bool {
    patterns.iter().any(|p| matches(p, input))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Case {
        pattern: String,
        input: String,
        matched: bool,
    }

    #[test]
    fn shared_fixtures() {
        let raw = include_str!("../../test/fixtures/matcher.json");
        let cases: Vec<Case> = serde_json::from_str(raw).unwrap();
        assert!(cases.len() > 40);
        for c in cases {
            assert_eq!(
                matches(&c.pattern, &c.input),
                c.matched,
                "{} ~ {}",
                c.pattern,
                c.input
            );
        }
    }

    #[test]
    fn empty_list_matches_nothing() {
        assert!(!match_any(&[], "https://x/"));
    }
}
