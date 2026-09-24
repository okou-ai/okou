#![allow(
    clippy::expect_used,
    clippy::indexing_slicing,
    reason = "synthetic peers and manual live fixture use assertions"
)]

use crypto_bigint::{
    BoxedUint, Odd,
    modular::{BoxedMontyForm, BoxedMontyParams},
};
use rfb_client::{AppleSrpCredentials, AuthenticationStage, Error, authenticate_apple_srp};
use sha2::{Digest, Sha256, Sha512};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, DuplexStream, duplex},
    time::{Duration, Instant},
};

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
async fn srp_peer(server: &mut DuplexStream, corrupt_m2: bool, rejected_status: bool) {
    negotiate(server, &[30, 33, 36]).await;
    assert_eq!(server.read_u8().await.expect("selection"), 36);
    assert_eq!(server.read_u8().await.expect("branch"), 36);
    let entry_len = server.read_u32().await.expect("entry length") as usize;
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
    server.write_all(&challenge).await.expect("challenge");

    let response_len = server.read_u32().await.expect("response outer") as usize;
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
        server.write_u32(0).await.expect("reject invalid M1");
        return;
    }
    let mut m2 = sha512(&[a_bytes, m1, &session_key]);
    if corrupt_m2 {
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
    if !corrupt_m2 {
        server
            .write_u32(u32::from(rejected_status))
            .await
            .expect("security result");
        if rejected_status {
            server.write_u32(0).await.expect("empty failure reason");
        } else {
            server.write_u8(0x42).await.expect("handoff marker");
        }
    }
}

#[tokio::test]
async fn exact_type_36_authenticates_and_hands_off_stream() {
    let (client, mut server) = duplex(4096);
    let peer = tokio::spawn(async move { srp_peer(&mut server, false, false).await });
    let authenticated = authenticate_apple_srp(client, credentials(), deadline())
        .await
        .expect("SRP success");
    let mut stream = authenticated.into_stream();
    assert_eq!(stream.read_u8().await.expect("post-auth marker"), 0x42);
    peer.await.expect("peer");
}

#[tokio::test]
async fn corrupt_server_proof_never_yields_a_session() {
    let (client, mut server) = duplex(4096);
    let peer = tokio::spawn(async move { srp_peer(&mut server, true, false).await });
    let result = authenticate_apple_srp(client, credentials(), deadline()).await;
    assert!(matches!(result, Err(Error::AuthenticationFailed)));
    peer.await.expect("peer");
}

#[tokio::test]
async fn wrong_password_never_yields_a_session() {
    let (client, mut server) = duplex(4096);
    let peer = tokio::spawn(async move { srp_peer(&mut server, false, false).await });
    let wrong = AppleSrpCredentials::new("test-user".into(), "wrong-password".into())
        .expect("fixed wrong credential");
    assert!(
        authenticate_apple_srp(client, wrong, deadline())
            .await
            .is_err()
    );
    peer.await.expect("peer");
}

#[tokio::test]
async fn rejected_security_result_never_yields_a_session() {
    let (client, mut server) = duplex(4096);
    let peer = tokio::spawn(async move { srp_peer(&mut server, false, true).await });
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
        negotiate(&mut server, &[36]).await;
        assert_eq!(server.read_u8().await.expect("selection"), 36);
        assert_eq!(server.read_u8().await.expect("branch"), 36);
        let entry_len = server.read_u32().await.expect("entry length") as usize;
        assert!(entry_len <= 266);
        let mut entry = vec![0; entry_len];
        server.read_exact(&mut entry).await.expect("entry");
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

/// Run manually with a one-time credential on the dedicated Mac test host.
/// This tests authentication only; it does not initialize, capture or control
/// the desktop, and it does not enable any product route.
#[tokio::test]
#[ignore = "requires dedicated macOS test host and ephemeral credential"]
async fn exact_mac_direct_srp_authenticates() {
    let address = std::env::var("OKOU_MAC_VNC_ADDR").expect("test host address");
    let username = std::env::var("OKOU_MAC_VNC_USER").expect("test username");
    let password = std::env::var("OKOU_MAC_VNC_PASSWORD").expect("one-time test password");
    let stream = tokio::net::TcpStream::connect(address)
        .await
        .expect("connect test host");
    let credentials = AppleSrpCredentials::new(username, password).expect("valid test credential");
    let authenticated = authenticate_apple_srp(
        stream,
        credentials,
        Instant::now() + Duration::from_secs(30),
    )
    .await
    .expect("direct SRP authentication");
    drop(authenticated);
}
