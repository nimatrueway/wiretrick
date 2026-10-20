//! The local proxy. Chrome's PAC routes only hosts that matched scripts can
//! touch; everything else never reaches us. Per connection:
//!
//!  * `CONNECT host:port` to a host no route can match → raw byte tunnel
//!    (through the user's upstream proxy, if any). No TLS termination.
//!  * `CONNECT` to a routed host → TLS terminated with a leaf minted by our
//!    CA (ALPN h2/http1.1) and every request matched against the routes.
//!  * absolute-form `GET http://…` → plain HTTP, matched the same way.
//!
//! A matched request pauses only for the phases its scripts have handlers
//! for (CDP Fetch-domain style): `req` before the upstream request, `res`
//! after the response head (with the decoded body when a body transform
//! exists). Unmatched requests and unpaused phases stream straight through.

use std::convert::Infallible;
use std::io::Read;
use std::pin::Pin;
use std::sync::{Arc, RwLock};
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Empty, Full, Limited, combinators::BoxBody};
use hyper::body::Incoming;
use hyper::header::{HeaderMap, HeaderName, HeaderValue};
use hyper::{Request, Response, StatusCode};
use hyper_util::client::legacy::Client;
use hyper_util::rt::{TokioExecutor, TokioIo};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::{TcpListener, TcpStream};

use crate::ca::{Ca, Resolver};
use crate::matcher::{match_any, matches};
use crate::nm::{Headers, In, Nm, Out, Route, b64decode};
use crate::upstream::{BoxIo, Connector, Hop, Tunnel, Upstream};

pub type BoxErr = Box<dyn std::error::Error + Send + Sync>;
pub type Body = BoxBody<Bytes, BoxErr>;

/// Requests to this host never leave the helper: the extension fetches it
/// through the PAC to learn whether Chrome trusts our CA.
pub const PROBE_HOST: &str = "wiretrick-helper.probe";
/// largest (encoded or decoded) body handed to body transforms
const MAX_BODY: usize = 64 * 1024 * 1024;
const REQ_TIMEOUT: Duration = Duration::from_secs(30);
const RES_TIMEOUT: Duration = Duration::from_secs(60);

const CANCELLED: &str = "cancelled by script";

#[derive(Debug)]
struct Abort;
impl std::fmt::Display for Abort {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("request aborted")
    }
}
impl std::error::Error for Abort {}

pub struct State {
    pub nm: Nm,
    pub ca: Arc<Ca>,
    pub up: Arc<Upstream>,
    client: Client<Connector, Body>,
    routes: RwLock<Arc<Vec<Route>>>,
}

impl State {
    pub fn new(nm: Nm, ca: Arc<Ca>, up: Arc<Upstream>) -> Arc<State> {
        let client = Client::builder(TokioExecutor::new())
            .pool_idle_timeout(Duration::from_secs(90))
            .build(Connector(up.clone()));
        Arc::new(State {
            nm,
            ca,
            up,
            client,
            routes: RwLock::new(Arc::new(Vec::new())),
        })
    }

    pub fn set_routes(&self, routes: Vec<Route>) {
        *self.routes.write().unwrap() = Arc::new(routes);
    }

    fn routes(&self) -> Arc<Vec<Route>> {
        self.routes.read().unwrap().clone()
    }

    /// OR of every matching route's phases.
    fn flags(&self, url: &str) -> Route {
        let mut f = Route::default();
        for r in self.routes().iter() {
            if match_any(&r.patterns, url) {
                f.req |= r.req;
                f.res_headers |= r.res_headers;
                f.body |= r.body;
            }
        }
        f
    }

    /// Could any route match some URL on this host? (decides MITM vs raw tunnel)
    pub fn host_routed(&self, host: &str, port: u16) -> bool {
        self.routes()
            .iter()
            .any(|r| r.patterns.iter().any(|p| host_may_match(p, host, port)))
    }
}

/// Host-part of a URL pattern vs a host (same rule the extension's PAC uses).
pub fn host_may_match(pattern: &str, host: &str, port: u16) -> bool {
    let Some((_, rest)) = pattern.split_once("://") else {
        return true; // e.g. "*" — could be anything
    };
    let host_pat = rest.split('/').next().unwrap_or("");
    let host_pat = host_pat.to_ascii_lowercase();
    let host = host.to_ascii_lowercase();
    matches(&host_pat, &host)
        || matches(&host_pat, &format!("{host}:{port}"))
        || matches(&host_pat, &format!("[{host}]:{port}"))
}

