//! Explicit opt-in, independent QEMU9.2/Cyrus/KDC fixture. See QEMU_GSSAPI.md.
#![cfg(test)]
#![cfg(target_os = "linux")]
mod controlled_peer;
use base64::Engine;
use kerberos_credentials::{ClientKeytab, Principal, ServiceTicketCache};
use kerberos_worker::{Credentials, KdcExchange, Password, Source, TicketPolicy};
use rfb_client::{
    Error, QemuGssapiAuthentication, Session, SharingMode, TrustRoots, authenticate_qemu_gssapi,
};
use rustls::pki_types::CertificateDer;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    time::Instant,
};
use zeroize::Zeroizing;

fn fixture(index: usize) -> PathBuf {
    PathBuf::from(std::env::var_os("QEMU_GSSAPI_FIXTURE").expect("set private fixture directory"))
        .join(index.to_string())
}
fn public(root: &Path, name: &str) -> String {
    fs::read_to_string(root.join(name)).unwrap()
}
fn principal(root: &Path, components: &[&str]) -> Principal {
    Principal::new(
        public(root, "realm"),
        components.iter().map(|name| (*name).into()).collect(),
    )
    .unwrap()
}
fn credentials(root: &Path, mode: &str) -> Credentials {
    let host = public(root, "hostname");
    let client = principal(
        root,
        &[if mode == "password" || mode == "wrong_password" {
            "passworduser"
        } else {
            "alice"
        }],
    );
    let server = principal(
        root,
        &[
            "vnc",
            if mode == "missing_service" {
                "absent.invalid"
            } else {
                &host
            },
        ],
    );
    let source = match mode {
        "ticket" => Source::Ticket(
            ServiceTicketCache::parse(
                fs::read(root.join("service.ccache")).unwrap(),
                &client,
                &server,
                u32::try_from(
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap()
                        .as_secs(),
                )
                .unwrap(),
            )
            .unwrap(),
        ),
        "keytab" | "short_ticket" | "missing_service" | "wrong_keytab" => Source::Keytab(
            ClientKeytab::parse(
                fs::read(root.join(if mode == "wrong_keytab" {
                    "alice-wrong.keytab"
                } else {
                    "alice.keytab"
                }))
                .unwrap(),
                &client,
            )
            .unwrap(),
        ),
        "password" => {
            Source::Password(Password::new(Zeroizing::new(public(root, "password"))).unwrap())
        }
        "wrong_password" => {
            Source::Password(Password::new(Zeroizing::new("wrong-synthetic-only".into())).unwrap())
        }
        _ => panic!("unsupported fixture mode"),
    };
    Credentials::new(client, server, source).unwrap()
}
fn roots(root: &Path) -> TrustRoots {
    let pem = public(root, "tls/ca-cert.pem");
    let encoded = pem
        .lines()
        .filter(|line| !line.starts_with("-----"))
        .collect::<String>();
    TrustRoots::custom(vec![CertificateDer::from(
        base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap(),
    )])
    .unwrap()
}
struct Relay {
    realm: String,
    port: u16,
    allowed: bool,
    requests: usize,
    unknown: bool,
    revoke_after_exchange: bool,
}
impl Relay {
    fn new(root: &Path) -> Self {
        Self {
            realm: public(root, "realm"),
            port: public(root, "kdc-port").parse().unwrap(),
            allowed: true,
            requests: 0,
            unknown: false,
            revoke_after_exchange: false,
        }
    }
}
impl KdcExchange for Relay {
    async fn authorize(&mut self) -> Result<(), kerberos_worker::Error> {
        if self.allowed {
            Ok(())
        } else {
            Err(kerberos_worker::Error::Authority)
        }
    }
    async fn exchange(
        &mut self,
        realm: &str,
        request: &[u8],
    ) -> Result<Zeroizing<Vec<u8>>, kerberos_worker::Error> {
        // This exact synthetic loopback binding is independent of the RFB destination.
        if !self.allowed || realm != self.realm {
            return Err(kerberos_worker::Error::Authority);
        }
        self.requests += 1;
        if self.unknown {
            return Err(kerberos_worker::Error::DeliveryUnknown);
        }
        if !(1..=65536).contains(&request.len()) {
            return Err(kerberos_worker::Error::Protocol);
        }
        let mut stream = TcpStream::connect(("127.0.0.1", self.port))
            .await
            .map_err(|_| kerberos_worker::Error::KdcUnavailable)?;
        self.authorize().await?;
        stream
            .write_u32(u32::try_from(request.len()).unwrap())
            .await
            .map_err(|_| kerberos_worker::Error::DeliveryUnknown)?;
        stream
            .write_all(request)
            .await
            .map_err(|_| kerberos_worker::Error::DeliveryUnknown)?;
        let length = stream
            .read_u32()
            .await
            .map_err(|_| kerberos_worker::Error::DeliveryUnknown)?;
        if !(1..=65536).contains(&length) {
            return Err(kerberos_worker::Error::Protocol);
        }
        let mut reply = Zeroizing::new(vec![0; usize::try_from(length).unwrap()]);
        stream
            .read_exact(&mut reply)
            .await
            .map_err(|_| kerberos_worker::Error::DeliveryUnknown)?;
        if self.revoke_after_exchange {
            self.allowed = false;
        }
        Ok(reply)
    }
}
async fn connect(
    root: &Path,
    mode: &str,
    name: &str,
    relay: &mut Relay,
    lifetime: Duration,
) -> Result<Session<TcpStream>, Error> {
    let port: u16 = public(root, "vnc-port").parse().unwrap();
    let stream = TcpStream::connect(("127.0.0.1", port)).await?;
    let auth = QemuGssapiAuthentication {
        credentials: credentials(root, mode),
        ticket_policy: TicketPolicy::new(
            Duration::from_secs(if mode == "short_ticket" { 4 } else { 60 }),
            Duration::from_secs(120),
        )
        .unwrap(),
        private_root: root.join("private"),
        expires_at: Instant::now() + lifetime,
    };
    let authenticated = authenticate_qemu_gssapi(
        stream,
        name,
        roots(root),
        auth,
        relay,
        Instant::now() + Duration::from_secs(10),
    )
    .await?;
    Ok(Session::new(
        authenticated
            .initialize(SharingMode::Shared, Instant::now() + Duration::from_secs(3))
            .await?,
    ))
}
async fn framebuffer(root: &Path, mode: &str, relay: &mut Relay) {
    let mut session = connect(root, mode, "localhost", relay, Duration::from_secs(60))
        .await
        .unwrap();
    let frame = session
        .capture(Instant::now() + Duration::from_secs(3))
        .await
        .unwrap();
    assert_eq!(
        (frame.metadata().width, frame.metadata().height),
        (640, 480)
    );
    assert!(frame.png().len() > 1000);
    drop(session);
    assert_eq!(fs::read_dir(root.join("private")).unwrap().count(), 0);
}

