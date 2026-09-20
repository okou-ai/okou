#![cfg(test)]

use std::{future::Future, io, sync::Arc, time::Duration};

use rfb_client::{
    AuthenticationStage, Error, PlainCredentials, TrustRoots, VncPassword, X509Authentication,
    authenticate,
};
use rustls::{ServerConfig, pki_types::CertificateDer, pki_types::PrivatePkcs8KeyDer};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    time::{Instant, timeout},
};
use tokio_rustls::{TlsAcceptor, server::TlsStream};

const BANNER: &[u8; 12] = b"RFB 003.008\n";
const NAME: &str = "vnc.example.test";
const CHALLENGE: &[u8; 16] = b"0123456789abcdef";
// Independent OpenSSL DES-ECB vector for password " secret ":
// key 04cea6c64ea62e04, plaintext 30313233343536373839616263646566.
const RESPONSE: [u8; 16] = [
    0x34, 0x57, 0xe0, 0xfd, 0xf6, 0xe8, 0x42, 0x5e, 0x58, 0xb4, 0xdf, 0x6b, 0x1b, 0xe5, 0x22, 0x13,
];

fn password() -> VncPassword {
    VncPassword::new(" secret ".to_owned()).unwrap()
}

fn authentication() -> X509Authentication {
    X509Authentication::VncPassword(password())
}

fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(5)
}

async fn bounded<T>(future: impl Future<Output = T>) -> T {
    timeout(Duration::from_secs(5), future).await.unwrap()
}

async fn sockets() -> (TcpStream, TcpStream) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (client, server) = tokio::join!(
        TcpStream::connect(listener.local_addr().unwrap()),
        listener.accept(),
    );
    let client = client.unwrap();
    let server = server.unwrap().0;
    client.set_nodelay(true).unwrap();
    server.set_nodelay(true).unwrap();
    (client, server)
}

struct Certificate {
    config: Arc<ServerConfig>,
    der: CertificateDer<'static>,
}

impl Certificate {
    fn new(name: &str, expired: bool, tls12_only: bool) -> Self {
        let key = rcgen::KeyPair::generate().unwrap();
        let mut params = rcgen::CertificateParams::new(vec![name.to_owned()]).unwrap();
        if expired {
            params.not_before = rcgen::date_time_ymd(2000, 1, 1);
            params.not_after = rcgen::date_time_ymd(2001, 1, 1);
        }
        let cert = params.self_signed(&key).unwrap();
        let versions = if tls12_only {
            vec![&rustls::version::TLS12]
        } else {
            vec![&rustls::version::TLS13, &rustls::version::TLS12]
        };
        let config = ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::aws_lc_rs::default_provider(),
        ))
        .with_protocol_versions(&versions)
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![cert.der().clone()],
            PrivatePkcs8KeyDer::from(key.serialize_der()).into(),
        )
        .unwrap();
        Self {
            config: Arc::new(config),
            der: cert.der().clone(),
        }
    }

    fn roots(&self) -> TrustRoots {
        TrustRoots::custom(vec![self.der.clone()]).unwrap()
    }
}

async fn negotiate(server: TcpStream) -> TcpStream {
    negotiate_subtype(server, 261).await
}

async fn negotiate_subtype(mut server: TcpStream, subtype: u32) -> TcpStream {
    server.write_all(BANNER).await.unwrap();
    let mut version = [0; 12];
    server.read_exact(&mut version).await.unwrap();
    assert_eq!(&version, BANNER);
    // None, plain VncAuth and an unknown type must not defeat secure selection.
    server.write_all(&[4, 1, 2, 200, 19]).await.unwrap();
    assert_eq!(server.read_u8().await.unwrap(), 19);
    server.write_all(&[0, 2]).await.unwrap();
    let mut version = [0; 2];
    server.read_exact(&mut version).await.unwrap();
    assert_eq!(version, [0, 2]);
    server.write_all(&[0, 5]).await.unwrap();
    for offered in [258, 260, 261, 262, 0xffff_ffff] {
        server.write_u32(offered).await.unwrap();
    }
    assert_eq!(server.read_u32().await.unwrap(), subtype);
    server.write_u8(1).await.unwrap();
    server
}

async fn secure(server: TcpStream, config: Arc<ServerConfig>) -> TlsStream<TcpStream> {
    secure_subtype(server, config, 261).await
}

