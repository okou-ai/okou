//! Controlled TLS peers test fail-closed SASL framing. QEMU interop is separate.
#![cfg(test)]
use std::{io, sync::Arc, time::Duration};

use rfb_client::{
    AuthenticationStage, Error, QemuScramCredentials, TrustRoots, X509Authentication, authenticate,
};
use rustls::{ServerConfig, pki_types::PrivatePkcs8KeyDer};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream},
    sync::oneshot,
    time::{Instant, timeout},
};
use tokio_rustls::TlsAcceptor;

const NAME: &str = "synthetic.test";

#[derive(Clone, Copy, Debug)]
enum Peer {
    Qemu264,
    MissingMechanism,
    OversizedOffer,
    BadPadding,
    EmptyData,
    NullData,
    ExcessiveIterations,
    ExcessiveSalt,
    EarlyComplete,
    WrongServerProof,
    FragmentedWrongServerProof,
    Silent,
}

fn credentials() -> X509Authentication {
    X509Authentication::QemuScramSha256(
        QemuScramCredentials::new("fixture37465".into(), "test-only-password".into()).unwrap(),
    )
}

async fn blob<S: AsyncWrite + Unpin>(stream: &mut S, value: Option<&[u8]>, complete: u8) {
    if let Some(value) = value {
        stream.write_u32((value.len() + 1) as u32).await.unwrap();
        stream.write_all(value).await.unwrap();
        stream.write_u8(0).await.unwrap();
    } else {
        stream.write_u32(0).await.unwrap();
    }
    stream.write_u8(complete).await.unwrap();
    stream.flush().await.unwrap();
}

async fn read_client_start<S: AsyncRead + Unpin>(stream: &mut S) -> Vec<u8> {
    let n = stream.read_u32().await.unwrap();
    assert_eq!(n, 13);
    let mut name = vec![0; n as usize];
    stream.read_exact(&mut name).await.unwrap();
    assert_eq!(&name, b"SCRAM-SHA-256");
    let n = stream.read_u32().await.unwrap();
    assert!((1..256).contains(&n));
    let mut data = vec![0; n as usize];
    stream.read_exact(&mut data).await.unwrap();
    assert_eq!(data.pop(), Some(0));
    data
}