fn mit_peer(root: &Path, mode: &str) -> tokio::process::Child {
    tokio::process::Command::new("python3")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mit_gss_peer.py"))
        .args(["--fixture", root.to_str().unwrap(), "--mode", mode])
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap())
        .env("KRB5_CONFIG", root.join("krb5.conf"))
        .env(
            "KRB5_KTNAME",
            format!("FILE:{}", root.join("server.keytab").display()),
        )
        .env(
            "KRB5_CLIENT_KTNAME",
            format!("FILE:{}", root.join("absent.keytab").display()),
        )
        .env("KRB5RCACHEDIR", root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap()
}

async fn peer_frame<S: tokio::io::AsyncRead + Unpin>(
    stream: &mut S,
) -> std::io::Result<Zeroizing<Vec<u8>>> {
    let size = stream.read_u32().await?;
    if !(1..=16384).contains(&size) {
        return Err(std::io::ErrorKind::InvalidData.into());
    }
    let mut bytes = Zeroizing::new(vec![0; usize::try_from(size).unwrap()]);
    stream.read_exact(&mut bytes).await?;
    Ok(bytes)
}

#[tokio::test]
#[ignore = "requires generated local-only QEMU9.2/Cyrus/KDC fixture"]
async fn pinned_completed_gss_rfc4752_authentic_mic_layers_and_sequence_controls() {
    use kerberos_worker::{Error as NativeError, NoKdc};
    let root = fixture(0);
    for mode in [
        "valid",
        "bad_ap_rep",
        "bad_mic",
        "confidential",
        "no_no_layer",
        "unknown_layer",
        "nonzero_maxbuf",
        "short_offer",
        "long_offer",
        "sequence_gap",
    ] {
        let (mut context, _) = kerberos_worker::open(
            &root.join("private"),
            credentials(&root, "ticket"),
            TicketPolicy::new(Duration::from_secs(60), Duration::ZERO).unwrap(),
            Instant::now() + Duration::from_secs(10),
            &mut NoKdc,
        )
        .await
        .unwrap();
        let mut peer = mit_peer(&root, mode);
        let mut input = peer.stdin.take().unwrap();
        let mut output = peer.stdout.take().unwrap();
        let result = tokio::time::timeout(Duration::from_secs(5), async {
            let first = context.step(None, &mut NoKdc).await?;
            let token = first.token.unwrap();
            input
                .write_u32(u32::try_from(token.len()).unwrap())
                .await
                .unwrap();
            input.write_all(&token).await.unwrap();
            let ap_rep = peer_frame(&mut output).await.unwrap();
            let step = context.step(Some(ap_rep), &mut NoKdc).await?;
            assert!(step.complete);
            assert!(step.expires_at > Instant::now());
            input.write_u8(1).await.unwrap();
            let offer = peer_frame(&mut output).await.unwrap();
            let selected = context.select_no_layer(offer, &mut NoKdc).await?;
            input
                .write_u32(u32::try_from(selected.len()).unwrap())
                .await
                .unwrap();
            input.write_all(&selected).await.unwrap();
            let receipt = peer_frame(&mut output).await.unwrap();
            assert_eq!(receipt.as_slice(), &[1]);
            // A completed no-layer selection is terminal; no second layer step.
            assert_eq!(
                context
                    .select_no_layer(Zeroizing::new(vec![1]), &mut NoKdc)
                    .await
                    .unwrap_err(),
                NativeError::Protocol
            );
            Ok::<_, NativeError>(())
        })
        .await;
        context.close().await.unwrap();
        drop(input);
        drop(output);
        if peer.try_wait().unwrap().is_none() {
            peer.start_kill().unwrap();
        }
        peer.wait().await.unwrap();
        assert_eq!(fs::read_dir(root.join("private")).unwrap().count(), 0);
        if mode == "valid" {
            assert_eq!(
                result.unwrap(),
                Ok(()),
                "positive independent acceptor must actually verify the selection"
            );
        } else {
            assert_eq!(
                result.unwrap(),
                Err(NativeError::Protocol),
                "control {mode}"
            );
        }
    }
    println!(
        "independent MIT acceptor: completed mutual GSS, authentic no-layer selection; corrupt AP-REP/MIC, confidentiality, layer bits/maxbuf/length and authenticated sequence-gap refused"
    );
}

