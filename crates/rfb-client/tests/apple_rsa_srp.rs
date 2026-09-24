#![allow(
    clippy::expect_used,
    clippy::indexing_slicing,
    reason = "bounded synthetic protocol fixtures and fixed test credentials"
)]

use crypto_bigint::{
    BoxedUint, Odd,
    modular::{BoxedMontyForm, BoxedMontyParams},
};
use rand::{
    SeedableRng,
    rngs::{StdRng, SysRng},
};
use rfb_client::{AppleRsaSrpCredentials, AuthenticationStage, Error, authenticate_apple_rsa_srp};
use rsa::{Pkcs1v15Encrypt, RsaPrivateKey, RsaPublicKey, pkcs8::EncodePublicKey};
use sha2::{Digest, Sha512};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, DuplexStream, duplex},
    time::{Duration, Instant},
};

fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(20)
}
fn credentials() -> AppleRsaSrpCredentials {
    AppleRsaSrpCredentials::new("test-user".into(), "test-password".into())
        .expect("test credential")
}
fn sha512(parts: &[&[u8]]) -> Vec<u8> {
    let mut h = Sha512::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().to_vec()
}
fn group() -> Vec<u8> {
    let hex: String = include_str!("data/rfc5054_4096.hex")
        .chars()
        .filter(|c| !c.is_ascii_whitespace())
        .collect();
    hex::decode(hex).expect("RFC group")
}

#[derive(Clone, Copy)]
enum Scenario {
    Success,
    CorruptProof,
    WrongPassword,
    InvalidGroup,
    BadKey,
    BadSpki,
    BadFinalFrame,
    RejectedStatus,
    TruncatedFinal,
}

