use aes::{
    Aes128,
    cipher::{Block, BlockCipherDecrypt, KeyInit},
};
use crypto_bigint::{
    BoxedUint, Odd,
    modular::{BoxedMontyForm, BoxedMontyParams},
};
use md5::{Digest, Md5};
use rfb_client::{
    AppleDhCredentials, AppleDhParameterCheck, AuthenticationStage, Error, Input, InputOutcome,
    Key, Session, SharingMode, authenticate_apple_dh,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, DuplexStream, duplex},
    time::{Duration, Instant},
};

const BITS: u32 = 4096;
const KEY_BYTES: usize = 512;

fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(20)
}

#[allow(clippy::unwrap_used, reason = "fixed synthetic test credentials")]
fn credentials() -> AppleDhCredentials {
    AppleDhCredentials::new("test-user".into(), "test-password".into()).unwrap()
}

fn synthetic_modulus() -> [u8; KEY_BYTES] {
    // Bounded synthetic odd group for framing tests only. The real-mac check
    // provides independent interoperability evidence; this is not a safe-prime
    // fixture or a recommendation for a production server.
    let mut bytes = [0xa5; KEY_BYTES];
    bytes[0] = 0x80;
    bytes[KEY_BYTES - 1] = 0xff;
    bytes
}

#[allow(clippy::unwrap_used, reason = "synthetic test peer")]
async fn negotiate(server: &mut DuplexStream, offered: &[u8]) {
    server.write_all(b"RFB 003.889\n").await.unwrap();
    let mut reply = [0; 12];
    server.read_exact(&mut reply).await.unwrap();
    assert_eq!(&reply, b"RFB 003.008\n");
    server.write_u8(offered.len() as u8).await.unwrap();
    server.write_all(offered).await.unwrap();
}

#[allow(clippy::unwrap_used, reason = "synthetic test peer")]
async fn assert_invalid_dh_public_value(server_public: [u8; KEY_BYTES]) {
    let (client, mut server) = duplex(2048);
    let peer = async move {
        negotiate(&mut server, &[30]).await;
        assert_eq!(server.read_u8().await.unwrap(), 30);
        server.write_u16(5).await.unwrap();
        server.write_u16(KEY_BYTES as u16).await.unwrap();
        server.write_all(&synthetic_modulus()).await.unwrap();
        server.write_all(&server_public).await.unwrap();
        let mut byte = [0; 1];
        assert_eq!(
            server.read(&mut byte).await.unwrap(),
            0,
            "invalid peer public value must not receive credential bytes"
        );
    };
    let caller = authenticate_apple_dh(client, credentials(), deadline());
    let ((), result) =
        tokio::time::timeout(Duration::from_secs(5), async { tokio::join!(peer, caller) })
            .await
            .unwrap();
    assert!(matches!(
        result,
        Err(Error::InvalidAppleDhParameters {
            check: AppleDhParameterCheck::ServerPublicRange,
            generator: Some(5),
            key_bytes: Some(512),
        })
    ));
}

#[tokio::test]
async fn type_30_authenticates_and_preserves_owned_raw_stream() {
    let (client, mut server) = duplex(4096);
    let peer = tokio::spawn(async move {
        negotiate(&mut server, &[30, 33, 36]).await;
        assert_eq!(server.read_u8().await.unwrap(), 30);

        let modulus = synthetic_modulus();
        let modulus_int = BoxedUint::from_be_slice(&modulus, BITS).unwrap();
        let params = BoxedMontyParams::new_vartime(
            Option::<Odd<BoxedUint>>::from(Odd::new(modulus_int)).unwrap(),
        );
        let generator = BoxedUint::from_be_slice(&[5], BITS).unwrap();
        let server_private = BoxedUint::from_be_slice(&[17], BITS).unwrap();
        let server_public = BoxedMontyForm::new(generator, &params)
            .pow_bounded_exp(&server_private, 8)
            .retrieve()
            .to_be_bytes();
        server.write_u16(5).await.unwrap();
        server.write_u16(KEY_BYTES as u16).await.unwrap();
        for chunk in modulus.chunks(64) {
            server.write_all(chunk).await.unwrap();
            tokio::task::yield_now().await;
        }
        for chunk in server_public.chunks(64) {
            server.write_all(chunk).await.unwrap();
            tokio::task::yield_now().await;
        }

        let mut encrypted = [0u8; 128];
        let mut client_public = [0u8; KEY_BYTES];
        server.read_exact(&mut encrypted).await.unwrap();
        server.read_exact(&mut client_public).await.unwrap();
        let client_public = BoxedUint::from_be_slice(&client_public, BITS).unwrap();
        let shared = BoxedMontyForm::new(client_public, &params)
            .pow_bounded_exp(&server_private, 8)
            .retrieve()
            .to_be_bytes();
        let key = Md5::digest(&shared);
        let cipher = Aes128::new_from_slice(&key).unwrap();
        for chunk in encrypted.as_chunks_mut::<16>().0 {
            let mut block = Block::<Aes128>::default();
            block.copy_from_slice(chunk);
            cipher.decrypt_block(&mut block);
            chunk.copy_from_slice(&block);
        }
        assert_eq!(&encrypted[..10], b"test-user\0");
        assert_eq!(&encrypted[64..78], b"test-password\0");
        server.write_u32(0).await.unwrap();
        server.write_u8(0x42).await.unwrap();
    });

    let authenticated = authenticate_apple_dh(client, credentials(), deadline())
        .await
        .unwrap();
    let mut stream = authenticated.into_stream();
    assert_eq!(stream.read_u8().await.unwrap(), 0x42);
    peer.await.unwrap();
}