async fn secure_subtype(
    server: TcpStream,
    config: Arc<ServerConfig>,
    subtype: u32,
) -> TlsStream<TcpStream> {
    TlsAcceptor::from(config)
        .accept(negotiate_subtype(server, subtype).await)
        .await
        .unwrap()
}

async fn challenge(server: &mut TlsStream<TcpStream>) {
    server.write_all(CHALLENGE).await.unwrap();
    server.flush().await.unwrap();
    let mut response = [0; 16];
    server.read_exact(&mut response).await.unwrap();
    assert_eq!(response, RESPONSE);
}

async fn disconnected<S: AsyncRead + Unpin>(stream: &mut S) {
    let mut byte = [0];
    match bounded(stream.read(&mut byte)).await {
        Ok(0) => {}
        Err(error) => assert!(
            matches!(
                error.kind(),
                io::ErrorKind::UnexpectedEof
                    | io::ErrorKind::ConnectionReset
                    | io::ErrorKind::ConnectionAborted
            ),
            "{error:?}"
        ),
        result => panic!("expected a closed peer, got {result:?}"),
    }
}

#[tokio::test]
async fn authenticates_and_transfers_only_the_post_security_result_stream() {
    for (name, tls12_only) in [(NAME, false), (NAME, true), ("127.0.0.1", false)] {
        let cert = Certificate::new(name, false, tls12_only);
        let roots = cert.roots();
        let (client, server) = sockets().await;
        let peer = async move {
            let mut server = secure(server, cert.config).await;
            challenge(&mut server).await;
            server.write_u32(0).await.unwrap();
            // This byte represents the beginning of ServerInit, and must not be
            // consumed by the authentication layer.
            server.write_u8(0x42).await.unwrap();
            server.flush().await.unwrap();
            // ClientInit is solely the caller's responsibility.
            assert_eq!(server.read_u8().await.unwrap(), 1);
            disconnected(&mut server).await;
        };
        let caller = async {
            let mut stream = authenticate(client, name, authentication(), roots, deadline())
                .await
                .unwrap()
                .into_stream();
            assert_eq!(stream.read_u8().await.unwrap(), 0x42);
            stream.write_u8(1).await.unwrap();
            stream.flush().await.unwrap();
        };
        bounded(async { tokio::join!(peer, caller) }).await;
    }
}

#[tokio::test]
async fn authenticates_x509_none_without_inner_credentials() {
    let cert = Certificate::new(NAME, false, false);
    let roots = cert.roots();
    let (client, server) = sockets().await;
    let peer = async move {
        let mut server = secure_subtype(server, cert.config, 260).await;
        // Fragment the result to exercise exact asynchronous framing.
        for byte in 0_u32.to_be_bytes() {
            server.write_u8(byte).await.unwrap();
            server.flush().await.unwrap();
        }
        server.write_u8(0x42).await.unwrap();
        server.flush().await.unwrap();
        assert_eq!(server.read_u8().await.unwrap(), 1);
        disconnected(&mut server).await;
    };
    let caller = async {
        let mut stream = authenticate(client, NAME, X509Authentication::None, roots, deadline())
            .await
            .unwrap()
            .into_stream();
        assert_eq!(stream.read_u8().await.unwrap(), 0x42);
        stream.write_u8(1).await.unwrap();
        stream.flush().await.unwrap();
    };
    bounded(async { tokio::join!(peer, caller) }).await;
}

#[tokio::test]
async fn authenticates_x509_plain_with_exact_utf8_bytes() {
    let cert = Certificate::new(NAME, false, false);
    let roots = cert.roots();
    let (client, server) = sockets().await;
    let peer = async move {
        let mut server = secure_subtype(server, cert.config, 262).await;
        assert_eq!(server.read_u32().await.unwrap(), 8);
        assert_eq!(server.read_u32().await.unwrap(), 10);
        let mut username = [0; 8];
        let mut password = [0; 10];
        server.read_exact(&mut username).await.unwrap();
        server.read_exact(&mut password).await.unwrap();
        assert_eq!(&username, " user界".as_bytes());
        assert_eq!(&password, " päss 界".as_bytes());
        server.write_u32(0).await.unwrap();
        server.write_u8(0x42).await.unwrap();
        server.flush().await.unwrap();
        assert_eq!(server.read_u8().await.unwrap(), 1);
        disconnected(&mut server).await;
    };
    let caller = async {
        let credentials =
            PlainCredentials::new(" user界".to_owned(), " päss 界".to_owned()).unwrap();
        let mut stream = authenticate(
            client,
            NAME,
            X509Authentication::Plain(credentials),
            roots,
            deadline(),
        )
        .await
        .unwrap()
        .into_stream();
        assert_eq!(stream.read_u8().await.unwrap(), 0x42);
        stream.write_u8(1).await.unwrap();
        stream.flush().await.unwrap();
    };
    bounded(async { tokio::join!(peer, caller) }).await;
}

