//! Upstream connections, honoring the browser's/OS proxy configuration so
//! routing traffic through the helper never bypasses the user's proxy.
//!
//! A per-host hop list (PAC result syntax: `PROXY h:p; SOCKS5 h:p; DIRECT`)
//! is tried in order, like Chrome does. Hops: DIRECT, HTTP CONNECT,
//! HTTPS (TLS to the proxy, then CONNECT), SOCKS5, SOCKS4a.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use hyper::Uri;
use hyper_util::client::legacy::connect::{Connected, Connection};
use hyper_util::rt::TokioIo;
use rustls::pki_types::ServerName;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;

use crate::nm::{In, Nm, Out, UpstreamMode};

pub trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}
pub type BoxIo = Box<dyn Io>;

#[derive(Clone, Debug, PartialEq)]
pub enum Hop {
    Direct,
    Http(String),
    Https(String),
    Socks5(String),
    Socks4(String),
}

impl Hop {
    /// the PAC result entry for this hop
    pub fn to_pac(&self) -> String {
        match self {
            Hop::Direct => "DIRECT".into(),
            Hop::Http(a) => format!("PROXY {a}"),
            Hop::Https(a) => format!("HTTPS {a}"),
            Hop::Socks5(a) => format!("SOCKS5 {a}"),
            Hop::Socks4(a) => format!("SOCKS4 {a}"),
        }
    }
}

/// Parse a PAC `FindProxyForURL` result.
pub fn parse_pac_result(s: &str) -> Vec<Hop> {
    let mut out = Vec::new();
    for part in s.split(';') {
        let mut it = part.split_whitespace();
        let kind = it.next().unwrap_or("").to_ascii_uppercase();
        let addr = it.next().unwrap_or("").to_string();
        let hop = match kind.as_str() {
            "DIRECT" => Hop::Direct,
            "PROXY" | "HTTP" if !addr.is_empty() => Hop::Http(addr),
            "HTTPS" if !addr.is_empty() => Hop::Https(addr),
            "SOCKS" | "SOCKS5" if !addr.is_empty() => Hop::Socks5(addr),
            "SOCKS4" if !addr.is_empty() => Hop::Socks4(addr),
            _ => continue,
        };
        out.push(hop);
    }
    if out.is_empty() {
        out.push(Hop::Direct);
    }
    out
}

pub enum Tunnel {
    Ok(BoxIo),
    /// the upstream proxy demands credentials: relay this response head to the browser
    Auth(Vec<u8>),
}

fn split_addr(addr: &str, default_port: u16) -> (String, u16) {
    if let Some(rest) = addr.strip_prefix('[') {
        if let Some((h, p)) = rest.split_once("]:") {
            return (h.to_string(), p.parse().unwrap_or(default_port));
        }
        return (rest.trim_end_matches(']').to_string(), default_port);
    }
    match addr.rsplit_once(':') {
        Some((h, p)) if !h.contains(':') => (h.to_string(), p.parse().unwrap_or(default_port)),
        _ => (addr.to_string(), default_port),
    }
}

async fn tcp(host: &str, port: u16) -> std::io::Result<TcpStream> {
    let s = tokio::time::timeout(Duration::from_secs(20), TcpStream::connect((host, port)))
        .await
        .map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                format!("connect {host}:{port} timed out"),
            )
        })??;
    let _ = s.set_nodelay(true);
    Ok(s)
}

/// Read an HTTP response head byte-wise (never over-reads into the tunnel).
async fn read_head<R: AsyncRead + Unpin>(r: &mut R) -> std::io::Result<Vec<u8>> {
    let mut head = Vec::with_capacity(256);
    let mut b = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if r.read(&mut b).await? == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "proxy closed",
            ));
        }
        head.push(b[0]);
        if head.len() > 64 * 1024 {
            return Err(std::io::Error::other("proxy response head too large"));
        }
    }
    Ok(head)
}

