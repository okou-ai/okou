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
    tgs_requests: usize,
    renewal_failure: Option<kerberos_worker::Error>,
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
            tgs_requests: 0,
            renewal_failure: None,
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
        if request.first() == Some(&0x6c) {
            self.tgs_requests += 1;
            // The first TGS request acquires the service. The next requests
            // are the real renewal and refreshed service, before GSS starts.
            if self.tgs_requests == 2
                && let Some(error) = self.renewal_failure
            {
                return Err(error);
            }
        }
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
#[tokio::test]
#[ignore = "requires independent signed MIT KDC and actual native worker"]
async fn pinned_native_acquisition_preserves_valid_short_ticket_after_kdc_latency() {
    struct DelayedFirstRequest {
        relay: Relay,
        requested_at: Option<Instant>,
    }
    impl KdcExchange for DelayedFirstRequest {
        async fn authorize(&mut self) -> Result<(), kerberos_worker::Error> {
            self.relay.authorize().await
        }
        async fn exchange(
            &mut self,
            realm: &str,
            request: &[u8],
        ) -> Result<Zeroizing<Vec<u8>>, kerberos_worker::Error> {
            if self.requested_at.is_none() {
                self.requested_at = Some(Instant::now());
                // Actual KDC latency is the contract: the native request's
                // ticket endtime remains finite, but acquisition predates it.
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
            self.relay.exchange(realm, request).await
        }
    }
    let root = fixture(0);
    let private = root.join("private");
    let mut caller = DelayedFirstRequest {
        relay: Relay::new(&root),
        requested_at: None,
    };
    let started = Instant::now();
    let (mut context, status) = kerberos_worker::open(
        &private,
        credentials(&root, "keytab"),
        TicketPolicy::new(Duration::from_secs(8), Duration::ZERO).unwrap(),
        started + Duration::from_secs(12),
        &mut caller,
    )
    .await
    .unwrap();
    let id = context.process_id();
    let live_status = status.expires_at > Instant::now();
    let step = context.step(None, &mut caller).await;
    // Do not repair early expiry by granting a fresh requested lifetime at
    // receipt. The actual returned native endtime still closes this context.
    tokio::time::sleep_until(status.expires_at).await;
    let expired = context
        .step(Some(Zeroizing::new(vec![1])), &mut caller)
        .await;
    context.close().await.unwrap();
    assert!(!Path::new(&format!("/proc/{id}")).exists());
    assert_eq!(fs::read_dir(private).unwrap().count(), 0);
    assert!(
        live_status,
        "acquisition must not backdate a still-live ticket"
    );
    assert!(status.expires_at <= caller.requested_at.unwrap() + Duration::from_secs(8));
    let step = step.expect("a still-live service ticket must permit the initial AP-REQ");
    assert!(!step.complete);
    assert!(step.token.as_ref().is_some_and(|bytes| !bytes.is_empty()));
    assert_eq!(expired.unwrap_err(), kerberos_worker::Error::Expired);
    assert!(caller.relay.requests > 0);
}

async fn connect(
    root: &Path,
    mode: &str,
    name: &str,
    relay: &mut Relay,
    lifetime: Duration,
) -> Result<Session<TcpStream>, Error> {
    let policy = TicketPolicy::new(
        Duration::from_secs(if mode == "short_ticket" { 4 } else { 60 }),
        Duration::from_secs(120),
    )
    .unwrap();
    connect_with_policy(root, mode, name, relay, lifetime, policy).await
}

async fn connect_with_policy(
    root: &Path,
    mode: &str,
    name: &str,
    relay: &mut Relay,
    lifetime: Duration,
    policy: TicketPolicy,
) -> Result<Session<TcpStream>, Error> {
    let port: u16 = public(root, "vnc-port").parse().unwrap();
    let stream = TcpStream::connect(("127.0.0.1", port)).await?;
    let auth = QemuGssapiAuthentication {
        credentials: credentials(root, mode),
        ticket_policy: policy,
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

#[tokio::test]
#[ignore = "manual local-11 real QEMU with independent signed MIT KDC"]
async fn pinned_online_password_eligible_pre_auth_renewal_is_once_and_terminal_on_failure() {
    let root = fixture(0);
    for mode in ["keytab", "password"] {
        for (lifetime, renewable, expected_tgs) in [(4, 120, 3), (4, 0, 1), (60, 120, 1)] {
            let mut relay = Relay::new(&root);
            let mut session = connect_with_policy(
                &root,
                mode,
                "localhost",
                &mut relay,
                Duration::from_secs(60),
                TicketPolicy::new(
                    Duration::from_secs(lifetime),
                    Duration::from_secs(renewable),
                )
                .unwrap(),
            )
            .await
            .unwrap();
            let frame = session
                .capture(Instant::now() + Duration::from_secs(2))
                .await
                .unwrap();
            assert_eq!(
                (frame.metadata().width, frame.metadata().height),
                (640, 480)
            );
            assert!(frame.png().len() > 1000);
            assert_eq!(relay.tgs_requests, expected_tgs);
            session.close();
            assert_eq!(fs::read_dir(root.join("private")).unwrap().count(), 0);
        }
        for failure in [
            kerberos_worker::Error::KdcUnavailable,
            kerberos_worker::Error::DeliveryUnknown,
            kerberos_worker::Error::Authority,
        ] {
            let mut relay = Relay::new(&root);
            relay.renewal_failure = Some(failure);
            let result = connect_with_policy(
                &root,
                mode,
                "localhost",
                &mut relay,
                Duration::from_secs(60),
                TicketPolicy::new(Duration::from_secs(4), Duration::from_secs(120)).unwrap(),
            )
            .await;
            assert!(matches!(result, Err(Error::Kerberos(error)) if error == failure));
            assert_eq!(
                relay.tgs_requests, 2,
                "failed renewal must not reach GSS, reacquire or replay"
            );
            // Failed authentication drops Context; the owned fixture checks
            // actual kill/wait and private-tree cleanup before final teardown.
        }
    }
    println!(
        "real QEMU keytab/password automatic eligible pre-auth renewal; live nonrenewable/long tickets avoid renewal; controlled route failures are terminal without reacquisition/replay"
    );
}

#[tokio::test]
#[ignore = "requires independent signed MIT KDC and actual native worker"]
// Keep this in the manual full-QEMU group, outside controlled-peer CI selection.
async fn pinned_online_password_renew_cancellation_keeps_native_owner_until_reap_and_cleanup() {
    use std::os::unix::fs::PermissionsExt;
    use std::sync::{
        Arc,
        atomic::{AtomicU32, Ordering},
    };
    use tokio::sync::{OwnedSemaphorePermit, Semaphore, oneshot};

    struct Lease {
        root: Option<tempfile::TempDir>,
        pid: AtomicU32,
        permit: Option<OwnedSemaphorePermit>,
        completed: Option<oneshot::Sender<(bool, bool, bool)>>,
    }
    impl Drop for Lease {
        fn drop(&mut self) {
            let reaped =
                !Path::new(&format!("/proc/{}", self.pid.load(Ordering::Acquire))).exists();
            let empty = self.root.as_ref().is_some_and(|root| {
                fs::read_dir(root.path()).is_ok_and(|mut entries| entries.next().is_none())
            });
            let removed = self.root.take().unwrap().close().is_ok();
            drop(self.permit.take());
            let _ = self
                .completed
                .take()
                .unwrap()
                .send((reaped, empty, removed));
        }
    }
    struct OwnedRelay {
        relay: Relay,
        owner: Option<Arc<Lease>>,
        entered: Option<oneshot::Sender<()>>,
        gate: Option<oneshot::Receiver<()>>,
    }
    impl KdcExchange for OwnedRelay {
        fn work_owner(&self) -> Option<Arc<dyn kerberos_worker::WorkOwner>> {
            self.owner
                .as_ref()
                .map(|owner| Arc::clone(owner) as Arc<dyn kerberos_worker::WorkOwner>)
        }
        async fn authorize(&mut self) -> Result<(), kerberos_worker::Error> {
            self.relay.authorize().await
        }
        async fn exchange(
            &mut self,
            realm: &str,
            request: &[u8],
        ) -> Result<Zeroizing<Vec<u8>>, kerberos_worker::Error> {
            if let Some(gate) = self.gate.take() {
                self.entered.take().unwrap().send(()).unwrap();
                gate.await.map_err(|_| kerberos_worker::Error::Authority)?;
            }
            self.relay.exchange(realm, request).await
        }
    }

    let fixture = fixture(0);
    for cancel in [false, true] {
        let semaphore = Arc::new(Semaphore::new(1));
        let root = tempfile::Builder::new()
            .permissions(fs::Permissions::from_mode(0o700))
            .tempdir_in(fixture.join("private"))
            .unwrap();
        let path = root.path().to_owned();
        let (completed, receipt) = oneshot::channel();
        let owner = Arc::new(Lease {
            root: Some(root),
            pid: AtomicU32::new(0),
            permit: Some(semaphore.clone().acquire_owned().await.unwrap()),
            completed: Some(completed),
        });
        let weak = Arc::downgrade(&owner);
        let mut relay = OwnedRelay {
            relay: Relay::new(&fixture),
            owner: Some(owner.clone()),
            entered: None,
            gate: None,
        };
        let (mut context, _) = kerberos_worker::open(
            &path,
            credentials(&fixture, "keytab"),
            TicketPolicy::new(Duration::from_secs(60), Duration::from_secs(120)).unwrap(),
            Instant::now() + Duration::from_secs(20),
            &mut relay,
        )
        .await
        .unwrap();
        let pid = context.process_id();
        owner.pid.store(pid, Ordering::Release);
        relay.owner.take();
        drop(owner);
        assert!(weak.upgrade().is_some());
        assert_eq!(semaphore.available_permits(), 0);
        assert!(Path::new(&format!("/proc/{pid}")).exists());
        if cancel {
            let (entered, waiting) = oneshot::channel();
            let (release, gate) = oneshot::channel();
            relay.entered = Some(entered);
            relay.gate = Some(gate);
            let task = tokio::spawn(async move { context.renew(&mut relay).await });
            tokio::time::timeout(Duration::from_secs(5), waiting)
                .await
                .unwrap()
                .unwrap();
            task.abort();
            assert!(task.await.unwrap_err().is_cancelled());
            drop(release);
        } else {
            context.close().await.unwrap();
        }
        let observed = tokio::time::timeout(Duration::from_secs(5), receipt)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            observed,
            (true, true, true),
            "opaque owner was released before native reap/fixed-file cleanup/root removal"
        );
        assert!(weak.upgrade().is_none());
        assert_eq!(semaphore.available_permits(), 1);
        assert!(!path.exists());
    }
}
fn retain_frame(
    directory: &Path,
    root: &Path,
    mode: &str,
    occurrence: &str,
    bytes: &[u8],
) -> std::io::Result<()> {
    assert!(directory.is_dir() && !directory.is_symlink());
    assert!(matches!(
        occurrence,
        "sequential" | "concurrent" | "offline"
    ));
    let name = format!(
        "{}-{mode}-{occurrence}.png",
        root.file_name().unwrap().to_str().unwrap()
    );
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(directory.join(name))?;
    std::io::Write::write_all(&mut output, bytes)
}

#[test]
fn capture_receipts_preserve_sequential_and_concurrent_occurrences_without_overwrite() {
    // Public inert IO canary only; no PNG, TLS, GSS or native receipt is faked.
    let parent = Path::new(env!("CARGO_MANIFEST_DIR")).join("../target/qemu-gssapi-runtime-tests");
    fs::create_dir_all(&parent).unwrap();
    let directory = tempfile::tempdir_in(&parent).unwrap();
    let root = Path::new("0");
    retain_frame(
        directory.path(),
        root,
        "keytab",
        "sequential",
        b"public first capture IO canary",
    )
    .unwrap();
    retain_frame(
        directory.path(),
        root,
        "keytab",
        "concurrent",
        b"public second capture IO canary",
    )
    .unwrap();
    assert_eq!(
        fs::read(directory.path().join("0-keytab-sequential.png")).unwrap(),
        b"public first capture IO canary"
    );
    assert_eq!(
        fs::read(directory.path().join("0-keytab-concurrent.png")).unwrap(),
        b"public second capture IO canary"
    );
    assert_eq!(
        retain_frame(
            directory.path(),
            root,
            "keytab",
            "sequential",
            b"must not overwrite"
        )
        .unwrap_err()
        .kind(),
        std::io::ErrorKind::AlreadyExists
    );
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 2);
}

async fn framebuffer(root: &Path, mode: &str, occurrence: &str, relay: &mut Relay) {
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
    if let Some(directory) = std::env::var_os("QEMU_GSSAPI_CAPTURE_DIR") {
        retain_frame(
            &PathBuf::from(directory),
            root,
            mode,
            occurrence,
            frame.png(),
        )
        .unwrap();
    }
    drop(session);
    assert_eq!(fs::read_dir(root.join("private")).unwrap().count(), 0);
}

fn mit_peer(root: &Path, mode: &str) -> tokio::process::Child {
    let mut command = tokio::process::Command::new("python3");
    command
        // The fixture runner fixes CWD to its verified source checkout. Cross-job
        // optimized consumers must not read a producer-container absolute path.
        // Only the independent acceptor script is located here; the worker stays
        // the immutable native package sealed into this actual test executable.
        .arg(
            std::env::current_dir()
                .unwrap()
                .join("crates/rfb-client/tests/fixtures/mit_gss_peer.py"),
        )
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
        .kill_on_drop(true);
    match public(root, "peer-provider").as_str() {
        "pinned-host" => {}
        "signed-private" | "source-built-full-private" => {
            // These are explicit independently selected fixture profiles,
            // never a host fallback or production native backend override.
            // Only the independent acceptor receives this exact fixture directory.
            // Missing metadata refuses; there is no ambient-library fallback.
            command.env("LD_LIBRARY_PATH", public(root, "peer-libdir"));
        }
        _ => panic!("unsupported independent fixture provider"),
    }
    command.spawn().unwrap()
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
#[ignore = "requires generated local-only pinned MIT/KDC fixture"]
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
#[ignore = "requires generated local-only pinned MIT/KDC fixture"]
async fn pinned_completed_gss_expiry_is_retained_before_no_layer_output() {
    use kerberos_worker::Error as NativeError;
    let root = fixture(0);
    let mut relay = Relay::new(&root);
    let (mut context, status) = kerberos_worker::open(
        &root.join("private"),
        credentials(&root, "keytab"),
        TicketPolicy::new(Duration::from_secs(4), Duration::ZERO).unwrap(),
        Instant::now() + Duration::from_secs(10),
        &mut relay,
    )
    .await
    .unwrap();
    let id = context.process_id();
    let mut peer = mit_peer(&root, "valid");
    let mut input = peer.stdin.take().unwrap();
    let mut output = peer.stdout.take().unwrap();
    let first = context.step(None, &mut relay).await.unwrap();
    let token = first.token.unwrap();
    input
        .write_u32(u32::try_from(token.len()).unwrap())
        .await
        .unwrap();
    input.write_all(&token).await.unwrap();
    drop(token);
    let ap_rep = peer_frame(&mut output).await.unwrap();
    let complete = context.step(Some(ap_rep), &mut relay).await.unwrap();
    assert!(complete.complete);
    assert!(complete.expires_at < status.expires_at);
    input.write_u8(1).await.unwrap();
    let offer = peer_frame(&mut output).await.unwrap();
    // The rounded-down completed-GSS bound is earlier than the source ticket.
    // Native/kernel work uses the real clock, and no ticket lifetime is changed.
    tokio::time::sleep_until(complete.expires_at).await;
    assert!(Instant::now() < status.expires_at);
    let selected = context.select_no_layer(offer, &mut relay).await;
    let accepted_after_expiry = if let Ok(token) = &selected {
        input
            .write_u32(u32::try_from(token.len()).unwrap())
            .await
            .unwrap();
        input.write_all(token).await.unwrap();
        assert_eq!(peer_frame(&mut output).await.unwrap().as_slice(), &[1]);
        true
    } else {
        false
    };
    context.close().await.unwrap();
    assert!(!Path::new(&format!("/proc/{id}")).exists());
    drop(input);
    if !accepted_after_expiry {
        let end = tokio::time::timeout(Duration::from_secs(2), peer_frame(&mut output))
            .await
            .unwrap()
            .unwrap_err();
        assert_eq!(end.kind(), std::io::ErrorKind::UnexpectedEof);
    }
    drop(output);
    if peer.try_wait().unwrap().is_none() {
        peer.start_kill().unwrap();
    }
    peer.wait().await.unwrap();
    assert_eq!(fs::read_dir(root.join("private")).unwrap().count(), 0);
    assert!(
        !accepted_after_expiry,
        "the independent MIT acceptor verified a no-layer response after completed-GSS expiry"
    );
    assert!(matches!(selected, Err(NativeError::Expired)));
}

#[tokio::test]
#[ignore = "requires generated local-only QEMU9.2/Cyrus/KDC fixture"]
async fn pinned_online_password_keytab_and_concurrent_exact_realms() {
    let root = fixture(0);
    for mode in ["password", "keytab"] {
        let mut relay = Relay::new(&root);
        framebuffer(&root, mode, "sequential", &mut relay).await;
        assert!(relay.requests > 0);
        println!(
            "independent native QEMU263/{mode}: verified TLS, mutual GSS, complete ServerInit and PNG"
        );
    }
    let other = fixture(1);
    let mut first = Relay::new(&root);
    let mut second = Relay::new(&other);
    tokio::join!(
        framebuffer(&root, "keytab", "concurrent", &mut first),
        framebuffer(&other, "password", "concurrent", &mut second)
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
        framebuffer(&root, "ticket", "offline", &mut relay).await;
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
#[ignore = "requires independent signed MIT KDC and actual native worker"]
async fn pinned_native_renew_expired_ticket_has_live_renew_till() {
    let root = fixture(0);
    for mode in ["keytab", "password"] {
        let mut relay = Relay::new(&root);
        // An expired initial ticket is distinct from exhaustion of renew-till.
        // Refusal must not issue KDC traffic or silently reacquire the same source.
        let (mut context, status) = kerberos_worker::open(
            &root.join("private"),
            credentials(&root, mode),
            TicketPolicy::new(Duration::from_secs(2), Duration::from_secs(60)).unwrap(),
            Instant::now() + Duration::from_secs(10),
            &mut relay,
        )
        .await
        .unwrap();
        let id = context.process_id();
        assert!(status.renewable);
        tokio::time::sleep_until(status.expires_at + Duration::from_secs(1)).await;
        assert!(
            UNIX_EPOCH + Duration::from_secs(u64::from(status.declared_renew_till))
                > SystemTime::now()
        );
        let requests = relay.requests;
        assert_eq!(
            context.renew(&mut relay).await.unwrap_err(),
            kerberos_worker::Error::Expired
        );
        assert_eq!(relay.requests, requests);
        context.close().await.unwrap();
        assert!(!Path::new(&format!("/proc/{id}")).exists());
        assert_eq!(fs::read_dir(root.join("private")).unwrap().count(), 0);
    }
}

#[tokio::test]
#[ignore = "requires independent signed MIT KDC and actual native worker"]
async fn pinned_native_renew_nonrenewable_same_source_reacquisition() {
    let root = fixture(0);
    for mode in ["keytab", "password"] {
        let mut ids = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(15);
        let mut relay = Relay::new(&root);
        let (mut context, initial) = kerberos_worker::open(
            &root.join("private"),
            credentials(&root, mode),
            TicketPolicy::new(Duration::from_secs(10), Duration::from_secs(60)).unwrap(),
            deadline,
            &mut relay,
        )
        .await
        .unwrap();
        ids.push(context.process_id());
        assert!(initial.renewable);
        tokio::time::sleep(Duration::from_secs(2)).await;
        let renewed = context.renew(&mut relay).await.unwrap();
        assert!(renewed.expires_at > initial.expires_at);
        let next = context.reacquire(&mut relay).await.unwrap();
        assert!(next.expires_at > Instant::now());
        context.close().await.unwrap();
        let (mut context, status) = kerberos_worker::open(
            &root.join("private"),
            credentials(&root, mode),
            TicketPolicy::new(Duration::from_secs(10), Duration::ZERO).unwrap(),
            deadline,
            &mut relay,
        )
        .await
        .unwrap();
        ids.push(context.process_id());
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
            credentials(&root, mode),
            policy,
            deadline,
            &mut first,
        )
        .await
        .unwrap();
        let (mut reacquired, prior) = kerberos_worker::open(
            &root.join("private"),
            credentials(&root, mode),
            policy,
            deadline,
            &mut second,
        )
        .await
        .unwrap();
        ids.extend([expired.process_id(), reacquired.process_id()]);
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
        assert!(
            ids.into_iter()
                .all(|id| !Path::new(&format!("/proc/{id}")).exists())
        );
        assert_eq!(fs::read_dir(root.join("private")).unwrap().count(), 0);
    }
    println!(
        "real keytab/password AS/TGS renewal, nonrenewable and exhausted renew-till refusals; explicit same-source reacquisition after expiry, without fallback or active RFB extension"
    );
}