#[tokio::test]
async fn rejects_certificate_failures_without_a_password_response() {
    for case in [
        "untrusted",
        "wrong-name",
        "wrong-ip",
        "expired",
        "public-roots",
    ] {
        let cert = Certificate::new(NAME, case == "expired", false);
        let roots = match case {
            "untrusted" => Certificate::new(NAME, false, false).roots(),
            "public-roots" => TrustRoots::public_roots(),
            _ => cert.roots(),
        };
        let name = match case {
            "wrong-name" => "another.example.test",
            "wrong-ip" => "127.0.0.1",
            _ => NAME,
        };
        let (client, server) = sockets().await;
        let peer = async move {
            let result = TlsAcceptor::from(cert.config)
                .accept(negotiate(server).await)
                .await;
            // The real TLS server never reaches an authenticated RFB stream, so
            // it cannot receive a VNC password response.
            assert!(result.is_err(), "accepted {case}");
        };
        let caller = async {
            let result = authenticate(client, name, authentication(), roots, deadline()).await;
            assert!(matches!(result, Err(Error::Tls(_))), "{case}");
        };
        bounded(async { tokio::join!(peer, caller) }).await;
    }
}

#[tokio::test]
async fn rejects_certificate_failure_before_plain_credentials() {
    let cert = Certificate::new(NAME, false, false);
    let roots = cert.roots();
    let (client, server) = sockets().await;
    let peer = async move {
        let result = TlsAcceptor::from(cert.config)
            .accept(negotiate_subtype(server, 262).await)
            .await;
        assert!(result.is_err());
    };
    let caller = async {
        let credentials =
            PlainCredentials::new("operator".to_owned(), "top secret".to_owned()).unwrap();
        let result = authenticate(
            client,
            "another.example.test",
            X509Authentication::Plain(credentials),
            roots,
            deadline(),
        )
        .await;
        assert!(matches!(result, Err(Error::Tls(_))));
    };
    bounded(async { tokio::join!(peer, caller) }).await;
}

#[test]
fn validates_and_redacts_passwords_without_truncation() {
    for value in ["", "ninebytes", "密码", "secret\n", "\0", "\u{7f}"] {
        assert!(matches!(
            VncPassword::new(value.to_owned()),
            Err(Error::InvalidPassword)
        ));
    }
    for value in [" ", "12345678", " secret "] {
        let password = VncPassword::new(value.to_owned()).unwrap();
        assert_eq!(format!("{password:?}"), "VncPassword([REDACTED])");
    }
}

#[test]
fn validates_and_redacts_plain_credentials_without_normalization() {
    for username in [String::new(), "bad\0name".to_owned(), "a".repeat(1024)] {
        assert!(matches!(
            PlainCredentials::new(username, "password".to_owned()),
            Err(Error::InvalidPlainUsername)
        ));
    }
    for password in [String::new(), "bad\0password".to_owned(), "a".repeat(1024)] {
        assert!(matches!(
            PlainCredentials::new("username".to_owned(), password),
            Err(Error::InvalidPlainPassword)
        ));
    }
    let credentials = PlainCredentials::new("界".repeat(341), " pass word ".to_owned()).unwrap();
    assert_eq!(format!("{credentials:?}"), "PlainCredentials([REDACTED])");
    let authentication = X509Authentication::Plain(credentials);
    let debug = format!("{authentication:?}");
    assert_eq!(debug, "X509Authentication::Plain([REDACTED])");
    assert!(!debug.contains("pass word"));
}

#[test]
fn rejects_empty_invalid_or_oversized_custom_trust() {
    let cert = Certificate::new(NAME, false, false);
    for certificates in [
        vec![],
        vec![CertificateDer::from(vec![0; 10])],
        vec![CertificateDer::from(vec![0; 65_537])],
        vec![cert.der; 9],
    ] {
        assert!(matches!(
            TrustRoots::custom(certificates),
            Err(Error::InvalidTrustRoots)
        ));
    }
}