async fn peer(server: &mut DuplexStream, scenario: Scenario) {
    server.write_all(b"RFB 003.889\n").await.expect("banner");
    let mut version = [0; 12];
    server.read_exact(&mut version).await.expect("version");
    assert_eq!(&version, b"RFB 003.008\n");
    server.write_all(&[3, 30, 33, 36]).await.expect("offer");
    let mut request = [0; 15];
    server
        .read_exact(&mut request)
        .await
        .expect("combined RSA1 request");
    assert_eq!(
        &request,
        &[33, 0, 0, 0, 10, 1, 0, b'R', b'S', b'A', b'1', 0, 0, 0, 0]
    );

    let mut rng = StdRng::try_from_rng(&mut SysRng).expect("OS entropy");
    let private = RsaPrivateKey::new(&mut rng, 2048).expect("synthetic RSA key");
    let public = RsaPublicKey::from(&private);
    let der = public.to_public_key_der().expect("SPKI");
    assert_eq!(der.as_bytes().len(), 294);
    let mut key_reply = Vec::new();
    key_reply.extend_from_slice(&1u16.to_be_bytes());
    key_reply.extend_from_slice(&294u32.to_be_bytes());
    key_reply.extend_from_slice(der.as_bytes());
    if matches!(scenario, Scenario::BadSpki) {
        key_reply[6] ^= 1;
    }
    key_reply.push(u8::from(matches!(scenario, Scenario::BadKey)));
    server.write_u32(301).await.expect("key length");
    server.write_all(&key_reply).await.expect("key reply");
    if matches!(scenario, Scenario::BadKey | Scenario::BadSpki) {
        return;
    }

    assert_eq!(server.read_u32().await.expect("RSA init length"), 650);
    let mut init = [0u8; 650];
    server.read_exact(&mut init).await.expect("RSA init");
    assert_eq!(&init[..10], &[1, 0, b'R', b'S', b'A', b'1', 0, 2, 1, 0]);
    assert!(init[266..].iter().all(|v| *v == 0));
    let username = private
        .decrypt(Pkcs1v15Encrypt, &init[10..266])
        .expect("RSA username");
    assert_eq!(&username[..8], &[0, 0, 0, 16, 0, 0, 0, 9]);
    assert_eq!(&username[8..17], b"test-user");
    assert_eq!(&username[17..], &[0, 0, 0]);

    let mut n_bytes = group();
    let n = BoxedUint::from_be_slice(&n_bytes, 4096).expect("N");
    let params =
        BoxedMontyParams::new_vartime(Option::<Odd<BoxedUint>>::from(Odd::new(n)).expect("odd"));
    let g = BoxedMontyForm::new(BoxedUint::from_be_slice(&[5], 4096).expect("g"), &params);
    let salt = [0x13; 32];
    let mut derived = [0u8; 128];
    pbkdf2::pbkdf2_hmac::<Sha512>(b"test-password", &salt, 10_000, &mut derived);
    let x_inner = sha512(&[b":", &derived]);
    let x_hash = sha512(&[&salt, &x_inner]);
    let x = BoxedUint::from_be_slice(&x_hash, 4096).expect("x");
    let verifier = g.pow_bounded_exp(&x, 512);
    let mut g_pad = [0u8; 512];
    g_pad[511] = 5;
    let k_hash = sha512(&[&n_bytes, &g_pad]);
    let k = BoxedMontyForm::new(BoxedUint::from_be_slice(&k_hash, 4096).expect("k"), &params);
    let b_private = BoxedUint::from_be_slice(&[17], 4096).expect("b");
    let b_public = (&k * &verifier + g.pow_bounded_exp(&b_private, 8))
        .retrieve()
        .to_be_bytes();
    if matches!(scenario, Scenario::InvalidGroup) {
        n_bytes[0] ^= 1;
    }
    let mut fields = Vec::new();
    fields.push(0);
    fields.extend_from_slice(&512u16.to_be_bytes());
    fields.extend_from_slice(&n_bytes);
    fields.extend_from_slice(&1u16.to_be_bytes());
    fields.push(5);
    fields.push(32);
    fields.extend_from_slice(&salt);
    fields.extend_from_slice(&512u16.to_be_bytes());
    fields.extend_from_slice(&b_public);
    fields.extend_from_slice(&10_000u64.to_be_bytes());
    fields.extend_from_slice(&80u16.to_be_bytes());
    fields.extend_from_slice(&[0x31; 80]);
    assert_eq!(fields.len(), 1155);
    let mut challenge = Vec::new();
    challenge.extend_from_slice(&2u32.to_be_bytes());
    challenge.extend_from_slice(&1159u16.to_be_bytes());
    challenge.extend_from_slice(&0u16.to_be_bytes());
    challenge.extend_from_slice(&1155u16.to_be_bytes());
    challenge.extend_from_slice(&fields);
    server.write_u32(1165).await.expect("challenge outer");
    server.write_all(&challenge).await.expect("challenge");
    if matches!(scenario, Scenario::InvalidGroup) {
        return;
    }

    assert_eq!(server.read_u32().await.expect("proof length"), 1076);
    let mut packet = vec![0; 1076];
    server.read_exact(&mut packet).await.expect("proof packet");
    assert_eq!(
        &packet[..14],
        &[1, 0, b'R', b'S', b'A', b'1', 0, 2, 2, 170, 0, 0, 2, 166]
    );
    let response = &packet[14..692];
    assert!(packet[692..].iter().all(|v| *v == 0));
    assert_eq!(&response[..2], &512u16.to_be_bytes());
    let a_bytes = &response[2..514];
    assert_eq!(response[514], 64);
    let m1 = &response[515..579];
    assert_eq!(&response[579..581], &80u16.to_be_bytes());
    assert_eq!(&response[581..661], &[0x31; 80]);
    assert_eq!(response[661], 16);
    let a = BoxedMontyForm::new(BoxedUint::from_be_slice(a_bytes, 4096).expect("A"), &params);
    let u = BoxedUint::from_be_slice(&sha512(&[a_bytes, &b_public]), 4096).expect("u");
    let shared = (a * verifier.pow_bounded_exp(&u, 512))
        .pow_bounded_exp(&b_private, 8)
        .retrieve()
        .to_be_bytes();
    let session_key = sha512(&[&shared]);
    let hn = sha512(&[&group()]);
    let hg = sha512(&[&g_pad]);
    let xor_ng: Vec<u8> = hn.iter().zip(hg.iter()).map(|(n, g)| n ^ g).collect();
    let expected_m1 = sha512(&[
        &xor_ng,
        &sha512(&[b""]),
        &salt,
        a_bytes,
        &b_public,
        &session_key,
    ]);
    if m1 != expected_m1 {
        server.write_u32(6).await.expect("reject proof");
        return;
    }
    let mut m2 = sha512(&[a_bytes, m1, &session_key]);
    if matches!(scenario, Scenario::CorruptProof) {
        m2[0] ^= 1;
    }
    let mut final_token = Vec::new();
    final_token.extend_from_slice(&2u32.to_be_bytes());
    final_token.extend_from_slice(&92u16.to_be_bytes());
    final_token.extend_from_slice(&0u16.to_be_bytes());
    final_token.extend_from_slice(&88u16.to_be_bytes());
    final_token.push(64);
    final_token.extend_from_slice(&m2);
    final_token.push(16);
    final_token.extend_from_slice(&[0x47; 16]);
    final_token.extend_from_slice(&0u16.to_be_bytes());
    final_token.extend_from_slice(&0u32.to_be_bytes());
    assert_eq!(final_token.len(), 98);
    server.write_u32(98).await.expect("final length");
    if matches!(scenario, Scenario::BadFinalFrame) {
        final_token[8] ^= 1;
    }
    if matches!(scenario, Scenario::TruncatedFinal) {
        server
            .write_all(&final_token[..50])
            .await
            .expect("truncated final");
        return;
    }
    server.write_all(&final_token).await.expect("final token");
    if !matches!(scenario, Scenario::CorruptProof | Scenario::BadFinalFrame) {
        let status = u32::from(matches!(scenario, Scenario::RejectedStatus));
        server.write_u32(status).await.expect("SecurityResult");
        if status != 0 {
            server.write_u32(0).await.expect("empty failure reason");
        } else {
            server.write_u8(0x42).await.expect("post-auth marker");
        }
    }
}

