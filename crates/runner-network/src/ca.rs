use std::path::{Path, PathBuf};

use crate::error::{RunnerError, RunnerResult};
use runner_host::lock;
use runner_host::paths::HomePaths;
use runner_host::state_file;

pub const CA_CERT: &str = "mitmproxy-ca-cert.pem";
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
///
/// Waiting for the CA lock is cancellable. Once admitted, preparation finishes
/// under that lock even if the caller stops waiting or its runtime shuts down.
pub async fn ensure(home: &HomePaths) -> RunnerResult<()> {
    reconcile_locked(home.ca_dir(), home.ca_lock(), true)
        .await
        .map(drop)
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
    reconcile_locked(ca_dir.to_path_buf(), ca_lock_path.to_path_buf(), false).await
}

async fn reconcile_locked(
    ca_dir: PathBuf,
    ca_lock_path: PathBuf,
    allow_generation: bool,
) -> RunnerResult<PreparedCa> {
    // Contention remains asynchronously cancellable. Once acquired, the lock
    // travels with all physical work: cancelling this waiter or shutting down
    // its runtime must not release authority before a filesystem operation ends.
    let ca_lock = lock::acquire(ca_lock_path).await?;
    tokio::task::spawn_blocking(move || {
        let prepared = PreparedCa { _lock: ca_lock };
        if allow_generation {
            create_ca_dir(&ca_dir)?;
        }
        secure_ca_dir(&ca_dir)?;
        reconcile(&ca_dir, allow_generation)?;
        Ok(prepared)
    })
    .await
    .map_err(|e| RunnerError::Internal(format!("CA preparation task: {e}")))?
}

fn create_ca_dir(ca_dir: &Path) -> RunnerResult<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(ca_dir)
        .map_err(|e| RunnerError::Internal(format!("create ca dir: {e}")))
}

fn secure_ca_dir(ca_dir: &Path) -> RunnerResult<()> {
    // Refuse to chmod through a directory symlink. The runner-owned parent is
    // the trust boundary for the small metadata-to-chmod TOCTOU window.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let meta = std::fs::symlink_metadata(ca_dir)
            .map_err(|e| RunnerError::Internal(format!("stat ca dir: {e}")))?;
        if !meta.file_type().is_dir() {
            return Err(RunnerError::Internal(format!(
                "{} is not a directory (refusing to chmod through symlink)",
                ca_dir.display()
            )));
        }
        std::fs::set_permissions(ca_dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| RunnerError::Internal(format!("chmod ca dir: {e}")))?;
    }
    Ok(())
}

fn reconcile(ca_dir: &Path, allow_generation: bool) -> RunnerResult<()> {
    let files = CaFiles::new(ca_dir);

    let identity = if let Some(identity) = load_identity(&files.combined, &files.combined)? {
        tracing::info!("using valid combined proxy CA identity");
        identity
    } else if let Some(identity) = load_identity(&files.cert, &files.key)? {
        tracing::info!("recovering combined proxy CA from valid standalone identity");
        identity
    } else if allow_generation {
        tracing::info!("generating proxy CA certificate...");
        generate_identity(ca_dir)?
    } else {
        return Err(RunnerError::Config(format!(
            "proxy CA in {} is not recoverable; run `runner build` before starting the proxy",
            ca_dir.display()
        )));
    };

    publish_identity(&files, &identity)?;
    apply_perms(&files.cert, &files.key, &files.combined)?;
    Ok(())
}

fn load_identity(cert: &Path, key: &Path) -> RunnerResult<Option<CaIdentity>> {
    if !exists(cert)? || !exists(key)? {
        return Ok(None);
    }

    let cert_path = cert.to_string_lossy();
    let key_path = key.to_string_lossy();
    let Some(cert_pem) = try_openssl(&["x509", "-in", cert_path.as_ref(), "-outform", "PEM"])?
    else {
        return Ok(None);
    };
    let Some(key_pem) = try_openssl(&["pkey", "-in", key_path.as_ref(), "-outform", "PEM"])? else {
        return Ok(None);
    };
    let Some(cert_public_key) =
        try_openssl(&["x509", "-in", cert_path.as_ref(), "-pubkey", "-noout"])?
    else {
        return Ok(None);
    };
    let Some(private_public_key) = try_openssl(&["pkey", "-in", key_path.as_ref(), "-pubout"])?
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

fn generate_identity(ca_dir: &Path) -> RunnerResult<CaIdentity> {
    let staging = tempfile::Builder::new()
        .prefix(".ca-generation-")
        .tempdir_in(ca_dir)
        .map_err(|e| RunnerError::Internal(format!("create CA staging directory: {e}")))?;
    let key = staging.path().join(CA_KEY);
    let cert = staging.path().join(CA_CERT);

    run_openssl(&["genrsa", "-out", key.to_string_lossy().as_ref(), "4096"])?;
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
    ])?;

    load_identity(&cert, &key)?.ok_or_else(|| {
        RunnerError::Internal("generated proxy CA certificate and key do not match".into())
    })
}

fn exists(path: &Path) -> RunnerResult<bool> {
    path.try_exists()
        .map_err(|e| RunnerError::Internal(format!("check {}: {e}", path.display())))
}

fn publish_identity(files: &CaFiles, identity: &CaIdentity) -> RunnerResult<()> {
    write_if_changed(&files.cert, &identity.cert)?;
    write_if_changed(&files.key, &identity.key)?;
    write_if_changed(&files.combined, &identity.combined())?;
    Ok(())
}

fn write_if_changed(path: &Path, content: &[u8]) -> RunnerResult<()> {
    match std::fs::read(path) {
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
    Ok(state_file::write_private_atomic_blocking(path, content)?)
}

/// Chmod the three CA files: cert 0o644, key 0o600, combined 0o600.
/// Migrates legacy runners that shipped with looser perms. No-op on non-Unix.
#[cfg_attr(not(unix), allow(unused_variables))]
fn apply_perms(cert: &Path, key: &Path, combined: &Path) -> RunnerResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(cert, std::fs::Permissions::from_mode(0o644))
            .map_err(|e| RunnerError::Internal(format!("chmod CA cert: {e}")))?;
        std::fs::set_permissions(key, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| RunnerError::Internal(format!("chmod CA key: {e}")))?;
        std::fs::set_permissions(combined, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| RunnerError::Internal(format!("chmod CA combined: {e}")))?;
    }
    Ok(())
}

fn run_openssl(args: &[&str]) -> RunnerResult<()> {
    let output = openssl_output(args)?;
    if !output.status.success() {
        return Err(openssl_error(args, &output));
    }
    Ok(())
}

fn try_openssl(args: &[&str]) -> RunnerResult<Option<Vec<u8>>> {
    let output = openssl_output(args)?;
    Ok(output.status.success().then_some(output.stdout))
}

fn openssl_output(args: &[&str]) -> RunnerResult<std::process::Output> {
    let mut cmd = std::process::Command::new("openssl");
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    cmd.output()
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

#[cfg(test)]
mod tests;
