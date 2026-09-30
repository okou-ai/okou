//! Opt-in, independently configured QEMU 8.2.2 VeNCrypt interop.
//! Run `cargo test -p rfb-client --test qemu_mutual_tls -- --ignored --nocapture`.
//! No pre-existing VNC server or real credentials are used; see tests/QEMU_MTLS.md.
#![cfg(test)]
#![cfg(unix)]

use std::{fs, os::unix::fs::PermissionsExt, path::Path, process::Stdio, time::Duration};

use base64::Engine;
use rfb_client::{
    AuthenticationStage, ClientCertificateAuthentication, ClientIdentity, Error, TrustRoots,
    VncPassword, X509Authentication, authenticate, authenticate_with_client_certificate,
};
use rustls::pki_types::{CertificateDer, PrivatePkcs8KeyDer};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream, UnixStream},
    process::{Child, Command},
    time::{Instant, sleep, timeout},
};

const QEMU_VERSION: &str = "QEMU emulator version 8.2.2 (Debian 1:8.2.2+ds-0ubuntu1)";
const NAME: &str = "vnc.example.test";
const PASSWORD: &str = "secret";

struct Fixture {
    dir: tempfile::TempDir,
    root: CertificateDer<'static>,
    client: CertificateDer<'static>,
    key: Vec<u8>,
    wrong_ca_client: CertificateDer<'static>,
    wrong_ca_key: Vec<u8>,
    expired_client: CertificateDer<'static>,
    expired_key: Vec<u8>,
}

fn ca() -> (rcgen::CertificateParams, rcgen::KeyPair, rcgen::Certificate) {
    let key = rcgen::KeyPair::generate().unwrap();
    let mut params = rcgen::CertificateParams::default();
    params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    params.key_usages = vec![
        rcgen::KeyUsagePurpose::KeyCertSign,
        rcgen::KeyUsagePurpose::DigitalSignature,
    ];
    let cert = params.self_signed(&key).unwrap();
    (params, key, cert)
}

fn issue_client(
    params: &rcgen::CertificateParams,
    ca_key: &rcgen::KeyPair,
    expired: bool,
) -> (CertificateDer<'static>, Vec<u8>) {
    let key = rcgen::KeyPair::generate().unwrap();
    let mut leaf = rcgen::CertificateParams::new(vec!["client.example.test".into()]).unwrap();
    leaf.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ClientAuth];
    if expired {
        leaf.not_before = rcgen::date_time_ymd(2000, 1, 1);
        leaf.not_after = rcgen::date_time_ymd(2001, 1, 1);
    }
    let cert = leaf
        .signed_by(&key, &rcgen::Issuer::from_params(params, ca_key))
        .unwrap();
    (cert.der().clone(), key.serialize_der())
}

fn pem(kind: &str, der: &[u8]) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(der);
    let body = encoded
        .as_bytes()
        .chunks(64)
        .map(|line| std::str::from_utf8(line).unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    format!("-----BEGIN {kind}-----\n{body}\n-----END {kind}-----\n")
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let (params, ca_key, ca_cert) = ca();
        let server_key = rcgen::KeyPair::generate().unwrap();
        let mut server_params = rcgen::CertificateParams::new(vec![NAME.into()]).unwrap();
        server_params.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ServerAuth];
        let server = server_params
            .signed_by(&server_key, &rcgen::Issuer::from_params(&params, &ca_key))
            .unwrap();
        fs::write(
            dir.path().join("ca-cert.pem"),
            pem("CERTIFICATE", ca_cert.der()),
        )
        .unwrap();
        fs::write(
            dir.path().join("server-cert.pem"),
            pem("CERTIFICATE", server.der()),
        )
        .unwrap();
        let key_file = dir.path().join("server-key.pem");
        fs::write(&key_file, pem("PRIVATE KEY", &server_key.serialize_der())).unwrap();
        fs::set_permissions(&key_file, fs::Permissions::from_mode(0o600)).unwrap();
        let (client, key) = issue_client(&params, &ca_key, false);
        let (expired_client, expired_key) = issue_client(&params, &ca_key, true);
        let (wrong_params, wrong_key, _) = ca();
        let (wrong_ca_client, wrong_ca_key) = issue_client(&wrong_params, &wrong_key, false);
        Self {
            dir,
            root: ca_cert.der().clone(),
            client,
            key,
            wrong_ca_client,
            wrong_ca_key,
            expired_client,
            expired_key,
        }
    }

    fn identity(&self, cert: CertificateDer<'static>, key: Vec<u8>) -> ClientIdentity {
        ClientIdentity::from_pkcs8_der(vec![cert], PrivatePkcs8KeyDer::from(key)).unwrap()
    }

    fn roots(&self) -> TrustRoots {
        TrustRoots::custom(vec![self.root.clone()]).unwrap()
    }
}