#[tokio::test]
async fn type_33_authenticates_and_hands_off_only_after_valid_proof() {
    let (client, mut server) = duplex(4096);
    let peer = tokio::spawn(async move { peer(&mut server, Scenario::Success).await });
    let authenticated = authenticate_apple_rsa_srp(client, credentials(), deadline())
        .await
        .expect("authenticated");
    let mut stream = authenticated.into_stream();
    assert_eq!(stream.read_u8().await.expect("handoff"), 0x42);
    peer.await.expect("peer task");
}

#[tokio::test]
async fn invalid_key_group_proof_and_missing_final_fail_closed() {
    for (scenario, expected) in [
        (Scenario::BadKey, "parameters"),
        (Scenario::BadSpki, "parameters"),
        (Scenario::InvalidGroup, "parameters"),
        (Scenario::CorruptProof, "authentication"),
        (Scenario::BadFinalFrame, "authentication"),
        (Scenario::RejectedStatus, "authentication"),
        (Scenario::WrongPassword, "authentication"),
        (Scenario::TruncatedFinal, "transport"),
    ] {
        let (client, mut server) = duplex(4096);
        let peer = tokio::spawn(async move { peer(&mut server, scenario).await });
        let credential = if matches!(scenario, Scenario::WrongPassword) {
            AppleRsaSrpCredentials::new("test-user".into(), "incorrect".into())
                .expect("wrong password")
        } else {
            credentials()
        };
        let result = tokio::time::timeout(
            Duration::from_secs(20),
            authenticate_apple_rsa_srp(client, credential, deadline()),
        )
        .await
        .expect("bounded outcome");
        let classification = match result {
            Err(Error::InvalidAppleRsaSrpParameters) => "parameters",
            Err(Error::AuthenticationFailed) => "authentication",
            Err(Error::Io(_)) => "transport",
            _ => panic!("unexpected type-33 outcome"),
        };
        assert_eq!(classification, expected);
        peer.await.expect("peer task");
    }
}

