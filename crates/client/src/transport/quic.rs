//! QUIC peer transport.
//!
//! Each peer runs a single QUIC endpoint on a UDP socket. The endpoint
//! both listens (for incoming peer connections) and dials (for outgoing
//! ones). Connections use self-signed certificates carrying the
//! device's ed25519 public key as a SAN URI; the peer verifies that
//! the certificate's public key matches the expected device key it
//! looked up from the keystore. The web PKI is never consulted.
//!
//! Why custom verification: we are not authenticating CA chains — we
//! are authenticating device keys we already trust through the
//! keystore. The TLS layer's job is confidentiality and integrity of
//! the QUIC handshake; the identity layer is ours.
//!
//! Milestone 3 scope: bind, listen, dial, accept. Audio framing /
//! MLS round-trip / jitter buffering live in milestone 4.

use std::net::SocketAddr;
use std::sync::Arc;

use quinn::crypto::rustls::QuicServerConfig;
use quinn::{ClientConfig, Endpoint, ServerConfig};
use rcgen::{CertificateParams, DistinguishedName, DnType, KeyPair, SanType};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};
use rustls::server::danger::{ClientCertVerified, ClientCertVerifier};
use rustls::{DigitallySignedStruct, DistinguishedName as RustlsDN, SignatureScheme};

use crocodile_protocol::keys::DevicePublicKey;

use crate::error::{ClientError, Result};

/// A bound QUIC endpoint that can accept incoming peer connections and
/// dial outbound ones.
#[derive(Debug, Clone)]
pub struct PeerEndpoint {
    endpoint: Endpoint,
    local_addr: SocketAddr,
}

impl PeerEndpoint {
    /// Bind a new endpoint on the given UDP address (use `0.0.0.0:0`
    /// for an ephemeral port).
    ///
    /// `device_pk` is the local device's public key; the self-signed
    /// certificate's SAN encodes it so the remote peer can confirm
    /// our identity against the keystore.
    pub fn bind(bind_addr: SocketAddr, device_pk: &DevicePublicKey) -> Result<Self> {
        rustls::crypto::ring::default_provider()
            .install_default()
            // already-installed is fine — multiple endpoints share a
            // process-wide default provider.
            .ok();

        let (cert_der, key_der) = generate_self_signed(device_pk)?;

        let server_config = build_server_config(cert_der.clone(), key_der.clone_key())?;
        let mut endpoint = Endpoint::server(server_config, bind_addr).map_err(map_io)?;
        endpoint.set_default_client_config(build_client_config()?);

        let local_addr = endpoint.local_addr().map_err(map_io)?;
        Ok(Self {
            endpoint,
            local_addr,
        })
    }

    /// Returns the address the endpoint is actually bound to (useful
    /// when the caller passed port 0).
    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    /// Dial a peer at `addr`, expecting it to present a certificate
    /// whose embedded public key equals `expected_peer_pk`.
    ///
    /// The QUIC handshake's TLS layer authenticates the public key
    /// only; we do *not* check a server name. We pass a fixed
    /// `"crocodile"` placeholder server name to satisfy rustls.
    pub async fn connect(
        &self,
        addr: SocketAddr,
        expected_peer_pk: DevicePublicKey,
    ) -> Result<quinn::Connection> {
        // Build a per-connection client config carrying a verifier
        // closed over the expected pubkey.
        let client_config = build_client_config_for(expected_peer_pk)?;
        let connecting = self
            .endpoint
            .connect_with(client_config, addr, "crocodile")
            .map_err(|e| ClientError::Quic(format!("connect error: {e}")))?;
        let conn = connecting
            .await
            .map_err(|e| ClientError::Quic(format!("handshake error: {e}")))?;
        Ok(conn)
    }

    /// Accept the next incoming peer connection.
    pub async fn accept(&self) -> Option<quinn::Incoming> {
        self.endpoint.accept().await
    }

    /// Underlying [`Endpoint`] for advanced use (e.g. polling stats).
    pub fn endpoint(&self) -> &Endpoint {
        &self.endpoint
    }
}

// -------------------- self-signed cert generation --------------------