fn before_vencrypt() -> Vec<u8> {
    let mut bytes = BANNER.to_vec();
    bytes.extend([1, 19]);
    bytes
}

fn before_subtypes() -> Vec<u8> {
    let mut bytes = before_vencrypt();
    bytes.extend([0, 2, 0]);
    bytes
}

fn before_tls_ack(subtype: u32) -> Vec<u8> {
    let mut bytes = before_subtypes();
    bytes.push(1);
    bytes.extend(subtype.to_be_bytes());
    bytes
}

async fn rejected_plaintext_with(
    authentication: X509Authentication,
    payload: Vec<u8>,
    truncated: bool,
) -> Error {
    let (client, mut server) = sockets().await;
    let peer = async move {
        server.write_all(&payload).await.unwrap();
        if truncated {
            server.shutdown().await.unwrap();
        }
        // A bounded observer of all client negotiation bytes and eventual EOF.
        let mut received = Vec::new();
        server.take(64).read_to_end(&mut received).await.unwrap();
        assert!(received.len() < 64);
    };
    let caller = authenticate(
        client,
        NAME,
        authentication,
        TrustRoots::public_roots(),
        deadline(),
    );
    let (_, result) = bounded(async { tokio::join!(peer, caller) }).await;
    match result {
        Err(error) => error,
        Ok(_) => panic!("accepted malformed negotiation"),
    }
}

async fn rejected_plaintext(payload: Vec<u8>, truncated: bool) -> Error {
    rejected_plaintext_with(authentication(), payload, truncated).await
}

#[tokio::test]
async fn rejects_unsupported_versions_and_insecure_security_lists() {
    for banner in [b"RFB 003.003\n", b"RFB 003.007\n", b"RFB garbage\n"] {
        assert!(matches!(
            rejected_plaintext(banner.to_vec(), false).await,
            Error::UnsupportedRfbVersion
        ));
    }
    for types in [vec![1], vec![2], vec![1, 2, 18, 255]] {
        let mut bytes = BANNER.to_vec();
        bytes.push(types.len() as u8);
        bytes.extend(types);
        assert!(matches!(
            rejected_plaintext(bytes, false).await,
            Error::UnsupportedSecurity
        ));
    }
    for version in [[0, 1], [1, 0]] {
        let mut bytes = before_vencrypt();
        bytes.extend(version);
        assert!(matches!(
            rejected_plaintext(bytes, false).await,
            Error::UnsupportedSecurity
        ));
    }
    for subtypes in [vec![], vec![1, 2, 257, 258, 260, 262, u32::MAX]] {
        let mut bytes = before_subtypes();
        bytes.push(subtypes.len() as u8);
        for subtype in subtypes {
            bytes.extend(subtype.to_be_bytes());
        }
        assert!(matches!(
            rejected_plaintext(bytes, false).await,
            Error::UnsupportedSecurity
        ));
    }
}

#[tokio::test]
async fn every_policy_rejects_other_x509_subtypes_without_downgrade() {
    for (authentication, offered) in [
        (X509Authentication::None, [261_u32, 262]),
        (authentication(), [260, 262]),
        (
            X509Authentication::Plain(
                PlainCredentials::new("operator".to_owned(), "password".to_owned()).unwrap(),
            ),
            [260, 261],
        ),
    ] {
        let mut bytes = before_subtypes();
        bytes.push(offered.len() as u8);
        for subtype in offered {
            bytes.extend(subtype.to_be_bytes());
        }
        assert!(matches!(
            rejected_plaintext_with(authentication, bytes, false).await,
            Error::UnsupportedSecurity
        ));
    }
}

#[tokio::test]
async fn requires_the_distinct_version_and_subtype_acknowledgements() {
    for ack in [1, 2, 255] {
        let mut bytes = before_vencrypt();
        bytes.extend([0, 2, ack]);
        assert!(matches!(
            rejected_plaintext(bytes, false).await,
            Error::NegotiationRejected
        ));
    }
    for ack in [0, 2, 255] {
        let mut bytes = before_tls_ack(261);
        bytes.push(ack);
        assert!(matches!(
            rejected_plaintext(bytes, false).await,
            Error::NegotiationRejected
        ));
    }
}