#[test]
fn type_33_credentials_have_distinct_rsa_bound_and_redacted_debug() {
    assert_eq!(
        format!("{:?}", credentials()),
        "AppleRsaSrpCredentials([REDACTED])"
    );
    assert!(AppleRsaSrpCredentials::new("ü".repeat(117), "p".into()).is_ok());
    assert!(matches!(
        AppleRsaSrpCredentials::new("ü".repeat(118), "p".into()),
        Err(Error::InvalidAppleRsaSrpUsername)
    ));
    assert!(matches!(
        AppleRsaSrpCredentials::new("u".into(), "".into()),
        Err(Error::InvalidAppleRsaSrpPassword)
    ));
}

// A Mac-only read wrapper flips one byte of M2 while preserving all other
// bytes. It tracks only the public, bounded wire lengths; it logs no payload.
#[cfg(target_os = "macos")]
mod mac_proof_fault {
    use std::{
        io,
        pin::Pin,
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
        task::{Context, Poll},
    };
    use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

    enum Phase {
        Banner(usize),
        OfferCount,
        Offers(usize),
        Length {
            branch: u8,
            read: u8,
            value: u32,
        },
        Body {
            branch: u8,
            offset: u32,
            remaining: u32,
        },
        Done,
    }
    pub(super) struct CorruptProof<S> {
        inner: S,
        phase: Phase,
        flipped: Arc<AtomicBool>,
    }
    impl<S> CorruptProof<S> {
        pub(super) fn new(inner: S, flipped: Arc<AtomicBool>) -> Self {
            Self {
                inner,
                phase: Phase::Banner(12),
                flipped,
            }
        }
        fn consume(&mut self, byte: &mut u8) {
            self.phase = match std::mem::replace(&mut self.phase, Phase::Done) {
                Phase::Banner(1) => Phase::OfferCount,
                Phase::Banner(n) => Phase::Banner(n - 1),
                Phase::OfferCount if *byte > 0 => Phase::Offers(usize::from(*byte)),
                Phase::Offers(1) => Phase::Length {
                    branch: 0,
                    read: 0,
                    value: 0,
                },
                Phase::Offers(n) => Phase::Offers(n - 1),
                Phase::Length {
                    branch,
                    read,
                    value,
                } => {
                    let value = (value << 8) | u32::from(*byte);
                    if read == 3 {
                        // 0=RSA key, 1=SRP challenge, 2=final M2 token.
                        let expected = [301, 1165, 98][usize::from(branch)];
                        if value == expected {
                            Phase::Body {
                                branch,
                                offset: 0,
                                remaining: value,
                            }
                        } else {
                            Phase::Done
                        }
                    } else {
                        Phase::Length {
                            branch,
                            read: read + 1,
                            value,
                        }
                    }
                }
                Phase::Body {
                    branch,
                    offset,
                    remaining,
                } => {
                    if branch == 2 && offset == 11 {
                        *byte ^= 1;
                        self.flipped.store(true, Ordering::SeqCst);
                    }
                    if remaining == 1 {
                        if branch == 2 {
                            Phase::Done
                        } else {
                            Phase::Length {
                                branch: branch + 1,
                                read: 0,
                                value: 0,
                            }
                        }
                    } else {
                        Phase::Body {
                            branch,
                            offset: offset + 1,
                            remaining: remaining - 1,
                        }
                    }
                }
                _ => Phase::Done,
            };
        }
    }
    impl<S: AsyncRead + Unpin> AsyncRead for CorruptProof<S> {
        fn poll_read(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            let before = buf.filled().len();
            let result = Pin::new(&mut self.inner).poll_read(cx, buf);
            if matches!(result, Poll::Ready(Ok(()))) {
                for byte in &mut buf.filled_mut()[before..] {
                    self.consume(byte);
                }
            }
            result
        }
    }
    impl<S: AsyncWrite + Unpin> AsyncWrite for CorruptProof<S> {
        fn poll_write(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &[u8],
        ) -> Poll<io::Result<usize>> {
            Pin::new(&mut self.inner).poll_write(cx, buf)
        }
        fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            Pin::new(&mut self.inner).poll_flush(cx)
        }
        fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            Pin::new(&mut self.inner).poll_shutdown(cx)
        }
    }
}

