use super::*;
use runner_host::paths::HomePaths;
use tokio::sync::OnceCell;

struct CaBytes {
    cert: Vec<u8>,
    key: Vec<u8>,
    combined: Vec<u8>,
}

struct TestCaIdentities {
    first: CaBytes,
    second: CaBytes,
}

static TEST_CA_IDENTITIES: OnceCell<TestCaIdentities> = OnceCell::const_new();

fn read_ca(ca_dir: &Path) -> CaBytes {
    CaBytes {
        cert: std::fs::read(ca_dir.join(CA_CERT)).unwrap(),
        key: std::fs::read(ca_dir.join(CA_KEY)).unwrap(),
        combined: std::fs::read(ca_dir.join(CA_COMBINED)).unwrap(),
    }
}

fn generate_test_ca() -> CaBytes {
    let dir = tempfile::tempdir().unwrap();
    let files = CaFiles::new(dir.path());
    let key_path = files.key.to_string_lossy();
    let cert_path = files.cert.to_string_lossy();

    // Recovery inputs need valid RSA identities, not production-strength keys.
    run_openssl(&[
        "req",
        "-new",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-keyout",
        key_path.as_ref(),
        "-out",
        cert_path.as_ref(),
        "-subj",
        "/CN=runner-ca-test",
    ])
    .unwrap();

    let cert = std::fs::read(&files.cert).unwrap();
    let key = std::fs::read(&files.key).unwrap();
    let mut combined = cert.clone();
    combined.extend_from_slice(&key);
    CaBytes {
        cert,
        key,
        combined,
    }
}

async fn test_ca_identities() -> &'static TestCaIdentities {
    TEST_CA_IDENTITIES
        .get_or_init(|| async {
            tokio::task::spawn_blocking(|| {
                let first = generate_test_ca();
                let second = generate_test_ca();
                assert!(first.key != second.key, "test CA identities should differ");
                TestCaIdentities { first, second }
            })
            .await
            .unwrap()
        })
        .await
}

fn write_ca(ca_dir: &Path, cert: &[u8], key: &[u8], combined: Option<&[u8]>) {
    std::fs::create_dir_all(ca_dir).unwrap();
    std::fs::write(ca_dir.join(CA_CERT), cert).unwrap();
    std::fs::write(ca_dir.join(CA_KEY), key).unwrap();
    if let Some(combined) = combined {
        std::fs::write(ca_dir.join(CA_COMBINED), combined).unwrap();
    }
}

fn assert_ca_eq(actual: &CaBytes, expected: &CaBytes) {
    assert!(actual.cert == expected.cert, "certificate identity changed");
    assert!(actual.key == expected.key, "private key identity changed");
    assert!(
        actual.combined == expected.combined,
        "combined identity changed"
    );
}

/// Gate the real OpenSSL input without replacing the CA implementation.
/// Drop also releases the reader if a test fails before its normal cleanup.
struct CaReadGate {
    path: PathBuf,
    replacement: PathBuf,
    content: &'static [u8],
    writer: Option<std::fs::File>,
    released: bool,
}

impl CaReadGate {
    fn new(ca_dir: &Path, content: &'static [u8]) -> Self {
        std::fs::create_dir_all(ca_dir).unwrap();
        let path = ca_dir.join(CA_COMBINED);
        nix::unistd::mkfifo(
            &path,
            nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR,
        )
        .unwrap();
        let replacement = ca_dir.join("valid-combined.pem");
        std::fs::write(&replacement, content).unwrap();
        Self {
            path,
            replacement,
            content,
            writer: None,
            released: false,
        }
    }

    async fn wait_for_reader(&mut self) {
        use std::os::unix::fs::OpenOptionsExt;

        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                match std::fs::OpenOptions::new()
                    .write(true)
                    .custom_flags(libc::O_NONBLOCK | libc::O_CLOEXEC)
                    .open(&self.path)
                {
                    Ok(writer) => {
                        self.writer = Some(writer);
                        return;
                    }
                    Err(error) if error.raw_os_error() == Some(libc::ENXIO) => {
                        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                    }
                    Err(error) => panic!("open CA input gate: {error}"),
                }
            }
        })
        .await
        .expect("OpenSSL must open the CA input");
    }

    fn release(&mut self) -> std::io::Result<()> {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;

        if self.released {
            return Ok(());
        }
        self.released = true;
        // A failing setup may leave OpenSSL waiting in open(), before we
        // obtained its writer. Pair it before replacing the FIFO path.
        let writer = self.writer.take().or_else(|| {
            std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .custom_flags(libc::O_NONBLOCK | libc::O_CLOEXEC)
                .open(&self.path)
                .ok()
        });
        let replacement = std::fs::rename(&self.replacement, &self.path);
        let delivery = writer.map(|mut writer| writer.write_all(self.content));
        replacement?;
        delivery.transpose()?;
        Ok(())
    }
}

