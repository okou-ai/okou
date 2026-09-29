#![cfg(test)]

use std::{sync::Arc, time::Duration};

use rfb_client::{
    AuthenticationStage, ClientCertificateAuthentication, ClientIdentity, Error, TrustRoots,
    VncPassword, authenticate, authenticate_with_client_certificate,
};
use rustls::{
    RootCertStore, ServerConfig,
    pki_types::{CertificateDer, PrivatePkcs8KeyDer},
    server::WebPkiClientVerifier,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    time::{Instant, timeout},
};
use tokio_rustls::TlsAcceptor;

const NAME: &str = "vnc.example.test";
const BANNER: &[u8; 12] = b"RFB 003.008\n";
const CHALLENGE: &[u8; 16] = b"0123456789abcdef";
const RESPONSE: [u8; 16] = [
    0x34, 0x57, 0xe0, 0xfd, 0xf6, 0xe8, 0x42, 0x5e, 0x58, 0xb4, 0xdf, 0x6b, 0x1b, 0xe5, 0x22, 0x13,
];

fn root() -> (
    rcgen::CertificateParams,
    rcgen::KeyPair,
    CertificateDer<'static>,
) {
    let key = rcgen::KeyPair::generate().unwrap();
    let mut params = rcgen::CertificateParams::default();
    params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    params.key_usages = vec![
        rcgen::KeyUsagePurpose::KeyCertSign,
        rcgen::KeyUsagePurpose::DigitalSignature,
    ];
    let der = params.self_signed(&key).unwrap().der().clone();
    (params, key, der)
}

struct Fixture {
    config: Arc<ServerConfig>,
    server_root: CertificateDer<'static>,
    client_certificate: CertificateDer<'static>,
    client_key: Vec<u8>,
}

impl Fixture {
    fn new(tls12: bool, request_client: bool, wrong_client_ca: bool, expired_client: bool) -> Self {
        let (server_params, server_root_key, server_root) = root();
        let server_key = rcgen::KeyPair::generate().unwrap();
        let server_certificate = rcgen::CertificateParams::new(vec![NAME.into()])
            .unwrap()
            .signed_by(
                &server_key,
                &rcgen::Issuer::from_params(&server_params, &server_root_key),
            )
            .unwrap();
        let (client_params, client_root_key, client_root) = root();
        let client_key = rcgen::KeyPair::generate().unwrap();
        let mut client_params_leaf =
            rcgen::CertificateParams::new(vec!["client.example.test".into()]).unwrap();
        client_params_leaf.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ClientAuth];
        if expired_client {
            client_params_leaf.not_before = rcgen::date_time_ymd(2000, 1, 1);
            client_params_leaf.not_after = rcgen::date_time_ymd(2001, 1, 1);
        }
        let client_certificate = client_params_leaf
            .signed_by(
                &client_key,
                &rcgen::Issuer::from_params(&client_params, &client_root_key),
            )
            .unwrap();
        let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
        let versions = if tls12 {
            vec![&rustls::version::TLS12]
        } else {
            vec![&rustls::version::TLS13]
        };
        let builder = ServerConfig::builder_with_provider(Arc::clone(&provider))
            .with_protocol_versions(&versions)
            .unwrap();
        let builder = if request_client {
            let mut roots = RootCertStore::empty();
            let allowed = if wrong_client_ca {
                root().2
            } else {
                client_root
            };
            roots.add(allowed).unwrap();
            let verifier = WebPkiClientVerifier::builder_with_provider(Arc::new(roots), provider)
                .build()
                .unwrap();
            builder.with_client_cert_verifier(verifier)
        } else {
            builder.with_no_client_auth()
        };
        let config = builder
            .with_single_cert(
                vec![server_certificate.der().clone()],
                PrivatePkcs8KeyDer::from(server_key.serialize_der()).into(),
            )
            .unwrap();
        Self {
            config: Arc::new(config),
            server_root,
            client_certificate: client_certificate.der().clone(),
            client_key: client_key.serialize_der(),
        }
    }

    fn identity(&self) -> ClientIdentity {
        ClientIdentity::from_pkcs8_der(
            vec![self.client_certificate.clone()],
            PrivatePkcs8KeyDer::from(self.client_key.clone()),
        )
        .unwrap()
    }

    fn roots(&self) -> TrustRoots {
        TrustRoots::custom(vec![self.server_root.clone()]).unwrap()
    }
}