/// Run manually on the authorized Mac, through host-key-verified SSH and
/// literal loopback only. Credentials are generated and used on that Mac.
#[cfg(target_os = "macos")]
#[tokio::test]
#[ignore = "requires dedicated macOS test host and ephemeral credential"]
async fn exact_mac_rsa_srp_accepts_and_rejects_credentials() {
    use zeroize::Zeroizing;
    let address = std::env::var("OKOU_MAC_VNC_ADDR").expect("literal Mac loopback address");
    assert_eq!(address, "127.0.0.1:5900");
    let username = std::env::var("OKOU_MAC_VNC_USER").expect("test username");
    let password =
        Zeroizing::new(std::env::var("OKOU_MAC_VNC_PASSWORD").expect("one-time test password"));
    let good = AppleRsaSrpCredentials::new_zeroizing(
        username.clone(),
        Zeroizing::new(password.to_string()),
    )
    .expect("test credential");
    let stream = tokio::net::TcpStream::connect(&address)
        .await
        .expect("Mac loopback");
    stream
        .set_nodelay(true)
        .expect("disable Nagle for RSA1 request");
    let authenticated =
        authenticate_apple_rsa_srp(stream, good, Instant::now() + Duration::from_secs(30))
            .await
            .expect("valid type-33 proof and SecurityResult");
    drop(authenticated);

    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    let flipped = Arc::new(AtomicBool::new(false));
    let stream = tokio::net::TcpStream::connect(&address)
        .await
        .expect("Mac loopback proof control");
    stream
        .set_nodelay(true)
        .expect("disable Nagle for RSA1 request");
    let stream = mac_proof_fault::CorruptProof::new(stream, Arc::clone(&flipped));
    let proof_credential = AppleRsaSrpCredentials::new_zeroizing(
        username.clone(),
        Zeroizing::new(password.to_string()),
    )
    .expect("test credential for proof control");
    let outcome = authenticate_apple_rsa_srp(
        stream,
        proof_credential,
        Instant::now() + Duration::from_secs(30),
    )
    .await;
    assert!(
        flipped.load(Ordering::SeqCst),
        "Mac final proof was intercepted"
    );
    assert!(matches!(outcome, Err(Error::AuthenticationFailed)));

    let mut wrong_password = Zeroizing::new(password.to_string());
    wrong_password.push('!');
    let bad =
        AppleRsaSrpCredentials::new_zeroizing(username, wrong_password).expect("negative control");
    let stream = tokio::net::TcpStream::connect(&address)
        .await
        .expect("Mac loopback negative");
    stream
        .set_nodelay(true)
        .expect("disable Nagle for RSA1 request");
    assert!(
        authenticate_apple_rsa_srp(stream, bad, Instant::now() + Duration::from_secs(30))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn expired_deadline_reports_the_initial_stage() {
    let (client, _server) = duplex(128);
    assert!(matches!(
        authenticate_apple_rsa_srp(client, credentials(), Instant::now()).await,
        Err(Error::AuthenticationDeadlineExceeded {
            stage: AuthenticationStage::RfbVersion
        })
    ));
}

async fn negotiate(server: &mut DuplexStream, offer: &[u8]) {
    server.write_all(b"RFB 003.889\n").await.expect("banner");
    let mut version = [0; 12];
    server.read_exact(&mut version).await.expect("version");
    assert_eq!(&version, b"RFB 003.008\n");
    server
        .write_u8(offer.len() as u8)
        .await
        .expect("offer count");
    server.write_all(offer).await.expect("offer");
}

#[tokio::test]
async fn unavailable_type_33_never_downgrades_or_sends_credentials() {
    let (client, mut server) = duplex(64);
    let peer = tokio::spawn(async move {
        negotiate(&mut server, &[30, 36]).await;
        let mut byte = [0];
        assert_eq!(server.read(&mut byte).await.expect("closed"), 0);
    });
    assert!(matches!(
        authenticate_apple_rsa_srp(client, credentials(), deadline()).await,
        Err(Error::UnsupportedSecurity)
    ));
    peer.await.expect("peer task");
}

#[tokio::test]
async fn oversized_key_reply_is_rejected_before_allocating_or_sending_username() {
    let (client, mut server) = duplex(64);
    let peer = tokio::spawn(async move {
        negotiate(&mut server, &[33]).await;
        let mut selection = [0; 15];
        server
            .read_exact(&mut selection)
            .await
            .expect("RSA1 request");
        assert_eq!(selection[0], 33);
        server
            .write_u32(u32::MAX)
            .await
            .expect("oversized key length");
        let mut byte = [0];
        assert_eq!(server.read(&mut byte).await.expect("closed"), 0);
    });
    assert!(matches!(
        authenticate_apple_rsa_srp(client, credentials(), deadline()).await,
        Err(Error::InvalidAppleRsaSrpParameters)
    ));
    peer.await.expect("peer task");
}

#[tokio::test]
async fn short_rsa1_request_write_fails_without_replaying_remainder() {
    let (client, mut server) = duplex(1);
    let peer = tokio::spawn(async move {
        negotiate(&mut server, &[33]).await;
        assert_eq!(server.read_u8().await.expect("partial selection"), 33);
        let mut byte = [0];
        assert_eq!(server.read(&mut byte).await.expect("closed"), 0);
    });
    let (result, ()) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(
            authenticate_apple_rsa_srp(client, credentials(), deadline()),
            async { peer.await.expect("peer task") }
        )
    })
    .await
    .expect("bounded short-write outcome");
    assert!(
        matches!(result, Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::WriteZero)
    );
}

