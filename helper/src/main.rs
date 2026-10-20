//! rescript-helper — local interception helper for ResScript Override's
//! `process` strategy. Started by the browser over native messaging; also a
//! small CLI for installing itself (`rescript-helper install …`).

mod ca;
mod install;
mod matcher;
mod nm;
mod paths;
mod proxy;
mod upstream;

use std::path::PathBuf;
use std::sync::Arc;

use tokio::net::TcpListener;

use crate::nm::{In, Nm, Out};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

const USAGE: &str = "rescript-helper — local interception helper for ResScript Override

USAGE:
  rescript-helper install --extension-id ID [--extension-id ID]... [--browser NAME]...
                          [--user-data-dir DIR]... [--trust-ca] [--nssdb DIR]
  rescript-helper uninstall [--user-data-dir DIR]... [--nssdb DIR]
  rescript-helper trust-ca [--nssdb DIR]
  rescript-helper untrust-ca [--nssdb DIR]
  rescript-helper ca-path
  rescript-helper version

Browsers: chrome, chrome-beta, chrome-dev, chrome-canary, chromium, brave, edge, vivaldi
(default: every installed one). Started without a command (or with a
chrome-extension:// origin, as the browser does) it speaks native messaging.
State lives in $RESCRIPT_HELPER_HOME or the per-user config dir.";

pub fn client_tls_config() -> rustls::ClientConfig {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let verifier =
        rustls_platform_verifier::Verifier::new(provider.clone()).expect("platform verifier");
    rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .expect("tls versions")
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth()
}

fn main() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cmd = args.first().map(String::as_str).unwrap_or("");
    if cmd.is_empty()
        || cmd.starts_with("chrome-extension://")
        || cmd.starts_with("--parent-window")
    {
        native();
        return;
    }
    let r = match cmd {
        "install" | "uninstall" | "trust-ca" | "untrust-ca" => match parse_opts(&args[1..]) {
            Ok(o) => match cmd {
                "install" => install::install(&o),
                "uninstall" => install::uninstall(&o),
                "trust-ca" => install::trust_ca(o.nssdb.as_deref()).map(|m| println!("{m}")),
                _ => install::untrust_ca(o.nssdb.as_deref()).map(|m| println!("{m}")),
            },
            Err(e) => Err(e),
        },
        "ca-path" => ca::Ca::load_or_create(&paths::config_dir())
            .map(|c| println!("{}\nSHA-256 {}", c.path.display(), c.fingerprint()))
            .map_err(|e| e.to_string()),
        "version" | "--version" | "-V" => {
            println!("rescript-helper {VERSION}");
            Ok(())
        }
        "help" | "--help" | "-h" => {
            println!("{USAGE}");
            Ok(())
        }
        other => Err(format!("unknown command {other:?}\n\n{USAGE}")),
    };
    if let Err(e) = r {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

fn parse_opts(a: &[String]) -> Result<install::InstallOpts, String> {
    let mut o = install::InstallOpts {
        extension_ids: vec![],
        browsers: vec![],
        user_data_dirs: vec![],
        trust: false,
        nssdb: None,
    };
    let mut i = 0;
    while i < a.len() {
        let (flag, inline) = match a[i].split_once('=') {
            Some((f, v)) => (f.to_string(), Some(v.to_string())),
            None => (a[i].clone(), None),
        };
        let mut value = || -> Result<String, String> {
            if let Some(v) = inline.clone() {
                return Ok(v);
            }
            i += 1;
            a.get(i)
                .cloned()
                .ok_or_else(|| format!("{flag} needs a value"))
        };
        match flag.as_str() {
            "--extension-id" => o.extension_ids.push(value()?),
            "--browser" | "--browsers" => o
                .browsers
                .extend(value()?.split(',').map(|s| s.trim().to_string())),
            "--user-data-dir" => o.user_data_dirs.push(PathBuf::from(value()?)),
            "--nssdb" => o.nssdb = Some(PathBuf::from(value()?)),
            "--trust-ca" => o.trust = true,
            f => return Err(format!("unknown option {f}")),
        }
        i += 1;
    }
    Ok(o)
}

fn native() {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("runtime");
    rt.block_on(async {
        let nm = Nm::new(tokio::io::stdout());
        let ca = match ca::Ca::load_or_create(&paths::config_dir()) {
            Ok(c) => Arc::new(c),
            Err(e) => {
                nm.log(
                    "error",
                    format!(
                        "cannot create the CA in {}: {e}",
                        paths::config_dir().display()
                    ),
                );
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                std::process::exit(2);
            }
        };
        let up = Arc::new(upstream::Upstream::new(nm.clone(), client_tls_config()));
        let st = proxy::State::new(nm.clone(), ca.clone(), up.clone());
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind loopback");
        let port = listener.local_addr().unwrap().port();
        nm.send(&Out::Ready {
            port,
            version: VERSION,
            ca_pem: ca.pem.clone(),
            ca_fingerprint: ca.fingerprint(),
            ca_path: ca.path.display().to_string(),
        });
        tokio::spawn(proxy::serve(listener, st.clone()));
        {
            let nm = nm.clone();
            tokio::spawn(async move {
                let sp = tokio::task::spawn_blocking(upstream::read_system_proxy)
                    .await
                    .unwrap_or_default();
                nm.send(&Out::System {
                    http: sp.http.as_ref().map(|h| h.to_pac()),
                    https: sp.https.as_ref().map(|h| h.to_pac()),
                    socks: sp.socks.as_ref().map(|h| h.to_pac()),
                    bypass: sp.bypass,
                    pac_url: sp.pac_url,
                });
            });
        }

        let mut stdin = tokio::io::stdin();
        loop {
            let frame = match nm::read_frame(&mut stdin).await {
                Ok(Some(f)) => f,
                // browser closed the port (extension reloaded / disabled)
                _ => std::process::exit(0),
            };
            let msg: In = match serde_json::from_slice(&frame) {
                Ok(m) => m,
                Err(e) => {
                    nm.log("warn", format!("bad message: {e}"));
                    continue;
                }
            };
            match nm.dispatch(msg) {
                Some(In::Config { routes, upstream }) => {
                    st.set_routes(routes);
                    up.set_mode(upstream);
                }
                Some(In::TrustCa {}) => {
                    let nm = nm.clone();
                    tokio::task::spawn_blocking(move || {
                        let r = install::trust_ca(None);
                        let (ok, msg) = match r {
                            Ok(m) => (true, m),
                            Err(m) => (false, m),
                        };
                        nm.send(&Out::TrustResult { ok, msg });
                    });
                }
                Some(In::Ping {}) => nm.send(&Out::Pong {}),
                _ => {}
            }
        }
    });
}
