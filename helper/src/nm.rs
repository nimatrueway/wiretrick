//! Native-messaging transport: u32 (native endian = LE on every supported
//! target) length-prefixed JSON on stdin/stdout, plus the message schema.
//! Host→extension frames are capped by Chrome at 1 MB, so large bodies go
//! out as base64 `chunk` frames before the message that references them.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};

/// raw bytes per chunk frame (base64 grows it to ~800 KB, under the 1 MB cap)
pub const CHUNK_RAW: usize = 600 * 1024;
/// extension→host frames may be up to 4 GB; refuse silly sizes anyway
const MAX_IN_FRAME: usize = 512 * 1024 * 1024;

pub type Headers = Vec<(String, String)>;

#[derive(Debug, Clone, Deserialize, Serialize, Default, PartialEq)]
pub struct Route {
    /// URLPattern constructor strings (`<all_urls>`/`*` = every URL), parsed
    /// by `proxy::State::set_routes`
    #[serde(rename = "match")]
    pub patterns: Vec<String>,
    /// onRequest / replaceResponse handlers → pause at the request stage
    #[serde(default)]
    pub req: bool,
    /// onResponseHeaders handlers → pause at the response stage (headers only)
    #[serde(default, rename = "resHeaders")]
    pub res_headers: bool,
    /// modifyResponse handlers → pause at the response stage with the body
    #[serde(default)]
    pub body: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum UpstreamMode {
    /// connect directly
    Direct,
    /// ask the extension per host (fixed_servers / pac_script)
    Ask,
    /// read the OS proxy configuration
    System,
}

/// extension → helper
#[derive(Debug, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum In {
    Config {
        routes: Vec<Route>,
        #[serde(default = "default_upstream")]
        upstream: UpstreamMode,
    },
    Continue {
        id: u64,
        #[serde(default)]
        headers: Option<Headers>,
    },
    Redirect {
        id: u64,
        url: String,
    },
    Fulfill {
        id: u64,
        status: u16,
        #[serde(default)]
        headers: Headers,
        /// base64
        #[serde(default)]
        body: String,
    },
    Fail {
        id: u64,
    },
    Upstream {
        id: u64,
        /// PAC-style list, e.g. "PROXY h:3128; SOCKS5 h:1080; DIRECT"
        proxy: String,
    },
    TrustCa {},
    Ping {},
}

fn default_upstream() -> UpstreamMode {
    UpstreamMode::Direct
}

impl In {
    pub fn pending_id(&self) -> Option<u64> {
        match self {
            In::Continue { id, .. }
            | In::Redirect { id, .. }
            | In::Fulfill { id, .. }
            | In::Fail { id }
            | In::Upstream { id, .. } => Some(*id),
            _ => None,
        }
    }
}

/// helper → extension
#[derive(Debug, Serialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum Out {
    Ready {
        port: u16,
        version: &'static str,
        #[serde(rename = "caPem")]
        ca_pem: String,
        #[serde(rename = "caFingerprint")]
        ca_fingerprint: String,
        #[serde(rename = "caPath")]
        ca_path: String,
    },
    /// OS proxy settings as PAC entries (sent once after `ready`; the
    /// extension mirrors them in its PAC for hosts the helper doesn't route)
    System {
        http: Option<String>,
        https: Option<String>,
        socks: Option<String>,
        bypass: Vec<String>,
        #[serde(rename = "pacUrl")]
        pac_url: Option<String>,
    },
    Req {
        id: u64,
        url: String,
        method: String,
        headers: Headers,
    },
    Chunk {
        id: u64,
        data: String,
    },
    Res {
        id: u64,
        url: String,
        method: String,
        status: u16,
        headers: Headers,
        /// "none" (not requested), "skipped:<why>", or "chunks" (sent before this frame)
        body: String,
    },
    NeedUpstream {
        id: u64,
        url: String,
        host: String,
        /// system mode: the OS points at a PAC file the extension must evaluate
        #[serde(rename = "pacUrl", skip_serializing_if = "Option::is_none")]
        pac_url: Option<String>,
    },
    TrustResult {
        ok: bool,
        msg: String,
    },
    Log {
        level: &'static str,
        msg: String,
    },
    Pong {},
}

#[derive(Clone)]
pub struct Nm {
    tx: mpsc::UnboundedSender<Vec<u8>>,
    next: Arc<AtomicU64>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<In>>>>,
}

