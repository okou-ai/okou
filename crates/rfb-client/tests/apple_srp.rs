#![allow(
    clippy::expect_used,
    clippy::indexing_slicing,
    reason = "synthetic peers and manual live fixture use assertions"
)]

use std::{
    io,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    task::{Context, Poll},
};

use crypto_bigint::{
    BoxedUint, Odd,
    modular::{BoxedMontyForm, BoxedMontyParams},
};
use rfb_client::{
    AppleSrpCredentials, AuthenticationStage, Error, Input, InputOutcome, Session, SharingMode,
    authenticate_apple_srp,
};
use sha2::{Digest, Sha256, Sha512};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream, ReadBuf, duplex},
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(20)
}

fn credentials() -> AppleSrpCredentials {
    AppleSrpCredentials::new("test-user".into(), "test-password".into())
        .expect("fixed test credentials")
}

async fn negotiate(server: &mut DuplexStream, offered: &[u8]) {
    server.write_all(b"RFB 003.889\n").await.expect("banner");
    let mut reply = [0; 12];
    server.read_exact(&mut reply).await.expect("version reply");
    assert_eq!(&reply, b"RFB 003.008\n");
    server
        .write_u8(offered.len() as u8)
        .await
        .expect("type count");
    server.write_all(offered).await.expect("types");
}

async fn read_username_entry(server: &mut DuplexStream) {
    negotiate(server, &[36]).await;
    assert_eq!(server.read_u8().await.expect("branch"), 36);
    let entry_len = server.read_u32().await.expect("entry length") as usize;
    assert!(entry_len <= 266);
    let mut entry = vec![0; entry_len];
    server.read_exact(&mut entry).await.expect("username entry");
}

fn group() -> Vec<u8> {
    let hex_group: String = include_str!("data/rfc5054_4096.hex")
        .chars()
        .filter(|c| !c.is_ascii_whitespace())
        .collect();
    let group = hex::decode(hex_group).expect("RFC 5054 test group hex");
    assert_eq!(group.len(), 512);
    assert_eq!(
        Sha256::digest(&group).as_slice(),
        hex::decode("4ee95187682bcb230ad26a95205f6920e84708f6251b3894329b09ec23919e33")
            .expect("group digest hex")
    );
    group
}

fn sha512(parts: &[&[u8]]) -> Vec<u8> {
    let mut hasher = Sha512::new();
    for part in parts {
        hasher.update(part);
    }
    hasher.finalize().to_vec()
}

/// Independent synthetic server: derives its verifier with the maintained
/// PBKDF2 crate, then uses the SRP server equation instead of reusing the
/// client's SRP implementation.
#[derive(Clone, Copy)]
enum PeerScenario {
    HandoffMarker,
    FragmentedSession,
    CorruptProof,
    RejectedStatus,
    WrongPassword,
}

