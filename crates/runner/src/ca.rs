use std::path::{Path, PathBuf};

use crate::error::{RunnerError, RunnerResult};
use crate::lock;
use crate::paths::HomePaths;
use crate::state_file;

pub(crate) const CA_CERT: &str = "mitmproxy-ca-cert.pem";
const CA_KEY: &str = "mitmproxy-ca-key.pem";
const CA_COMBINED: &str = "mitmproxy-ca.pem";

struct CaFiles {
    cert: PathBuf,
    key: PathBuf,
    combined: PathBuf,
}

impl CaFiles {
    fn new(ca_dir: &Path) -> Self {
        Self {
            cert: ca_dir.join(CA_CERT),
            key: ca_dir.join(CA_KEY),
            combined: ca_dir.join(CA_COMBINED),
        }
    }
}

struct CaIdentity {
    cert: Vec<u8>,
    key: Vec<u8>,
}

impl CaIdentity {
    fn combined(&self) -> Vec<u8> {
        let mut combined = self.cert.clone();
        combined.extend_from_slice(&self.key);
        combined
    }
}

/// Holds the CA flock after proxy preparation until mitmdump is ready.
pub(crate) struct PreparedCa {
    _lock: nix::fcntl::Flock<std::fs::File>,
}

/// Ensure CA certificates exist at `/var/lib/vm0-runner/ca/`.
///
/// Recovers a valid combined identity first, then a valid standalone identity.
/// Generates a self-signed RSA 4096 CA via openssl only when neither
/// representation is recoverable. Idempotent — safe to call on every build.
///
/// Also locks down permissions unconditionally on every call (not just on
/// first-ever generation) so legacy runners that shipped with looser perms
/// get migrated automatically.
pub async fn ensure(home: &HomePaths) -> RunnerResult<()> {
    let _lock = lock::acquire(home.ca_lock()).await?;
    let ca_dir = home.ca_dir();
    create_ca_dir(&ca_dir).await?;
    secure_ca_dir(&ca_dir).await?;
    reconcile(&ca_dir, true).await
}

/// Validate and recover an existing CA before launching mitmdump.
///
/// Unlike [`ensure`], this never generates a replacement identity. The
/// returned guard keeps the shared CA lock held while mitmdump reads the
/// reconciled files.
pub(crate) async fn prepare_for_proxy(
    ca_dir: &Path,
    ca_lock_path: &Path,
) -> RunnerResult<PreparedCa> {
    let ca_lock = lock::acquire(ca_lock_path.to_path_buf()).await?;
    secure_ca_dir(ca_dir).await?;
    reconcile(ca_dir, false).await?;
    Ok(PreparedCa { _lock: ca_lock })
}

async fn create_ca_dir(ca_dir: &Path) -> RunnerResult<()> {
    let mut builder = tokio::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    builder.mode(0o700);
    builder
        .create(ca_dir)
        .await
        .map_err(|e| RunnerError::Internal(format!("create ca dir: {e}")))
}

async fn secure_ca_dir(ca_dir: &Path) -> RunnerResult<()> {
    // Refuse to chmod through a directory symlink. The runner-owned parent is
    // the trust boundary for the small metadata-to-chmod TOCTOU window.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let meta = tokio::fs::symlink_metadata(ca_dir)
            .await
            .map_err(|e| RunnerError::Internal(format!("stat ca dir: {e}")))?;
        if !meta.file_type().is_dir() {
            return Err(RunnerError::Internal(format!(
                "{} is not a directory (refusing to chmod through symlink)",
                ca_dir.display()
            )));
        }
        tokio::fs::set_permissions(ca_dir, std::fs::Permissions::from_mode(0o700))
            .await
            .map_err(|e| RunnerError::Internal(format!("chmod ca dir: {e}")))?;
    }
    Ok(())
}

async fn reconcile(ca_dir: &Path, allow_generation: bool) -> RunnerResult<()> {
    let files = CaFiles::new(ca_dir);

    let identity = if let Some(identity) = load_identity(&files.combined, &files.combined).await? {
        tracing::info!("using valid combined proxy CA identity");
        identity
    } else if let Some(identity) = load_identity(&files.cert, &files.key).await? {
        tracing::info!("recovering combined proxy CA from valid standalone identity");
        identity
    } else if allow_generation {
        tracing::info!("generating proxy CA certificate...");
        generate_identity(ca_dir).await?
    } else {
        return Err(RunnerError::Config(format!(
            "proxy CA in {} is not recoverable; run `runner build` before starting the proxy",
            ca_dir.display()
        )));
    };

    publish_identity(&files, &identity).await?;
    apply_perms(&files.cert, &files.key, &files.combined).await?;
    Ok(())
}

async fn load_identity(cert: &Path, key: &Path) -> RunnerResult<Option<CaIdentity>> {
    if !exists(cert).await? || !exists(key).await? {
        return Ok(None);
    }

    let cert_path = cert.to_string_lossy();
    let key_path = key.to_string_lossy();
    let Some(cert_pem) =
        try_openssl(&["x509", "-in", cert_path.as_ref(), "-outform", "PEM"]).await?
    else {
        return Ok(None);
    };
    let Some(key_pem) = try_openssl(&["pkey", "-in", key_path.as_ref(), "-outform", "PEM"]).await?
    else {
        return Ok(None);
    };
    let Some(cert_public_key) =
        try_openssl(&["x509", "-in", cert_path.as_ref(), "-pubkey", "-noout"]).await?
    else {
        return Ok(None);
    };
    let Some(private_public_key) =
        try_openssl(&["pkey", "-in", key_path.as_ref(), "-pubout"]).await?
    else {
        return Ok(None);
    };
    if cert_public_key != private_public_key {
        return Ok(None);
    }

    Ok(Some(CaIdentity {
        cert: cert_pem,
        key: key_pem,
    }))
}

