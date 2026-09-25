#![allow(
    clippy::unwrap_used,
    reason = "bounded synthetic RFB peers and test assertions"
)]

use std::{io, time::Duration};

use rfb_client::{AuthenticationStage, Error, VncPassword, authenticate_apple_vnc_password};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, DuplexStream, duplex},
    time::{Instant, timeout},
};
use zeroize::Zeroizing;

const BANNER: &[u8; 12] = b"RFB 003.889\n";
const REPLY: &[u8; 12] = b"RFB 003.008\n";
const CHALLENGE: &[u8; 16] = b"0123456789abcdef";
// Independent OpenSSL DES-ECB vector for password " secret ".
const RESPONSE: &[u8; 16] = &[
    0x34, 0x57, 0xe0, 0xfd, 0xf6, 0xe8, 0x42, 0x5e, 0x58, 0xb4, 0xdf, 0x6b, 0x1b, 0xe5, 0x22, 0x13,
];

fn password() -> VncPassword {
    VncPassword::new(" secret ".to_owned()).unwrap()
}

fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(5)
}

async fn negotiate(server: &mut DuplexStream, offered: &[u8]) {
    server.write_all(BANNER).await.unwrap();
    let mut reply = [0; 12];
    server.read_exact(&mut reply).await.unwrap();
    assert_eq!(&reply, REPLY);
    server.write_u8(offered.len() as u8).await.unwrap();
    server.write_all(offered).await.unwrap();
}

#[tokio::test]
async fn authenticates_exact_type_two_and_preserves_post_auth_stream() {
    let (client, mut server) = duplex(512);
    let peer = tokio::spawn(async move {
        negotiate(&mut server, &[30, 33, 36, 19, 2]).await;
        assert_eq!(server.read_u8().await.unwrap(), 2);
        server.write_all(CHALLENGE).await.unwrap();
        let mut response = [0; 16];
        server.read_exact(&mut response).await.unwrap();
        assert_eq!(&response, RESPONSE);
        server.write_u32(0).await.unwrap();
        server.write_u8(0x42).await.unwrap();
        server.flush().await.unwrap();
        assert_eq!(server.read_u8().await.unwrap(), 1); // ClientInit remains caller-owned.
        let mut byte = [0; 1];
        assert_eq!(server.read(&mut byte).await.unwrap(), 0);
    });
    let mut stream = authenticate_apple_vnc_password(client, password(), deadline())
        .await
        .unwrap()
        .into_stream();
    assert_eq!(stream.read_u8().await.unwrap(), 0x42);
    stream.write_u8(1).await.unwrap();
    drop(stream);
    peer.await.unwrap();
}

#[tokio::test]
async fn wrong_password_never_returns_an_authenticated_stream() {
    let (client, mut server) = duplex(512);
    let peer = tokio::spawn(async move {
        negotiate(&mut server, &[2]).await;
        assert_eq!(server.read_u8().await.unwrap(), 2);
        server.write_all(CHALLENGE).await.unwrap();
        let mut response = [0; 16];
        server.read_exact(&mut response).await.unwrap();
        assert_ne!(&response, RESPONSE);
        server.write_u32(1).await.unwrap();
        server.write_u32(0).await.unwrap();
    });
    let wrong = VncPassword::new("different".to_owned());
    assert!(matches!(wrong, Err(Error::InvalidPassword))); // No silent truncation.
    let wrong = VncPassword::new("badpass!".to_owned()).unwrap();
    let result = authenticate_apple_vnc_password(client, wrong, deadline()).await;
    assert!(matches!(result, Err(Error::AuthenticationFailed)));
    peer.await.unwrap();
}