#[tokio::test]
async fn rejected_security_result_never_yields_a_session() {
    let (client, mut server) = duplex(4096);
    let peer = tokio::spawn(async move {
        negotiate(&mut server, &[30]).await;
        assert_eq!(server.read_u8().await.unwrap(), 30);
        let modulus = synthetic_modulus();
        let modulus_int = BoxedUint::from_be_slice(&modulus, BITS).unwrap();
        let params = BoxedMontyParams::new_vartime(
            Option::<Odd<BoxedUint>>::from(Odd::new(modulus_int)).unwrap(),
        );
        let generator = BoxedUint::from_be_slice(&[5], BITS).unwrap();
        let server_public = BoxedMontyForm::new(generator, &params)
            .pow_bounded_exp(&BoxedUint::from_be_slice(&[17], BITS).unwrap(), 8)
            .retrieve()
            .to_be_bytes();
        server.write_u16(5).await.unwrap();
        server.write_u16(KEY_BYTES as u16).await.unwrap();
        server.write_all(&modulus).await.unwrap();
        server.write_all(&server_public).await.unwrap();
        let mut credentials_and_public = [0u8; 128 + KEY_BYTES];
        server
            .read_exact(&mut credentials_and_public)
            .await
            .unwrap();
        server.write_u32(1).await.unwrap();
        server.write_u32(0).await.unwrap();
    });
    let result = authenticate_apple_dh(client, credentials(), deadline()).await;
    assert!(matches!(result, Err(Error::AuthenticationFailed)));
    peer.await.unwrap();
}

#[tokio::test]
async fn credentials_enforce_utf8_byte_bounds_without_revealing_secrets() {
    let credentials = AppleDhCredentials::new("名字".into(), "secret".into()).unwrap();
    assert_eq!(format!("{credentials:?}"), "AppleDhCredentials([REDACTED])");
    assert!(matches!(
        AppleDhCredentials::new("".into(), "secret".into()),
        Err(Error::InvalidAppleDhUsername)
    ));
    assert!(matches!(
        AppleDhCredentials::new("ü".repeat(32), "secret".into()),
        Err(Error::InvalidAppleDhUsername)
    ));
    assert!(matches!(
        AppleDhCredentials::new("name".into(), "a".repeat(64)),
        Err(Error::InvalidAppleDhPassword)
    ));
    assert!(matches!(
        AppleDhCredentials::new("name\0tail".into(), "secret".into()),
        Err(Error::InvalidAppleDhUsername)
    ));
    assert!(matches!(
        AppleDhCredentials::new("name".into(), "secret\0tail".into()),
        Err(Error::InvalidAppleDhPassword)
    ));
    assert!(AppleDhCredentials::new("u".repeat(63), "p".repeat(63)).is_ok());
}

#[tokio::test]
async fn apple_profile_rejects_other_banner_without_writing_a_reply() {
    let (client, mut server) = duplex(64);
    server.write_all(b"RFB 003.008\n").await.unwrap();
    let result = authenticate_apple_dh(client, credentials(), deadline()).await;
    assert!(matches!(result, Err(Error::UnsupportedRfbVersion)));
    let mut byte = [0; 1];
    assert_eq!(server.read(&mut byte).await.unwrap(), 0);
}

#[tokio::test]
async fn unavailable_type_30_never_selects_a_fallback() {
    let (client, mut server) = duplex(64);
    let peer = tokio::spawn(async move {
        negotiate(&mut server, &[33, 36]).await;
        let mut byte = [0; 1];
        assert_eq!(server.read(&mut byte).await.unwrap(), 0);
    });
    let result = authenticate_apple_dh(client, credentials(), deadline()).await;
    assert!(matches!(result, Err(Error::UnsupportedSecurity)));
    peer.await.unwrap();
}