async fn generate_identity(ca_dir: &Path) -> RunnerResult<CaIdentity> {
    let staging = tempfile::Builder::new()
        .prefix(".ca-generation-")
        .tempdir_in(ca_dir)
        .map_err(|e| RunnerError::Internal(format!("create CA staging directory: {e}")))?;
    let key = staging.path().join(CA_KEY);
    let cert = staging.path().join(CA_CERT);

    run_openssl(&["genrsa", "-out", key.to_string_lossy().as_ref(), "4096"]).await?;
    run_openssl(&[
        "req",
        "-new",
        "-x509",
        "-days",
        "3650",
        "-key",
        key.to_string_lossy().as_ref(),
        "-out",
        cert.to_string_lossy().as_ref(),
        "-subj",
        "/CN=mitmproxy/O=mitmproxy",
        "-addext",
        "basicConstraints=critical,CA:TRUE",
        "-addext",
        "keyUsage=critical,keyCertSign,cRLSign",
    ])
    .await?;

    load_identity(&cert, &key).await?.ok_or_else(|| {
        RunnerError::Internal("generated proxy CA certificate and key do not match".into())
    })
}

async fn exists(path: &Path) -> RunnerResult<bool> {
    tokio::fs::try_exists(path)
        .await
        .map_err(|e| RunnerError::Internal(format!("check {}: {e}", path.display())))
}

async fn publish_identity(files: &CaFiles, identity: &CaIdentity) -> RunnerResult<()> {
    write_if_changed(&files.cert, &identity.cert).await?;
    write_if_changed(&files.key, &identity.key).await?;
    write_if_changed(&files.combined, &identity.combined()).await?;
    Ok(())
}

async fn write_if_changed(path: &Path, content: &[u8]) -> RunnerResult<()> {
    match tokio::fs::read(path).await {
        Ok(existing) if existing == content => return Ok(()),
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            return Err(RunnerError::Internal(format!(
                "read CA file {}: {e}",
                path.display()
            )));
        }
    }
    state_file::write_private_atomic(path, content).await
}

/// Chmod the three CA files: cert 0o644, key 0o600, combined 0o600.
/// Migrates legacy runners that shipped with looser perms. No-op on non-Unix.
#[cfg_attr(not(unix), allow(unused_variables))]
async fn apply_perms(cert: &Path, key: &Path, combined: &Path) -> RunnerResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(cert, std::fs::Permissions::from_mode(0o644))
            .await
            .map_err(|e| RunnerError::Internal(format!("chmod CA cert: {e}")))?;
        tokio::fs::set_permissions(key, std::fs::Permissions::from_mode(0o600))
            .await
            .map_err(|e| RunnerError::Internal(format!("chmod CA key: {e}")))?;
        tokio::fs::set_permissions(combined, std::fs::Permissions::from_mode(0o600))
            .await
            .map_err(|e| RunnerError::Internal(format!("chmod CA combined: {e}")))?;
    }
    Ok(())
}

async fn run_openssl(args: &[&str]) -> RunnerResult<()> {
    let output = openssl_output(args).await?;
    if !output.status.success() {
        return Err(openssl_error(args, &output));
    }
    Ok(())
}

async fn try_openssl(args: &[&str]) -> RunnerResult<Option<Vec<u8>>> {
    let output = openssl_output(args).await?;
    Ok(output.status.success().then_some(output.stdout))
}

async fn openssl_output(args: &[&str]) -> RunnerResult<std::process::Output> {
    let mut cmd = tokio::process::Command::new("openssl");
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    cmd.output()
        .await
        .map_err(|e| RunnerError::Internal(format!("spawn openssl: {e}")))
}

fn openssl_error(args: &[&str], output: &std::process::Output) -> RunnerError {
    let stderr = String::from_utf8_lossy(&output.stderr);
    RunnerError::Internal(format!(
        "openssl {} failed with {}: {stderr}",
        args.first().unwrap_or(&""),
        output.status
    ))
}

runner_test_group!(network; #[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::HomePaths;
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

    async fn generate_test_ca() -> CaBytes {
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
        .await
        .unwrap();

        let identity = load_identity(&files.cert, &files.key)
            .await
            .unwrap()
            .expect("test CA should be valid");
        let combined = identity.combined();
        CaBytes {
            cert: identity.cert,
            key: identity.key,
            combined,
        }
    }

    async fn test_ca_identities() -> &'static TestCaIdentities {
        TEST_CA_IDENTITIES
            .get_or_init(|| async {
                let first = generate_test_ca().await;
                let second = generate_test_ca().await;
                assert!(first.key != second.key, "test CA identities should differ");
                TestCaIdentities { first, second }
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

    async fn assert_valid_ca(ca_dir: &Path) {
        let files = CaFiles::new(ca_dir);
        let identity = load_identity(&files.cert, &files.key)
            .await
            .unwrap()
            .expect("standalone CA should be valid");
        assert!(
            std::fs::read(&files.combined).unwrap() == identity.combined(),
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
        assert!(
            combined.contains("BEGIN PRIVATE KEY") || combined.contains("BEGIN RSA PRIVATE KEY")
        );
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
});