async fn sockets() -> (TcpStream, TcpStream) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (client, server) = tokio::join!(
        TcpStream::connect(listener.local_addr().unwrap()),
        listener.accept(),
    );
    (client.unwrap(), server.unwrap().0)
}

async fn negotiate(mut server: TcpStream, subtype: u32) -> TcpStream {
    for byte in BANNER {
        server.write_all(&[*byte]).await.unwrap();
    }
    let mut banner = [0; 12];
    server.read_exact(&mut banner).await.unwrap();
    assert_eq!(&banner, BANNER);
    server.write_all(&[3, 1, 2, 19]).await.unwrap();
    assert_eq!(server.read_u8().await.unwrap(), 19);
    server.write_all(&[0, 2]).await.unwrap();
    let mut version = [0; 2];
    server.read_exact(&mut version).await.unwrap();
    assert_eq!(version, [0, 2]);
    server.write_u8(0).await.unwrap();
    server.write_u8(2).await.unwrap();
    server.write_u32(260).await.unwrap();
    server.write_u32(261).await.unwrap();
    assert_eq!(server.read_u32().await.unwrap(), subtype);
    server.write_u8(1).await.unwrap();
    server
}

fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(4)
}

#[tokio::test]
async fn requested_identity_authenticates_exact_subtypes_on_tls12_and_tls13() {
    for tls12 in [false, true] {
        for (subtype, auth) in [
            (260, ClientCertificateAuthentication::None),
            (
                261,
                ClientCertificateAuthentication::VncPassword(
                    VncPassword::new(" secret ".into()).unwrap(),
                ),
            ),
        ] {
            let fixture = Fixture::new(tls12, true, false, false);
            let (client, server) = sockets().await;
            let peer = async {
                let mut stream = TlsAcceptor::from(Arc::clone(&fixture.config))
                    .accept(negotiate(server, subtype).await)
                    .await
                    .unwrap();
                assert!(stream.get_ref().1.peer_certificates().is_some());
                if subtype == 261 {
                    stream.write_all(CHALLENGE).await.unwrap();
                    let mut response = [0; 16];
                    stream.read_exact(&mut response).await.unwrap();
                    assert_eq!(response, RESPONSE);
                }
                stream.write_u32(0).await.unwrap();
                stream.write_u8(0x42).await.unwrap();
                stream.flush().await.unwrap();
                assert_eq!(stream.read_u8().await.unwrap(), 1);
            };
            let caller = async {
                let mut stream = authenticate_with_client_certificate(
                    client,
                    NAME,
                    auth,
                    fixture.roots(),
                    fixture.identity(),
                    deadline(),
                )
                .await
                .unwrap()
                .into_stream();
                assert_eq!(stream.read_u8().await.unwrap(), 0x42);
                stream.write_u8(1).await.unwrap();
                stream.flush().await.unwrap();
            };
            timeout(Duration::from_secs(5), async { tokio::join!(peer, caller) })
                .await
                .unwrap();
        }
    }
}

