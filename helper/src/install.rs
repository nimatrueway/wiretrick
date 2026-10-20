//! `install` / `uninstall` / `trust-ca` / `untrust-ca`: user-level only,
//! never needs admin rights.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::ca::CA_NAME;
use crate::paths::{config_dir, home};
use crate::ui;

pub const HOST_NAME: &str = "com.wiretrick.helper";

/// (label, per-user NativeMessagingHosts dir or registry key)
fn browser_targets() -> Vec<(&'static str, PathBuf)> {
    let h = home();
    if cfg!(target_os = "macos") {
        let s = h.join("Library").join("Application Support");
        vec![
            ("chrome", s.join("Google/Chrome")),
            ("chrome-beta", s.join("Google/Chrome Beta")),
            ("chrome-canary", s.join("Google/Chrome Canary")),
            ("chromium", s.join("Chromium")),
            ("brave", s.join("BraveSoftware/Brave-Browser")),
            ("edge", s.join("Microsoft Edge")),
            ("vivaldi", s.join("Vivaldi")),
        ]
    } else if cfg!(windows) {
        // registry keys (HKCU\<key>\NativeMessagingHosts\<name>)
        vec![
            ("chrome", PathBuf::from(r"Software\Google\Chrome")),
            ("chromium", PathBuf::from(r"Software\Chromium")),
            (
                "brave",
                PathBuf::from(r"Software\BraveSoftware\Brave-Browser"),
            ),
            ("edge", PathBuf::from(r"Software\Microsoft\Edge")),
        ]
    } else {
        let c = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| h.join(".config"));
        vec![
            ("chrome", c.join("google-chrome")),
            ("chrome-beta", c.join("google-chrome-beta")),
            ("chrome-dev", c.join("google-chrome-unstable")),
            ("chromium", c.join("chromium")),
            ("brave", c.join("BraveSoftware/Brave-Browser")),
            ("edge", c.join("microsoft-edge")),
            ("vivaldi", c.join("vivaldi")),
        ]
    }
}

pub struct InstallOpts {
    pub extension_ids: Vec<String>,
    pub browsers: Vec<String>,
    /// explicit Chrome user-data-dirs (tests, portable profiles)
    pub user_data_dirs: Vec<PathBuf>,
    pub trust: bool,
    pub nssdb: Option<PathBuf>,
}

fn manifest_json(exe: &Path, ids: &[String]) -> String {
    let origins: Vec<String> = ids
        .iter()
        .map(|id| format!("chrome-extension://{id}/"))
        .collect();
    serde_json::to_string_pretty(&serde_json::json!({
        "name": HOST_NAME,
        "description": "Wiretrick local interception helper (process strategy)",
        "path": exe.to_string_lossy(),
        "type": "stdio",
        "allowed_origins": origins,
    }))
    .unwrap()
}

/// Copy ourselves to a stable per-user location the manifest can point at.
fn stable_exe() -> std::io::Result<PathBuf> {
    let me = std::env::current_exe()?;
    let dir = config_dir().join("bin");
    std::fs::create_dir_all(&dir)?;
    let dest = dir.join(if cfg!(windows) {
        "wiretrick-helper.exe"
    } else {
        "wiretrick-helper"
    });
    let same = std::fs::canonicalize(&me).ok() == std::fs::canonicalize(&dest).ok();
    if !same {
        // replacing a running binary (upgrade while Chrome runs the old one):
        // unlinking works on unix; Windows can't delete a running .exe but
        // can rename it out of the way
        if dest.exists() && std::fs::remove_file(&dest).is_err() {
            let old = dest.with_extension("old.exe");
            let _ = std::fs::remove_file(&old);
            std::fs::rename(&dest, &old)?;
        }
        std::fs::copy(&me, &dest)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755))?;
        }
    }
    Ok(dest)
}

