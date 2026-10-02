//! Opt-in independent TigerVNC 1.13.1 fixture; see RSA_AES.md.
use rfb_client::{
    RsaAesCredentials, RsaAesSecurity, RsaServerKeyPin, Session, SharingMode, authenticate_rsa_aes,
};
use std::{env, time::Duration};
use tokio::{net::TcpStream, time::Instant};

#[tokio::test]
#[ignore = "requires isolated release-pinned TigerVNC fixture; see RSA_AES.md"]
async fn independent_tigervnc_authenticates_and_captures_the_selected_mode() {
    let mode = match env::var("RSA_AES_MODE").unwrap().as_str() {
        "RA2" => RsaAesSecurity::Ra2,
        "RA2_256" => RsaAesSecurity::Ra2_256,
        "RA2ne" => RsaAesSecurity::Ra2ne,
        "RA2ne_256" => RsaAesSecurity::Ra2ne256,
        _ => panic!("exact fixture mode required"),
    };
    let user = env::var("RSA_AES_USER").unwrap_or_default();
    let password = env::var("RSA_AES_PASSWORD").expect("synthetic fixture password");
    let credential = if user.is_empty() {
        RsaAesCredentials::password(password).unwrap()
    } else {
        RsaAesCredentials::username_password(user, password).unwrap()
    };
    let encoded = env::var("RSA_AES_PIN").unwrap();
    let pin: [u8; 32] = hex::decode(encoded).unwrap().try_into().unwrap();
    let port = env::var("RSA_AES_PORT").unwrap().parse::<u16>().unwrap();
    let stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let result = authenticate_rsa_aes(
        stream,
        mode,
        credential,
        RsaServerKeyPin::new(pin),
        Instant::now() + Duration::from_secs(30),
    )
    .await;
    if env::var("RSA_AES_NEGATIVE").is_ok() {
        assert!(
            result.is_err(),
            "negative fixture unexpectedly authenticated"
        );
        return;
    }
    let connection = result
        .unwrap()
        .initialize(
            SharingMode::Shared,
            Instant::now() + Duration::from_secs(30),
        )
        .await
        .unwrap();
    let mut session = Session::new(connection);
    let captured = session
        .capture(Instant::now() + Duration::from_secs(30))
        .await
        .unwrap();
    assert_eq!(
        (captured.metadata().width, captured.metadata().height),
        (640, 480)
    );
    assert!(captured.png().starts_with(b"\x89PNG\r\n\x1a\n"));
    println!(
        "independent {mode:?}:640x480 PNG {} bytes",
        captured.png().len()
    );
    session.close();
}