#[tokio::test]
async fn no_client_certificate_request_is_rejected_before_password_or_result() {
    for auth in [
        ClientCertificateAuthentication::None,
        ClientCertificateAuthentication::VncPassword(VncPassword::new(" secret ".into()).unwrap()),
    ] {
        let subtype = if matches!(auth, ClientCertificateAuthentication::None) {
            260
        } else {
            261
        };
        let fixture = Fixture::new(false, false, false, false);
        let (client, server) = sockets().await;
        let peer = async {
            let mut stream = TlsAcceptor::from(Arc::clone(&fixture.config))
                .accept(negotiate(server, subtype).await)
                .await
                .unwrap();
            let mut byte = [0];
            let read = stream.read(&mut byte).await;
            assert!(
                matches!(read, Ok(0) | Err(_)),
                "must not send inner credentials: {read:?}"
            );
        };
        let caller = async {
            assert!(matches!(
                authenticate_with_client_certificate(
                    client,
                    NAME,
                    auth,
                    fixture.roots(),
                    fixture.identity(),
                    deadline(),
                )
                .await,
                Err(Error::ClientCertificateNotRequested)
            ));
        };
        timeout(Duration::from_secs(5), async { tokio::join!(peer, caller) })
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn invalid_client_and_server_identifications_never_return_a_stream() {
    for (tls12, wrong_client_ca, expired_client, wrong_name, wrong_root) in [
        (false, true, false, false, false),
        (true, true, false, false, false),
        (false, false, true, false, false),
        (false, false, false, true, false),
        (false, false, false, false, true),
    ] {
        let fixture = Fixture::new(tls12, true, wrong_client_ca, expired_client);
        let (client, server) = sockets().await;
        let peer = async {
            let negotiated = negotiate(server, 260).await;
            let _ = TlsAcceptor::from(Arc::clone(&fixture.config))
                .accept(negotiated)
                .await;
        };
        let caller = async {
            let roots = if wrong_root {
                TrustRoots::custom(vec![root().2]).unwrap()
            } else {
                fixture.roots()
            };
            assert!(
                authenticate_with_client_certificate(
                    client,
                    if wrong_name {
                        "wrong.example.test"
                    } else {
                        NAME
                    },
                    ClientCertificateAuthentication::None,
                    roots,
                    fixture.identity(),
                    deadline(),
                )
                .await
                .is_err()
            );
        };
        timeout(Duration::from_secs(5), async { tokio::join!(peer, caller) })
            .await
            .unwrap();
    }
}

#[test]
fn identity_rejects_malformed_oversized_and_mismatched_keys() {
    let fixture = Fixture::new(false, true, false, false);
    let invalid = |chain: Vec<CertificateDer<'static>>, key: Vec<u8>| {
        ClientIdentity::from_pkcs8_der(chain, PrivatePkcs8KeyDer::from(key)).unwrap_err()
    };
    assert!(matches!(
        invalid(vec![], fixture.client_key.clone()),
        Error::InvalidClientIdentity
    ));
    assert!(matches!(
        invalid(vec![fixture.client_certificate.clone()], vec![]),
        Error::InvalidClientIdentity
    ));
    assert!(matches!(
        invalid(
            vec![fixture.client_certificate.clone()],
            vec![0; 16 * 1024 + 1]
        ),
        Error::InvalidClientIdentity
    ));
    assert!(matches!(
        invalid(
            vec![CertificateDer::from(vec![0; 64 * 1024 + 1])],
            fixture.client_key.clone()
        ),
        Error::InvalidClientIdentity
    ));
    assert!(matches!(
        invalid(vec![fixture.client_certificate.clone()], vec![1, 2, 3]),
        Error::InvalidClientIdentity
    ));
    assert!(matches!(
        invalid(
            vec![
                fixture.client_certificate.clone(),
                CertificateDer::from(vec![1, 2, 3])
            ],
            fixture.client_key.clone(),
        ),
        Error::InvalidClientIdentity
    ));
    assert!(matches!(
        invalid(
            vec![fixture.client_certificate.clone()],
            rcgen::KeyPair::generate().unwrap().serialize_der()
        ),
        Error::InvalidClientIdentity
    ));
    assert_eq!(
        format!("{:?}", fixture.identity()),
        "ClientIdentity([REDACTED])"
    );
}

#[tokio::test]
async fn deadline_and_cancellation_drop_the_owned_stream() {
    let fixture = Fixture::new(false, true, false, false);
    let (client, mut server) = sockets().await;
    let err = authenticate_with_client_certificate(
        client,
        NAME,
        ClientCertificateAuthentication::None,
        fixture.roots(),
        fixture.identity(),
        Instant::now() + Duration::from_millis(30),
    )
    .await
    .err()
    .unwrap();
    assert!(matches!(
        err,
        Error::AuthenticationDeadlineExceeded {
            stage: AuthenticationStage::RfbVersion
        }
    ));
    let mut byte = [0];
    assert!(matches!(server.read(&mut byte).await, Ok(0) | Err(_)));

    let (client, mut server) = sockets().await;
    let handle = tokio::spawn(authenticate_with_client_certificate(
        client,
        NAME,
        ClientCertificateAuthentication::None,
        fixture.roots(),
        fixture.identity(),
        deadline(),
    ));
    tokio::task::yield_now().await;
    handle.abort();
    assert!(matches!(handle.await, Err(error) if error.is_cancelled()));
    assert!(matches!(server.read(&mut byte).await, Ok(0) | Err(_)));
}

#[tokio::test]
async fn certificate_free_entry_point_still_connects_to_a_no_request_peer() {
    let fixture = Fixture::new(false, false, false, false);
    let (client, server) = sockets().await;
    let peer = async {
        let mut stream = TlsAcceptor::from(Arc::clone(&fixture.config))
            .accept(negotiate(server, 260).await)
            .await
            .unwrap();
        stream.write_u32(0).await.unwrap();
        stream.flush().await.unwrap();
    };
    let caller = async {
        authenticate(
            client,
            NAME,
            rfb_client::X509Authentication::None,
            fixture.roots(),
            deadline(),
        )
        .await
        .unwrap();
    };
    timeout(Duration::from_secs(5), async { tokio::join!(peer, caller) })
        .await
        .unwrap();
}

#[tokio::test]
async fn bad_vnc_password_does_not_pass_security_result() {
    let fixture = Fixture::new(false, true, false, false);
    let (client, server) = sockets().await;
    let peer = async {
        let mut stream = TlsAcceptor::from(Arc::clone(&fixture.config))
            .accept(negotiate(server, 261).await)
            .await
            .unwrap();
        stream.write_all(CHALLENGE).await.unwrap();
        let mut response = [0; 16];
        stream.read_exact(&mut response).await.unwrap();
        assert_ne!(response, RESPONSE);
        stream.write_u32(1).await.unwrap();
        stream.write_u32(0).await.unwrap();
        stream.flush().await.unwrap();
    };
    let caller = async {
        assert!(matches!(
            authenticate_with_client_certificate(
                client,
                NAME,
                ClientCertificateAuthentication::VncPassword(
                    VncPassword::new("wrong".into()).unwrap()
                ),
                fixture.roots(),
                fixture.identity(),
                deadline(),
            )
            .await,
            Err(Error::AuthenticationFailed)
        ));
    };
    timeout(Duration::from_secs(5), async { tokio::join!(peer, caller) })
        .await
        .unwrap();
}

#[tokio::test]
async fn bad_server_result_does_not_return_a_stream() {
    let fixture = Fixture::new(false, true, false, false);
    let (client, server) = sockets().await;
    let peer = async {
        let mut stream = TlsAcceptor::from(Arc::clone(&fixture.config))
            .accept(negotiate(server, 260).await)
            .await
            .unwrap();
        stream.write_u32(0xffff_ffff).await.unwrap();
        stream.flush().await.unwrap();
    };
    let caller = async {
        assert!(matches!(
            authenticate_with_client_certificate(
                client,
                NAME,
                ClientCertificateAuthentication::None,
                fixture.roots(),
                fixture.identity(),
                deadline()
            )
            .await,
            Err(Error::InvalidAuthenticationResult)
        ));
    };
    timeout(Duration::from_secs(5), async { tokio::join!(peer, caller) })
        .await
        .unwrap();
}

#[tokio::test]
async fn returned_tls_stream_closes_when_dropped() {
    let fixture = Fixture::new(false, true, false, false);
    let (client, server) = sockets().await;
    let peer = async {
        let mut stream = TlsAcceptor::from(Arc::clone(&fixture.config))
            .accept(negotiate(server, 260).await)
            .await
            .unwrap();
        stream.write_u32(0).await.unwrap();
        stream.flush().await.unwrap();
        let mut byte = [0];
        let result = stream.read(&mut byte).await;
        assert!(
            matches!(result, Ok(0) | Err(_)),
            "expected closed TLS stream: {result:?}"
        );
    };
    let caller = async {
        let stream = authenticate_with_client_certificate(
            client,
            NAME,
            ClientCertificateAuthentication::None,
            fixture.roots(),
            fixture.identity(),
            deadline(),
        )
        .await
        .unwrap();
        drop(stream);
    };
    timeout(Duration::from_secs(5), async { tokio::join!(peer, caller) })
        .await
        .unwrap();
}