async fn srp_peer(server: &mut DuplexStream, scenario: PeerScenario) {
    negotiate(server, &[30, 33, 36]).await;
    assert_eq!(server.read_u8().await.expect("branch"), 36);
    let entry_len = server.read_u32().await.expect("entry length") as usize;
    assert_eq!(entry_len, 20);
    let mut entry = vec![0; entry_len];
    server.read_exact(&mut entry).await.expect("entry");
    assert_eq!(
        u32::from_be_bytes(entry[..4].try_into().expect("entry inner")) as usize,
        entry_len - 4
    );
    let username_len = u16::from_be_bytes(entry[6..8].try_into().expect("username len")) as usize;
    assert_eq!(&entry[8..8 + username_len], b"test-user");

    let n_bytes = group();
    let n = BoxedUint::from_be_slice(&n_bytes, 4096).expect("N");
    let params =
        BoxedMontyParams::new_vartime(Option::<Odd<BoxedUint>>::from(Odd::new(n)).expect("odd N"));
    let g = BoxedMontyForm::new(BoxedUint::from_be_slice(&[5], 4096).expect("g"), &params);
    let salt = [0x13; 32];
    let mut derived = [0u8; 128];
    pbkdf2::pbkdf2_hmac::<Sha512>(b"test-password", &salt, 10_000, &mut derived);
    let x_inner = sha512(&[b":", &derived]);
    let x_hash = sha512(&[&salt, &x_inner]);
    let x = BoxedUint::from_be_slice(&x_hash, 4096).expect("x");
    let verifier = g.pow_bounded_exp(&x, 512);
    let mut g_padded = [0u8; 512];
    g_padded[511] = 5;
    let k_hash = sha512(&[&n_bytes, &g_padded]);
    let k = BoxedMontyForm::new(BoxedUint::from_be_slice(&k_hash, 4096).expect("k"), &params);
    let b_private = BoxedUint::from_be_slice(&[17], 4096).expect("b");
    let b_public = (&k * &verifier + g.pow_bounded_exp(&b_private, 8))
        .retrieve()
        .to_be_bytes();

    let mut challenge = Vec::new();
    challenge.extend_from_slice(&[0; 4]);
    challenge.push(0);
    challenge.extend_from_slice(&(512u16).to_be_bytes());
    challenge.extend_from_slice(&n_bytes);
    challenge.extend_from_slice(&(1u16).to_be_bytes());
    challenge.push(5);
    challenge.push(32);
    challenge.extend_from_slice(&salt);
    challenge.extend_from_slice(&(512u16).to_be_bytes());
    challenge.extend_from_slice(&b_public);
    challenge.extend_from_slice(&(10_000u64).to_be_bytes());
    challenge.extend_from_slice(&(80u16).to_be_bytes());
    challenge.extend_from_slice(&[0x31; 80]);
    let inner_len = (challenge.len() - 4) as u32;
    challenge[..4].copy_from_slice(&inner_len.to_be_bytes());
    server
        .write_u32(challenge.len() as u32)
        .await
        .expect("challenge outer");
    if matches!(scenario, PeerScenario::FragmentedSession) {
        for fragment in challenge.chunks(17) {
            server
                .write_all(fragment)
                .await
                .expect("challenge fragment");
            tokio::task::yield_now().await;
        }
    } else {
        server.write_all(&challenge).await.expect("challenge");
    }

    let response_len = server.read_u32().await.expect("response outer") as usize;
    assert_eq!(response_len, 682);
    let mut response = vec![0; response_len];
    server.read_exact(&mut response).await.expect("response");
    assert_eq!(
        u32::from_be_bytes(response[..4].try_into().expect("response inner")) as usize,
        response_len - 4
    );
    assert_eq!(
        u16::from_be_bytes(response[4..6].try_into().expect("A length")),
        512
    );
    let a_bytes = &response[6..518];
    assert_eq!(response[518], 64);
    let m1 = &response[519..583];
    assert_eq!(
        u16::from_be_bytes(response[583..585].try_into().expect("options length")),
        80
    );
    assert_eq!(&response[585..665], &[0x31; 80]);
    assert_eq!(response[665], 16);
    assert_eq!(response.len(), 682);

    let a = BoxedMontyForm::new(BoxedUint::from_be_slice(a_bytes, 4096).expect("A"), &params);
    let u_hash = sha512(&[a_bytes, &b_public]);
    let u = BoxedUint::from_be_slice(&u_hash, 4096).expect("u");
    let shared = (a * verifier.pow_bounded_exp(&u, 512))
        .pow_bounded_exp(&b_private, 8)
        .retrieve()
        .to_be_bytes();
    let session_key = sha512(&[&shared]);
    let h_n = sha512(&[&n_bytes]);
    let h_g = sha512(&[&g_padded]);
    let xor_ng: Vec<u8> = h_n.iter().zip(h_g.iter()).map(|(n, g)| n ^ g).collect();
    let h_empty = sha512(&[b""]);
    let expected_m1 = sha512(&[&xor_ng, &h_empty, &salt, a_bytes, &b_public, &session_key]);
    if m1 != expected_m1 {
        server.write_u32(1).await.expect("reject invalid M1");
        return;
    }
    let mut m2 = sha512(&[a_bytes, m1, &session_key]);
    if matches!(scenario, PeerScenario::CorruptProof) {
        m2[0] ^= 1;
    }
    let mut final_token = Vec::with_capacity(92);
    final_token.extend_from_slice(&(88u32).to_be_bytes());
    final_token.push(64);
    final_token.extend_from_slice(&m2);
    final_token.push(16);
    final_token.extend_from_slice(&[0x47; 16]);
    final_token.extend_from_slice(&(0u16).to_be_bytes());
    final_token.extend_from_slice(&(0u32).to_be_bytes());
    assert_eq!(final_token.len(), 92);
    server.write_u32(92).await.expect("final outer");
    server.write_all(&final_token).await.expect("final token");
    if !matches!(scenario, PeerScenario::CorruptProof) {
        server
            .write_u32(u32::from(matches!(scenario, PeerScenario::RejectedStatus)))
            .await
            .expect("security result");
        if matches!(scenario, PeerScenario::RejectedStatus) {
            server.write_u32(0).await.expect("empty failure reason");
        } else if matches!(scenario, PeerScenario::HandoffMarker) {
            server.write_u8(0x42).await.expect("handoff marker");
        }
    }
}