pub async fn serve(listener: TcpListener, st: Arc<State>) {
    loop {
        let Ok((sock, _)) = listener.accept().await else {
            continue;
        };
        let _ = sock.set_nodelay(true);
        let st = st.clone();
        tokio::spawn(async move {
            let _ = conn(sock, st).await;
        });
    }
}

/// A stream with bytes already read off it pushed back in front.
struct Rewind<T> {
    pre: Bytes,
    inner: T,
}

impl<T: AsyncRead + Unpin> AsyncRead for Rewind<T> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        if !self.pre.is_empty() {
            let n = self.pre.len().min(buf.remaining());
            let chunk = self.pre.split_to(n);
            buf.put_slice(&chunk);
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl<T: AsyncWrite + Unpin> AsyncWrite for Rewind<T> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        b: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, b)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

async fn read_request_head(sock: &mut TcpStream) -> std::io::Result<(Vec<u8>, Bytes)> {
    let mut buf = Vec::with_capacity(1024);
    let mut tmp = [0u8; 4096];
    loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let rest = Bytes::copy_from_slice(&buf[i + 4..]);
            buf.truncate(i + 4);
            return Ok((buf, rest));
        }
        if buf.len() > 64 * 1024 {
            return Err(std::io::Error::other("request head too large"));
        }
        let n = tokio::time::timeout(Duration::from_secs(30), sock.read(&mut tmp))
            .await
            .map_err(|_| std::io::Error::other("head timeout"))??;
        if n == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "closed",
            ));
        }
        buf.extend_from_slice(&tmp[..n]);
    }
}

fn split_host_port(target: &str, default: u16) -> (String, u16) {
    if let Some(rest) = target.strip_prefix('[') {
        let (h, p) = rest.split_once(']').unwrap_or((rest, ""));
        return (
            h.to_string(),
            p.trim_start_matches(':').parse().unwrap_or(default),
        );
    }
    match target.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), p.parse().unwrap_or(default)),
        None => (target.to_string(), default),
    }
}

fn authority_of(host: &str, port: u16, default: u16) -> String {
    let h = if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    if port == default {
        h
    } else {
        format!("{h}:{port}")
    }
}

/// Upstream 407 → a minimal 407 for the browser (status + challenges only).
fn relay_407(head: &[u8]) -> Vec<u8> {
    let text = String::from_utf8_lossy(head);
    let mut out = String::from("HTTP/1.1 407 Proxy Authentication Required\r\n");
    for line in text.lines().skip(1) {
        if line.to_ascii_lowercase().starts_with("proxy-authenticate:") {
            out.push_str(line);
            out.push_str("\r\n");
        }
    }
    out.push_str("Content-Length: 0\r\nConnection: close\r\n\r\n");
    out.into_bytes()
}

async fn conn(mut sock: TcpStream, st: Arc<State>) -> std::io::Result<()> {
    let (head, rest) = read_request_head(&mut sock).await?;
    if !head.starts_with(b"CONNECT ") {
        // absolute-form plain HTTP: hand the whole stream to hyper
        let io = Rewind {
            pre: Bytes::from([head, rest.to_vec()].concat()),
            inner: sock,
        };
        return serve_http(io, st, None).await;
    }
    let text = String::from_utf8_lossy(&head).into_owned();
    let target = text.split_whitespace().nth(1).unwrap_or("").to_string();
    let (host, port) = split_host_port(&target, 443);
    let browser_auth = text.lines().find_map(|l| {
        l.split_once(':')
            .filter(|(k, _)| k.trim().eq_ignore_ascii_case("proxy-authorization"))
            .map(|(_, v)| v.trim().to_string())
    });
    let probe = host.eq_ignore_ascii_case(PROBE_HOST);
    let mitm = probe || st.host_routed(&host, port);

    if !mitm {
        match st
            .up
            .tunnel(&host, port, port != 80, browser_auth.clone())
            .await
        {
            Ok(Tunnel::Ok(mut upstream)) => {
                sock.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                    .await?;
                if !rest.is_empty() {
                    upstream.write_all(&rest).await?;
                }
                let _ = tokio::io::copy_bidirectional(&mut sock, &mut upstream).await;
                return Ok(());
            }
            Ok(Tunnel::Auth(h)) => return sock.write_all(&relay_407(&h)).await,
            Err(e) => {
                st.nm.log("warn", format!("tunnel {host}:{port}: {e}"));
                return sock.write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            }
        }
    }

    // MITM through an authenticating upstream proxy: check credentials NOW,
    // while the browser can still answer a 407 on its CONNECT
    if !probe
        && matches!(
            st.up.hops_for(&host, true).await.first(),
            Some(Hop::Http(_) | Hop::Https(_))
        )
    {
        match st.up.tunnel(&host, port, true, browser_auth.clone()).await {
            Ok(Tunnel::Ok(io)) => st.up.stash(&host, port, io),
            Ok(Tunnel::Auth(h)) => return sock.write_all(&relay_407(&h)).await,
            Err(e) => {
                st.nm
                    .log("warn", format!("upstream proxy for {host}:{port}: {e}"));
                return sock.write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            }
        }
    }

    sock.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await?;
    let first = if !rest.is_empty() {
        rest[0]
    } else {
        let mut b = [0u8; 1];
        match tokio::time::timeout(Duration::from_secs(30), sock.peek(&mut b)).await {
            Ok(Ok(1)) => b[0],
            _ => return Ok(()),
        }
    };
    let io = Rewind {
        pre: rest,
        inner: sock,
    };
    if first != 0x16 {
        // not TLS (ws:// or http:// over CONNECT)
        return serve_http(io, st, Some(("http", authority_of(&host, port, 80)))).await;
    }
    let mut cfg = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_cert_resolver(Arc::new(Resolver {
            ca: st.ca.clone(),
            fallback: host.clone(),
        }));
    cfg.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    let tls = tokio_rustls::TlsAcceptor::from(Arc::new(cfg))
        .accept(io)
        .await?;
    serve_http(tls, st, Some(("https", authority_of(&host, port, 443)))).await
}