fn reg(args: &[&str]) -> bool {
    Command::new("reg")
        .args(args)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub fn install(o: &InstallOpts) -> Result<(), String> {
    if o.extension_ids.is_empty() {
        return Err(
            "--extension-id is required (shown in the extension manager's Helper panel)".into(),
        );
    }
    for id in &o.extension_ids {
        if id.len() != 32 || !id.chars().all(|c| ('a'..='p').contains(&c)) {
            return Err(format!(
                "{id:?} is not a Chrome extension id (32 letters a-p)"
            ));
        }
    }
    let exe = stable_exe().map_err(|e| format!("copying the helper: {e}"))?;
    let manifest = manifest_json(&exe, &o.extension_ids);
    let file = format!("{HOST_NAME}.json");
    let mut done = Vec::new();

    for dir in &o.user_data_dirs {
        let d = dir.join("NativeMessagingHosts");
        std::fs::create_dir_all(&d).map_err(|e| format!("{}: {e}", d.display()))?;
        std::fs::write(d.join(&file), &manifest).map_err(|e| e.to_string())?;
        done.push(ui::path(&d));
    }
    if o.user_data_dirs.is_empty() {
        if cfg!(windows) {
            let mpath = config_dir().join(&file);
            std::fs::write(&mpath, &manifest).map_err(|e| e.to_string())?;
            for (label, key) in browser_targets() {
                if !o.browsers.is_empty() && !o.browsers.iter().any(|b| b == label) {
                    continue;
                }
                let k = format!(r"HKCU\{}\NativeMessagingHosts\{HOST_NAME}", key.display());
                if reg(&[
                    "add",
                    &k,
                    "/ve",
                    "/t",
                    "REG_SZ",
                    "/d",
                    &mpath.to_string_lossy(),
                    "/f",
                ]) {
                    done.push(format!(
                        "{} {}",
                        ui::bold(label),
                        ui::dim(&format!("({k})"))
                    ));
                }
            }
        } else {
            for (label, root) in browser_targets() {
                let wanted = if o.browsers.is_empty() {
                    root.exists()
                } else {
                    o.browsers.iter().any(|b| b == label)
                };
                if !wanted {
                    continue;
                }
                let d = root.join("NativeMessagingHosts");
                if std::fs::create_dir_all(&d)
                    .and_then(|_| std::fs::write(d.join(&file), &manifest))
                    .is_ok()
                {
                    done.push(format!(
                        "{} {}",
                        ui::bold(label),
                        ui::dim(&format!("({})", ui::path(&d)))
                    ));
                }
            }
        }
    }
    if done.is_empty() {
        return Err("no Chromium-family browser profile found; pass --browser chrome (or --user-data-dir DIR)".into());
    }
    ui::ok(&format!("installed helper {}", ui::path(&exe)));
    for d in &done {
        ui::ok(&format!("registered native messaging host for {d}"));
    }
    if o.trust {
        trust_ca_cli(o.nssdb.as_deref())?;
    } else {
        let exe_s = exe.display().to_string();
        let exe_s = if exe_s.contains(' ') {
            format!("\"{exe_s}\"")
        } else {
            exe_s
        };
        ui::next(&format!(
            "CA not trusted yet — HTTPS interception needs {}",
            ui::cyan(&format!("{exe_s} trust-ca"))
        ));
    }
    ui::next(&format!(
        "reload the extension (or click {} in Settings → Local helper) to start the helper",
        ui::bold("Retry")
    ));
    Ok(())
}

pub fn uninstall(o: &InstallOpts) -> Result<(), String> {
    let file = format!("{HOST_NAME}.json");
    for dir in &o.user_data_dirs {
        let _ = std::fs::remove_file(dir.join("NativeMessagingHosts").join(&file));
    }
    if cfg!(windows) {
        for (_, key) in browser_targets() {
            reg(&[
                "delete",
                &format!(r"HKCU\{}\NativeMessagingHosts\{HOST_NAME}", key.display()),
                "/f",
            ]);
        }
        let _ = std::fs::remove_file(config_dir().join(&file));
    } else {
        for (_, root) in browser_targets() {
            let _ = std::fs::remove_file(root.join("NativeMessagingHosts").join(&file));
        }
    }
    ui::ok("removed the native messaging host");
    untrust_ca_cli(o.nssdb.as_deref())?;
    Ok(())
}

fn ca_pem_path() -> Result<PathBuf, String> {
    let ca =
        crate::ca::Ca::load_or_create(&config_dir()).map_err(|e| format!("loading CA: {e}"))?;
    Ok(ca.path.clone())
}

fn run(cmd: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new(cmd).args(args).output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            match cmd {
                "certutil" if !cfg!(windows) => "`certutil` not found — install it (Debian/Ubuntu: libnss3-tools, Fedora: nss-tools, Arch: nss)".to_string(),
                _ => format!("`{cmd}` not found"),
            }
        } else {
            format!("{cmd}: {e}")
        }
    })?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    if out.status.success() {
        Ok(text)
    } else {
        Err(format!("{cmd} {}: {}", args.join(" "), text.trim()))
    }
}