#[tokio::test]
async fn oversized_dh_is_rejected_before_peer_material_is_read() {
    let (client, mut server) = duplex(64);
    let peer = tokio::spawn(async move {
        negotiate(&mut server, &[30]).await;
        assert_eq!(server.read_u8().await.unwrap(), 30);
        server.write_u16(5).await.unwrap();
        server.write_u16(513).await.unwrap();
        let mut byte = [0; 1];
        assert_eq!(server.read(&mut byte).await.unwrap(), 0);
    });
    let result = authenticate_apple_dh(client, credentials(), deadline()).await;
    assert!(matches!(
        result,
        Err(Error::InvalidAppleDhParameters {
            check: AppleDhParameterCheck::KeyLength,
            generator: Some(5),
            key_bytes: Some(513),
        })
    ));
    peer.await.unwrap();
}

#[tokio::test]
async fn invalid_dh_public_value_is_rejected_without_credential_bytes() {
    assert_invalid_dh_public_value([0; KEY_BYTES]).await;
}

#[tokio::test]
async fn dh_public_lower_bound_one_is_rejected_without_credential_bytes() {
    let mut server_public = [0; KEY_BYTES];
    server_public[KEY_BYTES - 1] = 1;
    assert_invalid_dh_public_value(server_public).await;
}

#[tokio::test]
async fn dh_public_upper_bound_p_minus_one_is_rejected_without_credential_bytes() {
    let mut server_public = synthetic_modulus();
    // The synthetic modulus ends in 0xff, so subtracting one needs no borrow.
    server_public[KEY_BYTES - 1] -= 1;
    assert_invalid_dh_public_value(server_public).await;
}

#[tokio::test]
async fn dh_public_upper_bound_p_is_rejected_without_credential_bytes() {
    assert_invalid_dh_public_value(synthetic_modulus()).await;
}

#[tokio::test]
async fn invalid_dh_modulus_is_rejected_without_credential_bytes() {
    for check in [
        AppleDhParameterCheck::ModulusParity,
        AppleDhParameterCheck::ModulusWidth,
    ] {
        let mut modulus = synthetic_modulus();
        if check == AppleDhParameterCheck::ModulusParity {
            modulus[KEY_BYTES - 1] = 0xfe;
        } else {
            modulus[0] = 0x01;
        }
        let (client, mut server) = duplex(2048);
        let peer = tokio::spawn(async move {
            negotiate(&mut server, &[30]).await;
            assert_eq!(server.read_u8().await.unwrap(), 30);
            server.write_u16(5).await.unwrap();
            server.write_u16(KEY_BYTES as u16).await.unwrap();
            server.write_all(&modulus).await.unwrap();
            server.write_all(&[5; KEY_BYTES]).await.unwrap();
            let mut byte = [0; 1];
            assert_eq!(server.read(&mut byte).await.unwrap(), 0);
        });
        let result = authenticate_apple_dh(client, credentials(), deadline()).await;
        match result {
            Err(
                error @ Error::InvalidAppleDhParameters {
                    check: actual,
                    generator: Some(5),
                    key_bytes: Some(512),
                },
            ) => {
                assert_eq!(actual, check);
                assert_eq!(error.diagnostic_code(), "invalid_apple_dh_parameters");
                assert!(!format!("{error:?}").contains("test-password"));
            }
            _ => panic!("expected bounded modulus rejection diagnostics"),
        }
        peer.await.unwrap();
    }
}

#[tokio::test]
async fn rejected_dh_header_retains_public_values_and_never_sends_credentials() {
    for (generator, key_bytes, expected) in [
        (1, 512, AppleDhParameterCheck::Generator),
        (5, 128, AppleDhParameterCheck::KeyLength),
        (5, 257, AppleDhParameterCheck::KeyLength),
    ] {
        let (client, mut server) = duplex(64);
        let peer = tokio::spawn(async move {
            negotiate(&mut server, &[30]).await;
            assert_eq!(server.read_u8().await.unwrap(), 30);
            server.write_u16(generator).await.unwrap();
            server.write_u16(key_bytes).await.unwrap();
            let mut byte = [0; 1];
            assert_eq!(server.read(&mut byte).await.unwrap(), 0);
        });
        let result = authenticate_apple_dh(client, credentials(), deadline()).await;
        match result {
            Err(
                error @ Error::InvalidAppleDhParameters {
                    check,
                    generator: actual_generator,
                    key_bytes: actual_key_bytes,
                },
            ) => {
                assert_eq!(check, expected);
                assert_eq!(actual_generator, Some(generator));
                assert_eq!(actual_key_bytes, Some(key_bytes));
                assert_eq!(error.diagnostic_code(), "invalid_apple_dh_parameters");
            }
            _ => panic!("expected bounded header rejection diagnostics"),
        }
        peer.await.unwrap();
    }
}

