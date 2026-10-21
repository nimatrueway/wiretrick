//! URL matching for routes, plus the star matcher used for proxy bypass lists.
//!
//! Routes' `match` entries are URLPattern constructor strings
//! (<https://developer.mozilla.org/en-US/docs/Web/API/URL_Pattern_API>), the
//! same `new URLPattern(str).test(url)` the extension runs. `<all_urls>` and
//! `*` match every URL; strings that don't parse match nothing.
//!
//! `matches` is a port of `src/shared/matcher.ts` (`match(...).matched`).
//! Star groups are greedy-from-the-left exactly like the TS version: each
//! literal token is split at its FIRST occurrence in the remaining input.

use url::Url;
use urlpattern::parser::RegexSyntax;
use urlpattern::regexp::RegExp;
use urlpattern::{UrlPattern, UrlPatternInit, UrlPatternMatchInput};

/// `regex-lite` backend for URLPattern: ~1 MB smaller than `regex`. Group
/// regexps in patterns get ASCII-only classes (`\d`, `\w`), no `\p{..}`.
#[derive(Debug)]
pub struct Re(regex_lite::Regex);

impl RegExp for Re {
    fn syntax() -> RegexSyntax {
        RegexSyntax::Rust
    }

    fn parse(pattern: &str, _flags: &str, _force_eval: bool) -> Result<Self, ()> {
        regex_lite::Regex::new(pattern).map(Re).map_err(|_| ())
    }

    fn matches<'a>(&self, text: &'a str) -> Option<Vec<Option<&'a str>>> {
        let caps = self.0.captures(text)?;
        Some(caps.iter().skip(1).map(|c| c.map(|m| m.as_str())).collect())
    }

    fn pattern_string(&self) -> &str {
        self.0.as_str()
    }
}

/// A parsed route `match` entry.
#[derive(Debug)]
pub enum UrlMatcher {
    All,
    Pattern(Box<UrlPattern<Re>>),
}

impl UrlMatcher {
    /// `None` when the string isn't a valid URLPattern (it matches nothing).
    pub fn parse(pattern: &str) -> Option<Self> {
        if pattern == "<all_urls>" || pattern == "*" {
            return Some(Self::All);
        }
        let init = UrlPatternInit::parse_constructor_string::<Re>(pattern, None).ok()?;
        let p = UrlPattern::parse(init, Default::default()).ok()?;
        Some(Self::Pattern(Box::new(p)))
    }

    pub fn test(&self, url: &Url) -> bool {
        match self {
            Self::All => true,
            Self::Pattern(p) => p
                .test(UrlPatternMatchInput::Url(url.clone()))
                .unwrap_or(false),
        }
    }

    /// Could this pattern match some URL on `host:port`? (MITM vs raw tunnel)
    /// Over-approximates: ignores protocol and path, and also tries the empty
    /// port a URL has when 80/443 is its scheme's default.
    pub fn host_may_match(&self, host: &str, port: u16) -> bool {
        let Self::Pattern(p) = self else {
            return true;
        };
        let host = host.trim_end_matches('.').to_ascii_lowercase();
        let host = if host.contains(':') && !host.starts_with('[') {
            format!("[{host}]")
        } else {
            host
        };
        if p.hostname.matcher.matches(&host).is_none() {
            return false;
        }
        let port_s = port.to_string();
        p.port.matcher.matches(&port_s).is_some()
            || (matches!(port, 80 | 443) && p.port.matcher.matches("").is_some())
    }
}

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
    fn shared_urlpattern_fixtures() {
        let raw = include_str!("../../test/fixtures/urlpattern.json");
        let cases: Vec<Case> = serde_json::from_str(raw).unwrap();
        assert!(!cases.is_empty());
        for c in cases {
            assert_eq!(
                url_matches(&c.pattern, &c.input),
                c.matched,
                "{} ~ {}",
                c.pattern,
                c.input
            );
        }
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

    fn url_matches(pattern: &str, url: &str) -> bool {
        UrlMatcher::parse(pattern).is_some_and(|m| m.test(&Url::parse(url).unwrap()))
    }

    fn host_may(pattern: &str, host: &str, port: u16) -> bool {
        UrlMatcher::parse(pattern).is_some_and(|m| m.host_may_match(host, port))
    }

    #[test]
    fn url_patterns() {
        let yes = [
            ("*://example.com/*", "https://example.com/a?b=1"),
            ("*://example.com/*", "http://example.com/"),
            ("*://example.com/*", "https://example.com:443/a"),
            ("https://*.example.com/*", "https://a.b.example.com/x"),
            (
                "*://app.example.com/api/user*",
                "https://app.example.com/api/users?x",
            ),
            (
                "https://example.com/users/:id",
                "https://example.com/users/42",
            ),
            ("https://localhost:*/*", "https://localhost:8443/x"),
            (
                r"https://example.com/users/(\d+)",
                "https://example.com/users/42",
            ),
            ("https://example.com/:file.js", "https://example.com/app.js"),
            ("<all_urls>", "https://anything.test:1234/p?q#h"),
            ("<all_urls>", "http://[::1]/"),
            ("*", "http://localhost:1/"),
            (r"http://[\:\:1]:*/*", "http://[::1]:8080/"),
        ];
        let no = [
            ("*://example.com/*", "https://example.com:8080/a"),
            ("*://example.com/*", "https://evil.com/"),
            ("https://*.example.com/*", "https://example.com/"),
            (
                "https://example.com/users/:id",
                "https://example.com/users/42/x",
            ),
            ("*example.com*", "https://example.com/"),
            (
                r"https://example.com/users/(\d+)",
                "https://example.com/users/abc",
            ),
            ("/relative/*", "https://example.com/relative/x"),
            ("", "https://example.com/"),
        ];
        for (p, u) in yes {
            assert!(url_matches(p, u), "{p} should match {u}");
        }
        for (p, u) in no {
            assert!(!url_matches(p, u), "{p} should not match {u}");
        }
        assert!(UrlMatcher::parse("*example.com*").is_none());
    }

    #[test]
    fn host_gate() {
        let yes = [
            ("*://example.com/*", "example.com", 443),
            ("*://example.com/*", "EXAMPLE.com", 443),
            ("http://example.com/*", "example.com", 80),
            ("https://*.example.com/*", "a.b.example.com", 443),
            ("https://:sub.example.com/*", "a.example.com", 443),
            ("https://(api|www).example.com/*", "www.example.com", 443),
            ("https://example.com:8443/*", "example.com", 8443),
            ("https://localhost:*/*", "localhost", 12345),
            (r"https://[\:\:1]/*", "::1", 443),
            ("<all_urls>", "anything.test", 9999),
            ("*://*/*", "anything.test", 443),
            ("*", "anything.test", 1),
        ];
        let no = [
            ("*://example.com/*", "evil.com", 443),
            ("*://example.com/*", "example.com", 8443),
            ("https://*.example.com/*", "example.com", 443),
            ("https://:sub.example.com/*", "a.b.example.com", 443),
            ("https://example.com:8443/*", "example.com", 443),
            ("*example.com*", "example.com", 443),
        ];
        for (p, h, port) in yes {
            assert!(host_may(p, h, port), "{p} should gate {h}:{port}");
        }
        for (p, h, port) in no {
            assert!(!host_may(p, h, port), "{p} should not gate {h}:{port}");
        }
    }
}
