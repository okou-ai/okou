//! Controlled RFB/TLS boundary peers, not mutual GSS interoperability.
#![cfg(test)]
#![cfg(target_os = "linux")]
use kerberos_credentials::Principal;
use kerberos_worker::{
    Credentials, Error as NativeError, KdcExchange, Password, Source, TicketPolicy,
};
use rfb_client::{
    AuthenticationStage, Error, QemuGssapiAuthentication, TrustRoots, authenticate_qemu_gssapi,
};
use rustls::{ServerConfig, pki_types::PrivatePkcs8KeyDer};
use std::{fs, io, os::unix::fs::PermissionsExt, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, DuplexStream},
    sync::oneshot,
    time::Instant,
};
use tokio_rustls::TlsAcceptor;
use zeroize::Zeroizing;

fn tls() -> (TrustRoots, TlsAcceptor) {
    let key = rcgen::KeyPair::generate().unwrap();
    let cert = rcgen::CertificateParams::new(vec!["gss-fixture.invalid".into()])
        .unwrap()
        .self_signed(&key)
        .unwrap();
    let config = ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::aws_lc_rs::default_provider(),
    ))
    .with_protocol_versions(&[&rustls::version::TLS13])
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(
        vec![cert.der().clone()],
        PrivatePkcs8KeyDer::from(key.serialize_der()).into(),
    )
    .unwrap();
    (
        TrustRoots::custom(vec![cert.der().clone()]).unwrap(),
        TlsAcceptor::from(Arc::new(config)),
    )
}

fn selected(root: &std::path::Path) -> QemuGssapiAuthentication {
    let client = Principal::new("GSS-FIXTURE.INVALID".into(), vec!["probe".into()]).unwrap();
    let service = Principal::new(
        "GSS-FIXTURE.INVALID".into(),
        vec!["vnc".into(), "explicit-service".into()],
    )
    .unwrap();
    QemuGssapiAuthentication {
        credentials: Credentials::new(
            client,
            service,
            Source::Password(
                Password::new(Zeroizing::new("synthetic-not-delivered".into())).unwrap(),
            ),
        )
        .unwrap(),
        ticket_policy: TicketPolicy::new(Duration::from_secs(60), Duration::ZERO).unwrap(),
        private_root: root.to_owned(),
        expires_at: Instant::now() + Duration::from_secs(60),
    }
}

async fn peer(
    mut stream: DuplexStream,
    acceptor: TlsAcceptor,
    subtype: u32,
    offer: &[u8],
    size: u32,
) {
    stream.write_all(b"RFB 003.008\n").await.unwrap();
    let mut banner = [0; 12];
    stream.read_exact(&mut banner).await.unwrap();
    assert_eq!(&banner, b"RFB 003.008\n");
    stream.write_all(&[1, 19]).await.unwrap();
    assert_eq!(stream.read_u8().await.unwrap(), 19);
    stream.write_all(&[0, 2]).await.unwrap();
    let mut version = [0; 2];
    stream.read_exact(&mut version).await.unwrap();
    assert_eq!(version, [0, 2]);
    stream.write_all(&[0, 1]).await.unwrap();
    stream.write_u32(subtype).await.unwrap();
    stream.flush().await.unwrap();
    if subtype != 263 {
        return;
    }
    assert_eq!(stream.read_u32().await.unwrap(), 263);
    stream.write_u8(1).await.unwrap();
    let mut stream = acceptor.accept(stream).await.unwrap();
    stream.write_u32(size).await.unwrap();
    stream.write_all(offer).await.unwrap();
    stream.flush().await.unwrap();
    let result = tokio::time::timeout(Duration::from_secs(2), stream.read_u8())
        .await
        .unwrap();
    assert!(
        matches!(result, Err(error) if matches!(error.kind(), io::ErrorKind::UnexpectedEof | io::ErrorKind::ConnectionReset)),
        "refusal/cancellation must drop the supplied TLS stream without a mechanism or token write"
    );
}

struct NoAuthority;
impl KdcExchange for NoAuthority {
    async fn authorize(&mut self) -> Result<(), NativeError> {
        panic!("invalid subtype/mechanism must refuse before native credential authority");
    }
    async fn exchange(&mut self, _: &str, _: &[u8]) -> Result<Zeroizing<Vec<u8>>, NativeError> {
        panic!("no KDC exchange is admitted");
    }
}

#[tokio::test]
async fn rejects_non263_aliases_empty_and_malformed_mechanisms_before_native_delivery() {
    fs::create_dir_all(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let root = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let mut cases = vec![
        (264, Vec::new(), 0),
        (20, Vec::new(), 0),
        (263, Vec::new(), 0),
        (263, Vec::new(), 4097),
    ];
    for offer in [
        b"PLAIN".as_slice(),
        b"GSS-SPNEGO",
        b"gssapi",
        b"GSSAPI,",
        b",GSSAPI",
        b"GSSAPI\0",
        b"GSSAPI,PLAIN\n",
    ] {
        cases.push((263, offer.to_vec(), u32::try_from(offer.len()).unwrap()));
    }
    for (subtype, offer, size) in cases {
        let (roots, acceptor) = tls();
        let (client, server) = tokio::io::duplex(16384);
        let task = tokio::spawn(async move { peer(server, acceptor, subtype, &offer, size).await });
        let result = authenticate_qemu_gssapi(
            client,
            "gss-fixture.invalid",
            roots,
            selected(&root.path().canonicalize().unwrap()),
            &mut NoAuthority,
            Instant::now() + Duration::from_secs(2),
        )
        .await;
        if subtype != 263 {
            assert!(matches!(result, Err(Error::UnsupportedSecurity)));
        } else {
            assert!(matches!(result, Err(Error::InvalidKerberosExchange)));
        }
        task.await.unwrap();
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    }
}

struct PendingAuthority(Option<oneshot::Sender<()>>);
impl KdcExchange for PendingAuthority {
    async fn authorize(&mut self) -> Result<(), NativeError> {
        self.0.take().unwrap().send(()).unwrap();
        std::future::pending().await
    }
    async fn exchange(&mut self, _: &str, _: &[u8]) -> Result<Zeroizing<Vec<u8>>, NativeError> {
        panic!("pending authority never admits KDC delivery");
    }
}

#[tokio::test]
async fn expired_or_cancelled_gss_authority_phase_closes_tls_without_native_work() {
    for cancelled in [false, true] {
        fs::create_dir_all(env!("CARGO_TARGET_TMPDIR")).unwrap();
        let root = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let (roots, acceptor) = tls();
        let (client, server) = tokio::io::duplex(16384);
        let task = tokio::spawn(peer(server, acceptor, 263, b"GSSAPI", 6));
        let (signal, waiting) = oneshot::channel();
        let mut caller = PendingAuthority(Some(signal));
        let mut authentication = Box::pin(authenticate_qemu_gssapi(
            client,
            "gss-fixture.invalid",
            roots,
            selected(&root.path().canonicalize().unwrap()),
            &mut caller,
            Instant::now() + Duration::from_millis(100),
        ));
        tokio::select! { _result = &mut authentication => panic!("authentication finished before pending authority"), result = waiting => result.unwrap() }
        if !cancelled {
            let error = match authentication.as_mut().await {
                Ok(_) => panic!("pending authority authenticated"),
                Err(error) => error,
            };
            assert!(
                matches!(
                    error,
                    Error::AuthenticationDeadlineExceeded {
                        stage: AuthenticationStage::QemuGssapiAuthentication
                    }
                ),
                "unexpected bounded deadline category: {error}"
            );
        }
        drop(authentication);
        task.await.unwrap();
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    }
}