#[tokio::test(start_paused = true)]
async fn silent_key_peer_hits_the_shared_authentication_deadline() {
    let (client, mut server) = duplex(64);
    let caller = tokio::spawn(authenticate_apple_rsa_srp(
        client,
        credentials(),
        deadline(),
    ));
    negotiate(&mut server, &[33]).await;
    let mut request = [0; 15];
    server.read_exact(&mut request).await.expect("RSA1 request");
    tokio::time::advance(Duration::from_secs(21)).await;
    assert!(matches!(
        caller.await.expect("caller"),
        Err(Error::AuthenticationDeadlineExceeded {
            stage: AuthenticationStage::AppleRsaSrpAuthentication
        })
    ));
    let mut byte = [0];
    assert_eq!(server.read(&mut byte).await.expect("closed"), 0);
}

#[tokio::test]
async fn cancelling_while_waiting_for_key_closes_the_owned_stream() {
    let (client, mut server) = duplex(64);
    let caller = tokio::spawn(authenticate_apple_rsa_srp(
        client,
        credentials(),
        deadline(),
    ));
    negotiate(&mut server, &[33]).await;
    let mut request = [0; 15];
    server.read_exact(&mut request).await.expect("RSA1 request");
    caller.abort();
    assert!(matches!(caller.await, Err(error) if error.is_cancelled()));
    let mut byte = [0];
    assert_eq!(server.read(&mut byte).await.expect("closed"), 0);
}