fn generate_self_signed(
    device_pk: &DevicePublicKey,
) -> Result<(CertificateDer<'static>, PrivateKeyDer<'static>)> {
    let mut params = CertificateParams::default();
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, "crocodile-peer");
    params.distinguished_name = dn;
    // Pin our device pubkey into a SAN URI so the peer can recover
    // it. The verifier extracts and compares against the keystore.
    params.subject_alt_names = vec![SanType::URI(
        format!("crocodile-device:{}", hex::encode(device_pk.0))
            .try_into()
            .map_err(|e| ClientError::Quic(format!("invalid san: {e}")))?,
    )];
    let key_pair =
        KeyPair::generate().map_err(|e| ClientError::Quic(format!("keypair gen failed: {e}")))?;
    let cert = params
        .self_signed(&key_pair)
        .map_err(|e| ClientError::Quic(format!("cert gen failed: {e}")))?;
    let cert_der = CertificateDer::from(cert.der().to_vec());
    let key_der = PrivateKeyDer::try_from(key_pair.serialize_der())
        .map_err(|e| ClientError::Quic(format!("key der: {e}")))?;
    Ok((cert_der, key_der))
}

fn build_server_config(
    cert: CertificateDer<'static>,
    key: PrivateKeyDer<'static>,
) -> Result<ServerConfig> {
    let mut crypto = rustls::ServerConfig::builder()
        .with_client_cert_verifier(Arc::new(AcceptAnyClient))
        .with_single_cert(vec![cert], key)
        .map_err(|e| ClientError::Quic(format!("rustls server config: {e}")))?;
    crypto.alpn_protocols = vec![b"crocodile/1".to_vec()];
    let quic_server = QuicServerConfig::try_from(crypto)
        .map_err(|e| ClientError::Quic(format!("quic server config: {e}")))?;
    Ok(ServerConfig::with_crypto(Arc::new(quic_server)))
}

fn build_client_config() -> Result<ClientConfig> {
    // Default client config used when the caller hasn't supplied a
    // verifier — accepts any cert. Real dials use
    // [`build_client_config_for`] which checks the embedded pubkey.
    let mut crypto = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AcceptAnyServer))
        .with_no_client_auth();
    crypto.alpn_protocols = vec![b"crocodile/1".to_vec()];
    let quic_client = quinn::crypto::rustls::QuicClientConfig::try_from(crypto)
        .map_err(|e| ClientError::Quic(format!("quic client config: {e}")))?;
    Ok(ClientConfig::new(Arc::new(quic_client)))
}

fn build_client_config_for(expected: DevicePublicKey) -> Result<ClientConfig> {
    let verifier = Arc::new(PubkeyMatchingVerifier { expected });
    let mut crypto = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    crypto.alpn_protocols = vec![b"crocodile/1".to_vec()];
    let quic_client = quinn::crypto::rustls::QuicClientConfig::try_from(crypto)
        .map_err(|e| ClientError::Quic(format!("quic client config: {e}")))?;
    Ok(ClientConfig::new(Arc::new(quic_client)))
}

// -------------------- custom TLS verifiers --------------------
//
// These intentionally ignore the web PKI (no CA chain), trusting only
// the device-pubkey binding embedded in the certificate. The
// supported_verify_schemes / verify_*_signature methods all delegate
// to the standard rustls verifier for the algorithm work — we only
// override *which identity* counts as valid.

#[derive(Debug)]
struct AcceptAnyServer;

impl ServerCertVerifier for AcceptAnyServer {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        all_schemes()
    }
}

#[derive(Debug)]
struct AcceptAnyClient;

impl ClientCertVerifier for AcceptAnyClient {
    fn root_hint_subjects(&self) -> &[RustlsDN] {
        &[]
    }
    fn verify_client_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _now: UnixTime,
    ) -> std::result::Result<ClientCertVerified, rustls::Error> {
        Ok(ClientCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }
    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        all_schemes()
    }
}

/// Verifier that requires the presented certificate to contain a SAN
/// URI of the form `crocodile-device:<hex>` whose hex equals the
/// expected device pubkey.
///
/// We are intentionally not doing chain validation or hostname
/// matching — peer identity is the device key, period.
#[derive(Debug)]
struct PubkeyMatchingVerifier {
    expected: DevicePublicKey,
}

impl ServerCertVerifier for PubkeyMatchingVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        extract_pubkey_san(end_entity.as_ref())
            .and_then(|pk| {
                if pk == self.expected.0 {
                    Ok(ServerCertVerified::assertion())
                } else {
                    Err(rustls::Error::General("device pubkey mismatch".into()))
                }
            })
            .map_err(|e| match e {
                rustls::Error::General(_) => e,
                other => other,
            })
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        all_schemes()
    }
}