#[tokio::test]
async fn exact_type_36_authenticates_and_hands_off_stream() {
    let (client, mut server) = duplex(4096);
    let peer =
        tokio::spawn(async move { srp_peer(&mut server, PeerScenario::HandoffMarker).await });
    let authenticated = authenticate_apple_srp(client, credentials(), deadline())
        .await
        .expect("SRP success");
    let mut stream = authenticated.into_stream();
    assert_eq!(stream.read_u8().await.expect("post-auth marker"), 0x42);
    peer.await.expect("peer");
}

#[tokio::test]
async fn authenticated_stream_supports_capture_and_bounded_input() {
    let (client, mut server) = duplex(4096);
    let peer = tokio::spawn(async move {
        srp_peer(&mut server, PeerScenario::FragmentedSession).await;
        assert_eq!(server.read_u8().await.expect("ClientInit"), 1);
        let mut init = Vec::new();
        init.extend_from_slice(&1u16.to_be_bytes());
        init.extend_from_slice(&1u16.to_be_bytes());
        init.extend_from_slice(&[32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 0, 8, 16, 0, 0, 0]);
        init.extend_from_slice(&0u32.to_be_bytes());
        server.write_all(&init).await.expect("ServerInit");

        let mut pixel_format = [0; 20];
        server
            .read_exact(&mut pixel_format)
            .await
            .expect("pixel format");
        assert_eq!(&pixel_format[..4], &[0; 4]);
        let mut encodings = [0; 24];
        server.read_exact(&mut encodings).await.expect("encodings");
        assert_eq!(&encodings[..4], &[2, 0, 0, 5]);

        let mut update_request = [0; 10];
        server
            .read_exact(&mut update_request)
            .await
            .expect("framebuffer request");
        assert_eq!(update_request, [3, 0, 0, 0, 0, 0, 0, 1, 0, 1]);
        server
            .write_all(&[0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 255, 0, 0, 0])
            .await
            .expect("red framebuffer update");

        let mut keys = [0; 16];
        server
            .read_exact(&mut keys)
            .await
            .expect("balanced key input");
        assert_eq!(keys, [4, 1, 0, 0, 0, 0, 0, 65, 4, 0, 0, 0, 0, 0, 0, 65]);
    });
    let client = async {
        let authenticated = authenticate_apple_srp(client, credentials(), deadline())
            .await
            .expect("SRP success");
        let connection = authenticated
            .initialize(SharingMode::Shared, deadline())
            .await
            .expect("framebuffer initialization");
        let mut session = Session::new(connection);
        let capture = session.capture(deadline()).await.expect("capture");
        assert_eq!(
            (capture.metadata().width, capture.metadata().height),
            (1, 1)
        );
        let mut reader = png::Decoder::new(std::io::Cursor::new(capture.png()))
            .read_info()
            .expect("PNG header");
        let mut pixels = vec![0; reader.output_buffer_size().expect("PNG capacity")];
        let frame = reader.next_frame(&mut pixels).expect("PNG frame");
        assert_eq!(&pixels[..frame.buffer_size()], &[255, 0, 0, 255]);
        let mut outcome = InputOutcome::NotStarted;
        session
            .input(Input::Text("A"), &mut outcome, deadline())
            .await
            .expect("bounded key input");
        assert_eq!(outcome, InputOutcome::Sent);
        session.close();
    };
    let ((), ()) = tokio::time::timeout(Duration::from_secs(20), async {
        tokio::join!(client, async { peer.await.expect("peer") })
    })
    .await
    .expect("synthetic session deadline");
}

#[tokio::test]
async fn corrupt_server_proof_never_yields_a_session() {
    let (client, mut server) = duplex(4096);
    let peer = tokio::spawn(async move { srp_peer(&mut server, PeerScenario::CorruptProof).await });
    let result = authenticate_apple_srp(client, credentials(), deadline()).await;
    assert!(matches!(result, Err(Error::AuthenticationFailed)));
    peer.await.expect("peer");
}