#[tokio::test]
async fn bounds_failure_reasons_and_does_not_wait_for_eof_or_echo_text() {
    for length in [0_u32, 17, 4096, 4097, u32::MAX] {
        let mut bytes = BANNER.to_vec();
        bytes.push(0);
        bytes.extend(length.to_be_bytes());
        if length <= 4096 {
            bytes.extend(vec![b'!'; length as usize]);
        }
        let error = rejected_plaintext(bytes, false).await;
        if length <= 4096 {
            assert!(matches!(error, Error::ServerRejected));
        } else {
            assert!(matches!(error, Error::RemoteDataTooLarge));
        }
        assert!(!format!("{error:?}").contains('!'));
    }
}

#[tokio::test]
async fn rejects_truncated_messages_and_closes_the_socket() {
    let complete = before_tls_ack(261);
    // Every incomplete prefix up to the TLS boundary must terminate on EOF.
    for length in 0..complete.len() {
        assert!(matches!(
            rejected_plaintext(complete[..length].to_vec(), true).await,
            Error::Io(_)
        ));
    }
    let mut bytes = BANNER.to_vec();
    bytes.push(0);
    bytes.extend(10_u32.to_be_bytes());
    bytes.extend(b"short");
    assert!(matches!(
        rejected_plaintext(bytes, true).await,
        Error::Io(_)
    ));
}

#[tokio::test]
async fn safely_handles_failed_and_unknown_authentication_results() {
    for (result, length) in [(1_u32, 21_u32), (1, 4097), (2, 0), (u32::MAX, 0)] {
        let cert = Certificate::new(NAME, false, false);
        let roots = cert.roots();
        let (client, server) = sockets().await;
        let peer = async move {
            let mut server = secure(server, cert.config).await;
            challenge(&mut server).await;
            server.write_u32(result).await.unwrap();
            if result == 1 {
                server.write_u32(length).await.unwrap();
                if length <= 4096 {
                    server.write_all(b"secret echoed by peer").await.unwrap();
                }
            }
            server.flush().await.unwrap();
            disconnected(&mut server).await;
        };
        let caller = async {
            let error = match authenticate(client, NAME, authentication(), roots, deadline()).await
            {
                Err(error) => error,
                Ok(_) => panic!("accepted failed authentication"),
            };
            match (result, length) {
                (1, 21) => assert!(matches!(error, Error::AuthenticationFailed)),
                (1, 4097) => assert!(matches!(error, Error::RemoteDataTooLarge)),
                _ => assert!(matches!(error, Error::InvalidAuthenticationResult)),
            }
            assert!(!format!("{error:?} {error}").contains("secret"));
        };
        bounded(async { tokio::join!(peer, caller) }).await;
    }
}

#[tokio::test]
async fn x509_none_and_plain_share_bounded_failure_results() {
    for (subtype, authentication) in [
        (260, X509Authentication::None),
        (
            262,
            X509Authentication::Plain(
                PlainCredentials::new("operator".to_owned(), "password".to_owned()).unwrap(),
            ),
        ),
    ] {
        let cert = Certificate::new(NAME, false, false);
        let roots = cert.roots();
        let (client, server) = sockets().await;
        let peer = async move {
            let mut server = secure_subtype(server, cert.config, subtype).await;
            if subtype == 262 {
                let username_length = server.read_u32().await.unwrap();
                let password_length = server.read_u32().await.unwrap();
                assert_eq!((username_length, password_length), (8, 8));
                let mut credentials = vec![0; (username_length + password_length) as usize];
                server.read_exact(&mut credentials).await.unwrap();
                assert_eq!(&credentials, b"operatorpassword");
            }
            server.write_u32(1).await.unwrap();
            server.write_u32(18).await.unwrap();
            server.write_all(b"peer secret reason").await.unwrap();
            server.flush().await.unwrap();
            disconnected(&mut server).await;
        };
        let caller = async {
            let error = match authenticate(client, NAME, authentication, roots, deadline()).await {
                Err(error) => error,
                Ok(_) => panic!("accepted failed authentication"),
            };
            assert!(matches!(error, Error::AuthenticationFailed));
            assert!(!format!("{error:?} {error}").contains("peer secret"));
        };
        bounded(async { tokio::join!(peer, caller) }).await;
    }
}