#[tokio::test]
#[ignore = "requires generated local-only QEMU9.2/Cyrus/KDC fixture"]
async fn pinned_online_password_keytab_and_concurrent_exact_realms() {
    let root = fixture(0);
    for mode in ["password", "keytab"] {
        let mut relay = Relay::new(&root);
        framebuffer(&root, mode, &mut relay).await;
        assert!(relay.requests > 0);
        println!(
            "independent native QEMU263/{mode}: verified TLS, mutual GSS, complete ServerInit and PNG"
        );
    }
    let other = fixture(1);
    let mut first = Relay::new(&root);
    let mut second = Relay::new(&other);
    tokio::join!(
        framebuffer(&root, "keytab", &mut first),
        framebuffer(&other, "password", &mut second)
    );
    assert!(first.requests > 0 && second.requests > 0);
    assert_ne!(first.realm, second.realm);
    println!(
        "two simultaneous owner/realm contexts: distinct exact caller routes and mutual names"
    );
}

#[tokio::test]
#[ignore = "requires generated local-only QEMU9.2/Cyrus/KDC fixture"]
async fn pinned_offline_import_with_kdc_stopped_no_relay() {
    assert_eq!(std::env::var("QEMU_GSSAPI_KDC_STOPPED").unwrap(), "1");
    for index in 0..2 {
        let root = fixture(index);
        let mut relay = Relay::new(&root);
        framebuffer(&root, "ticket", &mut relay).await;
        assert_eq!(relay.requests, 0);
        for mode in ["password", "keytab"] {
            let mut unavailable = Relay::new(&root);
            assert!(matches!(
                connect(
                    &root,
                    mode,
                    "localhost",
                    &mut unavailable,
                    Duration::from_secs(60)
                )
                .await,
                Err(Error::Kerberos(kerberos_worker::Error::KdcUnavailable))
            ));
            assert_eq!(unavailable.requests, 1);
        }
    }
    println!(
        "service-only imports: both KDCs stopped, zero caller exchange, native socket denial, PNG; online sources report real connect unavailability without retry"
    );
}