struct Server {
    child: Child,
    port: u16,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}

async fn start_server(dir: &Path, verify_peer: bool, password: bool) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    assert!(port >= 5900, "ephemeral port is below QEMU's VNC base");
    drop(listener);
    let socket = dir.join(if password {
        "qmp-password"
    } else {
        "qmp-no-password"
    });
    let vnc = format!(
        "127.0.0.1:{},tls-creds=tls0{}",
        port - 5900,
        if password { ",password=on" } else { "" }
    );
    let mut child = Command::new("qemu-system-x86_64")
        .args([
            "-machine",
            "none",
            "-nodefaults",
            "-display",
            "none",
            "-m",
            "64",
        ])
        .arg("-object")
        .arg(format!(
            "tls-creds-x509,id=tls0,dir={},endpoint=server,verify-peer={}",
            dir.display(),
            if verify_peer { "on" } else { "off" }
        ))
        .args(["-vnc", &vnc, "-qmp"])
        .arg(format!("unix:{},server=on,wait=off", socket.display()))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();

    for _ in 0..100 {
        if socket.exists() && TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
            if password {
                set_password(&socket).await;
            }
            return Server { child, port };
        }
        if let Some(exit) = child.try_wait().unwrap() {
            let output = child.wait_with_output().await.unwrap();
            panic!(
                "QEMU exited {exit}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        sleep(Duration::from_millis(25)).await;
    }
    panic!("disposable QEMU VNC did not start");
}

async fn set_password(socket: &Path) {
    let mut qmp = UnixStream::connect(socket).await.unwrap();
    let mut greeting = Vec::new();
    while !greeting.windows(5).any(|part| part == b"\"QMP\"") {
        let mut buffer = [0; 512];
        let count = timeout(Duration::from_secs(2), qmp.read(&mut buffer))
            .await
            .unwrap()
            .unwrap();
        assert_ne!(count, 0, "QMP closed before greeting");
        greeting.extend_from_slice(&buffer[..count]);
        assert!(greeting.len() < 4096, "QMP greeting too large");
    }
    qmp.write_all(b"{\"execute\":\"qmp_capabilities\"}\n")
        .await
        .unwrap();
    read_return(&mut qmp).await;
    qmp.write_all(
        format!(
            "{{\"execute\":\"set_password\",\"arguments\":{{\"protocol\":\"vnc\",\"password\":\"{PASSWORD}\"}}}}\n"
        )
        .as_bytes(),
    )
    .await
    .unwrap();
    read_return(&mut qmp).await;
}

async fn read_return(qmp: &mut UnixStream) {
    let mut data = Vec::new();
    while !data.windows(8).any(|part| part == b"\"return\"") {
        let mut buffer = [0; 512];
        let count = timeout(Duration::from_secs(2), qmp.read(&mut buffer))
            .await
            .unwrap()
            .unwrap();
        assert_ne!(count, 0, "QMP closed unexpectedly");
        data.extend_from_slice(&buffer[..count]);
        assert!(data.len() < 4096, "QMP response too large");
        assert!(
            !data.windows(7).any(|part| part == b"\"error\""),
            "QMP rejected command"
        );
    }
}