fn serve_http<I: AsyncRead + AsyncWrite + Unpin + Send + 'static>(
    io: I,
    st: Arc<State>,
    base: Option<(&'static str, String)>,
) -> Pin<Box<dyn std::future::Future<Output = std::io::Result<()>> + Send>> {
    // concrete error type + boxed Send future: a `Box<dyn Error>` service
    // error trips rustc's "implementation of From is not general enough"
    type Fut = Pin<Box<dyn std::future::Future<Output = Result<Response<Body>, Abort>> + Send>>;
    let svc = hyper::service::service_fn(move |req: Request<Incoming>| -> Fut {
        let (st, base) = (st.clone(), base.clone());
        Box::pin(async move {
            handle(req, st.clone(), base).await.map_err(|e| {
                if e.to_string() != CANCELLED {
                    st.nm.log("warn", format!("upstream: {e}"));
                }
                // hyper resets the stream / closes the connection: the page
                // sees a network error, as with a native failure
                Abort
            })
        })
    });
    Box::pin(async move {
        hyper_util::server::conn::auto::Builder::new(TokioExecutor::new())
            .serve_connection_with_upgrades(TokioIo::new(io), svc)
            .await
            .map_err(std::io::Error::other)
    })
}

fn full(b: impl Into<Bytes>) -> Body {
    Full::new(b.into())
        .map_err(|n: Infallible| match n {})
        .boxed()
}

fn empty() -> Body {
    Empty::<Bytes>::new()
        .map_err(|n: Infallible| match n {})
        .boxed()
}

fn incoming(b: Incoming) -> Body {
    b.map_err(|e| Box::new(e) as BoxErr).boxed()
}

fn text_response(status: u16, msg: &str) -> Response<Body> {
    let mut r = Response::new(full(msg.to_string()));
    *r.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);
    r.headers_mut().insert(
        "content-type",
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    r
}

const HOP_BY_HOP: &[&str] = &[
    "connection",
    "proxy-connection",
    "keep-alive",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

fn headers_to_vec(h: &HeaderMap) -> Headers {
    h.iter()
        .map(|(k, v)| {
            (
                k.as_str().to_string(),
                String::from_utf8_lossy(v.as_bytes()).into_owned(),
            )
        })
        .collect()
}

fn vec_to_headers(v: &Headers, skip: &[&str]) -> HeaderMap {
    let mut h = HeaderMap::new();
    for (k, val) in v {
        let lk = k.to_ascii_lowercase();
        if lk.starts_with(':') || HOP_BY_HOP.contains(&lk.as_str()) || skip.contains(&lk.as_str()) {
            continue;
        }
        if let (Ok(n), Ok(vv)) = (
            HeaderName::from_bytes(lk.as_bytes()),
            HeaderValue::from_str(val),
        ) {
            h.append(n, vv);
        }
    }
    h
}

fn cors_echo(req_headers: &HeaderMap, h: &mut HeaderMap) {
    if let Some(origin) = req_headers.get("origin") {
        h.insert("access-control-allow-origin", origin.clone());
        h.insert(
            "access-control-allow-credentials",
            HeaderValue::from_static("true"),
        );
    }
}

fn header_str<'a>(h: &'a HeaderMap, k: &str) -> &'a str {
    h.get(k).and_then(|v| v.to_str().ok()).unwrap_or("")
}