#[tokio::test]
#[ignore = "requires generated local-only QEMU9.2/Cyrus/KDC fixture"]
async fn pinned_tls_authority_password_uncertain_delivery_and_established_expiry() {
    let root = fixture(0);
    let mut relay = Relay::new(&root);
    assert!(matches!(
        connect(
            &root,
            "password",
            "not-localhost.invalid",
            &mut relay,
            Duration::from_secs(60)
        )
        .await,
        Err(Error::Tls(_))
    ));
    assert_eq!(relay.requests, 0);
    assert_eq!(fs::read_dir(root.join("private")).unwrap().count(), 0);
    relay.allowed = false;
    assert!(matches!(
        connect(
            &root,
            "keytab",
            "localhost",
            &mut relay,
            Duration::from_secs(60)
        )
        .await,
        Err(Error::Kerberos(kerberos_worker::Error::Authority))
    ));
    assert_eq!(relay.requests, 0);
    relay.allowed = true;
    for mode in ["wrong_password", "wrong_keytab", "missing_service"] {
        let mut rejected = Relay::new(&root);
        assert!(matches!(
            connect(
                &root,
                mode,
                "localhost",
                &mut rejected,
                Duration::from_secs(60)
            )
            .await,
            Err(Error::Kerberos(kerberos_worker::Error::CredentialRejected))
        ));
        assert!(rejected.requests > 0);
    }
    let mut revoked = Relay::new(&root);
    revoked.revoke_after_exchange = true;
    assert!(matches!(
        connect(
            &root,
            "keytab",
            "localhost",
            &mut revoked,
            Duration::from_secs(60)
        )
        .await,
        Err(Error::Kerberos(kerberos_worker::Error::Authority))
    ));
    assert_eq!(revoked.requests, 1);
    let mut unknown = Relay::new(&root);
    unknown.unknown = true;
    assert!(matches!(
        connect(
            &root,
            "keytab",
            "localhost",
            &mut unknown,
            Duration::from_secs(60)
        )
        .await,
        Err(Error::Kerberos(kerberos_worker::Error::DeliveryUnknown))
    ));
    assert_eq!(unknown.requests, 1); // Explicitly not replayed or marked revoked.
    let mut relay = Relay::new(&root);
    let mut session = connect(
        &root,
        "keytab",
        "localhost",
        &mut relay,
        Duration::from_secs(3),
    )
    .await
    .unwrap();
    session
        .capture(Instant::now() + Duration::from_secs(2))
        .await
        .unwrap();
    tokio::time::sleep_until(session.expires_at()).await;
    assert!(matches!(
        session
            .capture(Instant::now() + Duration::from_secs(1))
            .await,
        Err(Error::DeadlineExceeded)
    ));
    assert!(session.is_closed());
    let started = Instant::now();
    let mut short = connect(
        &root,
        "short_ticket",
        "localhost",
        &mut relay,
        Duration::from_secs(60),
    )
    .await
    .unwrap();
    assert!(short.expires_at() <= started + Duration::from_secs(4));
    short
        .capture(Instant::now() + Duration::from_secs(1))
        .await
        .unwrap();
    tokio::time::sleep_until(short.expires_at()).await;
    assert!(matches!(
        short.capture(Instant::now() + Duration::from_secs(1)).await,
        Err(Error::DeadlineExceeded)
    ));
    assert!(short.is_closed());
    println!(
        "wrong TLS/authority/password/keytab/service and unknown delivery refused; changed authority blocks the next KDC send; native ticket/GSS and Run deadlines separately close sessions"
    );
}

