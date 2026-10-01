//! Opt-in QEMU 8.2.2 / Cyrus SCRAM integration test. See QEMU_SASL.md.
#![cfg(test)]
#![cfg(unix)]

use std::{fs, time::Duration};

use base64::Engine;
use rfb_client::{
    Authenticated, Error, QemuScramCredentials, SharingMode, TrustRoots, X509Authentication,
    authenticate,
};
use rustls::pki_types::CertificateDer;
use tokio::{net::TcpStream, time::Instant};

const NAME: &str = "localhost";
const USER: &str = "fixture37465";
const PASSWORD: &str = "fixture-test-only-37465";

fn roots() -> TrustRoots {
    let path = std::env::var("QEMU_SASL_ROOT_PEM").expect("set synthetic QEMU_SASL_ROOT_PEM");
    let pem = fs::read_to_string(path).unwrap();
    let base64 = pem
        .lines()
        .filter(|line| !line.starts_with("-----"))
        .collect::<String>();
    let der = base64::engine::general_purpose::STANDARD
        .decode(base64)
        .unwrap();
    TrustRoots::custom(vec![CertificateDer::from(der)]).unwrap()
}

async fn connect(
    name: &str,
    password: &str,
    roots: TrustRoots,
) -> Result<Authenticated<TcpStream>, Error> {
    let port: u16 = std::env::var("QEMU_SASL_PORT")
        .expect("set loopback QEMU_SASL_PORT")
        .parse()
        .unwrap();
    let stream = TcpStream::connect(("127.0.0.1", port)).await?;
    let auth = X509Authentication::QemuScramSha256(
        QemuScramCredentials::new(USER.to_owned(), password.to_owned()).unwrap(),
    );
    authenticate(
        stream,
        name,
        auth,
        roots,
        Instant::now() + Duration::from_secs(8),
    )
    .await
}

async fn attempt(name: &str, password: &str, roots: TrustRoots) -> Result<(), Error> {
    // Consume the *complete* ServerInit and initialize the public framebuffer
    // path, not just the first four geometry bytes or a TLS/SASL success flag.
    let frame = connect(name, password, roots)
        .await?
        .initialize(SharingMode::Shared, Instant::now() + Duration::from_secs(8))
        .await?;
    assert!(frame.width() > 0 && frame.height() > 0);
    Ok(())
}

#[tokio::test]
#[ignore = "requires synthetic loopback-only QEMU/Cyrus fixture per QEMU_SASL.md"]
async fn pinned_qemu_scram_valid_and_invalid() {
    if std::env::var_os("QEMU_SASL_EXPECT_MISSING_SCRAM").is_some() {
        assert!(matches!(
            connect(NAME, PASSWORD, roots()).await,
            Err(Error::UnsupportedScramMechanism)
        ));
        return;
    }
    attempt(NAME, PASSWORD, roots()).await.unwrap();
    assert!(matches!(
        connect(NAME, "wrong-test-only-password", roots()).await,
        Err(Error::AuthenticationFailed | Error::InvalidScramExchange | Error::Io(_))
    ));
    attempt(NAME, PASSWORD, roots()).await.unwrap();
    assert!(matches!(
        connect("not-localhost.example", PASSWORD, roots()).await,
        Err(Error::Tls(_))
    ));
    let wrong_root = rcgen::CertificateParams::new(vec!["irrelevant.test".into()])
        .unwrap()
        .self_signed(&rcgen::KeyPair::generate().unwrap())
        .unwrap();
    assert!(matches!(
        connect(
            NAME,
            PASSWORD,
            TrustRoots::custom(vec![wrong_root.der().clone()]).unwrap()
        )
        .await,
        Err(Error::Tls(_))
    ));
}