#[tokio::test]
async fn wrong_password_never_yields_a_session() {
    let (client, mut server) = duplex(4096);
    let peer =
        tokio::spawn(async move { srp_peer(&mut server, PeerScenario::WrongPassword).await });
    let wrong = AppleSrpCredentials::new("test-user".into(), "wrong-password".into())
        .expect("fixed wrong credential");
    assert!(matches!(
        authenticate_apple_srp(client, wrong, deadline()).await,
        Err(Error::AuthenticationFailed)
    ));
    peer.await.expect("peer");
}

#[tokio::test]
async fn rejected_security_result_never_yields_a_session() {
    let (client, mut server) = duplex(4096);
    let peer =
        tokio::spawn(async move { srp_peer(&mut server, PeerScenario::RejectedStatus).await });
    let result = authenticate_apple_srp(client, credentials(), deadline()).await;
    assert!(matches!(result, Err(Error::AuthenticationFailed)));
    peer.await.expect("peer");
}

#[tokio::test]
async fn credentials_are_bounded_and_redacted() {
    let value = credentials();
    assert_eq!(format!("{value:?}"), "AppleSrpCredentials([REDACTED])");
    assert!(matches!(
        AppleSrpCredentials::new("".into(), "p".into()),
        Err(Error::InvalidAppleSrpUsername)
    ));
    assert!(matches!(
        AppleSrpCredentials::new("u".into(), "".into()),
        Err(Error::InvalidAppleSrpPassword)
    ));
    assert!(matches!(
        AppleSrpCredentials::new("ü".repeat(128), "p".into()),
        Err(Error::InvalidAppleSrpUsername)
    ));
    assert!(matches!(
        AppleSrpCredentials::new("u".into(), "p".repeat(1024)),
        Err(Error::InvalidAppleSrpPassword)
    ));
    assert!(matches!(
        AppleSrpCredentials::new("u\0".into(), "p".into()),
        Err(Error::InvalidAppleSrpUsername)
    ));
    assert!(matches!(
        AppleSrpCredentials::new("u".into(), "p\0".into()),
        Err(Error::InvalidAppleSrpPassword)
    ));
}

#[tokio::test]
async fn unavailable_type_36_never_falls_back() {
    let (client, mut server) = duplex(64);
    let peer = tokio::spawn(async move {
        negotiate(&mut server, &[30, 33]).await;
        let mut byte = [0];
        assert_eq!(server.read(&mut byte).await.expect("read close"), 0);
    });
    let result = authenticate_apple_srp(client, credentials(), deadline()).await;
    assert!(matches!(result, Err(Error::UnsupportedSecurity)));
    peer.await.expect("peer");
}

#[tokio::test]
async fn malformed_challenge_is_rejected_before_password_work() {
    let (client, mut server) = duplex(512);
    let peer = tokio::spawn(async move {
        read_username_entry(&mut server).await;
        server.write_u32(4).await.expect("blob length");
        server.write_u32(1).await.expect("incorrect inner length");
        let mut byte = [0];
        assert_eq!(server.read(&mut byte).await.expect("read close"), 0);
    });
    let result = authenticate_apple_srp(client, credentials(), deadline()).await;
    assert!(matches!(result, Err(Error::InvalidAppleSrpParameters)));
    peer.await.expect("peer");
}

#[tokio::test]
async fn oversized_challenge_is_rejected_without_reading_or_allocating_it() {
    let (client, mut server) = duplex(512);
    let peer = tokio::spawn(async move {
        read_username_entry(&mut server).await;
        server.write_u32(u32::MAX).await.expect("oversized length");
        let mut byte = [0];
        assert_eq!(server.read(&mut byte).await.expect("read close"), 0);
    });
    let result = authenticate_apple_srp(client, credentials(), deadline()).await;
    assert!(matches!(result, Err(Error::InvalidAppleSrpParameters)));
    peer.await.expect("peer");
}

#[tokio::test]
async fn a_short_branch_write_fails_closed_without_replaying_the_remainder() {
    let (client, mut server) = duplex(1);
    let peer = tokio::spawn(async move {
        negotiate(&mut server, &[36]).await;
        assert_eq!(server.read_u8().await.expect("partial branch"), 36);
        let mut byte = [0];
        assert_eq!(server.read(&mut byte).await.expect("read close"), 0);
    });
    let (result, ()) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(
            authenticate_apple_srp(client, credentials(), deadline()),
            async { peer.await.expect("peer") }
        )
    })
    .await
    .expect("short-write deadline");
    assert!(
        matches!(result, Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::WriteZero)
    );
}