#[tokio::test]
async fn an_expired_deadline_or_invalid_name_closes_before_network_writes() {
    for invalid_name in [false, true] {
        let (client, mut server) = sockets().await;
        let name = if invalid_name { "bad name" } else { NAME };
        let end = if invalid_name {
            deadline()
        } else {
            Instant::now()
        };
        let result = authenticate(
            client,
            name,
            authentication(),
            TrustRoots::public_roots(),
            end,
        )
        .await;
        if invalid_name {
            assert!(matches!(result, Err(Error::InvalidServerName)));
        } else {
            assert!(matches!(
                result,
                Err(Error::AuthenticationDeadlineExceeded {
                    stage: AuthenticationStage::RfbVersion
                })
            ));
        }
        disconnected(&mut server).await;
    }
}

#[tokio::test]
async fn a_pre_banner_stall_reports_the_rfb_version_stage_and_disconnects() {
    let (client, mut server) = sockets().await;
    let result = authenticate(
        client,
        NAME,
        authentication(),
        TrustRoots::public_roots(),
        Instant::now() + Duration::from_millis(20),
    )
    .await;
    assert!(matches!(
        result,
        Err(Error::AuthenticationDeadlineExceeded {
            stage: AuthenticationStage::RfbVersion
        })
    ));
    disconnected(&mut server).await;
}

#[tokio::test]
async fn a_security_negotiation_stall_reports_its_stage_and_disconnects() {
    let (client, mut server) = sockets().await;
    let peer = async move {
        server.write_all(BANNER).await.unwrap();
        server.flush().await.unwrap();
        let mut version = [0; 12];
        server.read_exact(&mut version).await.unwrap();
        assert_eq!(&version, BANNER);
        disconnected(&mut server).await;
    };
    let caller = authenticate(
        client,
        NAME,
        authentication(),
        TrustRoots::public_roots(),
        Instant::now() + Duration::from_secs(1),
    );
    let ((), result) = bounded(async { tokio::join!(peer, caller) }).await;
    assert!(matches!(
        result,
        Err(Error::AuthenticationDeadlineExceeded {
            stage: AuthenticationStage::SecurityNegotiation
        })
    ));
}

#[tokio::test]
async fn a_tls_stall_reports_its_stage_and_disconnects() {
    let (client, server) = sockets().await;
    let peer = async move {
        let server = negotiate(server).await;
        let mut tls_bytes = Vec::new();
        bounded(server.take(64 * 1024).read_to_end(&mut tls_bytes))
            .await
            .unwrap();
        assert!(!tls_bytes.is_empty());
        assert!(tls_bytes.len() < 64 * 1024);
    };
    let caller = authenticate(
        client,
        NAME,
        authentication(),
        TrustRoots::public_roots(),
        Instant::now() + Duration::from_secs(1),
    );
    let ((), result) = bounded(async { tokio::join!(peer, caller) }).await;
    assert!(matches!(
        result,
        Err(Error::AuthenticationDeadlineExceeded {
            stage: AuthenticationStage::TlsHandshake
        })
    ));
}

#[tokio::test]
async fn a_vnc_authentication_stall_reports_its_stage_and_disconnects() {
    let cert = Certificate::new(NAME, false, false);
    let roots = cert.roots();
    let (client, server) = sockets().await;
    let peer = async move {
        let mut server = secure(server, cert.config).await;
        disconnected(&mut server).await;
    };
    let caller = authenticate(
        client,
        NAME,
        authentication(),
        roots,
        Instant::now() + Duration::from_secs(1),
    );
    let ((), result) = bounded(async { tokio::join!(peer, caller) }).await;
    assert!(matches!(
        result,
        Err(Error::AuthenticationDeadlineExceeded {
            stage: AuthenticationStage::VncAuthentication
        })
    ));
}

async fn assert_x509_authentication_stall(
    authentication: X509Authentication,
    subtype: u32,
    expected_stage: AuthenticationStage,
) {
    let cert = Certificate::new(NAME, false, false);
    let roots = cert.roots();
    let (client, server) = sockets().await;
    let peer = async move {
        let mut server = secure_subtype(server, cert.config, subtype).await;
        if subtype == 262 {
            let username_length = server.read_u32().await.unwrap();
            let password_length = server.read_u32().await.unwrap();
            let mut credentials = vec![0; (username_length + password_length) as usize];
            server.read_exact(&mut credentials).await.unwrap();
            assert_eq!(&credentials, b"operatorpassword");
        }
        disconnected(&mut server).await;
    };
    let caller = authenticate(
        client,
        NAME,
        authentication,
        roots,
        Instant::now() + Duration::from_secs(1),
    );
    let ((), result) = bounded(async { tokio::join!(peer, caller) }).await;
    assert!(matches!(
        result,
        Err(Error::AuthenticationDeadlineExceeded { stage }) if stage == expected_stage
    ));
}