fn head_status(head: &[u8]) -> u16 {
    std::str::from_utf8(head)
        .ok()
        .and_then(|s| s.split_whitespace().nth(1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
}

async fn http_connect(
    mut io: BoxIo,
    host: &str,
    port: u16,
    auth: Option<&str>,
) -> std::io::Result<Tunnel> {
    let target = if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    let mut req = format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n");
    if let Some(a) = auth {
        req.push_str(&format!("Proxy-Authorization: {a}\r\n"));
    }
    req.push_str("\r\n");
    io.write_all(req.as_bytes()).await?;
    let head = read_head(&mut io).await?;
    match head_status(&head) {
        200..=299 => Ok(Tunnel::Ok(io)),
        407 => Ok(Tunnel::Auth(head)),
        s => Err(std::io::Error::other(format!(
            "upstream proxy CONNECT {target} → {s}"
        ))),
    }
}

async fn socks5(mut io: BoxIo, host: &str, port: u16) -> std::io::Result<BoxIo> {
    io.write_all(&[5, 1, 0]).await?;
    let mut r = [0u8; 2];
    io.read_exact(&mut r).await?;
    if r != [5, 0] {
        return Err(std::io::Error::other(
            "SOCKS5: no acceptable auth method (only no-auth is supported, like Chrome)",
        ));
    }
    let h = host.as_bytes();
    if h.len() > 255 {
        return Err(std::io::Error::other("SOCKS5: host too long"));
    }
    let mut req = vec![5, 1, 0, 3, h.len() as u8];
    req.extend_from_slice(h);
    req.extend_from_slice(&port.to_be_bytes());
    io.write_all(&req).await?;
    let mut rep = [0u8; 4];
    io.read_exact(&mut rep).await?;
    if rep[1] != 0 {
        return Err(std::io::Error::other(format!(
            "SOCKS5 connect {host}:{port} failed (code {})",
            rep[1]
        )));
    }
    let skip = match rep[3] {
        1 => 4,
        4 => 16,
        3 => {
            let mut l = [0u8; 1];
            io.read_exact(&mut l).await?;
            l[0] as usize
        }
        _ => return Err(std::io::Error::other("SOCKS5: bad address type")),
    };
    let mut rest = vec![0u8; skip + 2];
    io.read_exact(&mut rest).await?;
    Ok(io)
}

async fn socks4a(mut io: BoxIo, host: &str, port: u16) -> std::io::Result<BoxIo> {
    let mut req = vec![4, 1];
    req.extend_from_slice(&port.to_be_bytes());
    req.extend_from_slice(&[0, 0, 0, 1, 0]);
    req.extend_from_slice(host.as_bytes());
    req.push(0);
    io.write_all(&req).await?;
    let mut rep = [0u8; 8];
    io.read_exact(&mut rep).await?;
    if rep[1] != 0x5a {
        return Err(std::io::Error::other(format!(
            "SOCKS4 connect {host}:{port} rejected"
        )));
    }
    Ok(io)
}

/// OS proxy settings (mode "system"), refreshed at most once a minute.
#[derive(Clone, Debug, Default)]
pub struct SystemProxy {
    pub http: Option<Hop>,
    pub https: Option<Hop>,
    pub socks: Option<Hop>,
    pub bypass: Vec<String>,
    pub pac_url: Option<String>,
}

impl SystemProxy {
    pub fn hops(&self, host: &str, https: bool) -> Option<Vec<Hop>> {
        if self.bypassed(host) {
            return Some(vec![Hop::Direct]);
        }
        let primary = if https {
            self.https.clone()
        } else {
            self.http.clone()
        };
        let hop = primary.or_else(|| self.socks.clone())?;
        Some(vec![hop])
    }

    fn bypassed(&self, host: &str) -> bool {
        let host = host.to_ascii_lowercase();
        self.bypass.iter().any(|raw| {
            let b = raw.trim().to_ascii_lowercase();
            if b.is_empty() {
                return false;
            }
            if b == "*" {
                return true;
            }
            if b == "<local>" {
                return !host.contains('.');
            }
            if b.contains('*') {
                return crate::matcher::matches(&b, &host);
            }
            let b = b.trim_start_matches('.');
            host == b || host.ends_with(&format!(".{b}"))
        })
    }
}

fn env_hop(names: &[&str]) -> Option<Hop> {
    for n in names {
        for v in [std::env::var(n), std::env::var(n.to_ascii_lowercase())]
            .into_iter()
            .flatten()
        {
            let v = v.trim();
            if v.is_empty() {
                continue;
            }
            let (scheme, rest) = v.split_once("://").unwrap_or(("http", v));
            let rest = rest
                .rsplit('@')
                .next()
                .unwrap_or(rest)
                .trim_end_matches('/');
            return Some(match scheme {
                "https" => Hop::Https(rest.to_string()),
                "socks5" | "socks5h" | "socks" => Hop::Socks5(rest.to_string()),
                "socks4" | "socks4a" => Hop::Socks4(rest.to_string()),
                _ => Hop::Http(rest.to_string()),
            });
        }
    }
    None
}

fn run(cmd: &str, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new(cmd).args(args).output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

pub fn read_system_proxy() -> SystemProxy {
    let mut sp = SystemProxy {
        http: env_hop(&["HTTP_PROXY", "ALL_PROXY"]),
        https: env_hop(&["HTTPS_PROXY", "ALL_PROXY"]),
        socks: None,
        bypass: std::env::var("NO_PROXY")
            .or_else(|_| std::env::var("no_proxy"))
            .unwrap_or_default()
            .split(',')
            .map(|s| s.trim().to_string())
            .collect(),
        pac_url: None,
    };
    if sp.http.is_some() || sp.https.is_some() {
        return sp;
    }
    if cfg!(target_os = "macos") {
        if let Some(out) = run("scutil", &["--proxy"]) {
            let kv: HashMap<String, String> = out
                .lines()
                .filter_map(|l| {
                    l.split_once(" : ")
                        .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
                })
                .collect();
            let on = |k: &str| kv.get(k).map(|v| v == "1").unwrap_or(false);
            let addr = |h: &str, p: &str| {
                kv.get(h)
                    .map(|h| format!("{h}:{}", kv.get(p).cloned().unwrap_or_default()))
            };
            if on("HTTPEnable") {
                sp.http = addr("HTTPProxy", "HTTPPort").map(Hop::Http);
            }
            if on("HTTPSEnable") {
                sp.https = addr("HTTPSProxy", "HTTPSPort").map(Hop::Http);
            }
            if on("SOCKSEnable") {
                sp.socks = addr("SOCKSProxy", "SOCKSPort").map(Hop::Socks5);
            }
            if on("ProxyAutoConfigEnable") {
                sp.pac_url = kv.get("ProxyAutoConfigURLString").cloned();
            }
            let mut in_list = false;
            for l in out.lines() {
                let t = l.trim();
                if t.starts_with("ExceptionsList") {
                    in_list = true;
                } else if in_list && t == "}" {
                    in_list = false;
                } else if in_list && let Some((_, v)) = t.split_once(" : ") {
                    sp.bypass.push(v.to_string());
                }
            }
        }
    } else if cfg!(windows) {
        if let Some(out) = run(
            "reg",
            &[
                "query",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            ],
        ) {
            let val = |name: &str| {
                out.lines().find_map(|l| {
                    let mut it = l.split_whitespace();
                    (it.next() == Some(name)).then(|| it.skip(1).collect::<Vec<_>>().join(" "))
                })
            };
            if val("ProxyEnable").is_some_and(|v| v.trim() == "0x1") {
                let server = val("ProxyServer").unwrap_or_default();
                if server.contains('=') {
                    for part in server.split(';') {
                        if let Some((k, v)) = part.split_once('=') {
                            match k.trim().to_ascii_lowercase().as_str() {
                                "http" => sp.http = Some(Hop::Http(v.trim().to_string())),
                                "https" => sp.https = Some(Hop::Http(v.trim().to_string())),
                                "socks" => sp.socks = Some(Hop::Socks4(v.trim().to_string())),
                                _ => {}
                            }
                        }
                    }
                } else if !server.trim().is_empty() {
                    sp.http = Some(Hop::Http(server.trim().to_string()));
                    sp.https = sp.http.clone();
                }
                sp.bypass.extend(
                    val("ProxyOverride")
                        .unwrap_or_default()
                        .split(';')
                        .map(|s| s.to_string()),
                );
            }
            sp.pac_url = val("AutoConfigURL");
        }
    } else {
        let g = |k: &str, key: &str| {
            run("gsettings", &["get", k, key]).map(|s| s.trim().trim_matches('\'').to_string())
        };
        match g("org.gnome.system.proxy", "mode").as_deref() {
            Some("manual") => {
                let addr = |schema: &str| {
                    let host = g(schema, "host").unwrap_or_default();
                    let port = g(schema, "port").unwrap_or_default();
                    (!host.is_empty() && port != "0").then(|| format!("{host}:{port}"))
                };
                sp.http = addr("org.gnome.system.proxy.http").map(Hop::Http);
                sp.https = addr("org.gnome.system.proxy.https").map(Hop::Http);
                sp.socks = addr("org.gnome.system.proxy.socks").map(Hop::Socks5);
                if let Some(list) = g("org.gnome.system.proxy", "ignore-hosts") {
                    sp.bypass.extend(
                        list.trim_matches(|c| c == '[' || c == ']')
                            .split(',')
                            .map(|s| s.trim().trim_matches('\'').to_string()),
                    );
                }
            }
            Some("auto") => {
                sp.pac_url = g("org.gnome.system.proxy", "autoconfig-url").filter(|u| !u.is_empty())
            }
            _ => {}
        }
    }
    sp
}

struct Preconnected {
    at: Instant,
    io: BoxIo,
}

pub struct Upstream {
    nm: Nm,
    mode: Mutex<UpstreamMode>,
    hops: Mutex<HashMap<String, Vec<Hop>>>,
    system: Mutex<Option<(Instant, SystemProxy)>>,
    /// last Proxy-Authorization the browser sent us, per upstream proxy address
    auth: Mutex<HashMap<String, String>>,
    /// tunnels opened while answering a browser CONNECT (auth check), reused once
    pre: Mutex<HashMap<String, Vec<Preconnected>>>,
    pub tls: TlsConnector,
    pub tls_h1: TlsConnector,
    proxy_tls: TlsConnector,
}

impl Upstream {
    pub fn new(nm: Nm, client_cfg: rustls::ClientConfig) -> Upstream {
        let mk = |alpn: Vec<Vec<u8>>| {
            let mut c = client_cfg.clone();
            c.alpn_protocols = alpn;
            TlsConnector::from(Arc::new(c))
        };
        Upstream {
            nm,
            mode: Mutex::new(UpstreamMode::Direct),
            hops: Mutex::new(HashMap::new()),
            system: Mutex::new(None),
            auth: Mutex::new(HashMap::new()),
            pre: Mutex::new(HashMap::new()),
            tls: mk(vec![b"h2".to_vec(), b"http/1.1".to_vec()]),
            tls_h1: mk(vec![b"http/1.1".to_vec()]),
            proxy_tls: mk(vec![]),
        }
    }

    pub fn set_mode(&self, mode: UpstreamMode) {
        *self.mode.lock().unwrap() = mode;
        self.hops.lock().unwrap().clear();
    }

    /// Hops for `host` (cached per host and scheme).
    pub fn hops_for<'a>(
        &'a self,
        host: &'a str,
        https: bool,
    ) -> Pin<Box<dyn Future<Output = Vec<Hop>> + Send + 'a>> {
        Box::pin(async move {
            let key = format!("{}://{host}", if https { "https" } else { "http" });
            if let Some(h) = self.hops.lock().unwrap().get(&key) {
                return h.clone();
            }
            let mode = self.mode.lock().unwrap().clone();
            let url = format!("{key}/");
            let hops = match mode {
                UpstreamMode::Direct => vec![Hop::Direct],
                UpstreamMode::Ask => self.ask(url.clone(), host.to_string(), None).await,
                UpstreamMode::System => {
                    let cached = self
                        .system
                        .lock()
                        .unwrap()
                        .as_ref()
                        .filter(|(at, _)| at.elapsed() < Duration::from_secs(60))
                        .map(|(_, s)| s.clone());
                    let sp = match cached {
                        Some(s) => s,
                        None => {
                            let fresh = tokio::task::spawn_blocking(read_system_proxy)
                                .await
                                .unwrap_or_default();
                            *self.system.lock().unwrap() = Some((Instant::now(), fresh.clone()));
                            fresh
                        }
                    };
                    match (sp.hops(host, https), sp.pac_url.clone()) {
                        (Some(h), _) => h,
                        (None, Some(pac)) => {
                            self.ask(url.clone(), host.to_string(), Some(pac)).await
                        }
                        (None, None) => vec![Hop::Direct],
                    }
                }
            };
            self.hops.lock().unwrap().insert(key, hops.clone());
            hops
        })
    }

    async fn ask(&self, url: String, host: String, pac_url: Option<String>) -> Vec<Hop> {
        let id = self.nm.next_id();
        let msg = Out::NeedUpstream {
            id,
            url,
            host: host.clone(),
            pac_url,
        };
        match self.nm.ask(id, msg, Duration::from_secs(10)).await {
            Some(In::Upstream { proxy, .. }) => parse_pac_result(&proxy),
            _ => {
                self.nm.log(
                    "warn",
                    format!("no upstream proxy decision for {host} — connecting DIRECT"),
                );
                vec![Hop::Direct]
            }
        }
    }

    pub fn stash(&self, host: &str, port: u16, io: BoxIo) {
        let mut g = self.pre.lock().unwrap();
        g.retain(|_, v| {
            v.retain(|p| p.at.elapsed() < Duration::from_secs(10));
            !v.is_empty()
        });
        g.entry(format!("{host}:{port}"))
            .or_default()
            .push(Preconnected {
                at: Instant::now(),
                io,
            });
    }

    fn take_stashed(&self, host: &str, port: u16) -> Option<BoxIo> {
        let mut g = self.pre.lock().unwrap();
        let v = g.get_mut(&format!("{host}:{port}"))?;
        while let Some(p) = v.pop() {
            if p.at.elapsed() < Duration::from_secs(10) {
                return Some(p.io);
            }
        }
        None
    }

    async fn via(
        &self,
        hop: &Hop,
        host: &str,
        port: u16,
        browser_auth: Option<String>,
    ) -> std::io::Result<Tunnel> {
        match hop {
            Hop::Direct => Ok(Tunnel::Ok(Box::new(tcp(host, port).await?))),
            Hop::Http(addr) | Hop::Https(addr) => {
                let (ph, pp) = split_addr(
                    addr,
                    if matches!(hop, Hop::Https(_)) {
                        443
                    } else {
                        80
                    },
                );
                let sock = tcp(&ph, pp).await?;
                let io: BoxIo = if matches!(hop, Hop::Https(_)) {
                    let name = ServerName::try_from(ph.clone()).map_err(std::io::Error::other)?;
                    Box::new(self.proxy_tls.connect(name, sock).await?)
                } else {
                    Box::new(sock)
                };
                let stored = self.auth.lock().unwrap().get(addr).cloned();
                let auth = browser_auth.clone().or(stored);
                let t = http_connect(io, host, port, auth.as_deref()).await?;
                if let (Tunnel::Ok(_), Some(a)) = (&t, browser_auth) {
                    self.auth.lock().unwrap().insert(addr.clone(), a);
                }
                Ok(t)
            }
            Hop::Socks5(addr) => {
                let (ph, pp) = split_addr(addr, 1080);
                Ok(Tunnel::Ok(
                    socks5(Box::new(tcp(&ph, pp).await?), host, port).await?,
                ))
            }
            Hop::Socks4(addr) => {
                let (ph, pp) = split_addr(addr, 1080);
                Ok(Tunnel::Ok(
                    socks4a(Box::new(tcp(&ph, pp).await?), host, port).await?,
                ))
            }
        }
    }

    /// A byte tunnel to host:port through the configured hops.
    // boxed with an explicit `Send` bound: works around rustc's
    // "implementation of Send is not general enough" for borrowed args
    pub fn tunnel<'a>(
        &'a self,
        host: &'a str,
        port: u16,
        https: bool,
        browser_auth: Option<String>,
    ) -> Pin<Box<dyn Future<Output = std::io::Result<Tunnel>> + Send + 'a>> {
        Box::pin(async move {
            let hops = self.hops_for(host, https).await;
            let mut last = std::io::Error::other("no upstream route");
            for hop in &hops {
                match self.via(hop, host, port, browser_auth.clone()).await {
                    Ok(t) => return Ok(t),
                    Err(e) => last = e,
                }
            }
            Err(last)
        })
    }

    /// Connection for a plain-http request. `true` = connected to an HTTP
    /// proxy, so requests must use absolute-form.
    async fn connect_http(&self, host: &str, port: u16) -> std::io::Result<(BoxIo, bool)> {
        let hops = self.hops_for(host, false).await;
        let mut last = std::io::Error::other("no upstream route");
        for hop in &hops {
            let r = match hop {
                Hop::Http(addr) => {
                    let (ph, pp) = split_addr(addr, 80);
                    tcp(&ph, pp).await.map(|s| (Box::new(s) as BoxIo, true))
                }
                Hop::Https(addr) => {
                    let (ph, pp) = split_addr(addr, 443);
                    match (tcp(&ph, pp).await, ServerName::try_from(ph.clone())) {
                        (Ok(s), Ok(name)) => self
                            .proxy_tls
                            .connect(name, s)
                            .await
                            .map(|t| (Box::new(t) as BoxIo, true)),
                        (Err(e), _) => Err(e),
                        (_, Err(e)) => Err(std::io::Error::other(e)),
                    }
                }
                other => match self.via(other, host, port, None).await {
                    Ok(Tunnel::Ok(io)) => Ok((io, false)),
                    Ok(Tunnel::Auth(_)) => Err(std::io::Error::other("proxy auth required")),
                    Err(e) => Err(e),
                },
            };
            match r {
                Ok(x) => return Ok(x),
                Err(e) => last = e,
            }
        }
        Err(last)
    }

    /// True when plain-http requests to `host` go through an HTTP proxy
    /// (the browser's Proxy-Authorization must then be forwarded).
    pub async fn http_via_proxy(&self, host: &str) -> bool {
        matches!(
            self.hops_for(host, false).await.first(),
            Some(Hop::Http(_) | Hop::Https(_))
        )
    }

    pub async fn connect_tls(
        &self,
        host: &str,
        port: u16,
        h1_only: bool,
    ) -> std::io::Result<(BoxIo, bool)> {
        let io = match self.take_stashed(host, port) {
            Some(io) => io,
            None => match self.tunnel(host, port, true, None).await? {
                Tunnel::Ok(io) => io,
                Tunnel::Auth(_) => {
                    return Err(std::io::Error::other(
                        "upstream proxy requires authentication",
                    ));
                }
            },
        };
        let name = ServerName::try_from(host.to_string()).map_err(std::io::Error::other)?;
        let c = if h1_only { &self.tls_h1 } else { &self.tls };
        let t = c.connect(name, io).await?;
        let h2 = t.get_ref().1.alpn_protocol() == Some(b"h2");
        Ok((Box::new(t), h2))
    }
}