impl Drop for CaReadGate {
    fn drop(&mut self) {
        let _ = self.release();
    }
}

async fn start_blocked_ca(
    home: &HomePaths,
    proxy: bool,
) -> (tokio::task::JoinHandle<RunnerResult<()>>, CaReadGate) {
    let expected = &test_ca_identities().await.first;
    let mut gate = CaReadGate::new(&home.ca_dir(), &expected.combined);
    let home = home.clone();
    let task = tokio::spawn(async move {
        if proxy {
            prepare_for_proxy(&home.ca_dir(), &home.ca_lock())
                .await
                .map(drop)
        } else {
            ensure(&home).await
        }
    });
    gate.wait_for_reader().await;
    (task, gate)
}

async fn assert_cancelled_ca_finishes(home: &HomePaths, mut gate: CaReadGate) {
    let expected = &test_ca_identities().await.first;
    let held = matches!(
        lock::try_acquire_or_busy_blocking(&home.ca_lock()).unwrap(),
        lock::TryLock::Busy
    );
    let delivery = gate.release();
    // This independently opened lock observes physical retirement, including
    // all publications, rather than the cancelled caller's task completion.
    let retired = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        lock::acquire(home.ca_lock()),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(
        held,
        "cancelling the waiter released CA authority before physical completion"
    );
    delivery.unwrap();
    assert_ca_eq(&read_ca(&home.ca_dir()), expected);
    drop(retired);
}

#[tokio::test]
async fn cancelled_ca_waiters_retain_lock_until_physical_completion() {
    for proxy in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());
        let (task, gate) = start_blocked_ca(&home, proxy).await;
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert_cancelled_ca_finishes(&home, gate).await;
    }
}

#[test]
fn ca_work_retains_lock_across_runtime_shutdown() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let (task, gate) = runtime.block_on(start_blocked_ca(&home, false));
    runtime.shutdown_background();
    let observer = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    observer.block_on(async {
        assert!(task.await.unwrap_err().is_cancelled());
        assert_cancelled_ca_finishes(&home, gate).await;
    });
}

#[tokio::test]
async fn proxy_preparation_transfers_authority_and_releases_it_on_failure() {
    let expected = &test_ca_identities().await.first;
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().join("valid"));
    write_ca(
        &home.ca_dir(),
        &expected.cert,
        &expected.key,
        Some(&expected.combined),
    );

    let prepared = prepare_for_proxy(&home.ca_dir(), &home.ca_lock())
        .await
        .unwrap();
    assert!(matches!(
        lock::try_acquire_or_busy_blocking(&home.ca_lock()).unwrap(),
        lock::TryLock::Busy
    ));
    drop(prepared);
    let reacquired = lock::try_acquire_or_busy_blocking(&home.ca_lock()).unwrap();
    assert!(matches!(reacquired, lock::TryLock::Acquired(_)));
    drop(reacquired);

    let invalid = HomePaths::with_root(dir.path().join("invalid"));
    std::fs::create_dir_all(invalid.ca_dir()).unwrap();
    let error = prepare_for_proxy(&invalid.ca_dir(), &invalid.ca_lock())
        .await
        .err()
        .unwrap();
    assert!(matches!(error, RunnerError::Config(_)));
    assert_eq!(
        std::fs::read_dir(invalid.ca_dir()).unwrap().count(),
        0,
        "proxy preparation must not generate an identity"
    );
    assert!(matches!(
        lock::try_acquire_or_busy_blocking(&invalid.ca_lock()).unwrap(),
        lock::TryLock::Acquired(_)
    ));
}

async fn assert_valid_ca(ca_dir: &Path) {
    let files = CaFiles::new(ca_dir);
    let combined = std::fs::read(&files.combined).unwrap();
    let identity = tokio::task::spawn_blocking(move || load_identity(&files.cert, &files.key))
        .await
        .unwrap()
        .unwrap()
        .expect("standalone CA should be valid");
    assert!(
        combined == identity.combined(),
        "combined should exactly contain the standalone certificate and key"
    );
}