#[tokio::test]
async fn truncated_challenge_closes_the_owned_stream() {
    let (client, mut server) = duplex(512);
    let peer = tokio::spawn(async move {
        read_username_entry(&mut server).await;
        server.write_u32(10).await.expect("challenge length");
        server
            .write_all(&[0, 0, 0])
            .await
            .expect("partial challenge");
        server.shutdown().await.expect("peer EOF");
        let mut byte = [0];
        assert_eq!(server.read(&mut byte).await.expect("read close"), 0);
    });
    let result = authenticate_apple_srp(client, credentials(), deadline()).await;
    assert!(
        matches!(result, Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::UnexpectedEof)
    );
    peer.await.expect("peer");
}

#[tokio::test]
async fn cancellation_while_waiting_for_challenge_closes_the_owned_stream() {
    let (client, mut server) = duplex(512);
    let caller = tokio::spawn(authenticate_apple_srp(client, credentials(), deadline()));
    read_username_entry(&mut server).await;
    caller.abort();
    assert!(matches!(caller.await, Err(error) if error.is_cancelled()));
    let mut byte = [0];
    assert_eq!(server.read(&mut byte).await.expect("read close"), 0);
}

#[tokio::test(start_paused = true)]
async fn silent_challenge_peer_hits_the_shared_authentication_deadline() {
    let (client, mut server) = duplex(512);
    let caller = tokio::spawn(authenticate_apple_srp(client, credentials(), deadline()));
    read_username_entry(&mut server).await;
    tokio::time::advance(Duration::from_secs(21)).await;
    assert!(matches!(
        caller.await.expect("authentication task"),
        Err(Error::AuthenticationDeadlineExceeded {
            stage: AuthenticationStage::AppleSrpAuthentication
        })
    ));
    let mut byte = [0];
    assert_eq!(server.read(&mut byte).await.expect("read close"), 0);
}

#[tokio::test]
async fn expired_deadline_writes_nothing() {
    let (client, mut server) = duplex(64);
    let result = authenticate_apple_srp(client, credentials(), Instant::now()).await;
    assert!(matches!(
        result,
        Err(Error::AuthenticationDeadlineExceeded {
            stage: AuthenticationStage::RfbVersion
        })
    ));
    let mut byte = [0];
    assert_eq!(server.read(&mut byte).await.expect("read close"), 0);
}

// Manual Mac-only fault injection: parse only public framing lengths and flip
// one byte of the final server proof. No packet content is logged or retained.
enum MacReadPhase {
    Banner(u8),
    OfferCount,
    Offers(u8),
    ChallengeLength { read: u8, length: u32 },
    Challenge(u32),
    FinalLength { read: u8, length: u32 },
    Final { offset: u32, remaining: u32 },
    Done,
}

struct CorruptMacProof<S> {
    inner: S,
    phase: MacReadPhase,
    flipped: Arc<AtomicBool>,
}

impl<S> CorruptMacProof<S> {
    fn new(inner: S, flipped: Arc<AtomicBool>) -> Self {
        Self {
            inner,
            phase: MacReadPhase::Banner(12),
            flipped,
        }
    }