#[tokio::test]
async fn dropping_a_stalled_apple_dh_handshake_closes_the_stream() {
    let (client, mut server) = duplex(64);
    let task = tokio::spawn(authenticate_apple_dh(client, credentials(), deadline()));
    negotiate(&mut server, &[30]).await;
    assert_eq!(server.read_u8().await.unwrap(), 30);
    // The peer never sends generator/length; no credential bytes can be sent.
    task.abort();
    assert!(matches!(task.await, Err(error) if error.is_cancelled()));
    let mut byte = [0; 1];
    assert_eq!(server.read(&mut byte).await.unwrap(), 0);
}

#[tokio::test]
async fn stalled_apple_dh_parameters_expire_and_close_the_stream() {
    let (client, mut server) = duplex(64);
    let peer = async move {
        negotiate(&mut server, &[30]).await;
        assert_eq!(server.read_u8().await.unwrap(), 30);
        // The peer withholds generator/length until the client disconnects.
        let mut byte = [0; 1];
        assert_eq!(server.read(&mut byte).await.unwrap(), 0);
    };
    let caller = authenticate_apple_dh(
        client,
        credentials(),
        Instant::now() + Duration::from_secs(1),
    );
    let ((), result) =
        tokio::time::timeout(Duration::from_secs(5), async { tokio::join!(peer, caller) })
            .await
            .unwrap();
    assert!(matches!(
        result,
        Err(Error::AuthenticationDeadlineExceeded {
            stage: AuthenticationStage::AppleDhAuthentication
        })
    ));
}

#[tokio::test]
async fn deadline_expires_before_first_io() {
    let (client, _server) = duplex(64);
    let result = authenticate_apple_dh(client, credentials(), Instant::now()).await;
    assert!(matches!(
        result,
        Err(Error::AuthenticationDeadlineExceeded {
            stage: AuthenticationStage::RfbVersion
        })
    ));
}

#[tokio::test]
#[ignore = "requires owner-authorized macOS server and synthetic credentials"]
async fn pinned_mac_type_30_capture_and_safe_input() {
    let endpoint = std::env::var("OKOU_MAC_VNC_ENDPOINT").expect("test endpoint");
    let username = std::env::var("OKOU_MAC_VNC_USER").expect("test username");
    let password = std::env::var("OKOU_MAC_VNC_PASSWORD").expect("test password");
    let stream = tokio::net::TcpStream::connect(endpoint).await.unwrap();
    let authenticated = authenticate_apple_dh(
        stream,
        AppleDhCredentials::new(username, password).unwrap(),
        Instant::now() + Duration::from_secs(30),
    )
    .await
    .unwrap();
    let connection = authenticated
        .initialize(
            SharingMode::Shared,
            Instant::now() + Duration::from_secs(30),
        )
        .await
        .unwrap();
    let mut session = Session::new(connection);
    let capture = session
        .capture(Instant::now() + Duration::from_secs(30))
        .await
        .unwrap();
    assert_eq!(
        (capture.metadata().width, capture.metadata().height),
        (1024, 768)
    );
    let mut outcome = InputOutcome::NotStarted;
    session
        .input(
            Input::KeyChord(&[Key::Shift]),
            &mut outcome,
            Instant::now() + Duration::from_secs(5),
        )
        .await
        .unwrap();
    assert_eq!(outcome, InputOutcome::Sent);
}

#[tokio::test]
#[ignore = "requires owner-authorized macOS server and synthetic credentials"]
async fn pinned_mac_type_30_rejects_wrong_password() {
    let endpoint = std::env::var("OKOU_MAC_VNC_ENDPOINT").expect("test endpoint");
    let username = std::env::var("OKOU_MAC_VNC_USER").expect("test username");
    let stream = tokio::net::TcpStream::connect(endpoint).await.unwrap();
    let result = authenticate_apple_dh(
        stream,
        AppleDhCredentials::new(username, "intentionally-wrong-test-password".into()).unwrap(),
        Instant::now() + Duration::from_secs(30),
    )
    .await;
    assert!(matches!(result, Err(Error::AuthenticationFailed)));
}