/// Content types never handed to body transforms (the extension re-checks
/// decoded bytes with looksTextual anyway).
fn skip_body_reason(ct: &str) -> Option<&'static str> {
    let ct = ct.to_ascii_lowercase();
    if ct.contains("svg") {
        return None;
    }
    if ct.starts_with("text/event-stream") {
        return Some("stream");
    }
    for p in [
        "image/",
        "video/",
        "audio/",
        "font/",
        "application/octet-stream",
        "application/zip",
        "application/pdf",
        "application/wasm",
        "application/vnd.",
        "multipart/x-mixed-replace",
    ] {
        if ct.starts_with(p) {
            return Some("binary");
        }
    }
    None
}

/// Decode a content-encoding (gzip / deflate / br / identity). None = unknown/corrupt.
pub fn decode(encoding: &str, data: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let limit = (MAX_BODY + 1) as u64;
    let r = match encoding.trim().to_ascii_lowercase().as_str() {
        "" | "identity" => return Some(data.to_vec()),
        "gzip" | "x-gzip" => flate2::read::MultiGzDecoder::new(data)
            .take(limit)
            .read_to_end(&mut out),
        "deflate" => {
            let z = flate2::read::ZlibDecoder::new(data)
                .take(limit)
                .read_to_end(&mut out);
            if z.is_err() {
                out.clear();
                flate2::read::DeflateDecoder::new(data)
                    .take(limit)
                    .read_to_end(&mut out)
            } else {
                z
            }
        }
        "br" => brotli_decompressor::Decompressor::new(data, 4096)
            .take(limit)
            .read_to_end(&mut out),
        _ => return None,
    };
    (r.is_ok() && out.len() <= MAX_BODY).then_some(out)
}

fn respond(status: u16, headers: &Headers, body: Vec<u8>) -> Response<Body> {
    let mut r = Response::new(full(body));
    *r.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::OK);
    *r.headers_mut() = vec_to_headers(headers, &["content-length", "content-encoding"]);
    r
}