/// hyper connector over [`Upstream`].
#[derive(Clone)]
pub struct Connector(pub Arc<Upstream>);

pub struct Stream {
    io: TokioIo<BoxIo>,
    h2: bool,
    proxied: bool,
}

impl Connection for Stream {
    fn connected(&self) -> Connected {
        let c = Connected::new().proxy(self.proxied);
        if self.h2 { c.negotiated_h2() } else { c }
    }
}

impl hyper::rt::Read for Stream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: hyper::rt::ReadBufCursor<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.io).poll_read(cx, buf)
    }
}

impl hyper::rt::Write for Stream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        b: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.io).poll_write(cx, b)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.io).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.io).poll_shutdown(cx)
    }
}

impl tower_service::Service<Uri> for Connector {
    type Response = Stream;
    type Error = std::io::Error;
    type Future = Pin<Box<dyn Future<Output = std::io::Result<Stream>> + Send>>;

    fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, uri: Uri) -> Self::Future {
        let up = self.0.clone();
        Box::pin(async move {
            let host = uri
                .host()
                .unwrap_or_default()
                .trim_matches(|c| c == '[' || c == ']')
                .to_string();
            if uri.scheme_str() == Some("https") {
                let port = uri.port_u16().unwrap_or(443);
                let (io, h2) = up.connect_tls(&host, port, false).await?;
                Ok(Stream {
                    io: TokioIo::new(io),
                    h2,
                    proxied: false,
                })
            } else {
                let port = uri.port_u16().unwrap_or(80);
                let (io, proxied) = up.connect_http(&host, port).await?;
                Ok(Stream {
                    io: TokioIo::new(io),
                    h2: false,
                    proxied,
                })
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pac_results() {
        assert_eq!(parse_pac_result("DIRECT"), vec![Hop::Direct]);
        assert_eq!(
            parse_pac_result("PROXY p:3128; SOCKS5 s:1080;HTTPS h:443; SOCKS4 f:1; DIRECT"),
            vec![
                Hop::Http("p:3128".into()),
                Hop::Socks5("s:1080".into()),
                Hop::Https("h:443".into()),
                Hop::Socks4("f:1".into()),
                Hop::Direct
            ]
        );
        assert_eq!(parse_pac_result("garbage"), vec![Hop::Direct]);
    }

    #[test]
    fn addr_split() {
        assert_eq!(split_addr("h:8080", 80), ("h".into(), 8080));
        assert_eq!(split_addr("h", 80), ("h".into(), 80));
        assert_eq!(split_addr("[::1]:3128", 80), ("::1".into(), 3128));
    }

    #[test]
    fn bypass_rules() {
        let sp = SystemProxy {
            https: Some(Hop::Http("p:1".into())),
            bypass: vec![
                "localhost".into(),
                ".corp.test".into(),
                "*.internal".into(),
                "<local>".into(),
            ],
            ..Default::default()
        };
        assert_eq!(sp.hops("a.corp.test", true), Some(vec![Hop::Direct]));
        assert_eq!(sp.hops("x.internal", true), Some(vec![Hop::Direct]));
        assert_eq!(sp.hops("intranet", true), Some(vec![Hop::Direct]));
        assert_eq!(
            sp.hops("example.com", true),
            Some(vec![Hop::Http("p:1".into())])
        );
        assert_eq!(sp.hops("example.com", false), None);
    }

    async fn fake_proxy(reply: &'static [u8]) -> (String, tokio::task::JoinHandle<Vec<u8>>) {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap().to_string();
        let h = tokio::spawn(async move {
            let (mut s, _) = l.accept().await.unwrap();
            let head = read_head(&mut s).await.unwrap();
            s.write_all(reply).await.unwrap();
            s.write_all(b"tunnel-bytes").await.unwrap();
            head
        });
        (addr, h)
    }

    #[tokio::test]
    async fn http_connect_ok_and_auth() {
        let (addr, h) = fake_proxy(b"HTTP/1.1 200 OK\r\n\r\n").await;
        let io: BoxIo = Box::new(
            tcp(
                "127.0.0.1",
                addr.rsplit_once(':').unwrap().1.parse().unwrap(),
            )
            .await
            .unwrap(),
        );
        let t = http_connect(io, "example.com", 443, Some("Basic eHg="))
            .await
            .unwrap();
        let Tunnel::Ok(mut io) = t else {
            panic!("expected tunnel")
        };
        let mut buf = [0u8; 12];
        io.read_exact(&mut buf).await.unwrap();
        assert_eq!(
            &buf, b"tunnel-bytes",
            "head reader must not swallow tunnel data"
        );
        let head = String::from_utf8(h.await.unwrap()).unwrap();
        assert!(head.starts_with("CONNECT example.com:443 HTTP/1.1\r\n"));
        assert!(head.contains("Proxy-Authorization: Basic eHg=\r\n"));

        let (addr, _h) =
            fake_proxy(b"HTTP/1.1 407 Auth\r\nProxy-Authenticate: Basic realm=\"x\"\r\n\r\n").await;
        let io: BoxIo = Box::new(
            tcp(
                "127.0.0.1",
                addr.rsplit_once(':').unwrap().1.parse().unwrap(),
            )
            .await
            .unwrap(),
        );
        match http_connect(io, "example.com", 443, None).await.unwrap() {
            Tunnel::Auth(head) => {
                assert!(String::from_utf8_lossy(&head).contains("Proxy-Authenticate"))
            }
            Tunnel::Ok(_) => panic!("expected 407"),
        }
    }

    #[tokio::test]
    async fn socks5_handshake() {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        let srv = tokio::spawn(async move {
            let (mut s, _) = l.accept().await.unwrap();
            let mut g = [0u8; 3];
            s.read_exact(&mut g).await.unwrap();
            assert_eq!(g, [5, 1, 0]);
            s.write_all(&[5, 0]).await.unwrap();
            let mut r = [0u8; 5];
            s.read_exact(&mut r).await.unwrap();
            assert_eq!(&r[..4], &[5, 1, 0, 3]);
            let mut host = vec![0u8; r[4] as usize + 2];
            s.read_exact(&mut host).await.unwrap();
            assert_eq!(&host[..host.len() - 2], b"example.com");
            s.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await.unwrap();
            s.write_all(b"ok").await.unwrap();
        });
        let mut io = socks5(
            Box::new(tcp("127.0.0.1", port).await.unwrap()),
            "example.com",
            443,
        )
        .await
        .unwrap();
        let mut b = [0u8; 2];
        io.read_exact(&mut b).await.unwrap();
        assert_eq!(&b, b"ok");
        srv.await.unwrap();
    }
}