async fn connect_required(
    fixture: &Fixture,
    port: u16,
    cert: CertificateDer<'static>,
    key: Vec<u8>,
    password: Option<&str>,
    name: &str,
    roots: TrustRoots,
) -> Result<(), Error> {
    let auth = match password {
        Some(value) => ClientCertificateAuthentication::VncPassword(
            VncPassword::new(value.to_owned()).unwrap(),
        ),
        None => ClientCertificateAuthentication::None,
    };
    let stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let mut authenticated = authenticate_with_client_certificate(
        stream,
        name,
        auth,
        roots,
        fixture.identity(cert, key),
        Instant::now() + Duration::from_secs(8),
    )
    .await?
    .into_stream();
    // QEMU must remain usable after authentication: run ClientInit and read
    // ServerInit's bounded geometry, not only a TLS success result.
    authenticated.write_u8(1).await?;
    authenticated.flush().await?;
    let width = timeout(Duration::from_secs(4), authenticated.read_u16())
        .await
        .map_err(|_| Error::AuthenticationDeadlineExceeded {
            stage: AuthenticationStage::X509NoneAuthentication,
        })??;
    let height = timeout(Duration::from_secs(4), authenticated.read_u16())
        .await
        .map_err(|_| Error::AuthenticationDeadlineExceeded {
            stage: AuthenticationStage::X509NoneAuthentication,
        })??;
    assert!(width > 0 && height > 0);
    Ok(())
}

#[tokio::test]
#[ignore = "requires exact QEMU 8.2.2 executable; see tests/QEMU_MTLS.md"]
async fn qemu_vnc_mutual_tls_acceptance_and_rejections() {
    let version = Command::new("qemu-system-x86_64")
        .arg("--version")
        .output()
        .await
        .expect("install the pinned QEMU package described in tests/QEMU_MTLS.md");
    assert!(
        version.status.success()
            && String::from_utf8_lossy(&version.stdout).starts_with(QEMU_VERSION),
        "run only against the pinned QEMU version"
    );
    let fixture = Fixture::new();
    for password in [false, true] {
        let server = start_server(fixture.dir.path(), true, password).await;
        let expected = if password { Some(PASSWORD) } else { None };
        connect_required(
            &fixture,
            server.port,
            fixture.client.clone(),
            fixture.key.clone(),
            expected,
            NAME,
            fixture.roots(),
        )
        .await
        .unwrap();
        for (cert, key) in [
            (
                fixture.wrong_ca_client.clone(),
                fixture.wrong_ca_key.clone(),
            ),
            (fixture.expired_client.clone(), fixture.expired_key.clone()),
        ] {
            assert!(
                connect_required(
                    &fixture,
                    server.port,
                    cert,
                    key,
                    expected,
                    NAME,
                    fixture.roots()
                )
                .await
                .is_err()
            );
        }
        let raw = TcpStream::connect(("127.0.0.1", server.port))
            .await
            .unwrap();
        assert!(
            authenticate(
                raw,
                NAME,
                if password {
                    X509Authentication::VncPassword(VncPassword::new(PASSWORD.into()).unwrap())
                } else {
                    X509Authentication::None
                },
                fixture.roots(),
                Instant::now() + Duration::from_secs(8),
            )
            .await
            .is_err(),
            "verify-peer=on must reject a missing client certificate"
        );
        assert!(
            connect_required(
                &fixture,
                server.port,
                fixture.client.clone(),
                fixture.key.clone(),
                expected,
                "wrong.example.test",
                fixture.roots(),
            )
            .await
            .is_err()
        );
        assert!(
            connect_required(
                &fixture,
                server.port,
                fixture.client.clone(),
                fixture.key.clone(),
                expected,
                NAME,
                TrustRoots::custom(vec![ca().2.der().clone()]).unwrap(),
            )
            .await
            .is_err()
        );
        if password {
            assert!(
                connect_required(
                    &fixture,
                    server.port,
                    fixture.client.clone(),
                    fixture.key.clone(),
                    Some("wrong"),
                    NAME,
                    fixture.roots(),
                )
                .await
                .is_err()
            );
        }
        drop(server);
    }
    let server = start_server(fixture.dir.path(), false, false).await;
    let off_result = connect_required(
        &fixture,
        server.port,
        fixture.client.clone(),
        fixture.key.clone(),
        None,
        NAME,
        fixture.roots(),
    )
    .await;
    assert!(
        off_result.is_ok(),
        "QEMU verify-peer=off result: {off_result:?}"
    );
    let wrong_ca_off = connect_required(
        &fixture,
        server.port,
        fixture.wrong_ca_client.clone(),
        fixture.wrong_ca_key.clone(),
        None,
        NAME,
        fixture.roots(),
    )
    .await;
    assert!(
        wrong_ca_off.is_ok(),
        "QEMU verify-peer=off with wrong CA: {wrong_ca_off:?}"
    );
}
