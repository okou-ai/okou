//! Controlled TLS/RFB finality controls backed by the independent MIT acceptor.
//! These are not a replacement for the source-pinned QEMU positive fixtures.
use super::{credentials, fixture, mit_peer, peer_frame};
use kerberos_worker::{NoKdc, TicketPolicy};
use rfb_client::{Error, QemuGssapiAuthentication, TrustRoots, authenticate_qemu_gssapi};
use rustls::{ServerConfig, pki_types::PrivatePkcs8KeyDer};
use std::{fs, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, DuplexStream},
    process::{ChildStdin, ChildStdout},
    time::Instant,
};
use tokio_rustls::TlsAcceptor;
use zeroize::Zeroizing;

fn tls() -> (TrustRoots, TlsAcceptor) {
    let key = rcgen::KeyPair::generate().unwrap();
    let cert = rcgen::CertificateParams::new(vec!["localhost".into()])
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

async fn client_blob<S: tokio::io::AsyncRead + Unpin>(
    stream: &mut S,
) -> Option<Zeroizing<Vec<u8>>> {
    let size = stream.read_u32().await.unwrap();
    assert!(size <= 16385);
    if size == 0 {
        return None;
    }
    let mut value = Zeroizing::new(vec![0; usize::try_from(size).unwrap()]);
    stream.read_exact(&mut value).await.unwrap();
    assert_eq!(value.pop(), Some(0));
    Some(value)
}

async fn server_blob<S: tokio::io::AsyncWrite + Unpin>(
    stream: &mut S,
    value: Option<&[u8]>,
    finality: u8,
) {
    if let Some(value) = value {
        stream
            .write_u32(u32::try_from(value.len() + 1).unwrap())
            .await
            .unwrap();
        stream.write_all(value).await.unwrap();
        stream.write_u8(0).await.unwrap();
    } else {
        stream.write_u32(0).await.unwrap();
    }
    stream.write_u8(finality).await.unwrap();
    stream.flush().await.unwrap();
}

async fn serve(
    mut stream: DuplexStream,
    acceptor: TlsAcceptor,
    mut input: ChildStdin,
    mut output: ChildStdout,
    mode: &'static str,
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
    stream.write_u32(263).await.unwrap();
    assert_eq!(stream.read_u32().await.unwrap(), 263);
    stream.write_u8(1).await.unwrap();
    let mut stream = acceptor.accept(stream).await.unwrap();
    stream.write_u32(6).await.unwrap();
    stream.write_all(b"GSSAPI").await.unwrap();
    stream.flush().await.unwrap();
    assert_eq!(stream.read_u32().await.unwrap(), 6);
    let mut mechanism = [0; 6];
    stream.read_exact(&mut mechanism).await.unwrap();
    assert_eq!(&mechanism, b"GSSAPI");
    let ap_req = client_blob(&mut stream).await.unwrap();
    assert!(!ap_req.is_empty());
    input
        .write_u32(u32::try_from(ap_req.len()).unwrap())
        .await
        .unwrap();
    input.write_all(&ap_req).await.unwrap();
    let ap_rep = peer_frame(&mut output).await.unwrap();
    match mode {
        "null_token" => server_blob(&mut stream, None, 0).await,
        "empty_token" => server_blob(&mut stream, Some(&[]), 0).await,
        "early_complete" => server_blob(&mut stream, Some(&ap_rep), 1).await,
        "bad_finality" => server_blob(&mut stream, Some(&ap_rep), 2).await,
        "oversized_token" => {
            stream.write_u32(1_048_576).await.unwrap();
            stream.flush().await.unwrap();
        }
        "bad_padding" => {
            stream
                .write_u32(u32::try_from(ap_rep.len() + 1).unwrap())
                .await
                .unwrap();
            stream.write_all(&ap_rep).await.unwrap();
            stream.write_all(&[1, 0]).await.unwrap();
            stream.flush().await.unwrap();
        }
        _ => {
            server_blob(&mut stream, Some(&ap_rep), 0).await;
            assert!(
                client_blob(&mut stream)
                    .await
                    .is_none_or(|value| value.is_empty())
            );
            input.write_u8(1).await.unwrap();
            let offer = peer_frame(&mut output).await.unwrap();
            server_blob(&mut stream, Some(&offer), 0).await;
            let selected = client_blob(&mut stream).await.unwrap();
            input
                .write_u32(u32::try_from(selected.len()).unwrap())
                .await
                .unwrap();
            input.write_all(&selected).await.unwrap();
            assert_eq!(peer_frame(&mut output).await.unwrap().as_slice(), &[1]);
            match mode {
                "data_after_layer" => server_blob(&mut stream, Some(&[1]), 0).await,
                "nonempty_complete" => server_blob(&mut stream, Some(&[1]), 1).await,
                _ => {
                    server_blob(
                        &mut stream,
                        if mode == "valid_empty_complete" {
                            Some(&[])
                        } else {
                            None
                        },
                        1,
                    )
                    .await;
                    stream
                        .write_u32(u32::from(mode == "rejected_result"))
                        .await
                        .unwrap();
                    if mode == "rejected_result" {
                        stream.write_u32(0).await.unwrap();
                    }
                    stream.flush().await.unwrap();
                }
            }
        }
    }
    let mut next = [0];
    let result = tokio::time::timeout(Duration::from_secs(2), stream.read(&mut next))
        .await
        .unwrap();
    assert!(
        matches!(result, Ok(0))
            || matches!(result,Err(error) if matches!(error.kind(),std::io::ErrorKind::UnexpectedEof|std::io::ErrorKind::ConnectionReset)),
        "original TLS stream remained owned or received unexpected client bytes"
    );
}

fn children() -> Vec<u32> {
    let mut ids = Vec::new();
    for task in fs::read_dir("/proc/self/task").unwrap() {
        if let Ok(value) = fs::read_to_string(task.unwrap().path().join("children")) {
            ids.extend(
                value
                    .split_whitespace()
                    .map(|id| id.parse::<u32>().unwrap()),
            );
        }
    }
    ids
}

#[tokio::test]
#[ignore = "requires generated local-only QEMU9.2/Cyrus/KDC fixture"]
async fn pinned_rfb_finality_padding_and_security_result_use_actual_mutual_gss() {
    let root = fixture(0);
    for mode in [
        "valid_null_complete",
        "valid_empty_complete",
        "null_token",
        "empty_token",
        "early_complete",
        "bad_finality",
        "oversized_token",
        "bad_padding",
        "data_after_layer",
        "nonempty_complete",
        "rejected_result",
    ] {
        let before = children();
        let mut peer = mit_peer(&root, "valid");
        let (roots, acceptor) = tls();
        let (client, server) = tokio::io::duplex(32768);
        let input = peer.stdin.take().unwrap();
        let output = peer.stdout.take().unwrap();
        let task = tokio::spawn(serve(server, acceptor, input, output, mode));
        let selected = QemuGssapiAuthentication {
            credentials: credentials(&root, "ticket"),
            ticket_policy: TicketPolicy::new(Duration::from_secs(60), Duration::ZERO).unwrap(),
            private_root: root.join("private"),
            expires_at: Instant::now() + Duration::from_secs(60),
        };
        let result = authenticate_qemu_gssapi(
            client,
            "localhost",
            roots,
            selected,
            &mut NoKdc,
            Instant::now() + Duration::from_secs(5),
        )
        .await;
        if mode.starts_with("valid_") {
            assert!(result.is_ok());
        } else if mode == "rejected_result" {
            assert!(matches!(result, Err(Error::AuthenticationFailed)));
        } else {
            assert!(
                matches!(result, Err(Error::InvalidKerberosExchange)),
                "unexpected refusal for {mode}"
            );
        }
        drop(result);
        task.await.unwrap();
        if peer.try_wait().unwrap().is_none() {
            peer.start_kill().unwrap();
        }
        peer.wait().await.unwrap();
        let until = Instant::now() + Duration::from_secs(2);
        while children().into_iter().any(|id| !before.contains(&id)) && Instant::now() < until {
            tokio::task::yield_now().await;
        }
        assert!(
            children().into_iter().all(|id| before.contains(&id)),
            "native/acceptor child not reaped for {mode}"
        );
        assert_eq!(fs::read_dir(root.join("private")).unwrap().count(), 0);
    }
    println!(
        "actual mutual GSS over original verified TLS: NULL/empty final success; malformed token/padding/finality, post-layer data and rejected SecurityResult refuse; all native/acceptor children reaped"
    );
}
