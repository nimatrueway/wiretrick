//! End-to-end: a real TLS (h2/h1) upstream on localhost, the proxy, a mock
//! extension on the other end of the native-messaging pipe, and a client
//! that speaks CONNECT + TLS like Chrome does.

use std::collections::HashMap;
use std::io::Write;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use base64::Engine;
use http_body_util::BodyExt;
use rustls::pki_types::{CertificateDer, ServerName};
use serde_json::{Value, json};
use tokio::io::AsyncReadExt;

use super::*;
use crate::nm::{UpstreamMode, read_frame};

type Reply = Box<dyn Fn(&Value, &[u8]) -> Option<Value> + Send + Sync>;

struct Env {
    proxy_port: u16,
    up_port: u16,
    up_plain_port: u16,
    up_cert: CertificateDer<'static>,
    hits: Arc<AtomicUsize>,
    /// every message the mock extension saw
    seen: Arc<Mutex<Vec<Value>>>,
    reply: Arc<Mutex<Reply>>,
    client_roots: rustls::RootCertStore,
}

static NEXT: AtomicUsize = AtomicUsize::new(0);

fn provider() -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

fn b64(s: impl AsRef<[u8]>) -> String {
    base64::engine::general_purpose::STANDARD.encode(s)
}

fn big_text() -> String {
    "0123456789abcdef".repeat(2 * 1024 * 1024 / 16 + 7)
}

async fn upstream_handler(req: Request<Incoming>, hits: Arc<AtomicUsize>) -> Result<Response<Full<Bytes>>, Infallible> {
    hits.fetch_add(1, Ordering::SeqCst);
    let path = req.uri().path().to_string();
    let version = format!("{:?}", req.version());
    let headers: HashMap<String, String> = req.headers().iter().map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string())).collect();
    let mut r = Response::builder().header("content-type", "text/plain");
    let b: Vec<u8> = match path.as_str() {
        "/text" => b"hello world".to_vec(),
        "/echo" => {
            r = Response::builder().header("content-type", "application/json");
            serde_json::to_vec(&json!({ "version": version, "headers": headers })).unwrap()
        }
        "/gzip" => {
            r = r.header("content-encoding", "gzip");
            let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            e.write_all(b"compressed hello").unwrap();
            e.finish().unwrap()
        }
        "/deflate" => {
            r = r.header("content-encoding", "deflate");
            let mut e = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
            e.write_all(b"deflated hello").unwrap();
            e.finish().unwrap()
        }
        "/big" => big_text().into_bytes(),
        "/image" => {
            r = Response::builder().header("content-type", "image/png");
            vec![0x89, b'P', b'N', b'G', 0, 1, 2, 3]
        }
        _ => {
            r = r.status(404);
            b"nope".to_vec()
        }
    };
    Ok(r.header("x-upstream", "1").body(Full::new(Bytes::from(b))).unwrap())
}

async fn start_upstream(hits: Arc<AtomicUsize>) -> (u16, u16, CertificateDer<'static>) {
    let ck = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
    let cert = CertificateDer::from(ck.cert.der().to_vec());
    let key = rustls::pki_types::PrivateKeyDer::try_from(ck.signing_key.serialize_der()).unwrap();
    let mut cfg = rustls::ServerConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![cert.clone()], key)
        .unwrap();
    cfg.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(cfg));
    let tls_l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let plain_l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (tp, pp) = (tls_l.local_addr().unwrap().port(), plain_l.local_addr().unwrap().port());
    let h2 = hits.clone();
    tokio::spawn(async move {
        loop {
            let (s, _) = tls_l.accept().await.unwrap();
            let (acceptor, hits) = (acceptor.clone(), h2.clone());
            tokio::spawn(async move {
                let Ok(t) = acceptor.accept(s).await else { return };
                let svc = hyper::service::service_fn(move |r| upstream_handler(r, hits.clone()));
                let _ = hyper_util::server::conn::auto::Builder::new(TokioExecutor::new()).serve_connection(TokioIo::new(t), svc).await;
            });
        }
    });
    tokio::spawn(async move {
        loop {
            let (s, _) = plain_l.accept().await.unwrap();
            let hits = hits.clone();
            tokio::spawn(async move {
                let svc = hyper::service::service_fn(move |r| upstream_handler(r, hits.clone()));
                let _ = hyper_util::server::conn::auto::Builder::new(TokioExecutor::new()).serve_connection(TokioIo::new(s), svc).await;
            });
        }
    });
    (tp, pp, cert)
}