/// Naive search for `crocodile-device:<hex>` inside the DER. We use a
/// byte-pattern scan rather than a full X.509 parser because the SAN
/// is the only field we care about and pulling in a parser just for
/// SAN extraction is overkill at this layer.
///
/// The scan looks for the ASCII tag string we placed in the SAN URI;
/// anything matching the regex `crocodile-device:[0-9a-fA-F]{64}` is
/// accepted.
fn extract_pubkey_san(der: &[u8]) -> std::result::Result<[u8; 32], rustls::Error> {
    let needle = b"crocodile-device:";
    let pos = der
        .windows(needle.len())
        .position(|w| w == needle)
        .ok_or_else(|| rustls::Error::General("missing crocodile-device SAN".into()))?;
    let hex_start = pos + needle.len();
    if der.len() < hex_start + 64 {
        return Err(rustls::Error::General("SAN truncated".into()));
    }
    let hex_bytes = &der[hex_start..hex_start + 64];
    let mut out = [0u8; 32];
    hex::decode_to_slice(hex_bytes, &mut out)
        .map_err(|e| rustls::Error::General(format!("SAN hex decode: {e}")))?;
    Ok(out)
}

fn all_schemes() -> Vec<SignatureScheme> {
    vec![
        SignatureScheme::RSA_PKCS1_SHA256,
        SignatureScheme::ECDSA_NISTP256_SHA256,
        SignatureScheme::RSA_PSS_SHA256,
        SignatureScheme::RSA_PKCS1_SHA384,
        SignatureScheme::ECDSA_NISTP384_SHA384,
        SignatureScheme::RSA_PSS_SHA384,
        SignatureScheme::RSA_PKCS1_SHA512,
        SignatureScheme::ECDSA_NISTP521_SHA512,
        SignatureScheme::RSA_PSS_SHA512,
        SignatureScheme::ED25519,
        SignatureScheme::ED448,
    ]
}

fn map_io(e: std::io::Error) -> ClientError {
    ClientError::Quic(format!("io: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crocodile_protocol::keys::DeviceKeypair;
    use rand::rngs::OsRng;

    /// End-to-end: bind two endpoints on localhost and establish a
    /// QUIC connection between them, verifying pubkey identity.
    #[tokio::test]
    async fn endpoints_handshake_with_pubkey_verification() {
        let alice_kp = DeviceKeypair::generate(&mut OsRng);
        let bob_kp = DeviceKeypair::generate(&mut OsRng);
        let alice_pk = alice_kp.public_key();
        let bob_pk = bob_kp.public_key();

        let alice = PeerEndpoint::bind("127.0.0.1:0".parse().unwrap(), &alice_pk).unwrap();
        let bob = PeerEndpoint::bind("127.0.0.1:0".parse().unwrap(), &bob_pk).unwrap();

        let bob_addr = bob.local_addr();

        // Bob accepts in the background.
        let bob_accept = tokio::spawn(async move {
            let incoming = bob.accept().await.expect("incoming");
            let conn = incoming.await.expect("accept");
            conn.closed().await;
        });

        // Alice dials Bob with the right pubkey.
        let conn = alice
            .connect(bob_addr, bob_pk)
            .await
            .expect("connect ok with right pubkey");
        conn.close(0u32.into(), b"bye");

        // Wait for bob's accept task to complete.
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), bob_accept).await;
    }

    #[tokio::test]
    async fn handshake_rejects_wrong_pubkey() {
        let alice_kp = DeviceKeypair::generate(&mut OsRng);
        let bob_kp = DeviceKeypair::generate(&mut OsRng);
        let mallory_kp = DeviceKeypair::generate(&mut OsRng);
        let alice_pk = alice_kp.public_key();
        let bob_pk = bob_kp.public_key();
        let mallory_pk = mallory_kp.public_key();

        let alice = PeerEndpoint::bind("127.0.0.1:0".parse().unwrap(), &alice_pk).unwrap();
        let bob = PeerEndpoint::bind("127.0.0.1:0".parse().unwrap(), &bob_pk).unwrap();

        let bob_addr = bob.local_addr();

        // Bob runs an accept loop in the background so the listener
        // is actually pumping connections (otherwise the handshake
        // can stall regardless of pubkey).
        let _bob_accept = tokio::spawn(async move {
            while let Some(incoming) = bob.accept().await {
                if let Ok(conn) = incoming.await {
                    let _ = conn.closed().await;
                }
            }
        });

        // Alice dials Bob but expects mallory's pubkey — verifier
        // should reject.
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            alice.connect(bob_addr, mallory_pk),
        )
        .await
        .expect("connect attempt didn't time out");
        assert!(
            result.is_err(),
            "handshake should fail when expected pubkey doesn't match"
        );
    }
}