#[tokio::test]
async fn mac_classic_swapped_failure_result_is_authentication_failure() {
    let (client, mut server) = duplex(512);
    let peer = tokio::spawn(async move {
        negotiate(&mut server, &[30, 33, 36, 2]).await;
        assert_eq!(server.read_u8().await.unwrap(), 2);
        server.write_all(CHALLENGE).await.unwrap();
        let mut response = [0; 16];
        server.read_exact(&mut response).await.unwrap();
        assert_ne!(&response, RESPONSE);
        // Observed on macOS 26.6.2: status 01 00 00 00, followed by a
        // network-order, bounded failure-reason length. Never log its body.
        server.write_all(&[1, 0, 0, 0]).await.unwrap();
        server.write_u32(39).await.unwrap();
        server.write_all(&[b'x'; 39]).await.unwrap();
    });
    let wrong = VncPassword::new("badpass!".to_owned()).unwrap();
    let result = authenticate_apple_vnc_password(client, wrong, deadline()).await;
    assert!(matches!(result, Err(Error::AuthenticationFailed)));
    peer.await.unwrap();
}

#[tokio::test]
async fn mac_classic_swapped_failure_reason_remains_bounded() {
    let (client, mut server) = duplex(128);
    let peer = tokio::spawn(async move {
        negotiate(&mut server, &[2]).await;
        assert_eq!(server.read_u8().await.unwrap(), 2);
        server.write_all(CHALLENGE).await.unwrap();
        let mut response = [0; 16];
        server.read_exact(&mut response).await.unwrap();
        server.write_all(&[1, 0, 0, 0]).await.unwrap();
        server.write_u32(4097).await.unwrap();
        let mut byte = [0; 1];
        assert_eq!(server.read(&mut byte).await.unwrap(), 0);
    });
    let result = authenticate_apple_vnc_password(client, password(), deadline()).await;
    assert!(matches!(result, Err(Error::RemoteDataTooLarge)));
    peer.await.unwrap();
}

#[tokio::test]
async fn absent_type_two_cannot_select_an_offered_fallback() {
    let (client, mut server) = duplex(128);
    let peer = tokio::spawn(async move {
        negotiate(&mut server, &[30, 33, 36, 19, 1]).await;
        let mut byte = [0; 1];
        assert_eq!(server.read(&mut byte).await.unwrap(), 0);
    });
    let result = authenticate_apple_vnc_password(client, password(), deadline()).await;
    assert!(matches!(result, Err(Error::UnsupportedSecurity)));
    peer.await.unwrap();
}

#[tokio::test]
async fn maximum_offer_count_is_bounded_and_selects_only_type_two() {
    let (client, mut server) = duplex(1024);
    let peer = tokio::spawn(async move {
        let mut offered = [30u8; u8::MAX as usize];
        offered[offered.len() - 1] = 2;
        negotiate(&mut server, &offered).await;
        assert_eq!(server.read_u8().await.unwrap(), 2);
        server.write_all(CHALLENGE).await.unwrap();
        let mut response = [0; 16];
        server.read_exact(&mut response).await.unwrap();
        assert_eq!(&response, RESPONSE);
        server.write_u32(0).await.unwrap();
    });
    assert!(
        authenticate_apple_vnc_password(client, password(), deadline())
            .await
            .is_ok()
    );
    peer.await.unwrap();
}

#[tokio::test]
async fn rejects_incorrect_and_incomplete_apple_banner_without_a_reply() {
    for banner in [b"RFB 003.008\n".as_slice(), b"RFB 003.88".as_slice()] {
        let (client, mut server) = duplex(64);
        server.write_all(banner).await.unwrap();
        server.shutdown().await.unwrap();
        let result = authenticate_apple_vnc_password(client, password(), deadline()).await;
        assert!(matches!(
            result,
            Err(Error::UnsupportedRfbVersion | Error::Io(_))
        ));
        let mut byte = [0; 1];
        assert_eq!(server.read(&mut byte).await.unwrap(), 0);
    }
}

#[tokio::test]
async fn zero_offer_discards_bounded_reason_without_leaking_it() {
    let (client, mut server) = duplex(128);
    let peer = tokio::spawn(async move {
        negotiate(&mut server, &[]).await;
        server.write_u32(6).await.unwrap();
        server.write_all(b"secret").await.unwrap();
    });
    let result = authenticate_apple_vnc_password(client, password(), deadline()).await;
    assert!(matches!(result, Err(Error::ServerRejected)));
    assert!(!format!("{:?}", result.err().unwrap()).contains("secret"));
    peer.await.unwrap();
}

