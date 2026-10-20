//! Per-user locations (no `directories` crate: three env lookups suffice).

use std::path::PathBuf;

pub fn home() -> PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// `$XDG_CONFIG_HOME/wiretrick-helper`, `~/Library/Application Support/wiretrick-helper`, `%APPDATA%\wiretrick-helper`
pub fn config_dir() -> PathBuf {
    if let Some(d) = std::env::var_os("WIRETRICK_HELPER_HOME") {
        return PathBuf::from(d);
    }
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home().join("AppData").join("Roaming"))
    } else if cfg!(target_os = "macos") {
        home().join("Library").join("Application Support")
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .unwrap_or_else(|| home().join(".config"))
    };
    base.join("wiretrick-helper")
}