async fn setup(routes: Vec<Route>) -> Env {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let hits = Arc::new(AtomicUsize::new(0));
    let (up_port, up_plain_port, up_cert) = start_upstream(hits.clone()).await;

    let dir = std::env::temp_dir().join(format!("rescript-helper-test-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst)));
    let ca = Arc::new(Ca::load_or_create(&dir).unwrap());

    // the helper trusts the test upstream's self-signed cert
    let mut up_roots = rustls::RootCertStore::empty();
    up_roots.add(up_cert.clone()).unwrap();
    let ccfg = rustls::ClientConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(up_roots)
        .with_no_client_auth();

    let (ours, theirs) = tokio::io::duplex(1 << 20);
    let (mut ext_read, _ext_write) = tokio::io::split(theirs);
    let (_ours_r, ours_w) = tokio::io::split(ours);
    let nm = Nm::new(ours_w);
    let up = Arc::new(Upstream::new(nm.clone(), ccfg));
    up.set_mode(UpstreamMode::Direct);
    let st = State::new(nm.clone(), ca.clone(), up);
    st.set_routes(routes);

    let seen = Arc::new(Mutex::new(Vec::new()));
    let reply: Arc<Mutex<Reply>> = Arc::new(Mutex::new(Box::new(|_, _| None)));
    {
        let (seen, reply, nm) = (seen.clone(), reply.clone(), nm.clone());
        tokio::spawn(async move {
            let _keep = _ext_write;
            let mut chunks: HashMap<u64, Vec<u8>> = HashMap::new();
            while let Ok(Some(f)) = read_frame(&mut ext_read).await {
                let v: Value = serde_json::from_slice(&f).unwrap();
                let id = v["id"].as_u64().unwrap_or(0);
                match v["t"].as_str().unwrap() {
                    "chunk" => {
                        let part = base64::engine::general_purpose::STANDARD.decode(v["data"].as_str().unwrap()).unwrap();
                        chunks.entry(id).or_default().extend(part);
                        seen.lock().unwrap().push(json!({"t": "chunk", "id": id}));
                        continue;
                    }
                    "req" | "res" | "needUpstream" => {}
                    _ => continue,
                }
                let body = chunks.remove(&id).unwrap_or_default();
                seen.lock().unwrap().push(v.clone());
                let out = (reply.lock().unwrap())(&v, &body).unwrap_or_else(|| json!({"t": "continue"}));
                let mut out = out.as_object().unwrap().clone();
                out.insert("id".into(), json!(id));
                let msg: In = serde_json::from_value(Value::Object(out)).unwrap();
                nm.dispatch(msg);
            }
        });
    }

    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_port = l.local_addr().unwrap().port();
    tokio::spawn(serve(l, st));

    let mut client_roots = rustls::RootCertStore::empty();
    client_roots.add(CertificateDer::from(ca.der.clone())).unwrap();
    client_roots.add(up_cert.clone()).unwrap();
    Env { proxy_port, up_port, up_plain_port, up_cert, hits, seen, reply, client_roots }
}

fn route(pattern: &str, req: bool, res_headers: bool, body: bool) -> Route {
    Route { patterns: vec![pattern.into()], req, res_headers, body }
}

struct Got {
    status: u16,
    headers: HeaderMap,
    body: Vec<u8>,
    peer_cert: Vec<u8>,
    alpn_h2: bool,
}

impl Env {
    fn on(&self, f: impl Fn(&Value, &[u8]) -> Option<Value> + Send + Sync + 'static) {
        *self.reply.lock().unwrap() = Box::new(f);
    }

    fn seen(&self, t: &str) -> Vec<Value> {
        self.seen.lock().unwrap().iter().filter(|v| v["t"] == t).cloned().collect()
    }

    /// CONNECT localhost:<up_port>, TLS (h1 or h2 via ALPN), one request.
    async fn get(&self, path: &str, h2: bool, extra: &[(&str, &str)]) -> Result<Got, String> {
        let mut s = TcpStream::connect(("127.0.0.1", self.proxy_port)).await.unwrap();
        s.write_all(format!("CONNECT localhost:{0} HTTP/1.1\r\nHost: localhost:{0}\r\n\r\n", self.up_port).as_bytes()).await.unwrap();
        let mut head = Vec::new();
        while !head.ends_with(b"\r\n\r\n") {
            let mut b = [0u8; 1];
            if s.read(&mut b).await.unwrap() == 0 {
                return Err("closed during CONNECT".into());
            }
            head.push(b[0]);
        }
        let head = String::from_utf8_lossy(&head).to_string();
        if !head.starts_with("HTTP/1.1 200") {
            return Err(head);
        }
        let mut cfg = rustls::ClientConfig::builder_with_provider(provider())
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(self.client_roots.clone())
            .with_no_client_auth();
        cfg.alpn_protocols = if h2 { vec![b"h2".to_vec(), b"http/1.1".to_vec()] } else { vec![b"http/1.1".to_vec()] };
        let tls = tokio_rustls::TlsConnector::from(Arc::new(cfg)).connect(ServerName::try_from("localhost").unwrap(), s).await.map_err(|e| e.to_string())?;
        let peer_cert = tls.get_ref().1.peer_certificates().unwrap()[0].to_vec();
        let alpn_h2 = tls.get_ref().1.alpn_protocol() == Some(b"h2");
        let mut b = Request::builder().uri(format!("https://localhost:{}{path}", self.up_port));
        if !alpn_h2 {
            b = Request::builder().uri(path).header("host", format!("localhost:{}", self.up_port));
        }
        for (k, v) in extra {
            b = b.header(*k, *v);
        }
        let req = b.body(Empty::<Bytes>::new()).unwrap();
        let resp = if alpn_h2 {
            let (mut send, conn) = hyper::client::conn::http2::handshake(TokioExecutor::new(), TokioIo::new(tls)).await.map_err(|e| e.to_string())?;
            tokio::spawn(conn);
            send.send_request(req).await.map_err(|e| e.to_string())?
        } else {
            let (mut send, conn) = hyper::client::conn::http1::handshake(TokioIo::new(tls)).await.map_err(|e| e.to_string())?;
            tokio::spawn(conn);
            send.send_request(req).await.map_err(|e| e.to_string())?
        };
        let (p, body) = resp.into_parts();
        let body = body.collect().await.map_err(|e| e.to_string())?.to_bytes().to_vec();
        Ok(Got { status: p.status.as_u16(), headers: p.headers, body, peer_cert, alpn_h2 })
    }

    /// plain http, absolute-form through the proxy
    async fn get_plain(&self, host: &str, path: &str) -> Result<Got, String> {
        let s = TcpStream::connect(("127.0.0.1", self.proxy_port)).await.unwrap();
        let (mut send, conn) = hyper::client::conn::http1::handshake(TokioIo::new(s)).await.map_err(|e| e.to_string())?;
        tokio::spawn(conn);
        let req = Request::builder().uri(format!("http://{host}{path}")).header("host", host).body(Empty::<Bytes>::new()).unwrap();
        let resp = send.send_request(req).await.map_err(|e| e.to_string())?;
        let (p, body) = resp.into_parts();
        let body = body.collect().await.map_err(|e| e.to_string())?.to_bytes().to_vec();
        Ok(Got { status: p.status.as_u16(), headers: p.headers, body, peer_cert: vec![], alpn_h2: false })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unrouted_host_is_a_raw_tunnel() {
    let env = setup(vec![route("https://example.com/*", true, true, true)]).await;
    let g = env.get("/text", true, &[]).await.unwrap();
    assert_eq!(g.body, b"hello world");
    // the client talked TLS to the real server, not to us
    assert_eq!(g.peer_cert, env.up_cert.to_vec());
    assert!(env.seen.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn routed_host_without_pauses_streams_through_h2_both_sides() {
    let env = setup(vec![route("https://localhost*/never/*", true, true, true)]).await;
    let g = env.get("/echo", true, &[]).await.unwrap();
    assert!(g.alpn_h2);
    assert_ne!(g.peer_cert, env.up_cert.to_vec(), "MITM leaf expected");
    let v: Value = serde_json::from_slice(&g.body).unwrap();
    assert_eq!(v["version"], "HTTP/2.0", "helper should negotiate h2 upstream");
    assert!(env.seen.lock().unwrap().is_empty(), "no pause for unmatched paths");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn request_stage_fulfill_never_hits_upstream() {
    let env = setup(vec![route("https://localhost*/text", true, false, false)]).await;
    env.on(|v, _| {
        assert_eq!(v["t"], "req");
        assert_eq!(v["method"], "GET");
        Some(json!({"t": "fulfill", "status": 201, "headers": [["content-type", "text/plain"], ["x-mock", "yes"]], "body": b64("from script")}))
    });
    for h2 in [false, true] {
        let g = env.get("/text", h2, &[]).await.unwrap();
        assert_eq!(g.status, 201);
        assert_eq!(g.body, b"from script");
        assert_eq!(g.headers["x-mock"], "yes");
    }
    assert_eq!(env.hits.load(Ordering::SeqCst), 0);
    assert!(env.seen("req")[0]["url"].as_str().unwrap().ends_with("/text"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn request_stage_header_rewrite() {
    let env = setup(vec![route("https://localhost*/echo", true, false, false)]).await;
    env.on(|v, _| {
        let mut h: Vec<Value> = v["headers"].as_array().unwrap().iter().filter(|p| p[0] != "x-drop").cloned().collect();
        h.push(json!(["x-added", "1"]));
        Some(json!({"t": "continue", "headers": h}))
    });
    for h2 in [false, true] {
        let g = env.get("/echo", h2, &[("x-drop", "bye"), ("x-keep", "k")]).await.unwrap();
        let v: Value = serde_json::from_slice(&g.body).unwrap();
        assert_eq!(v["headers"]["x-added"], "1", "h2={h2}");
        assert_eq!(v["headers"]["x-keep"], "k");
        assert!(v["headers"].get("x-drop").is_none());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn request_stage_redirect_and_cancel() {
    let env = setup(vec![route("https://localhost*/*", true, false, false)]).await;
    env.on(|v, _| {
        if v["url"].as_str().unwrap().ends_with("/text") {
            Some(json!({"t": "redirect", "url": "https://elsewhere.test/x"}))
        } else {
            Some(json!({"t": "fail"}))
        }
    });
    let g = env.get("/text", false, &[("origin", "https://page.test")]).await.unwrap();
    assert_eq!(g.status, 307);
    assert_eq!(g.headers["location"], "https://elsewhere.test/x");
    assert_eq!(g.headers["access-control-allow-origin"], "https://page.test");
    assert!(env.get("/echo", false, &[]).await.is_err(), "fail = network error");
    assert!(env.get("/echo", true, &[]).await.is_err(), "fail = stream reset on h2");
    assert_eq!(env.hits.load(Ordering::SeqCst), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn body_transform_sees_decoded_gzip_and_deflate() {
    let env = setup(vec![route("https://localhost*/*", false, false, true)]).await;
    env.on(|v, body| {
        assert_eq!(v["t"], "res");
        assert_eq!(v["body"], "chunks");
        let hs = v["headers"].as_array().unwrap();
        assert!(!hs.iter().any(|p| p[0] == "content-encoding"), "encoding stripped for the transform");
        let up = String::from_utf8_lossy(body).to_uppercase();
        Some(json!({"t": "fulfill", "status": v["status"], "headers": hs, "body": b64(up)}))
    });
    for (path, want) in [("/gzip", "COMPRESSED HELLO"), ("/deflate", "DEFLATED HELLO"), ("/text", "HELLO WORLD")] {
        for h2 in [false, true] {
            let g = env.get(path, h2, &[("accept-encoding", "zstd")]).await.unwrap();
            assert_eq!(String::from_utf8_lossy(&g.body), want, "{path} h2={h2}");
            assert!(g.headers.get("content-encoding").is_none());
            assert_eq!(g.headers["x-upstream"], "1");
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn big_body_goes_out_in_chunks_and_continue_keeps_it() {
    let env = setup(vec![route("https://localhost*/big", false, false, true)]).await;
    let len = Arc::new(AtomicUsize::new(0));
    let l2 = len.clone();
    env.on(move |_, body| {
        l2.store(body.len(), Ordering::SeqCst);
        None
    });
    let g = env.get("/big", true, &[]).await.unwrap();
    let want = big_text();
    assert_eq!(len.load(Ordering::SeqCst), want.len());
    assert!(g.body == want.as_bytes());
    assert!(env.seen("chunk").len() >= 4, "{} chunks", env.seen("chunk").len());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn binary_bodies_are_skipped_but_headers_still_editable() {
    let env = setup(vec![route("https://localhost*/image", false, true, true)]).await;
    env.on(|v, body| {
        assert_eq!(v["body"], "skipped:binary");
        assert!(body.is_empty());
        let mut h = v["headers"].as_array().unwrap().clone();
        h.push(json!(["x-res", "edited"]));
        Some(json!({"t": "continue", "headers": h}))
    });
    let g = env.get("/image", false, &[]).await.unwrap();
    assert_eq!(g.headers["x-res"], "edited");
    assert_eq!(g.body, [0x89, b'P', b'N', b'G', 0, 1, 2, 3]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn plain_http_absolute_form() {
    let env = setup(vec![route("http://localhost*/*", true, true, false)]).await;
    env.on(|v, _| match v["t"].as_str().unwrap() {
        "req" => None,
        _ => {
            let mut h = v["headers"].as_array().unwrap().clone();
            h.push(json!(["x-res", "plain"]));
            Some(json!({"t": "continue", "headers": h}))
        }
    });
    let g = env.get_plain(&format!("localhost:{}", env.up_plain_port), "/text").await.unwrap();
    assert_eq!(g.body, b"hello world");
    assert_eq!(g.headers["x-res"], "plain");
    assert_eq!(env.seen("req").len(), 1);
    assert_eq!(env.seen("res").len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn probe_host_answers_locally() {
    let env = setup(vec![]).await;
    let g = env.get_plain(PROBE_HOST, "/").await.unwrap();
    assert_eq!(g.status, 200);
    assert_eq!(g.headers["access-control-allow-origin"], "*");
}