impl Nm {
    /// Spawn the writer task over `out`; feed incoming frames via [`Nm::dispatch`].
    pub fn new<W: AsyncWrite + Unpin + Send + 'static>(mut out: W) -> Nm {
        let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
        tokio::spawn(async move {
            while let Some(frame) = rx.recv().await {
                let len = (frame.len() as u32).to_le_bytes();
                if out.write_all(&len).await.is_err()
                    || out.write_all(&frame).await.is_err()
                    || out.flush().await.is_err()
                {
                    break;
                }
            }
        });
        Nm {
            tx,
            next: Arc::new(AtomicU64::new(1)),
            pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn send(&self, msg: &Out) {
        if let Ok(v) = serde_json::to_vec(msg) {
            let _ = self.tx.send(v);
        }
    }

    pub fn log(&self, level: &'static str, msg: impl Into<String>) {
        self.send(&Out::Log {
            level,
            msg: msg.into(),
        });
    }

    pub fn next_id(&self) -> u64 {
        self.next.fetch_add(1, Ordering::Relaxed)
    }

    /// Send body bytes as base64 chunk frames ahead of the frame that uses them.
    pub fn send_chunks(&self, id: u64, body: &[u8]) {
        for part in body.chunks(CHUNK_RAW) {
            self.send(&Out::Chunk {
                id,
                data: base64::engine::general_purpose::STANDARD.encode(part),
            });
        }
    }

    /// Send `msg` (built with `id`) and wait for the extension's verdict.
    /// None = timed out / extension gone → callers continue unmodified.
    pub fn ask(
        &self,
        id: u64,
        msg: Out,
        timeout: Duration,
    ) -> impl Future<Output = Option<In>> + Send + 'static {
        // register + send synchronously: `Out` (which holds `&'static str`)
        // must not live inside the returned future (rustc HRTB Send bug)
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        self.send(&msg);
        let pending = self.pending.clone();
        async move {
            let r = tokio::time::timeout(timeout, rx)
                .await
                .ok()
                .and_then(|r| r.ok());
            pending.lock().unwrap().remove(&id);
            r
        }
    }

    /// Route a reply to its waiter. Returns the message back when it isn't a reply.
    pub fn dispatch(&self, msg: In) -> Option<In> {
        if let Some(id) = msg.pending_id() {
            if let Some(tx) = self.pending.lock().unwrap().remove(&id) {
                let _ = tx.send(msg);
            }
            return None;
        }
        Some(msg)
    }
}

/// Read one frame. Ok(None) on clean EOF (the browser closed the port).
pub async fn read_frame<R: AsyncRead + Unpin>(r: &mut R) -> std::io::Result<Option<Vec<u8>>> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let n = u32::from_le_bytes(len) as usize;
    if n > MAX_IN_FRAME {
        return Err(std::io::Error::other("frame too large"));
    }
    let mut buf = vec![0u8; n];
    r.read_exact(&mut buf).await?;
    Ok(Some(buf))
}

pub fn b64decode(s: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD
        .decode(s)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn framing_roundtrip_and_chunking() {
        let (a, mut b) = tokio::io::duplex(8 << 20);
        let nm = Nm::new(a);
        let body = vec![7u8; CHUNK_RAW * 2 + 10];
        nm.send_chunks(5, &body);
        nm.send(&Out::Pong {});
        let mut got = Vec::new();
        for _ in 0..3 {
            let f = read_frame(&mut b).await.unwrap().unwrap();
            assert!(f.len() < 1024 * 1024, "frame over Chrome's 1 MB cap");
            let v: serde_json::Value = serde_json::from_slice(&f).unwrap();
            assert_eq!(v["t"], "chunk");
            got.extend(b64decode(v["data"].as_str().unwrap()));
        }
        assert_eq!(got, body);
        let f = read_frame(&mut b).await.unwrap().unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&f).unwrap()["t"],
            "pong"
        );
    }

    #[tokio::test]
    async fn ask_routes_reply_by_id() {
        let (a, _b) = tokio::io::duplex(1 << 16);
        let nm = Nm::new(a);
        let id = nm.next_id();
        let nm2 = nm.clone();
        let waiter =
            tokio::spawn(async move { nm2.ask(id, Out::Pong {}, Duration::from_secs(5)).await });
        tokio::time::sleep(Duration::from_millis(20)).await;
        let reply: In = serde_json::from_str(&format!(r#"{{"t":"fail","id":{id}}}"#)).unwrap();
        assert!(nm.dispatch(reply).is_none());
        assert!(matches!(waiter.await.unwrap(), Some(In::Fail { .. })));
    }

    #[test]
    fn parses_config() {
        let m: In = serde_json::from_str(r#"{"t":"config","routes":[{"match":["*://a/*"],"req":true,"body":true}],"upstream":"ask"}"#).unwrap();
        match m {
            In::Config { routes, upstream } => {
                assert_eq!(upstream, UpstreamMode::Ask);
                assert!(routes[0].req && routes[0].body && !routes[0].res_headers);
            }
            _ => panic!(),
        }
    }
}