#[cfg(unix)]
fn mode_of(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

#[tokio::test]
async fn ensure_generates_valid_ca_and_is_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());

    ensure(&home).await.unwrap();

    let ca_dir = home.ca_dir();
    assert!(ca_dir.join(CA_CERT).exists(), "cert should exist");
    assert!(ca_dir.join(CA_KEY).exists(), "key should exist");
    assert!(ca_dir.join(CA_COMBINED).exists(), "combined should exist");

    let combined = std::fs::read_to_string(ca_dir.join(CA_COMBINED)).unwrap();
    assert!(combined.contains("BEGIN CERTIFICATE"));
    assert!(combined.contains("BEGIN PRIVATE KEY") || combined.contains("BEGIN RSA PRIVATE KEY"));
    assert_valid_ca(&ca_dir).await;
    #[cfg(unix)]
    {
        assert_eq!(mode_of(&ca_dir), 0o700, "ca_dir should be 0700");
        assert_eq!(mode_of(&ca_dir.join(CA_KEY)), 0o600, "key should be 0600");
        assert_eq!(
            mode_of(&ca_dir.join(CA_COMBINED)),
            0o600,
            "combined should be 0600"
        );
        assert_eq!(mode_of(&ca_dir.join(CA_CERT)), 0o644, "cert should be 0644");
    }

    let first = read_ca(&ca_dir);
    ensure(&home).await.unwrap();
    assert_ca_eq(&read_ca(&ca_dir), &first);
}

#[cfg(unix)]
#[tokio::test]
async fn ensure_regenerates_invalid_legacy_files_and_migrates_permissions() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let ca_dir = home.ca_dir();

    // Simulate legacy runner: 0755 dir, 0644 key + combined.
    std::fs::create_dir_all(&ca_dir).unwrap();
    std::fs::set_permissions(&ca_dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(ca_dir.join(CA_CERT), b"fake cert").unwrap();
    std::fs::write(ca_dir.join(CA_KEY), b"fake key").unwrap();
    std::fs::write(ca_dir.join(CA_COMBINED), b"fake combined").unwrap();
    for name in [CA_CERT, CA_KEY, CA_COMBINED] {
        std::fs::set_permissions(ca_dir.join(name), std::fs::Permissions::from_mode(0o644))
            .unwrap();
    }

    ensure(&home).await.unwrap();

    assert_eq!(mode_of(&ca_dir), 0o700, "ca_dir should be migrated to 0700");
    assert_eq!(
        mode_of(&ca_dir.join(CA_KEY)),
        0o600,
        "key should be migrated to 0600"
    );
    assert_eq!(
        mode_of(&ca_dir.join(CA_COMBINED)),
        0o600,
        "combined should be migrated to 0600"
    );
    assert_eq!(
        mode_of(&ca_dir.join(CA_CERT)),
        0o644,
        "cert should remain 0644"
    );

    assert!(
        std::fs::read(ca_dir.join(CA_KEY)).unwrap() != b"fake key",
        "invalid legacy key should be replaced"
    );
    assert_valid_ca(&ca_dir).await;
}