async fn handle(
    mut req: Request<Incoming>,
    st: Arc<State>,
    base: Option<(&'static str, String)>,
) -> Result<Response<Body>, BoxErr> {
    let pq = req
        .uri()
        .path_and_query()
        .map(|p| p.as_str().to_string())
        .unwrap_or_else(|| "/".into());
    let url = match &base {
        Some((scheme, authority)) => format!("{scheme}://{authority}{pq}"),
        None => {
            if req.uri().scheme_str() != Some("http") || req.uri().authority().is_none() {
                return Ok(text_response(400, "wiretrick-helper is a proxy"));
            }
            req.uri().to_string()
        }
    };
    let uri: hyper::Uri = url.parse()?;
    let host = uri
        .host()
        .unwrap_or_default()
        .trim_matches(|c| c == '[' || c == ']')
        .to_string();
    if host.eq_ignore_ascii_case(PROBE_HOST) {
        let mut r = text_response(200, "wiretrick-helper ok");
        r.headers_mut()
            .insert("access-control-allow-origin", HeaderValue::from_static("*"));
        r.headers_mut()
            .insert("cache-control", HeaderValue::from_static("no-store"));
        return Ok(r);
    }
    let method = req.method().to_string();
    let flags = st.flags(&url);
    let is_upgrade = req.headers().contains_key("upgrade");

    // ---- request stage ----
    if flags.req {
        let id = st.nm.next_id();
        let msg = Out::Req {
            id,
            url: url.clone(),
            method: method.clone(),
            headers: headers_to_vec(req.headers()),
        };
        match st.nm.ask(id, msg, REQ_TIMEOUT).await {
            Some(In::Continue {
                headers: Some(h), ..
            }) => {
                let keep_upgrade: Vec<(HeaderName, HeaderValue)> = if is_upgrade {
                    ["connection", "upgrade"]
                        .iter()
                        .filter_map(|k| {
                            req.headers()
                                .get(*k)
                                .map(|v| (HeaderName::from_static(k), v.clone()))
                        })
                        .collect()
                } else {
                    vec![]
                };
                *req.headers_mut() = vec_to_headers(&h, &[]);
                for (k, v) in keep_upgrade {
                    req.headers_mut().insert(k, v);
                }
            }
            Some(In::Redirect { url: to, .. }) => {
                let mut r = Response::new(empty());
                *r.status_mut() = StatusCode::TEMPORARY_REDIRECT;
                r.headers_mut()
                    .insert("location", HeaderValue::from_str(&to)?);
                r.headers_mut()
                    .insert("cache-control", HeaderValue::from_static("no-store"));
                let rh = req.headers().clone();
                cors_echo(&rh, r.headers_mut());
                return Ok(r);
            }
            Some(In::Fulfill {
                status,
                headers,
                body,
                ..
            }) => return Ok(respond(status, &headers, b64decode(&body))),
            Some(In::Fail { .. }) => return Err(CANCELLED.into()),
            _ => {}
        }
    }

    if is_upgrade {
        return upgrade(req, st, &uri, &host).await;
    }

    // ---- upstream ----
    let https = uri.scheme_str() == Some("https");
    let keep_proxy_auth = !https && st.up.http_via_proxy(&host).await;
    let (mut parts, body) = req.into_parts();
    for h in HOP_BY_HOP {
        parts.headers.remove(*h);
    }
    parts.headers.remove(hyper::header::HOST);
    if !keep_proxy_auth {
        parts.headers.remove("proxy-authorization");
    }
    if flags.body {
        // only encodings we can decode for the transform
        parts.headers.insert(
            "accept-encoding",
            HeaderValue::from_static("gzip, deflate, br"),
        );
    }
    parts.uri = uri.clone();
    parts.version = hyper::Version::HTTP_11;
    let up_req = Request::from_parts(parts, incoming(body));
    let resp = match st.client.request(up_req).await {
        Ok(r) => r,
        Err(e) => {
            let mut msg = format!("{e}");
            let mut src = std::error::Error::source(&e);
            while let Some(s) = src {
                msg.push_str(&format!(": {s}"));
                src = s.source();
            }
            // surfaces as a network error, like the browser's own failure would
            return Err(format!("{url}: {msg}").into());
        }
    };

    if !(flags.res_headers || flags.body) {
        let (p, b) = resp.into_parts();
        return Ok(Response::from_parts(p, incoming(b)));
    }

    // ---- response stage ----
    let (mut rp, rb) = resp.into_parts();
    let status = rp.status.as_u16();
    let mut body_state = String::from("none");
    if flags.body {
        let ct = header_str(&rp.headers, "content-type").to_string();
        let len: Option<usize> = header_str(&rp.headers, "content-length").parse().ok();
        let skip =
            if method == "HEAD" || status == 204 || status == 304 || (100..200).contains(&status) {
                Some("empty")
            } else if len.is_some_and(|l| l > MAX_BODY) {
                Some("too-large")
            } else {
                skip_body_reason(&ct)
            };
        match skip {
            Some(why) => body_state = format!("skipped:{why}"),
            None => {
                let raw = match Limited::new(rb, MAX_BODY).collect().await {
                    Ok(c) => c.to_bytes(),
                    Err(e) => {
                        st.nm.log("warn", format!("reading body of {url}: {e}"));
                        return Err(e);
                    }
                };
                let enc = header_str(&rp.headers, "content-encoding").to_string();
                match decode(&enc, &raw) {
                    Some(dec) => {
                        rp.headers.remove("content-encoding");
                        rp.headers.remove("transfer-encoding");
                        rp.headers
                            .insert("content-length", HeaderValue::from(dec.len()));
                        return finish_response(st, url, method, status, rp, dec, "chunks".into())
                            .await;
                    }
                    None => {
                        // unknown encoding: pass the raw bytes through untouched
                        let mut r = Response::from_parts(rp, full(raw));
                        r.headers_mut().remove("transfer-encoding");
                        st.nm.log("info", format!("{url}: content-encoding {enc:?} not decodable — body transform skipped"));
                        return Ok(r);
                    }
                }
            }
        }
    }
    // headers-only pause, or a skipped body: the body keeps streaming
    finish_streaming(st, url, method, status, rp, rb, body_state).await
}

async fn finish_response(
    st: Arc<State>,
    url: String,
    method: String,
    status: u16,
    rp: hyper::http::response::Parts,
    body: Vec<u8>,
    body_state: String,
) -> Result<Response<Body>, BoxErr> {
    let id = st.nm.next_id();
    st.nm.send_chunks(id, &body);
    let msg = Out::Res {
        id,
        url,
        method,
        status,
        headers: headers_to_vec(&rp.headers),
        body: body_state,
    };
    match st.nm.ask(id, msg, RES_TIMEOUT).await {
        Some(In::Fulfill {
            status,
            headers,
            body,
            ..
        }) => Ok(respond(status, &headers, b64decode(&body))),
        Some(In::Fail { .. }) => Err(CANCELLED.into()),
        Some(In::Continue {
            headers: Some(h), ..
        }) => {
            let mut r = respond(status, &h, body);
            *r.status_mut() = rp.status;
            Ok(r)
        }
        _ => Ok(Response::from_parts(rp, full(body))),
    }
}

async fn finish_streaming(
    st: Arc<State>,
    url: String,
    method: String,
    status: u16,
    mut rp: hyper::http::response::Parts,
    rb: Incoming,
    body_state: String,
) -> Result<Response<Body>, BoxErr> {
    let id = st.nm.next_id();
    let msg = Out::Res {
        id,
        url,
        method,
        status,
        headers: headers_to_vec(&rp.headers),
        body: body_state,
    };
    match st.nm.ask(id, msg, RES_TIMEOUT).await {
        Some(In::Fulfill {
            status,
            headers,
            body,
            ..
        }) => Ok(respond(status, &headers, b64decode(&body))),
        Some(In::Fail { .. }) => Err(CANCELLED.into()),
        Some(In::Continue {
            headers: Some(h), ..
        }) => {
            // header-only change: the original body still streams
            let keep_len = rp.headers.get("content-length").cloned();
            let keep_enc = rp.headers.get("content-encoding").cloned();
            rp.headers = vec_to_headers(&h, &["content-length", "content-encoding"]);
            if let Some(v) = keep_len {
                rp.headers.insert("content-length", v);
            }
            if let Some(v) = keep_enc {
                rp.headers.insert("content-encoding", v);
            }
            Ok(Response::from_parts(rp, incoming(rb)))
        }
        _ => Ok(Response::from_parts(rp, incoming(rb))),
    }
}

/// WebSocket (or any HTTP/1.1 Upgrade): relay the handshake on a dedicated
/// upstream connection, then splice the two upgraded streams.
async fn upgrade(
    mut req: Request<Incoming>,
    st: Arc<State>,
    uri: &hyper::Uri,
    host: &str,
) -> Result<Response<Body>, BoxErr> {
    let https = uri.scheme_str() == Some("https");
    let port = uri.port_u16().unwrap_or(if https { 443 } else { 80 });
    let io: BoxIo = if https {
        st.up.connect_tls(host, port, true).await?.0
    } else {
        match st.up.tunnel(host, port, false, None).await? {
            Tunnel::Ok(io) => io,
            Tunnel::Auth(_) => {
                return Ok(text_response(502, "upstream proxy requires authentication"));
            }
        }
    };
    let (mut sender, conn) =
        hyper::client::conn::http1::handshake::<_, Empty<Bytes>>(TokioIo::new(io)).await?;
    tokio::spawn(async move {
        let _ = conn.with_upgrades().await;
    });
    let client_upgrade = hyper::upgrade::on(&mut req);
    let mut up_req = Request::builder()
        .method(req.method().clone())
        .uri(uri.path_and_query().map(|p| p.as_str()).unwrap_or("/"));
    for (k, v) in req.headers() {
        if k.as_str() == "proxy-authorization" || k.as_str() == "proxy-connection" {
            continue;
        }
        up_req = up_req.header(k, v);
    }
    if !req.headers().contains_key("host") {
        up_req = up_req.header("host", uri.authority().map(|a| a.as_str()).unwrap_or(host));
    }
    let mut resp = sender.send_request(up_req.body(Empty::new())?).await?;
    if resp.status() == StatusCode::SWITCHING_PROTOCOLS {
        let upstream_upgrade = hyper::upgrade::on(&mut resp);
        tokio::spawn(async move {
            if let (Ok(a), Ok(b)) = (client_upgrade.await, upstream_upgrade.await) {
                let _ =
                    tokio::io::copy_bidirectional(&mut TokioIo::new(a), &mut TokioIo::new(b)).await;
            }
        });
        let (p, _) = resp.into_parts();
        return Ok(Response::from_parts(p, empty()));
    }
    let (p, b) = resp.into_parts();
    Ok(Response::from_parts(p, incoming(b)))
}

#[cfg(test)]
mod tests;
