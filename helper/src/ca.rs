//! The helper-owned certificate authority. One P-256 CA per install,
//! persisted in the user config dir (key file 0600). Leaf certificates are
//! minted on demand per SNI host, all sharing one per-process leaf key
//! (a P-256 keygen per host would be wasted work; the CA signature is what
//! makes each leaf host-specific).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use base64::Engine;
use rcgen::{
    BasicConstraints, CertificateParams, DnType, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair,
    KeyUsagePurpose,
};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::server::{ClientHello, ResolvesServerCert};
use rustls::sign::CertifiedKey;

pub const CA_NAME: &str = "Wiretrick Local CA";
const LEAF_CACHE_MAX: usize = 1024;

pub struct Ca {
    issuer: Issuer<'static, KeyPair>,
    pub pem: String,
    pub der: Vec<u8>,
    pub path: PathBuf,
    leaf_key: KeyPair,
    leaf_signer: Arc<dyn rustls::sign::SigningKey>,
    cache: Mutex<HashMap<String, Arc<CertifiedKey>>>,
}

fn ca_params() -> CertificateParams {
    let mut p = CertificateParams::default();
    p.distinguished_name = rcgen::DistinguishedName::new();
    p.distinguished_name.push(DnType::CommonName, CA_NAME);
    p.distinguished_name.push(
        DnType::OrganizationName,
        "Wiretrick (local, this machine only)",
    );
    p.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
    p.key_usages = vec![
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
        KeyUsagePurpose::DigitalSignature,
    ];
    p
}

fn pem_to_der(pem: &str) -> Option<Vec<u8>> {
    let body: String = pem.lines().filter(|l| !l.starts_with("-----")).collect();
    base64::engine::general_purpose::STANDARD
        .decode(body.trim())
        .ok()
}

fn write_private(path: &Path, data: &str) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        f.write_all(data.as_bytes())
    }
    #[cfg(not(unix))]
    {
        // %APPDATA% is user-only by default ACL
        std::fs::write(path, data)
    }
}

impl Ca {
    /// Load the CA from `dir`, creating it on first use.
    pub fn load_or_create(dir: &Path) -> std::io::Result<Ca> {
        std::fs::create_dir_all(dir)?;
        let key_path = dir.join("ca.key");
        let cert_path = dir.join("ca.pem");
        let (key, pem) = match (
            std::fs::read_to_string(&key_path),
            std::fs::read_to_string(&cert_path),
        ) {
            (Ok(k), Ok(c)) => (KeyPair::from_pem(&k).map_err(std::io::Error::other)?, c),
            _ => {
                let key = KeyPair::generate().map_err(std::io::Error::other)?;
                let mut p = ca_params();
                let now = std::time::SystemTime::now();
                p.not_before = (now - std::time::Duration::from_secs(86_400)).into();
                p.not_after = (now + std::time::Duration::from_secs(10 * 365 * 86_400)).into();
                let cert = p.self_signed(&key).map_err(std::io::Error::other)?;
                write_private(&key_path, &key.serialize_pem())?;
                std::fs::write(&cert_path, cert.pem())?;
                (key, cert.pem())
            }
        };
        let der = pem_to_der(&pem).ok_or_else(|| std::io::Error::other("bad ca.pem"))?;
        // same DN + same key ⇒ issuer name and authority key id match the
        // stored certificate, so no X.509 parsing is needed
        let issuer = Issuer::new(ca_params(), key);
        let leaf_key = KeyPair::generate().map_err(std::io::Error::other)?;
        let leaf_der = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(leaf_key.serialize_der()));
        let leaf_signer = rustls::crypto::ring::sign::any_supported_type(&leaf_der)
            .map_err(std::io::Error::other)?;
        Ok(Ca {
            issuer,
            pem,
            der,
            path: cert_path,
            leaf_key,
            leaf_signer,
            cache: Mutex::new(HashMap::new()),
        })
    }

    /// SHA-256 of the CA certificate DER, colon-separated hex.
    pub fn fingerprint(&self) -> String {
        let d = ring::digest::digest(&ring::digest::SHA256, &self.der);
        d.as_ref()
            .iter()
            .map(|b| format!("{b:02X}"))
            .collect::<Vec<_>>()
            .join(":")
    }

    pub fn leaf(&self, host: &str) -> Option<Arc<CertifiedKey>> {
        let host = host.trim_end_matches('.').to_ascii_lowercase();
        if let Some(k) = self.cache.lock().unwrap().get(&host) {
            return Some(k.clone());
        }
        let mut p = CertificateParams::new(vec![host.clone()]).ok()?;
        p.distinguished_name = rcgen::DistinguishedName::new();
        p.distinguished_name.push(DnType::CommonName, host.as_str());
        p.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
        p.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        let now = std::time::SystemTime::now();
        p.not_before = (now - std::time::Duration::from_secs(86_400)).into();
        p.not_after = (now + std::time::Duration::from_secs(30 * 86_400)).into();
        let cert = p.signed_by(&self.leaf_key, &self.issuer).ok()?;
        let chain = vec![
            CertificateDer::from(cert.der().to_vec()),
            CertificateDer::from(self.der.clone()),
        ];
        let ck = Arc::new(CertifiedKey::new(chain, self.leaf_signer.clone()));
        let mut cache = self.cache.lock().unwrap();
        if cache.len() >= LEAF_CACHE_MAX {
            cache.clear();
        }
        cache.insert(host, ck.clone());
        Some(ck)
    }
}

/// Picks the leaf by SNI; falls back to the CONNECT host (IP literals and
/// clients that omit SNI).
pub struct Resolver {
    pub ca: Arc<Ca>,
    pub fallback: String,
}

impl std::fmt::Debug for Resolver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Resolver")
    }
}

impl ResolvesServerCert for Resolver {
    fn resolve(&self, hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        self.ca.leaf(hello.server_name().unwrap_or(&self.fallback))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustls::client::danger::ServerCertVerifier;
    use rustls::pki_types::{ServerName, UnixTime};

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "wiretrick-helper-test-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn persists_and_leaf_verifies_against_ca() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let dir = tmpdir("ca");
        let a = Ca::load_or_create(&dir).unwrap();
        let b = Ca::load_or_create(&dir).unwrap();
        assert_eq!(
            a.fingerprint(),
            b.fingerprint(),
            "CA must persist across runs"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join("ca.key"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        // a leaf minted by the RELOADED CA verifies against the stored cert
        let mut roots = rustls::RootCertStore::empty();
        roots.add(CertificateDer::from(a.der.clone())).unwrap();
        let v = rustls::client::WebPkiServerVerifier::builder(Arc::new(roots))
            .build()
            .unwrap();
        for host in ["example.com", "sub.example.test", "127.0.0.1"] {
            let leaf = b.leaf(host).unwrap();
            v.verify_server_cert(
                &leaf.cert[0],
                &leaf.cert[1..],
                &ServerName::try_from(host.to_string()).unwrap(),
                &[],
                UnixTime::now(),
            )
            .unwrap_or_else(|e| panic!("{host}: {e}"));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