#[cfg(unix)]
#[tokio::test]
async fn ensure_rejects_ca_dir_symlink_without_chmodding_target() {
    use std::os::unix::fs::{PermissionsExt, symlink};

    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target");
    std::fs::create_dir(&target).unwrap();
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).unwrap();

    let home_root = dir.path().join("home");
    std::fs::create_dir(&home_root).unwrap();
    let home = HomePaths::with_root(home_root);
    symlink(&target, home.ca_dir()).unwrap();

    let err = ensure(&home).await.unwrap_err();

    assert!(err.to_string().contains("not a directory"), "got {err:?}");
    assert_eq!(
        mode_of(&target),
        0o755,
        "target dir should not be chmodded through ca_dir symlink"
    );
    assert!(
        !target.join(CA_CERT).exists(),
        "CA files should not be generated through ca_dir symlink"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn ensure_rebuilds_combined_without_rotating_ca() {
    let identities = test_ca_identities().await;
    let original = &identities.first;
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let ca_dir = home.ca_dir();

    // Lose only the combined PEM — mirrors a manual cleanup or partial
    // disk corruption scenario.
    write_ca(
        &ca_dir,
        &original.cert,
        &original.key,
        Some(&original.combined),
    );
    std::fs::remove_file(ca_dir.join(CA_COMBINED)).unwrap();

    // Rebuild combined from existing cert + key without rotating the CA.
    ensure(&home).await.unwrap();

    assert_ca_eq(&read_ca(&ca_dir), original);
    assert_eq!(
        mode_of(&ca_dir.join(CA_COMBINED)),
        0o600,
        "rebuilt combined should be 0600"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn ensure_regenerates_combined_when_partial_state() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());

    // Leave a stale combined file with wrong perms behind from a prior run.
    let ca_dir = home.ca_dir();
    std::fs::create_dir_all(&ca_dir).unwrap();
    std::fs::write(ca_dir.join(CA_COMBINED), b"stale").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(
        ca_dir.join(CA_COMBINED),
        std::fs::Permissions::from_mode(0o644),
    )
    .unwrap();

    // Partial state (cert+key missing) → regenerate. Must not panic with EEXIST.
    ensure(&home).await.unwrap();

    assert_eq!(
        mode_of(&ca_dir.join(CA_COMBINED)),
        0o600,
        "regenerated combined should be 0600"
    );
    let combined = std::fs::read_to_string(ca_dir.join(CA_COMBINED)).unwrap();
    assert!(
        combined.contains("BEGIN CERTIFICATE"),
        "combined should contain real cert, not stale placeholder"
    );
    assert_valid_ca(&ca_dir).await;
}

#[tokio::test]
async fn ensure_prefers_valid_combined_over_different_standalone_identity() {
    let identities = test_ca_identities().await;
    let combined_identity = &identities.first;
    let standalone_identity = &identities.second;
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    write_ca(
        &home.ca_dir(),
        &standalone_identity.cert,
        &standalone_identity.key,
        Some(&combined_identity.combined),
    );

    ensure(&home).await.unwrap();

    assert_ca_eq(&read_ca(&home.ca_dir()), combined_identity);
}

#[tokio::test]
async fn ensure_repairs_mismatched_standalone_from_valid_combined() {
    let identities = test_ca_identities().await;
    let committed = &identities.first;
    let other = &identities.second;
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    write_ca(
        &home.ca_dir(),
        &other.cert,
        &committed.key,
        Some(&committed.combined),
    );

    ensure(&home).await.unwrap();

    assert_ca_eq(&read_ca(&home.ca_dir()), committed);
}

#[tokio::test]
async fn ensure_recovers_missing_standalone_from_valid_combined() {
    let identities = test_ca_identities().await;
    let committed = &identities.first;
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    std::fs::create_dir_all(home.ca_dir()).unwrap();
    let mut mitmproxy_order = committed.key.clone();
    mitmproxy_order.extend_from_slice(&committed.cert);
    std::fs::write(home.ca_dir().join(CA_COMBINED), mitmproxy_order).unwrap();

    ensure(&home).await.unwrap();

    assert_ca_eq(&read_ca(&home.ca_dir()), committed);
}

#[tokio::test]
async fn ensure_recovers_invalid_combined_from_valid_standalone() {
    let identities = test_ca_identities().await;
    let standalone = &identities.first;
    let other = &identities.second;
    let mut mismatched_combined = standalone.cert.clone();
    mismatched_combined.extend_from_slice(&other.key);

    for invalid_combined in [
        Vec::new(),
        standalone.cert.clone(),
        b"not a PEM file".to_vec(),
        mismatched_combined,
    ] {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());
        write_ca(
            &home.ca_dir(),
            &standalone.cert,
            &standalone.key,
            Some(&invalid_combined),
        );

        ensure(&home).await.unwrap();

        assert_ca_eq(&read_ca(&home.ca_dir()), standalone);
    }
}

#[tokio::test]
async fn ensure_generates_when_no_identity_is_recoverable() {
    let identities = test_ca_identities().await;
    let first = &identities.first;
    let second = &identities.second;
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    write_ca(
        &home.ca_dir(),
        &first.cert,
        &second.key,
        Some(b"partial combined"),
    );

    ensure(&home).await.unwrap();

    let generated = read_ca(&home.ca_dir());
    assert!(
        generated.cert.as_slice() != first.cert.as_slice(),
        "unrecoverable certificate should be replaced"
    );
    assert!(
        generated.key.as_slice() != second.key.as_slice(),
        "unrecoverable key should be replaced"
    );
    assert_valid_ca(&home.ca_dir()).await;
}

#[tokio::test]
async fn ensure_ignores_dangling_staging_file() {
    let identities = test_ca_identities().await;
    let standalone = &identities.first;
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    write_ca(
        &home.ca_dir(),
        &standalone.cert,
        &standalone.key,
        Some(b"partial combined"),
    );
    std::fs::write(
        home.ca_dir().join(".mitmproxy-ca.pem.interrupted.tmp"),
        b"staged but unpublished",
    )
    .unwrap();

    ensure(&home).await.unwrap();

    assert_ca_eq(&read_ca(&home.ca_dir()), standalone);
}