fn nssdb_dir(custom: Option<&Path>) -> PathBuf {
    custom
        .map(Path::to_path_buf)
        .unwrap_or_else(|| home().join(".pki").join("nssdb"))
}

pub fn trust_ca_cli(nssdb: Option<&Path>) -> Result<(), String> {
    trust_ca(nssdb)?;
    ui::ok(&format!(
        "trusted {} for this user {}",
        ui::bold(CA_NAME),
        ui::dim(&format!("({})", ui::path(&ca_pem_path()?)))
    ));
    ui::next("restart the browser if it was running");
    Ok(())
}

pub fn untrust_ca_cli(nssdb: Option<&Path>) -> Result<(), String> {
    untrust_ca(nssdb)?;
    ui::ok(&format!("removed trust for {}", ui::bold(CA_NAME)));
    Ok(())
}

/// Trust the CA for the current user. Returns a human-readable summary.
pub fn trust_ca(nssdb: Option<&Path>) -> Result<String, String> {
    let pem = ca_pem_path()?;
    let pem_s = pem.to_string_lossy().to_string();
    if cfg!(target_os = "macos") {
        let kc = home().join("Library/Keychains/login.keychain-db");
        run(
            "security",
            &[
                "add-trusted-cert",
                "-r",
                "trustRoot",
                "-p",
                "ssl",
                "-k",
                &kc.to_string_lossy(),
                &pem_s,
            ],
        )?;
    } else if cfg!(windows) {
        run("certutil", &["-user", "-f", "-addstore", "Root", &pem_s])?;
    } else {
        let db = nssdb_dir(nssdb);
        if !db.join("cert9.db").exists() {
            std::fs::create_dir_all(&db).map_err(|e| e.to_string())?;
            run(
                "certutil",
                &[
                    "-d",
                    &format!("sql:{}", db.display()),
                    "-N",
                    "--empty-password",
                ],
            )?;
        }
        let dbs = format!("sql:{}", db.display());
        let _ = run("certutil", &["-d", &dbs, "-D", "-n", CA_NAME]);
        run(
            "certutil",
            &["-d", &dbs, "-A", "-t", "C,,", "-n", CA_NAME, "-i", &pem_s],
        )?;
    }
    Ok(format!(
        "trusted \"{CA_NAME}\" ({pem_s}) for this user — restart the browser if it was running"
    ))
}

pub fn untrust_ca(nssdb: Option<&Path>) -> Result<String, String> {
    let pem = config_dir().join("ca.pem");
    if cfg!(target_os = "macos") {
        let _ = run("security", &["remove-trusted-cert", &pem.to_string_lossy()]);
        let kc = home().join("Library/Keychains/login.keychain-db");
        let _ = run(
            "security",
            &["delete-certificate", "-c", CA_NAME, &kc.to_string_lossy()],
        );
    } else if cfg!(windows) {
        let _ = run("certutil", &["-user", "-delstore", "Root", CA_NAME]);
    } else {
        let db = nssdb_dir(nssdb);
        if db.join("cert9.db").exists() {
            let _ = run(
                "certutil",
                &["-d", &format!("sql:{}", db.display()), "-D", "-n", CA_NAME],
            );
        }
    }
    Ok(format!("removed trust for \"{CA_NAME}\""))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_shape() {
        let m: serde_json::Value = serde_json::from_str(&manifest_json(
            Path::new("/x/wiretrick-helper"),
            &["abcdefghijklmnopabcdefghijklmnop".into()],
        ))
        .unwrap();
        assert_eq!(m["name"], HOST_NAME);
        assert_eq!(m["type"], "stdio");
        assert_eq!(
            m["allowed_origins"][0],
            "chrome-extension://abcdefghijklmnopabcdefghijklmnop/"
        );
    }

    #[test]
    fn rejects_bad_ids() {
        let o = InstallOpts {
            extension_ids: vec!["nope".into()],
            browsers: vec![],
            user_data_dirs: vec![],
            trust: false,
            nssdb: None,
        };
        assert!(install(&o).is_err());
    }
}