#[tokio::test]
async fn rejects_oversized_zero_offer_reason_before_reading_peer_bytes() {
    let (client, mut server) = duplex(64);
    let peer = tokio::spawn(async move {
        negotiate(&mut server, &[]).await;
        server.write_u32(4097).await.unwrap();
        let mut byte = [0; 1];
        assert_eq!(server.read(&mut byte).await.unwrap(), 0);
    });
    let result = authenticate_apple_vnc_password(client, password(), deadline()).await;
    assert!(matches!(result, Err(Error::RemoteDataTooLarge)));
    peer.await.unwrap();
}

#[tokio::test]
async fn malformed_truncated_and_oversized_results_fail_closed() {
    #[derive(Clone, Copy, Debug)]
    enum Case {
        Invalid,
        Short,
        OversizedReason,
        ShortReason,
        WrongNoReason,
    }
    for case in [
        Case::Invalid,
        Case::Short,
        Case::OversizedReason,
        Case::ShortReason,
        Case::WrongNoReason,
    ] {
        let (client, mut server) = duplex(512);
        let peer = tokio::spawn(async move {
            negotiate(&mut server, &[2]).await;
            assert_eq!(server.read_u8().await.unwrap(), 2);
            server.write_all(CHALLENGE).await.unwrap();
            let mut response = [0; 16];
            server.read_exact(&mut response).await.unwrap();
            assert_eq!(&response, RESPONSE);
            match case {
                Case::Invalid => server.write_u32(2).await.unwrap(),
                Case::Short => server.write_all(&[0, 0]).await.unwrap(),
                Case::OversizedReason => {
                    server.write_u32(1).await.unwrap();
                    server.write_u32(4097).await.unwrap();
                }
                Case::ShortReason => {
                    server.write_u32(1).await.unwrap();
                    server.write_u32(5).await.unwrap();
                    server.write_all(b"ab").await.unwrap();
                }
                Case::WrongNoReason => server.write_u32(1).await.unwrap(),
            }
        });
        let result = authenticate_apple_vnc_password(client, password(), deadline()).await;
        assert!(result.is_err(), "accepted malformed {case:?}");
        assert!(!format!("{:?}", result.err().unwrap()).contains("ab"));
        peer.await.unwrap();
    }
}