#[tokio::test]
async fn x509_none_and_plain_stalls_report_their_exact_stages() {
    assert_x509_authentication_stall(
        X509Authentication::None,
        260,
        AuthenticationStage::X509NoneAuthentication,
    )
    .await;
    assert_x509_authentication_stall(
        X509Authentication::Plain(
            PlainCredentials::new("operator".to_owned(), "password".to_owned()).unwrap(),
        ),
        262,
        AuthenticationStage::X509PlainAuthentication,
    )
    .await;
}

#[tokio::test]
async fn dropping_authentication_during_tls_closes_the_owned_socket() {
    let (client, server) = sockets().await;
    let task = tokio::spawn(authenticate(
        client,
        NAME,
        authentication(),
        TrustRoots::public_roots(),
        deadline(),
    ));
    let mut server = bounded(negotiate(server)).await;
    let mut first_tls_bytes = [0; 1024];
    assert!(bounded(server.read(&mut first_tls_bytes)).await.unwrap() > 0);
    task.abort();
    assert!(task.await.err().unwrap().is_cancelled());
    let mut remaining = Vec::new();
    bounded(server.take(64 * 1024).read_to_end(&mut remaining))
        .await
        .unwrap();
    assert!(remaining.len() < 64 * 1024);
}

#[tokio::test]
async fn dropping_authentication_after_tls_does_not_leave_a_password_reader() {
    let cert = Certificate::new(NAME, false, false);
    let roots = cert.roots();
    let (client, server) = sockets().await;
    let task = tokio::spawn(authenticate(
        client,
        NAME,
        authentication(),
        roots,
        deadline(),
    ));
    let mut server = bounded(secure(server, cert.config)).await;
    task.abort();
    assert!(task.await.err().unwrap().is_cancelled());
    disconnected(&mut server).await;
}

#[tokio::test]
async fn dropping_plain_authentication_after_credential_write_closes_the_socket() {
    let cert = Certificate::new(NAME, false, false);
    let roots = cert.roots();
    let (client, server) = sockets().await;
    let task = tokio::spawn(authenticate(
        client,
        NAME,
        X509Authentication::Plain(
            PlainCredentials::new("operator".to_owned(), "password".to_owned()).unwrap(),
        ),
        roots,
        deadline(),
    ));
    let mut server = bounded(secure_subtype(server, cert.config, 262)).await;
    let username_length = server.read_u32().await.unwrap();
    let password_length = server.read_u32().await.unwrap();
    let mut credentials = vec![0; (username_length + password_length) as usize];
    server.read_exact(&mut credentials).await.unwrap();
    assert_eq!(&credentials, b"operatorpassword");
    task.abort();
    assert!(task.await.err().unwrap().is_cancelled());
    disconnected(&mut server).await;
}

#[tokio::test]
async fn rejects_a_ready_security_result_when_the_deadline_has_already_elapsed() {
    let cert = Certificate::new(NAME, false, false);
    let roots = cert.roots();
    let (client, server) = sockets().await;
    let end = deadline();
    let mut authentication = Box::pin(authenticate(client, NAME, authentication(), roots, end));
    let mut server = bounded(async {
        tokio::select! {
            _ = &mut authentication => {
                panic!("authentication ended before the server sent SecurityResult");
            }
            server = async {
                let mut server = secure(server, cert.config).await;
                challenge(&mut server).await;
                server
            } => server,
        }
    })
    .await;
    server.write_u32(0).await.unwrap();
    server.flush().await.unwrap();

    // Deliberately leave the client future unpolled until its real deadline.
    // This reproduces a delayed caller with both result and timeout ready;
    // the timer is the behavior under test, not a synchronization delay.
    tokio::time::sleep_until(end).await;
    let result = authentication.await;
    match result {
        Err(Error::AuthenticationDeadlineExceeded {
            stage: AuthenticationStage::VncAuthentication,
        }) => {}
        Err(error) => panic!("unexpected authentication failure: {error}"),
        Ok(_) => panic!("returned an authenticated connection after its deadline"),
    }
    disconnected(&mut server).await;
}
