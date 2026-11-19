mod key;

use runner_host::host_file::{self, DirMode};
use runner_host::paths::HomePaths;
use runner_host::state_file;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Command, Stdio};

struct CaFixture {
    cert: String,
    key: String,
    combined: String,
}

pub(super) async fn prepare_test_ca(home: &HomePaths) {
    static CA: tokio::sync::OnceCell<CaFixture> = tokio::sync::OnceCell::const_new();
    let identity = CA
        .get_or_init(|| async { tokio::task::spawn_blocking(generate_ca).await.unwrap() })
        .await;

    // Each home owns its files and lock. Proxy startup validates and
    // reconciles the fixture through prepare_for_proxy.
    let lock = runner_host::lock::acquire(home.ca_lock()).await.unwrap();
    let directory = home.ca_dir();
    tokio::task::spawn_blocking(move || {
        let _lock = lock;
        host_file::ensure_dir(&directory, DirMode::Private, "test CA directory").unwrap();
        for (name, content) in [
            (crate::ca::CA_CERT, &identity.cert),
            ("mitmproxy-ca-key.pem", &identity.key),
            ("mitmproxy-ca.pem", &identity.combined),
        ] {
            state_file::write_private_atomic_blocking(&directory.join(name), content.as_bytes())
                .unwrap();
        }
        std::fs::set_permissions(
            directory.join(crate::ca::CA_CERT),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
    })
    .await
    .unwrap();
}

fn generate_ca() -> CaFixture {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("proxy-fixture-key.der");
    state_file::write_private_atomic_blocking(&source, &hex::decode(key::PKCS8_DER_HEX).unwrap())
        .unwrap();
    // Issue a fresh certificate with the public synthetic key. The separate
    // ca::tests suite exercises production prime generation and recovery.
    let cert = openssl(
        &[
            "req",
            "-new",
            "-x509",
            "-days",
            "3650",
            "-keyform",
            "DER",
            "-subj",
            "/CN=mitmproxy/O=mitmproxy",
            "-addext",
            "basicConstraints=critical,CA:TRUE",
            "-addext",
            "keyUsage=critical,keyCertSign,cRLSign",
            "-key",
        ],
        &source,
    );
    let key = openssl(&["pkey", "-inform", "DER", "-in"], &source);
    let combined = format!("{cert}{key}");
    CaFixture {
        cert,
        key,
        combined,
    }
}

fn openssl(args: &[&str], key: &Path) -> String {
    let output = Command::new("openssl")
        .args(args)
        .arg(key)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "openssl {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}