#[tokio::test]
#[ignore = "requires generated local-only QEMU9.2/Cyrus/KDC fixture"]
async fn pinned_native_renew_nonrenewable_same_source_reacquisition() {
    let root = fixture(0);
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut relay = Relay::new(&root);
    let (mut context, initial) = kerberos_worker::open(
        &root.join("private"),
        credentials(&root, "keytab"),
        TicketPolicy::new(Duration::from_secs(10), Duration::from_secs(60)).unwrap(),
        deadline,
        &mut relay,
    )
    .await
    .unwrap();
    assert!(initial.renewable);
    tokio::time::sleep(Duration::from_secs(2)).await;
    let renewed = context.renew(&mut relay).await.unwrap();
    assert!(renewed.expires_at > initial.expires_at);
    let next = context.reacquire(&mut relay).await.unwrap();
    assert!(next.expires_at > Instant::now());
    context.close().await.unwrap();
    let (mut context, status) = kerberos_worker::open(
        &root.join("private"),
        credentials(&root, "keytab"),
        TicketPolicy::new(Duration::from_secs(10), Duration::ZERO).unwrap(),
        deadline,
        &mut relay,
    )
    .await
    .unwrap();
    assert!(!status.renewable);
    assert_eq!(
        context.renew(&mut relay).await.unwrap_err(),
        kerberos_worker::Error::NonRenewable
    );
    context.close().await.unwrap();
    let policy = TicketPolicy::new(Duration::from_secs(2), Duration::from_secs(4)).unwrap();
    let deadline = Instant::now() + Duration::from_secs(12);
    let mut first = Relay::new(&root);
    let mut second = Relay::new(&root);
    let (mut expired, before) = kerberos_worker::open(
        &root.join("private"),
        credentials(&root, "keytab"),
        policy,
        deadline,
        &mut first,
    )
    .await
    .unwrap();
    let (mut reacquired, prior) = kerberos_worker::open(
        &root.join("private"),
        credentials(&root, "keytab"),
        policy,
        deadline,
        &mut second,
    )
    .await
    .unwrap();
    let renew_till = before.declared_renew_till.max(prior.declared_renew_till);
    assert!(before.renewable && prior.renewable);
    let until = UNIX_EPOCH + Duration::from_secs(u64::from(renew_till));
    tokio::time::sleep(until.duration_since(SystemTime::now()).unwrap_or_default()).await;
    assert!(SystemTime::now() >= until);
    let requests = first.requests;
    assert_eq!(
        expired.renew(&mut first).await.unwrap_err(),
        kerberos_worker::Error::RenewalExhausted
    );
    assert_eq!(first.requests, requests); // No automatic reacquisition/fallback.
    expired.close().await.unwrap();
    let next = reacquired.reacquire(&mut second).await.unwrap();
    assert!(next.expires_at > prior.expires_at && next.expires_at > Instant::now());
    reacquired.close().await.unwrap();
    assert_eq!(fs::read_dir(root.join("private")).unwrap().count(), 0);
    println!(
        "real AS/TGS renewal, nonrenewable and exhausted renew-till refusals; explicit same-source reacquisition after expiry, without fallback or active RFB extension"
    );
}