    fn consume(&mut self, byte: &mut u8) {
        self.phase = match std::mem::replace(&mut self.phase, MacReadPhase::Done) {
            MacReadPhase::Banner(1) => MacReadPhase::OfferCount,
            MacReadPhase::Banner(remaining) => MacReadPhase::Banner(remaining - 1),
            MacReadPhase::OfferCount if *byte > 0 => MacReadPhase::Offers(*byte),
            MacReadPhase::OfferCount => MacReadPhase::Done,
            MacReadPhase::Offers(1) => MacReadPhase::ChallengeLength { read: 0, length: 0 },
            MacReadPhase::Offers(remaining) => MacReadPhase::Offers(remaining - 1),
            MacReadPhase::ChallengeLength { read, length } => {
                let length = (length << 8) | u32::from(*byte);
                if read == 3 {
                    MacReadPhase::Challenge(length)
                } else {
                    MacReadPhase::ChallengeLength {
                        read: read + 1,
                        length,
                    }
                }
            }
            MacReadPhase::Challenge(1) => MacReadPhase::FinalLength { read: 0, length: 0 },
            MacReadPhase::Challenge(remaining) => MacReadPhase::Challenge(remaining - 1),
            MacReadPhase::FinalLength { read, length } => {
                let length = (length << 8) | u32::from(*byte);
                if read == 3 {
                    MacReadPhase::Final {
                        offset: 0,
                        remaining: length,
                    }
                } else {
                    MacReadPhase::FinalLength {
                        read: read + 1,
                        length,
                    }
                }
            }
            MacReadPhase::Final { offset, remaining } => {
                if offset == 5 {
                    *byte ^= 1;
                    self.flipped.store(true, Ordering::SeqCst);
                }
                if remaining == 1 {
                    MacReadPhase::Done
                } else {
                    MacReadPhase::Final {
                        offset: offset + 1,
                        remaining: remaining - 1,
                    }
                }
            }
            MacReadPhase::Done => MacReadPhase::Done,
        };
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for CorruptMacProof<S> {
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

impl<S: AsyncWrite + Unpin> AsyncWrite for CorruptMacProof<S> {
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

#[tokio::test]
async fn mac_proof_fault_injector_changes_only_m2() {
    let (client, mut server) = duplex(256);
    let flipped = Arc::new(AtomicBool::new(false));
    let mut client = CorruptMacProof::new(client, Arc::clone(&flipped));
    let mut wire = b"RFB 003.889\n".to_vec();
    wire.extend_from_slice(&[1, 36]);
    wire.extend_from_slice(&4u32.to_be_bytes());
    wire.extend_from_slice(&[0; 4]);
    wire.extend_from_slice(&92u32.to_be_bytes());
    wire.extend_from_slice(&[0x44; 92]);
    server.write_all(&wire).await.expect("synthetic stream");

    let mut received = vec![0; wire.len()];
    for chunk in received.chunks_mut(7) {
        client.read_exact(chunk).await.expect("fragmented read");
    }
    let proof_byte = wire.len() - 92 + 5;
    wire[proof_byte] ^= 1;
    assert_eq!(received, wire);
    assert!(flipped.load(Ordering::SeqCst));
}

/// Run manually with a one-time credential on the dedicated Mac test host.
/// This tests authentication only; it does not initialize, capture or control
/// the desktop, and it does not enable any product route.
#[tokio::test]
#[ignore = "requires dedicated macOS test host and ephemeral credential"]
async fn exact_mac_direct_srp_accepts_and_rejects_credentials_and_bad_proof() {
    let address = std::env::var("OKOU_MAC_VNC_ADDR").expect("test host address");
    let username = std::env::var("OKOU_MAC_VNC_USER").expect("test username");
    let password = std::env::var("OKOU_MAC_VNC_PASSWORD").expect("one-time test password");
    let proof_password = Zeroizing::new(password.clone());
    let mut wrong_password = Zeroizing::new(password.clone());
    wrong_password.push('!');
    let stream = tokio::net::TcpStream::connect(&address)
        .await
        .expect("connect test host");
    let credentials =
        AppleSrpCredentials::new(username.clone(), password).expect("valid test credential");
    let authenticated = authenticate_apple_srp(
        stream,
        credentials,
        Instant::now() + Duration::from_secs(30),
    )
    .await
    .expect("direct SRP authentication");
    drop(authenticated);

    let stream = tokio::net::TcpStream::connect(&address)
        .await
        .expect("connect test host for proof control");
    let flipped = Arc::new(AtomicBool::new(false));
    let stream = CorruptMacProof::new(stream, Arc::clone(&flipped));
    let credentials = AppleSrpCredentials::new_zeroizing(username.clone(), proof_password)
        .expect("valid proof-control credential");
    let result = authenticate_apple_srp(
        stream,
        credentials,
        Instant::now() + Duration::from_secs(30),
    )
    .await;
    assert!(
        flipped.load(Ordering::SeqCst),
        "server proof was intercepted"
    );
    assert!(matches!(result, Err(Error::AuthenticationFailed)));

    // The successful handshake above is the same-host positive control for a
    // fresh connection using an intentionally different password.
    let stream = tokio::net::TcpStream::connect(address)
        .await
        .expect("connect test host for negative control");
    let wrong = AppleSrpCredentials::new_zeroizing(username, wrong_password)
        .expect("valid negative-control credential");
    assert!(
        authenticate_apple_srp(stream, wrong, Instant::now() + Duration::from_secs(30))
            .await
            .is_err()
    );
}