#[tokio::test]
async fn short_challenge_never_produces_a_password_response() {
    let (client, mut server) = duplex(128);
    let peer = tokio::spawn(async move {
        negotiate(&mut server, &[2]).await;
        assert_eq!(server.read_u8().await.unwrap(), 2);
        server.write_all(b"partial!").await.unwrap();
        server.shutdown().await.unwrap();
        let mut byte = [0; 1];
        assert_eq!(server.read(&mut byte).await.unwrap(), 0);
    });
    let result = authenticate_apple_vnc_password(client, password(), deadline()).await;
    assert!(matches!(result, Err(Error::Io(_))));
    peer.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn deadlines_identify_the_current_stage_and_close_owned_stream() {
    let (client, mut server) = duplex(128);
    assert!(matches!(
        authenticate_apple_vnc_password(client, password(), Instant::now()).await,
        Err(Error::AuthenticationDeadlineExceeded {
            stage: AuthenticationStage::RfbVersion
        })
    ));
    let mut byte = [0; 1];
    assert_eq!(server.read(&mut byte).await.unwrap(), 0);

    let (client, mut server) = duplex(128);
    let caller = tokio::spawn(authenticate_apple_vnc_password(
        client,
        password(),
        Instant::now() + Duration::from_secs(2),
    ));
    server.write_all(BANNER).await.unwrap();
    let mut version = [0; 12];
    server.read_exact(&mut version).await.unwrap();
    assert_eq!(&version, REPLY);
    tokio::time::advance(Duration::from_secs(3)).await;
    assert!(matches!(
        caller.await.unwrap(),
        Err(Error::AuthenticationDeadlineExceeded {
            stage: AuthenticationStage::SecurityNegotiation
        })
    ));
    assert_eq!(server.read(&mut byte).await.unwrap(), 0);

    let (client, mut server) = duplex(128);
    let caller = tokio::spawn(authenticate_apple_vnc_password(
        client,
        password(),
        Instant::now() + Duration::from_secs(2),
    ));
    negotiate(&mut server, &[2]).await;
    assert_eq!(server.read_u8().await.unwrap(), 2);
    tokio::time::advance(Duration::from_secs(3)).await;
    assert!(matches!(
        caller.await.unwrap(),
        Err(Error::AuthenticationDeadlineExceeded {
            stage: AuthenticationStage::VncAuthentication
        })
    ));
    assert_eq!(server.read(&mut byte).await.unwrap(), 0);
}

#[tokio::test]
async fn cancellation_drops_stream_without_a_password_response() {
    let (client, mut server) = duplex(128);
    let pending = tokio::spawn(authenticate_apple_vnc_password(
        client,
        password(),
        Instant::now() + Duration::from_secs(5),
    ));
    negotiate(&mut server, &[2]).await;
    assert_eq!(server.read_u8().await.unwrap(), 2);
    pending.abort();
    let _ = pending.await;
    let mut byte = [0; 1];
    assert_eq!(
        timeout(Duration::from_secs(1), server.read(&mut byte))
            .await
            .unwrap()
            .unwrap(),
        0
    );
}

#[tokio::test]
#[ignore = "requires authorized macOS classic-password fixture and verified SSH-to-loopback with PF rollback"]
async fn authorized_mac_loopback_accepts_and_rejects_synthetic_password() {
    use tokio::net::TcpStream;
    let raw = Zeroizing::new(std::env::var("OKOU_VNC_TEST_PASSWORD").unwrap());
    let correct = VncPassword::new_zeroizing(raw).unwrap();
    let stream = TcpStream::connect("127.0.0.1:5900").await.unwrap();
    let accepted = authenticate_apple_vnc_password(stream, correct, deadline()).await;
    assert!(accepted.is_ok(), "correct synthetic password rejected");
    drop(accepted);
    let wrong = VncPassword::new("wrong???".to_owned()).unwrap();
    let stream = TcpStream::connect("127.0.0.1:5900").await.unwrap();
    let rejected = authenticate_apple_vnc_password(stream, wrong, deadline()).await;
    let outcome = match &rejected {
        Err(Error::AuthenticationFailed) => "authentication_failed",
        Err(Error::Io(_)) => "connection_closed",
        Err(Error::AuthenticationDeadlineExceeded {
            stage: AuthenticationStage::VncAuthentication,
        }) => "stage_deadline",
        Err(Error::InvalidAuthenticationResult) => "invalid_security_result",
        Err(Error::RemoteDataTooLarge) => "oversized_failure_reason",
        Err(Error::ServerRejected) => "rejected_before_authentication",
        Err(Error::UnsupportedSecurity) => "type_two_not_offered",
        _ => "other",
    };
    eprintln!("mac_wrong_password_outcome={outcome}");
    // The tested Mac returned a nonstandard nonzero SecurityResult for a wrong
    // password; another server may omit the optional reason or close instead.
    assert!(
        matches!(
            &rejected,
            Err(Error::AuthenticationFailed
                | Error::InvalidAuthenticationResult
                | Error::Io(_)
                | Error::AuthenticationDeadlineExceeded {
                    stage: AuthenticationStage::VncAuthentication
                })
        ),
        "wrong password did not fail closed during authentication"
    );
    assert!(!format!("{:?}", rejected.err().unwrap()).contains("wrong???"));
}

#[test]
fn password_is_redacted_and_never_truncated() {
    assert_eq!(format!("{:?}", password()), "VncPassword([REDACTED])");
    for invalid in ["", "ninebytes", "密码", "bad\n", "\0"] {
        assert!(matches!(
            VncPassword::new(invalid.into()),
            Err(Error::InvalidPassword)
        ));
    }
    assert!(VncPassword::new("12345678".into()).is_ok());
    // Keep the error type concrete and redacted, even for an early I/O failure.
    assert_eq!(
        format!(
            "{}",
            Error::Io(io::Error::from(io::ErrorKind::UnexpectedEof))
        ),
        "RFB transport failed"
    );
}