async fn peer(
    mut stream: DuplexStream,
    acceptor: TlsAcceptor,
    mode: Peer,
    ready: Option<oneshot::Sender<()>>,
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
    stream
        .write_u32(if matches!(mode, Peer::Qemu264) {
            264
        } else {
            263
        })
        .await
        .unwrap();
    if matches!(mode, Peer::Qemu264) {
        stream.flush().await.unwrap();
        return;
    }
    assert_eq!(stream.read_u32().await.unwrap(), 263);
    stream.write_u8(1).await.unwrap();
    let mut stream = acceptor.accept(stream).await.unwrap();
    match mode {
        Peer::MissingMechanism => {
            stream.write_u32(5).await.unwrap();
            stream.write_all(b"PLAIN").await.unwrap();
            stream.flush().await.unwrap();
            return;
        }
        Peer::OversizedOffer => {
            stream.write_u32(4097).await.unwrap();
            stream.flush().await.unwrap();
            return;
        }
        _ => {}
    }
    stream.write_u32(13).await.unwrap();
    stream.write_all(b"SCRAM-SHA-256").await.unwrap();
    stream.flush().await.unwrap();
    let first = read_client_start(&mut stream).await;
    if let Some(ready) = ready {
        let _ = ready.send(());
    }
    if matches!(mode, Peer::Silent) {
        let mut next = [0];
        let result = timeout(Duration::from_secs(2), stream.read(&mut next))
            .await
            .unwrap();
        assert!(
            matches!(&result, Ok(0))
                || matches!(&result, Err(error) if error.kind() == io::ErrorKind::UnexpectedEof),
            "expired SASL authentication must drop the TLS socket: {result:?}"
        );
        return;
    }
    if matches!(mode, Peer::BadPadding) {
        stream
            .write_all(&[0, 0, 0, 2, b'x', b'y', 0])
            .await
            .unwrap();
        stream.flush().await.unwrap();
        return;
    }
    if matches!(mode, Peer::NullData | Peer::EmptyData) {
        blob(
            &mut stream,
            if matches!(mode, Peer::EmptyData) {
                Some(b"")
            } else {
                None
            },
            0,
        )
        .await;
        return;
    }
    let nonce = first
        .split(|b| *b == b',')
        .find_map(|part| part.strip_prefix(b"r="))
        .unwrap();
    let mut server_first = b"r=".to_vec();
    server_first.extend_from_slice(nonce);
    server_first.extend_from_slice(b"server,s=");
    if matches!(mode, Peer::ExcessiveSalt) {
        server_first.extend_from_slice(&[b'A'; 176]);
    } else {
        server_first.extend_from_slice(b"c2FsdHNhbHRzYWx0");
    }
    server_first.extend_from_slice(b",i=");
    server_first.extend_from_slice(if matches!(mode, Peer::ExcessiveIterations) {
        b"999999"
    } else {
        b"4096"
    });
    if matches!(mode, Peer::FragmentedWrongServerProof) {
        let mut frame = (server_first.len() as u32 + 1).to_be_bytes().to_vec();
        frame.extend_from_slice(&server_first);
        frame.extend_from_slice(&[0, 0]); // NUL padding, then complete=0
        for byte in frame {
            stream.write_u8(byte).await.unwrap();
            tokio::task::yield_now().await;
        }
        stream.flush().await.unwrap();
    } else {
        blob(
            &mut stream,
            Some(&server_first),
            if matches!(mode, Peer::EarlyComplete) {
                1
            } else {
                0
            },
        )
        .await;
    }
    if matches!(
        mode,
        Peer::ExcessiveIterations | Peer::ExcessiveSalt | Peer::EarlyComplete
    ) {
        return;
    }
    let n = stream.read_u32().await.unwrap();
    assert!((1..1024).contains(&n));
    let mut final_message = vec![0; n as usize];
    stream.read_exact(&mut final_message).await.unwrap();
    assert_eq!(final_message.last(), Some(&0));
    blob(
        &mut stream,
        Some(b"v=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),
        1,
    )
    .await;
    // A malicious success status cannot bypass the client-side server proof.
    stream.write_u32(0).await.unwrap();
    stream.flush().await.unwrap();
}

fn tls_fixture() -> (TrustRoots, TlsAcceptor) {
    let key = rcgen::KeyPair::generate().unwrap();
    let cert = rcgen::CertificateParams::new(vec![NAME.into()])
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

async fn run(mode: Peer, deadline: Duration) -> Result<(), Error> {
    let (roots, acceptor) = tls_fixture();
    let (client, server) = tokio::io::duplex(64 * 1024);
    let peer = tokio::spawn(peer(server, acceptor, mode, None));
    let result = timeout(
        Duration::from_secs(5),
        authenticate(
            client,
            NAME,
            credentials(),
            roots,
            Instant::now() + deadline,
        ),
    )
    .await
    .expect("SASL auth must be bounded")
    .map(|_| ());
    peer.await.unwrap();
    result
}

#[tokio::test]
async fn rejects_qemu_264_missing_mechanism_and_malformed_framing() {
    for mode in [
        Peer::Qemu264,
        Peer::MissingMechanism,
        Peer::OversizedOffer,
        Peer::BadPadding,
        Peer::EmptyData,
        Peer::NullData,
        Peer::ExcessiveIterations,
        Peer::ExcessiveSalt,
        Peer::EarlyComplete,
    ] {
        let result = run(mode, Duration::from_secs(4)).await;
        match mode {
            Peer::Qemu264 => assert!(matches!(result, Err(Error::UnsupportedSecurity))),
            Peer::MissingMechanism => {
                assert!(matches!(result, Err(Error::UnsupportedScramMechanism)))
            }
            _ => assert!(
                matches!(result, Err(Error::InvalidScramExchange)),
                "{mode:?}: {result:?}"
            ),
        }
    }
}

#[tokio::test]
async fn forged_server_proof_fails_even_with_successful_security_result() {
    for mode in [Peer::WrongServerProof, Peer::FragmentedWrongServerProof] {
        assert!(matches!(
            run(mode, Duration::from_secs(4)).await,
            Err(Error::InvalidScramExchange)
        ));
    }
}

#[tokio::test]
async fn silent_sasl_peer_respects_absolute_deadline() {
    assert!(matches!(
        run(Peer::Silent, Duration::from_millis(200)).await,
        Err(Error::AuthenticationDeadlineExceeded {
            stage: AuthenticationStage::QemuScramAuthentication
        })
    ));
}

#[tokio::test]
async fn cancellation_during_sasl_closes_the_owned_socket() {
    let (roots, acceptor) = tls_fixture();
    let (client, server) = tokio::io::duplex(64 * 1024);
    let (ready_tx, ready_rx) = oneshot::channel();
    let peer = tokio::spawn(peer(server, acceptor, Peer::Silent, Some(ready_tx)));
    let task = tokio::spawn(authenticate(
        client,
        NAME,
        credentials(),
        roots,
        Instant::now() + Duration::from_secs(4),
    ));
    timeout(Duration::from_secs(2), ready_rx)
        .await
        .unwrap()
        .unwrap();
    task.abort();
    assert!(matches!(task.await, Err(error) if error.is_cancelled()));
    timeout(Duration::from_secs(2), peer)
        .await
        .unwrap()
        .unwrap();
}
