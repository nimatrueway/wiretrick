//! Terminal styling for the CLI commands (never used in native-messaging
//! mode, where stdout carries protocol frames). Dependency-free ANSI; off
//! when the stream isn't a terminal, with NO_COLOR, or TERM=dumb;
//! FORCE_COLOR / CLICOLOR_FORCE turn it on regardless.

use std::io::IsTerminal;
use std::path::Path;
use std::sync::OnceLock;

fn detect(is_tty: bool) -> bool {
    let set = |k: &str| std::env::var_os(k).is_some_and(|v| !v.is_empty() && v != "0");
    if set("FORCE_COLOR") || set("CLICOLOR_FORCE") {
        return enable_vt();
    }
    if std::env::var_os("NO_COLOR").is_some_and(|v| !v.is_empty()) {
        return false;
    }
    if std::env::var("TERM").is_ok_and(|t| t == "dumb") {
        return false;
    }
    is_tty && enable_vt()
}

fn out_on() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| detect(std::io::stdout().is_terminal()))
}

fn err_on() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| detect(std::io::stderr().is_terminal()))
}

#[cfg(windows)]
fn enable_vt() -> bool {
    // Windows 10+ consoles need ENABLE_VIRTUAL_TERMINAL_PROCESSING for ANSI
    unsafe extern "system" {
        fn GetStdHandle(n: u32) -> isize;
        fn GetConsoleMode(h: isize, mode: *mut u32) -> i32;
        fn SetConsoleMode(h: isize, mode: u32) -> i32;
    }
    const STD_OUTPUT_HANDLE: u32 = -11i32 as u32;
    const STD_ERROR_HANDLE: u32 = -12i32 as u32;
    const VT: u32 = 0x0004;
    let mut any = false;
    for n in [STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
        unsafe {
            let h = GetStdHandle(n);
            let mut m = 0u32;
            if GetConsoleMode(h, &mut m) != 0 && (m & VT != 0 || SetConsoleMode(h, m | VT) != 0) {
                any = true;
            }
        }
    }
    // not a console (e.g. mintty/MSYS pipes): those terminals speak ANSI
    any || std::env::var_os("TERM").is_some()
}

#[cfg(not(windows))]
fn enable_vt() -> bool {
    true
}

fn paint(on: bool, code: &str, s: &str) -> String {
    if on {
        format!("\x1b[{code}m{s}\x1b[0m")
    } else {
        s.to_string()
    }
}

pub fn bold(s: &str) -> String {
    paint(out_on(), "1", s)
}
pub fn dim(s: &str) -> String {
    paint(out_on(), "2", s)
}
pub fn cyan(s: &str) -> String {
    paint(out_on(), "36", s)
}

/// `~`-shortened path, styled as a path.
pub fn path(p: &Path) -> String {
    let s = p.display().to_string();
    let home = crate::paths::home().display().to_string();
    let s = match s.strip_prefix(&home) {
        Some(rest) if !home.is_empty() && (rest.is_empty() || rest.starts_with(['/', '\\'])) => {
            format!("~{rest}")
        }
        _ => s,
    };
    cyan(&s)
}

/// `✓ message`
pub fn ok(msg: &str) {
    println!("{} {msg}", paint(out_on(), "1;32", "✓"));
}

/// `→ message` — a next step for the user.
pub fn next(msg: &str) {
    println!("{} {msg}", paint(out_on(), "1;34", "→"));
}

/// `error: message` on stderr.
pub fn error(msg: &str) {
    eprintln!("{} {msg}", paint(err_on(), "1;31", "error:"));
}

/// Help text: section headings bold, `rescript-helper …` lines with the
/// command cyan and options dim.
pub fn usage(text: &str) -> String {
    let mut out = String::new();
    for (i, line) in text.lines().enumerate() {
        let styled = if i == 0 {
            match line.split_once(" — ") {
                Some((name, rest)) => format!("{} — {rest}", bold(name)),
                None => bold(line),
            }
        } else if line.ends_with(':') && !line.starts_with(' ') {
            bold(line)
        } else if let Some(rest) = line.trim_start().strip_prefix("rescript-helper ") {
            let indent = &line[..line.len() - line.trim_start().len()];
            let (cmd, opts) = rest.split_once(' ').unwrap_or((rest, ""));
            let opts = if opts.is_empty() {
                String::new()
            } else {
                format!(" {}", dim(opts))
            };
            format!("{indent}rescript-helper {}{opts}", cyan(cmd))
        } else if line.starts_with("    ") && line.trim_start().starts_with('[') {
            dim(line)
        } else {
            line.to_string()
        };
        out.push_str(&styled);
        out.push('\n');
    }
    out.pop();
    out
}
