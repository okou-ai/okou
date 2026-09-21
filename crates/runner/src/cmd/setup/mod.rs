//! Prepare a host to run Okou sandboxes.
//!
//! The setup command validates host prerequisites, creates the runner home
//! layout, and installs the pinned Firecracker, kernel, and mitmdump artifacts
//! used by sandbox startup.

mod artifacts;

use std::ffi::OsString;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::time::Duration;

use sha2::{Digest, Sha256};
use tempfile::TempPath;
use tokio::io::AsyncWriteExt;

use crate::deps::{FIRECRACKER_VERSION, MITMPROXY_VERSION, SYSTEM_CA_BUNDLE};
use crate::error::{RunnerError, RunnerResult};
use crate::paths::HomePaths;

const SETUP_TEMP_ARTIFACT_MODE: u32 = 0o600;
const SETUP_EXECUTABLE_ARTIFACT_MODE: u32 = 0o755;
const SETUP_KERNEL_ARTIFACT_MODE: u32 = 0o644;
const SETUP_TEMP_CREATE_ATTEMPTS: usize = 16;
const SETUP_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const SETUP_READ_TIMEOUT: Duration = Duration::from_secs(60);
const SETUP_REQUEST_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const GROUP_OR_OTHER_WRITE_BITS: u32 = 0o022;
const ROOT_UID: u32 = 0;
const RUNNER_START_SYSTEM_DEPENDENCIES: [&str; 2] = ["dnsmasq", "openssl"];
const OTHER_COMMAND_SYSTEM_DEPENDENCIES: [&str; 3] = ["pgrep", "debootstrap", "flock"];

struct ProducedSetupArtifact {
    path: TempPath,
    file: File,
    sha256: String,
}

struct SetupArtifactIdentity {
    size: u64,
    sha256: String,
}

/// Run the host setup workflow for sandbox execution.
///
/// Returns `RunnerError::Config` when the host configuration is unsupported or
/// missing required prerequisites, and `RunnerError::Internal` when filesystem,
/// download, extraction, checksum, or install operations fail. KVM access
/// problems are reported as warnings so setup can still prepare shared files.
pub async fn run_setup() -> RunnerResult<()> {
    let arch = check_architecture()?;
    let missing_required = check_system_dependencies();

    let paths = HomePaths::new()?;
    create_directories(&paths).await?;
    let http_client = reqwest::Client::builder()
        .connect_timeout(SETUP_CONNECT_TIMEOUT)
        .read_timeout(SETUP_READ_TIMEOUT)
        .timeout(SETUP_REQUEST_TIMEOUT)
        .build()
        .map_err(|e| RunnerError::Internal(format!("build setup HTTP client: {e}")))?;
    artifacts::install_firecracker(&http_client, &paths, arch).await?;
    artifacts::install_kernel(&http_client, &paths, arch).await?;
    artifacts::install_mitmdump(&http_client, &paths, arch).await?;
    check_system_ca_bundle()?;
    check_kvm();

    if !missing_required.is_empty() {
        return Err(RunnerError::Config(format!(
            "missing required dependencies: {}",
            missing_required.join(", ")
        )));
    }

    tracing::info!("setup complete");
    Ok(())
}

fn check_architecture() -> RunnerResult<&'static str> {
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x86_64",
        "aarch64" => "aarch64",
        other => {
            return Err(RunnerError::Config(format!(
                "unsupported architecture: {other}"
            )));
        }
    };
    tracing::info!("[OK] architecture: {arch}");
    Ok(arch)
}

/// Returns names of missing required dependencies.
fn check_system_dependencies() -> Vec<&'static str> {
    let start_system_dependencies = start_system_dependencies();
    let missing_required: Vec<&str> = start_system_dependencies
        .iter()
        .filter(|dep| which::which(dep).is_err())
        .copied()
        .collect();
    let missing_optional: Vec<&str> = OTHER_COMMAND_SYSTEM_DEPENDENCIES
        .iter()
        .filter(|dep| which::which(dep).is_err())
        .copied()
        .collect();

    if missing_required.is_empty() {
        tracing::info!("[OK] all required system dependencies found");
    } else {
        tracing::warn!(
            "missing required dependencies (needed by `runner start`): {}",
            missing_required.join(", ")
        );
    }

    if !missing_optional.is_empty() {
        tracing::warn!(
            "missing optional dependencies (needed by other commands): {}",
            missing_optional.join(", ")
        );
    }

    missing_required
}

fn start_system_dependencies() -> Vec<&'static str> {
    let mut dependencies = sandbox_firecracker::runtime_required_commands();
    dependencies.extend(RUNNER_START_SYSTEM_DEPENDENCIES);
    dependencies
}

async fn create_directories(paths: &HomePaths) -> RunnerResult<()> {
    let dirs = [
        paths.bin_dir(),
        paths.firecracker_dir(FIRECRACKER_VERSION),
        paths.mitmproxy_dir(MITMPROXY_VERSION),
        paths.runners_dir(),
    ];
    for dir in &dirs {
        ensure_setup_shared_dir(dir)?;
    }
    tracing::info!("[OK] directory structure created");
    Ok(())
}

fn ensure_setup_shared_dir(path: &Path) -> RunnerResult<()> {
    crate::host_file::ensure_dir(
        path,
        crate::host_file::DirMode::SharedTrusted,
        "setup directory",
    )
    .map_err(|e| RunnerError::Internal(format!("ensure setup directory {}: {e}", path.display())))
}

fn create_setup_temp_file(target: &Path, kind: &str) -> RunnerResult<(TempPath, File)> {
    let parent = file_parent(target);
    ensure_setup_shared_dir(parent)?;
    let file_name = target.file_name().ok_or_else(|| {
        RunnerError::Internal(format!(
            "{} does not have a file name; refusing to create setup temp artifact",
            target.display()
        ))
    })?;

    for _ in 0..SETUP_TEMP_CREATE_ATTEMPTS {
        let mut tmp_name = OsString::from(".");
        tmp_name.push(file_name);
        tmp_name.push(".");
        tmp_name.push(kind);
        tmp_name.push(".");
        tmp_name.push(uuid::Uuid::new_v4().to_string());
        tmp_name.push(".tmp");
        let tmp_path = target.with_file_name(tmp_name);

        match open_setup_temp_file_at(&tmp_path) {
            Ok(file) => {
                let cleanup_path = tmp_path.clone();
                let tmp_path = TempPath::try_from_path(tmp_path).map_err(|e| {
                    let _ = std::fs::remove_file(cleanup_path);
                    RunnerError::Internal(format!("own setup temp artifact path: {e}"))
                })?;
                secure_setup_temp_file(&file, &tmp_path)?;
                return Ok((tmp_path, file));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(RunnerError::Internal(format!(
                    "create setup temp artifact {}: {error}",
                    tmp_path.display()
                )));
            }
        }
    }

    Err(RunnerError::Internal(format!(
        "create setup temp artifact for {}: exhausted {SETUP_TEMP_CREATE_ATTEMPTS} attempts",
        target.display()
    )))
}

runner_test_support!(cmd_other; #[cfg(test)]
fn create_setup_temp_file_at(path: &Path) -> RunnerResult<File> {
    ensure_setup_shared_dir(file_parent(path))?;
    let file = open_setup_temp_file_at(path).map_err(|e| {
        RunnerError::Internal(format!(
            "create setup temp artifact {}: {e}",
            path.display()
        ))
    })?;
    secure_setup_temp_file(&file, path)?;
    Ok(file)
});

fn open_setup_temp_file_at(path: &Path) -> std::io::Result<File> {
    let mut options = File::options();
    options
        .read(true)
        .write(true)
        .create_new(true)
        .mode(SETUP_TEMP_ARTIFACT_MODE)
        .custom_flags(setup_file_open_flags());
    options.open(path)
}

fn secure_setup_temp_file(file: &File, path: &Path) -> RunnerResult<()> {
    let stat = setup_file_stat(file, path, "setup temp artifact")?;
    let file_type = stat.st_mode & libc::S_IFMT;
    if file_type != libc::S_IFREG {
        return Err(RunnerError::Internal(format!(
            "{} is not a regular setup temp artifact",
            path.display()
        )));
    }

    let expected_uid = nix::unistd::geteuid().as_raw();
    if stat.st_uid != expected_uid {
        return Err(RunnerError::Internal(format!(
            "{} is owned by uid {}, but runner euid is {expected_uid}",
            path.display(),
            stat.st_uid
        )));
    }

    let mode = stat.st_mode & 0o7777;
    if mode != SETUP_TEMP_ARTIFACT_MODE {
        chmod_fd(file, path, SETUP_TEMP_ARTIFACT_MODE, "setup temp artifact")?;
    }
    Ok(())
}

fn install_produced_artifact(
    artifact: ProducedSetupArtifact,
    target: &Path,
    mode: u32,
) -> RunnerResult<()> {
    let ProducedSetupArtifact {
        path,
        file,
        sha256: _,
    } = artifact;
    let produced_stat = setup_file_stat(&file, &path, "produced setup artifact")?;
    validate_trusted_regular_setup_file(&produced_stat, &path, "produced setup artifact")?;
    if (produced_stat.st_mode & GROUP_OR_OTHER_WRITE_BITS) != 0 {
        return Err(RunnerError::Internal(format!(
            "{} is group/other writable",
            path.display()
        )));
    }

    let temp_path_file = open_setup_file_for_identity(&path, "produced setup artifact")?;
    let temp_path_stat = setup_file_stat(&temp_path_file, &path, "produced setup artifact")?;
    validate_same_setup_file_identity(
        &produced_stat,
        &temp_path_stat,
        &path,
        "produced setup artifact",
    )?;

    chmod_fd(&file, &path, mode, "produced setup artifact")?;
    let chmod_stat = setup_file_stat(&file, &path, "produced setup artifact")?;
    validate_setup_artifact_mode(&chmod_stat, &path, mode, "produced setup artifact")?;
    drop(temp_path_file);

    path.persist(target).map_err(|e| {
        RunnerError::Internal(format!("rename to {}: {}", target.display(), e.error))
    })?;

    let target_file = open_setup_file_for_identity(target, "installed setup artifact")?;
    let target_stat = setup_file_stat(&target_file, target, "installed setup artifact")?;
    // The write-time SHA belongs to the held fd, not to a path string. After
    // the path-based rename, prove the target still resolves to that fd's inode.
    validate_same_setup_file_identity(
        &chmod_stat,
        &target_stat,
        target,
        "installed setup artifact",
    )?;
    validate_trusted_regular_setup_file(&target_stat, target, "installed setup artifact")?;
    validate_setup_artifact_mode(&target_stat, target, mode, "installed setup artifact")
}

fn ensure_artifact_installed_blocking(
    path: &Path,
    expected: &SetupArtifactIdentity,
    mode: u32,
) -> RunnerResult<bool> {
    let Some(mut file) = open_existing_setup_artifact(path)? else {
        return Ok(false);
    };

    let stat = setup_file_stat(&file, path, "setup artifact")?;
    if (stat.st_mode & libc::S_IFMT) != libc::S_IFREG {
        return Ok(false);
    }
    validate_trusted_setup_owner(&stat, path, "setup artifact")?;

    let current_mode = stat.st_mode & 0o7777;
    if current_mode & GROUP_OR_OTHER_WRITE_BITS != 0 {
        return Ok(false);
    }

    if setup_artifact_file_size(&stat, path, "setup artifact")? != expected.size {
        return Ok(false);
    }

    if file_sha256_open(&mut file, path)? != expected.sha256 {
        return Ok(false);
    }

    if current_mode != mode {
        chmod_fd(&file, path, mode, "setup artifact")?;
        let repaired = setup_file_stat(&file, path, "setup artifact")?;
        if (repaired.st_mode & 0o7777) != mode {
            return Ok(false);
        }
        if setup_artifact_file_size(&repaired, path, "setup artifact")? != expected.size {
            return Ok(false);
        }
        if file_sha256_open(&mut file, path)? != expected.sha256 {
            return Ok(false);
        }
    }

    Ok(true)
}

fn open_existing_setup_artifact(path: &Path) -> RunnerResult<Option<File>> {
    if !setup_artifact_path_is_regular(path)? {
        return Ok(None);
    }

    let mut options = File::options();
    options.read(true).custom_flags(setup_file_open_flags());
    match options.open(path) {
        Ok(file) => Ok(Some(file)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) if e.raw_os_error() == Some(libc::ELOOP) => Ok(None),
        Err(e) => {
            if !setup_artifact_path_is_regular(path)? {
                return Ok(None);
            }
            Err(RunnerError::Internal(format!(
                "open setup artifact {}: {e}",
                path.display()
            )))
        }
    }
}

fn open_setup_file_for_identity(path: &Path, context: &str) -> RunnerResult<File> {
    let mut options = File::options();
    options.read(true).custom_flags(setup_file_open_flags());
    options
        .open(path)
        .map_err(|e| RunnerError::Internal(format!("open {context} {}: {e}", path.display())))
}

fn setup_artifact_path_is_regular(path: &Path) -> RunnerResult<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => Ok(metadata.file_type().is_file()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(RunnerError::Internal(format!(
            "stat setup artifact {}: {e}",
            path.display()
        ))),
    }
}

fn file_sha256_open(file: &mut File, path: &Path) -> RunnerResult<String> {
    file.seek(SeekFrom::Start(0))
        .map_err(|e| RunnerError::Internal(format!("seek {}: {e}", path.display())))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| RunnerError::Internal(format!("read {}: {e}", path.display())))?;
        if n == 0 {
            break;
        }
        let chunk = buf
            .get(..n)
            .ok_or_else(|| RunnerError::Internal("read returned invalid length".into()))?;
        hasher.update(chunk);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn setup_file_stat<Fd: AsRawFd>(file: &Fd, path: &Path, context: &str) -> RunnerResult<libc::stat> {
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: `stat` points to writable memory and `file` owns a live fd.
    let result = unsafe { libc::fstat(file.as_raw_fd(), stat.as_mut_ptr()) };
    if result != 0 {
        return Err(RunnerError::Internal(format!(
            "stat {context} {}: {}",
            path.display(),
            std::io::Error::last_os_error()
        )));
    }
    // SAFETY: successful `fstat` initialized the full struct.
    Ok(unsafe { stat.assume_init() })
}

fn setup_artifact_file_size(stat: &libc::stat, path: &Path, context: &str) -> RunnerResult<u64> {
    u64::try_from(stat.st_size).map_err(|e| {
        RunnerError::Internal(format!("read {context} size for {}: {e}", path.display()))
    })
}

fn validate_same_setup_file_identity(
    expected: &libc::stat,
    actual: &libc::stat,
    path: &Path,
    context: &str,
) -> RunnerResult<()> {
    if expected.st_dev == actual.st_dev && expected.st_ino == actual.st_ino {
        return Ok(());
    }

    Err(RunnerError::Internal(format!(
        "{context} {} resolved to device/inode {}:{}, expected {}:{}",
        path.display(),
        actual.st_dev,
        actual.st_ino,
        expected.st_dev,
        expected.st_ino
    )))
}

fn validate_setup_artifact_mode(
    stat: &libc::stat,
    path: &Path,
    mode: u32,
    context: &str,
) -> RunnerResult<()> {
    if (stat.st_mode & 0o7777) == mode {
        return Ok(());
    }

    Err(RunnerError::Internal(format!(
        "{context} {} mode is {:o}, expected {mode:o}",
        path.display(),
        stat.st_mode & 0o7777
    )))
}

fn validate_trusted_regular_setup_file(
    stat: &libc::stat,
    path: &Path,
    context: &str,
) -> RunnerResult<()> {
    if (stat.st_mode & libc::S_IFMT) != libc::S_IFREG {
        return Err(RunnerError::Internal(format!(
            "{} is not a regular {context}",
            path.display()
        )));
    }
    validate_trusted_setup_owner(stat, path, context)
}

fn validate_trusted_setup_owner(stat: &libc::stat, path: &Path, context: &str) -> RunnerResult<()> {
    let expected_uid = nix::unistd::geteuid().as_raw();
    if stat.st_uid != ROOT_UID && stat.st_uid != expected_uid {
        return Err(RunnerError::Internal(format!(
            "{context} {} is owned by untrusted uid {}",
            path.display(),
            stat.st_uid
        )));
    }
    Ok(())
}

fn chmod_fd<Fd: AsRawFd>(file: &Fd, path: &Path, mode: u32, context: &str) -> RunnerResult<()> {
    // SAFETY: `fchmod` operates on the live fd and does not affect Rust aliasing.
    let result = unsafe { libc::fchmod(file.as_raw_fd(), mode as libc::mode_t) };
    if result == 0 {
        Ok(())
    } else {
        Err(RunnerError::Internal(format!(
            "chmod {context} {}: {}",
            path.display(),
            std::io::Error::last_os_error()
        )))
    }
}

fn setup_file_open_flags() -> i32 {
    libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK
}

fn file_parent(path: &Path) -> &Path {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
}

// ---------------------------------------------------------------------------
// Shared download helpers
// ---------------------------------------------------------------------------

/// Stream an HTTP response to an opened temp file, enforcing its exact identity.
async fn stream_to_file(
    mut response: reqwest::Response,
    mut file: tokio::fs::File,
    path: &Path,
    expected: &SetupArtifactIdentity,
    label: &str,
) -> RunnerResult<(File, String)> {
    let mut hasher = Sha256::new();
    let mut observed_size = 0_u64;

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| RunnerError::Internal(format!("read {label} response chunk: {e}")))?
    {
        let chunk_size = u64::try_from(chunk.len())
            .map_err(|e| RunnerError::Internal(format!("measure {label} response chunk: {e}")))?;
        let next_size = observed_size.checked_add(chunk_size).ok_or_else(|| {
            RunnerError::Internal(format!("{label} source size overflow while downloading"))
        })?;
        if next_size > expected.size {
            return Err(RunnerError::Internal(format!(
                "{label} source exceeds expected size of {} bytes (received at least {next_size} bytes)",
                expected.size
            )));
        }

        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|e| RunnerError::Internal(format!("write {}: {e}", path.display())))?;
        observed_size = next_size;
    }

    if observed_size != expected.size {
        return Err(RunnerError::Internal(format!(
            "{label} source size mismatch: expected {} bytes, got {observed_size} bytes",
            expected.size
        )));
    }

    file.flush()
        .await
        .map_err(|e| RunnerError::Internal(format!("flush {}: {e}", path.display())))?;

    Ok((file.into_std().await, hex::encode(hasher.finalize())))
}

/// Download a URL to a lifecycle-owned temp file.
async fn download_to_temp(
    client: &reqwest::Client,
    url: &str,
    target: &Path,
    kind: &str,
    label: &str,
    expected: &SetupArtifactIdentity,
) -> RunnerResult<ProducedSetupArtifact> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| RunnerError::Internal(format!("download {label}: {e}")))?;

    if !response.status().is_success() {
        return Err(RunnerError::Internal(format!(
            "download {label}: HTTP {}",
            response.status()
        )));
    }

    if let Some(content_length) = response.content_length()
        && content_length != expected.size
    {
        return Err(RunnerError::Internal(format!(
            "{label} source size mismatch: expected {} bytes, got {content_length} bytes",
            expected.size
        )));
    }

    let (tmp_path, file) = create_setup_temp_file(target, kind)?;
    let (file, sha256) = stream_to_file(
        response,
        tokio::fs::File::from_std(file),
        &tmp_path,
        expected,
        label,
    )
    .await?;
    verify_sha256(&sha256, &expected.sha256, &format!("{label} source"))?;
    Ok(ProducedSetupArtifact {
        path: tmp_path,
        file,
        sha256,
    })
}

/// Download a tarball and extract a named entry.
async fn download_and_extract(
    client: &reqwest::Client,
    url: &str,
    label: &str,
    entry_name: &str,
    target: &Path,
    archive_identity: &SetupArtifactIdentity,
    installed_identity: &SetupArtifactIdentity,
) -> RunnerResult<ProducedSetupArtifact> {
    let tarball = download_to_temp(client, url, target, "tarball", label, archive_identity).await?;

    extract_tar_entry(tarball, target, entry_name, label, installed_identity).await
}

/// Extract a named entry from a gzipped tarball, writing to tmp_path.
/// Matches by file_name (last path component).
async fn extract_tar_entry(
    tarball: ProducedSetupArtifact,
    target: &Path,
    entry_name: &str,
    label: &str,
    installed_identity: &SetupArtifactIdentity,
) -> RunnerResult<ProducedSetupArtifact> {
    let target = target.to_owned();
    let entry_name = entry_name.to_owned();
    let label = label.to_owned();
    let expected_size = installed_identity.size;

    tokio::task::spawn_blocking(move || {
        extract_tar_entry_blocking(tarball, &target, &entry_name, &label, expected_size)
    })
    .await
    .map_err(|e| RunnerError::Internal(format!("extract task failed: {e}")))?
}

fn extract_tar_entry_blocking(
    tarball: ProducedSetupArtifact,
    target: &Path,
    entry_name: &str,
    label: &str,
    expected_size: u64,
) -> RunnerResult<ProducedSetupArtifact> {
    let ProducedSetupArtifact {
        path: tarball_path,
        file: mut tarball_file,
        sha256: _,
    } = tarball;
    tarball_file.seek(SeekFrom::Start(0)).map_err(|e| {
        RunnerError::Internal(format!(
            "seek verified tarball {}: {e}",
            tarball_path.display()
        ))
    })?;
    let decoder = flate2::read::GzDecoder::new(tarball_file);
    let mut archive = tar::Archive::new(decoder);

    let entries = archive
        .entries()
        .map_err(|e| RunnerError::Internal(format!("read tarball entries: {e}")))?;

    for entry in entries {
        let mut entry =
            entry.map_err(|e| RunnerError::Internal(format!("read tarball entry: {e}")))?;

        let path = entry
            .path()
            .map_err(|e| RunnerError::Internal(format!("read entry path: {e}")))?;

        let file_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default();

        if file_name == entry_name {
            let declared_size = entry.size();
            if declared_size != expected_size {
                return Err(RunnerError::Internal(format!(
                    "{label} entry size mismatch: expected {expected_size} bytes, got {declared_size} bytes"
                )));
            }

            let (tmp, mut out) = create_setup_temp_file(target, "extract")?;
            let result = (|| {
                let mut hasher = Sha256::new();
                let mut buf = [0u8; 64 * 1024];
                let mut observed_size = 0_u64;
                loop {
                    let n = entry
                        .read(&mut buf)
                        .map_err(|e| RunnerError::Internal(format!("read tar entry: {e}")))?;
                    if n == 0 {
                        if observed_size != expected_size {
                            return Err(RunnerError::Internal(format!(
                                "{label} entry size mismatch: expected {expected_size} bytes, got {observed_size} bytes"
                            )));
                        }
                        std::io::Write::flush(&mut out)
                            .map_err(|e| RunnerError::Internal(format!("flush binary: {e}")))?;
                        return Ok(hex::encode(hasher.finalize()));
                    }
                    let chunk = buf.get(..n).ok_or_else(|| {
                        RunnerError::Internal("read returned invalid length".into())
                    })?;
                    let chunk_size = u64::try_from(chunk.len()).map_err(|e| {
                        RunnerError::Internal(format!("measure {label} tar entry chunk: {e}"))
                    })?;
                    let next_size = observed_size.checked_add(chunk_size).ok_or_else(|| {
                        RunnerError::Internal(format!(
                            "{label} entry size overflow while extracting"
                        ))
                    })?;
                    if next_size > expected_size {
                        return Err(RunnerError::Internal(format!(
                            "{label} entry exceeds expected size of {expected_size} bytes (read at least {next_size} bytes)"
                        )));
                    }
                    hasher.update(chunk);
                    std::io::Write::write_all(&mut out, chunk)
                        .map_err(|e| RunnerError::Internal(format!("write binary: {e}")))?;
                    observed_size = next_size;
                }
            })();
            return result.map(|sha256| ProducedSetupArtifact {
                path: tmp,
                file: out,
                sha256,
            });
        }
    }

    Err(RunnerError::Internal(format!(
        "'{entry_name}' not found in tarball"
    )))
}

/// Verify SHA256, set permissions through the produced fd, and atomically rename to target.
/// A failed rename only counts as a concurrent install if the target verifies.
async fn verify_and_install(
    artifact: ProducedSetupArtifact,
    expected: &SetupArtifactIdentity,
    label: &str,
    target: &Path,
    mode: u32,
) -> RunnerResult<()> {
    let verification = (|| {
        let stat = setup_file_stat(&artifact.file, &artifact.path, "produced setup artifact")?;
        let actual_size =
            setup_artifact_file_size(&stat, &artifact.path, "produced setup artifact")?;
        if actual_size != expected.size {
            return Err(RunnerError::Internal(format!(
                "{label} size mismatch: expected {} bytes, got {actual_size} bytes",
                expected.size
            )));
        }
        verify_sha256(&artifact.sha256, &expected.sha256, label)
    })();
    verification?;

    match atomic_install_produced(artifact, target, mode).await {
        Ok(()) => Ok(()),
        Err(e) => match ensure_artifact_installed(target, expected, mode).await {
            Ok(true) => {
                tracing::info!("[OK] {label} verified after another install attempt");
                Ok(())
            }
            Ok(false) => Err(e),
            Err(validate_err) => Err(RunnerError::Internal(format!(
                "{e}; failed to validate existing {}: {validate_err}",
                target.display()
            ))),
        },
    }
}

/// Prepare a produced artifact through its fd, then atomically rename it.
async fn atomic_install_produced(
    artifact: ProducedSetupArtifact,
    target: &Path,
    mode: u32,
) -> RunnerResult<()> {
    let target = target.to_owned();
    tokio::task::spawn_blocking(move || install_produced_artifact(artifact, &target, mode))
        .await
        .map_err(|e| RunnerError::Internal(format!("install task failed: {e}")))?
}

#[allow(clippy::unreachable)] // arch validated by check_architecture
fn select_sha<'a>(arch: &str, x86_64: &'a str, aarch64: &'a str) -> &'a str {
    match arch {
        "x86_64" => x86_64,
        "aarch64" => aarch64,
        _ => unreachable!(),
    }
}

#[allow(clippy::unreachable)] // arch validated by check_architecture
fn select_size(arch: &str, x86_64: u64, aarch64: u64) -> u64 {
    match arch {
        "x86_64" => x86_64,
        "aarch64" => aarch64,
        _ => unreachable!(),
    }
}

fn verify_sha256(actual_hex: &str, expected_hex: &str, label: &str) -> RunnerResult<()> {
    if actual_hex != expected_hex {
        return Err(RunnerError::Internal(format!(
            "{label} SHA256 mismatch: expected {expected_hex}, got {actual_hex}"
        )));
    }
    tracing::info!("[OK] {label} SHA256 verified");
    Ok(())
}

// ---------------------------------------------------------------------------
// Artifact downloads
// ---------------------------------------------------------------------------

runner_test_support!(cmd_other; /// Compute SHA256 of an existing file. Returns hex digest.
#[cfg(test)]
async fn file_sha256(path: &Path) -> RunnerResult<String> {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || {
        let Some(mut file) = open_existing_setup_artifact(&path)? else {
            return Err(RunnerError::Internal(format!(
                "open {}: not found",
                path.display()
            )));
        };
        let stat = setup_file_stat(&file, &path, "setup artifact")?;
        validate_trusted_regular_setup_file(&stat, &path, "setup artifact")?;
        file_sha256_open(&mut file, &path)
    })
    .await
    .map_err(|e| RunnerError::Internal(format!("sha256 task failed: {e}")))?
});

/// Ensure an existing setup artifact matches its pinned identity and usable mode.
async fn ensure_artifact_installed(
    path: &Path,
    expected: &SetupArtifactIdentity,
    mode: u32,
) -> RunnerResult<bool> {
    let path = path.to_owned();
    let expected = SetupArtifactIdentity {
        size: expected.size,
        sha256: expected.sha256.clone(),
    };
    tokio::task::spawn_blocking(move || ensure_artifact_installed_blocking(&path, &expected, mode))
        .await
        .map_err(|e| RunnerError::Internal(format!("artifact validation task failed: {e}")))?
}

// ---------------------------------------------------------------------------
// Host checks
// ---------------------------------------------------------------------------

fn check_system_ca_bundle() -> RunnerResult<()> {
    if Path::new(SYSTEM_CA_BUNDLE).exists() {
        tracing::info!("[OK] system CA bundle found at {SYSTEM_CA_BUNDLE}");
        Ok(())
    } else {
        Err(RunnerError::Config(format!(
            "system CA bundle not found at {SYSTEM_CA_BUNDLE} — \
             install ca-certificates: sudo apt install ca-certificates"
        )))
    }
}

fn check_kvm() {
    let result = File::options()
        .read(true)
        .write(true)
        .open("/dev/kvm")
        .map(drop);
    report_kvm_check(result);
}

fn report_kvm_check(result: std::io::Result<()>) {
    match result {
        Ok(()) => {
            tracing::info!("[OK] KVM accessible");
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            tracing::warn!("/dev/kvm not found — ensure bare-metal with KVM enabled");
        }
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            tracing::warn!(
                "/dev/kvm permission denied — expected root:kvm ownership with mode 0660; \
                 verify device permissions and host/container KVM access: {e}"
            );
        }
        Err(e) => {
            tracing::warn!("/dev/kvm check failed: {e}");
        }
    }
}

runner_test_group!(cmd_other; #[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::os::unix::net::UnixListener;
    use std::sync::mpsc;
    use std::time::Duration;

    use flate2::Compression;
    use flate2::write::GzEncoder;
    use nix::sys::stat::Mode;
    use tokio::sync::oneshot;
    use tracing::Level;
    use tracing_subscriber::prelude::*;
    use tracing_test_support::CapturedEvents;

    #[test]
    fn kvm_permission_denied_reports_least_privilege_guidance() {
        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());

        tracing::subscriber::with_default(subscriber, || {
            tracing::callsite::rebuild_interest_cache();
            report_kvm_check(Err(std::io::Error::from(
                std::io::ErrorKind::PermissionDenied,
            )));
        });

        let events = captured.entries();
        assert_eq!(events.len(), 1, "captured events: {events:#?}");
        let event = &events[0];
        assert_eq!(event.level, Level::WARN);
        let message = event
            .fields
            .get("message")
            .unwrap_or_else(|| panic!("missing message field; event={event:#?}"));
        assert!(message.contains("root:kvm"));
        assert!(message.contains("0660"));
        assert!(message.contains("host/container KVM access"));
        assert!(message.contains("permission denied"));
        assert!(!message.contains("chmod 666"));
        assert!(!message.contains("0666"));
    }

    fn mode(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    fn produced_artifact(path: &Path, content: &[u8]) -> ProducedSetupArtifact {
        let mut file = create_setup_temp_file_at(path).unwrap();
        std::io::Write::write_all(&mut file, content).unwrap();
        std::io::Write::flush(&mut file).unwrap();
        ProducedSetupArtifact {
            path: TempPath::try_from_path(path).unwrap(),
            file,
            sha256: hex::encode(Sha256::digest(content)),
        }
    }

    fn artifact_identity(content: &[u8]) -> SetupArtifactIdentity {
        SetupArtifactIdentity {
            size: u64::try_from(content.len()).unwrap(),
            sha256: hex::encode(Sha256::digest(content)),
        }
    }

    fn tarball_with_entry(entry_name: &str, content: &[u8]) -> Vec<u8> {
        let encoder = GzEncoder::new(Vec::new(), Compression::default());
        let mut builder = tar::Builder::new(encoder);
        let mut header = tar::Header::new_gnu();
        header.set_size(content.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        builder
            .append_data(&mut header, entry_name, content)
            .unwrap();
        builder.into_inner().unwrap().finish().unwrap()
    }

    async fn wait_until_path_is_removed(path: &Path) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while path.exists() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("setup temp was not removed");
    }

    #[test]
    fn check_architecture_returns_current() {
        let arch = check_architecture().unwrap();
        assert!(
            arch == "x86_64" || arch == "aarch64",
            "unexpected arch: {arch}"
        );
        assert_eq!(arch, std::env::consts::ARCH);
    }

    #[test]
    fn select_sha_x86_64() {
        assert_eq!(select_sha("x86_64", "sha_x86", "sha_arm"), "sha_x86");
    }

    #[test]
    fn select_sha_aarch64() {
        assert_eq!(select_sha("aarch64", "sha_x86", "sha_arm"), "sha_arm");
    }

    #[test]
    fn verify_sha256_matching() {
        let result = verify_sha256("abc123", "abc123", "test");
        assert!(result.is_ok());
    }

    #[test]
    fn verify_sha256_mismatch() {
        let result = verify_sha256("abc123", "def456", "test");
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("SHA256 mismatch"), "got: {err}");
        assert!(err.contains("abc123"));
        assert!(err.contains("def456"));
    }

    #[test]
    fn check_system_dependencies_only_returns_known_deps() {
        let missing = check_system_dependencies();
        let known = start_system_dependencies();
        for dep in &missing {
            assert!(
                known.contains(dep),
                "unexpected dependency reported as missing: {dep}"
            );
        }
    }

    #[test]
    fn runner_start_dependencies_include_openssl_for_proxy_ca_validation() {
        assert!(RUNNER_START_SYSTEM_DEPENDENCIES.contains(&"openssl"));
        assert!(!OTHER_COMMAND_SYSTEM_DEPENDENCIES.contains(&"openssl"));
    }

    #[test]
    fn start_dependencies_include_sandbox_runtime_commands() {
        let start_dependencies = start_system_dependencies();
        for dependency in sandbox_firecracker::runtime_required_commands() {
            assert!(start_dependencies.contains(&dependency));
        }
        assert!(start_dependencies.contains(&"conntrack"));
    }

    #[test]
    fn ensure_setup_shared_dir_creates_shared_directory() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("setup").join("firecracker");

        ensure_setup_shared_dir(&path).unwrap();

        assert_eq!(mode(&path), crate::host_file::SHARED_TRUSTED_DIR_MODE);
        assert!(path.is_dir());
    }

    #[test]
    fn ensure_setup_shared_dir_normalizes_existing_directory() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("setup");
        std::fs::create_dir(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();

        ensure_setup_shared_dir(&path).unwrap();

        assert_eq!(mode(&path), crate::host_file::SHARED_TRUSTED_DIR_MODE);
    }

    #[test]
    fn ensure_setup_shared_dir_rejects_parent_segment_before_creating_missing_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("base");
        std::fs::create_dir(&base).unwrap();

        let error =
            ensure_setup_shared_dir(&base.join("missing").join("..").join("leaf")).unwrap_err();

        assert!(
            matches!(error, RunnerError::Internal(_)),
            "unexpected error: {error}"
        );
        assert!(
            error.to_string().contains("parent directory segment"),
            "unexpected error: {error}"
        );
        assert!(!base.join("missing").exists());
        assert!(!base.join("leaf").exists());
    }

    #[test]
    fn ensure_setup_shared_dir_rejects_final_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        let link = dir.path().join("link");
        std::fs::create_dir(&target).unwrap();
        symlink(&target, &link).unwrap();

        let error = ensure_setup_shared_dir(&link).unwrap_err();

        assert!(
            error.to_string().contains("symlink") || error.to_string().contains("not a directory"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn ensure_setup_shared_dir_rejects_intermediate_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        let link = dir.path().join("link");
        std::fs::create_dir(&target).unwrap();
        symlink(&target, &link).unwrap();

        let error = ensure_setup_shared_dir(&link.join("child")).unwrap_err();

        assert!(
            error.to_string().contains("symlink") || error.to_string().contains("not a directory"),
            "unexpected error: {error}"
        );
        assert!(!target.join("child").exists());
    }

    #[test]
    fn ensure_setup_shared_dir_rejects_unsafe_writable_parent() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("unsafe");
        std::fs::create_dir(&parent).unwrap();
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o777)).unwrap();

        let error = ensure_setup_shared_dir(&parent.join("child")).unwrap_err();

        assert!(
            error.to_string().contains("group/other writable"),
            "unexpected error: {error}"
        );
        assert!(!parent.join("child").exists());
    }

    #[test]
    fn create_setup_temp_file_at_creates_private_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".artifact.tmp");

        let file = create_setup_temp_file_at(&path).unwrap();
        drop(file);

        assert_eq!(mode(&path), SETUP_TEMP_ARTIFACT_MODE);
    }

    #[test]
    fn create_setup_temp_file_at_rejects_stale_symlink_without_following() {
        let dir = tempfile::tempdir().unwrap();
        let outside = dir.path().join("outside");
        let link = dir.path().join(".artifact.tmp");
        std::fs::write(&outside, b"outside").unwrap();
        symlink(&outside, &link).unwrap();

        let error = create_setup_temp_file_at(&link).unwrap_err();

        assert!(
            error.to_string().contains("File exists")
                || error.to_string().contains("file exists")
                || error.to_string().contains("exists"),
            "unexpected error: {error}"
        );
        assert_eq!(std::fs::read(&outside).unwrap(), b"outside");
        assert!(
            std::fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }

    #[tokio::test]
    async fn file_sha256_computes_correctly() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.bin");
        std::fs::write(&path, b"hello world").unwrap();
        let sha = file_sha256(&path).await.unwrap();
        // SHA256("hello world") = b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
        assert_eq!(
            sha,
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
    }

    #[tokio::test]
    async fn file_sha256_empty_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty.bin");
        std::fs::write(&path, b"").unwrap();
        let sha = file_sha256(&path).await.unwrap();
        // SHA256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
        assert_eq!(
            sha,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[tokio::test]
    async fn ensure_artifact_installed_returns_false_for_missing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nonexistent");
        let expected = artifact_identity(b"anything");
        assert!(
            !ensure_artifact_installed(&path, &expected, SETUP_EXECUTABLE_ARTIFACT_MODE)
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn ensure_artifact_installed_returns_false_for_wrong_sha() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file.bin");
        std::fs::write(&path, b"content").unwrap();
        let expected = SetupArtifactIdentity {
            size: u64::try_from(b"content".len()).unwrap(),
            sha256: "wrong_sha".to_owned(),
        };
        assert!(
            !ensure_artifact_installed(&path, &expected, SETUP_EXECUTABLE_ARTIFACT_MODE)
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn ensure_artifact_installed_returns_false_for_wrong_size() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file.bin");
        std::fs::write(&path, b"content").unwrap();
        let mut expected = artifact_identity(b"content");
        expected.size += 1;

        assert!(
            !ensure_artifact_installed(&path, &expected, SETUP_EXECUTABLE_ARTIFACT_MODE)
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn ensure_artifact_installed_returns_true_for_matching_sha_and_kernel_mode() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file.bin");
        std::fs::write(&path, b"content").unwrap();
        std::fs::set_permissions(
            &path,
            std::fs::Permissions::from_mode(SETUP_KERNEL_ARTIFACT_MODE),
        )
        .unwrap();
        let expected = artifact_identity(b"content");
        assert!(
            ensure_artifact_installed(&path, &expected, SETUP_KERNEL_ARTIFACT_MODE)
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn ensure_artifact_installed_returns_true_for_matching_sha_and_mode() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file.bin");
        std::fs::write(&path, b"content").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        let expected = artifact_identity(b"content");

        assert!(
            ensure_artifact_installed(&path, &expected, SETUP_EXECUTABLE_ARTIFACT_MODE)
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn ensure_artifact_installed_repairs_matching_file_mode() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file.bin");
        std::fs::write(&path, b"content").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let expected = artifact_identity(b"content");

        assert!(
            ensure_artifact_installed(&path, &expected, SETUP_EXECUTABLE_ARTIFACT_MODE)
                .await
                .unwrap()
        );
        assert_eq!(mode(&path), SETUP_EXECUTABLE_ARTIFACT_MODE);
    }

    #[tokio::test]
    async fn ensure_artifact_installed_repairs_readonly_trusted_file_mode() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file.bin");
        std::fs::write(&path, b"content").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o444)).unwrap();
        let expected = artifact_identity(b"content");

        assert!(
            ensure_artifact_installed(&path, &expected, SETUP_KERNEL_ARTIFACT_MODE)
                .await
                .unwrap()
        );
        assert_eq!(mode(&path), SETUP_KERNEL_ARTIFACT_MODE);
    }

    #[tokio::test]
    async fn ensure_artifact_installed_does_not_follow_symlink_artifact() {
        let dir = tempfile::tempdir().unwrap();
        let outside = dir.path().join("outside.bin");
        let link = dir.path().join("file.bin");
        std::fs::write(&outside, b"content").unwrap();
        symlink(&outside, &link).unwrap();
        let expected = artifact_identity(b"content");

        assert!(
            !ensure_artifact_installed(&link, &expected, SETUP_EXECUTABLE_ARTIFACT_MODE)
                .await
                .unwrap()
        );
        assert_eq!(std::fs::read(&outside).unwrap(), b"content");
    }

    #[tokio::test]
    async fn ensure_artifact_installed_returns_false_for_fifo_without_blocking() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file.bin");
        nix::unistd::mkfifo(&path, Mode::from_bits_truncate(0o600)).unwrap();
        let expected = artifact_identity(b"anything");

        assert!(
            !ensure_artifact_installed(&path, &expected, SETUP_EXECUTABLE_ARTIFACT_MODE)
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn ensure_artifact_installed_returns_false_for_unix_socket() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file.bin");
        let _listener = UnixListener::bind(&path).unwrap();
        let expected = artifact_identity(b"anything");

        assert!(
            !ensure_artifact_installed(&path, &expected, SETUP_EXECUTABLE_ARTIFACT_MODE)
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn ensure_artifact_installed_returns_false_for_directory() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file.bin");
        std::fs::create_dir(&path).unwrap();
        let expected = artifact_identity(b"anything");

        assert!(
            !ensure_artifact_installed(&path, &expected, SETUP_EXECUTABLE_ARTIFACT_MODE)
                .await
                .unwrap()
        );
    }

    #[test]
    fn validate_same_setup_file_identity_rejects_different_files() {
        let dir = tempfile::tempdir().unwrap();
        let first_path = dir.path().join("first.bin");
        let second_path = dir.path().join("second.bin");
        std::fs::write(&first_path, b"first").unwrap();
        std::fs::write(&second_path, b"second").unwrap();
        let first = File::open(&first_path).unwrap();
        let second = File::open(&second_path).unwrap();
        let first_stat = setup_file_stat(&first, &first_path, "first").unwrap();
        let second_stat = setup_file_stat(&second, &second_path, "second").unwrap();

        let error = validate_same_setup_file_identity(
            &first_stat,
            &second_stat,
            &second_path,
            "test setup artifact",
        )
        .unwrap_err();

        assert!(error.to_string().contains("device/inode"));
    }

    #[test]
    fn validate_setup_artifact_mode_rejects_wrong_mode() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file.bin");
        std::fs::write(&path, b"content").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let file = File::open(&path).unwrap();
        let stat = setup_file_stat(&file, &path, "test").unwrap();

        let error =
            validate_setup_artifact_mode(&stat, &path, SETUP_EXECUTABLE_ARTIFACT_MODE, "test")
                .unwrap_err();

        assert!(error.to_string().contains("mode"));
    }

    #[tokio::test]
    async fn verify_and_install_installs_produced_artifact() {
        let dir = tempfile::tempdir().unwrap();
        let tmp_path = dir.path().join("tmp.bin");
        let target = dir.path().join("target.bin");
        let artifact = produced_artifact(&tmp_path, b"content");
        let expected = artifact_identity(b"content");

        verify_and_install(
            artifact,
            &expected,
            "test",
            &target,
            SETUP_EXECUTABLE_ARTIFACT_MODE,
        )
        .await
        .unwrap();

        assert_eq!(std::fs::read(&target).unwrap(), b"content");
        assert_eq!(mode(&target), SETUP_EXECUTABLE_ARTIFACT_MODE);
        assert!(!tmp_path.exists());
    }

    #[tokio::test]
    async fn verify_and_install_removes_produced_artifact_on_wrong_sha() {
        let dir = tempfile::tempdir().unwrap();
        let tmp_path = dir.path().join("tmp.bin");
        let target = dir.path().join("target.bin");
        let artifact = produced_artifact(&tmp_path, b"content");
        let expected = SetupArtifactIdentity {
            size: u64::try_from(b"content".len()).unwrap(),
            sha256: "wrong_sha".to_owned(),
        };

        let result = verify_and_install(
            artifact,
            &expected,
            "test",
            &target,
            SETUP_EXECUTABLE_ARTIFACT_MODE,
        )
        .await;

        assert!(result.is_err());
        assert!(!tmp_path.exists(), "SHA mismatch should clean temp file");
        assert!(!target.exists());
    }

    #[tokio::test]
    async fn verify_and_install_removes_produced_artifact_on_wrong_size() {
        let dir = tempfile::tempdir().unwrap();
        let tmp_path = dir.path().join("tmp.bin");
        let target = dir.path().join("target.bin");
        let artifact = produced_artifact(&tmp_path, b"content");
        let mut expected = artifact_identity(b"content");
        expected.size += 1;

        let result = verify_and_install(
            artifact,
            &expected,
            "test",
            &target,
            SETUP_EXECUTABLE_ARTIFACT_MODE,
        )
        .await;

        assert!(result.is_err());
        assert!(!tmp_path.exists(), "size mismatch should clean temp file");
        assert!(!target.exists());
    }

    #[tokio::test]
    async fn verify_and_install_rejects_replaced_temp_path() {
        let dir = tempfile::tempdir().unwrap();
        let tmp_path = dir.path().join("tmp.bin");
        let target = dir.path().join("target.bin");
        let artifact = produced_artifact(&tmp_path, b"content");
        let expected = artifact_identity(b"content");
        std::fs::remove_file(&tmp_path).unwrap();
        std::fs::write(&tmp_path, b"replacement").unwrap();

        let result = verify_and_install(
            artifact,
            &expected,
            "test",
            &target,
            SETUP_EXECUTABLE_ARTIFACT_MODE,
        )
        .await;

        assert!(result.is_err());
        assert!(!target.exists());
        assert!(
            !tmp_path.exists(),
            "failed install should clean replacement temp path"
        );
    }

    #[tokio::test]
    async fn verify_and_install_errors_when_rename_fails_with_invalid_target() {
        let dir = tempfile::tempdir().unwrap();
        let tmp_path = dir.path().join("tmp.bin");
        let target = dir.path().join("target.bin");
        let artifact = produced_artifact(&tmp_path, b"content");
        let expected = artifact_identity(b"content");
        std::fs::create_dir(&target).unwrap();

        let result = verify_and_install(
            artifact,
            &expected,
            "test",
            &target,
            SETUP_EXECUTABLE_ARTIFACT_MODE,
        )
        .await;

        assert!(result.is_err());
        assert!(target.is_dir());
        assert!(!tmp_path.exists(), "failed install should clean temp file");
    }

    #[tokio::test]
    async fn cancelled_blocking_extraction_removes_archive_and_output_temps() {
        let dir = tempfile::tempdir().unwrap();
        let content = b"extracted content";
        let tarball = tarball_with_entry("tool", content);
        let archive_path = dir.path().join("archive.tarball.tmp");
        let archive = produced_artifact(&archive_path, &tarball);
        let target = dir.path().join("tool");
        let expected = artifact_identity(content);
        let (entered_tx, entered_rx) = oneshot::channel();
        let (start_tx, start_rx) = mpsc::channel();
        let (output_tx, output_rx) = oneshot::channel();
        let (finish_tx, finish_rx) = mpsc::channel();
        let target_for_task = target.clone();

        let task = tokio::task::spawn_blocking(move || {
            entered_tx.send(()).unwrap();
            start_rx.recv().unwrap();
            let output = extract_tar_entry_blocking(
                archive,
                &target_for_task,
                "tool",
                "test",
                expected.size,
            )?;
            output_tx.send(output.path.to_path_buf()).unwrap();
            finish_rx.recv().unwrap();
            Ok::<ProducedSetupArtifact, RunnerError>(output)
        });

        tokio::time::timeout(Duration::from_secs(2), entered_rx)
            .await
            .expect("blocking extraction did not start")
            .expect("blocking extraction dropped its start signal");
        assert!(archive_path.exists());

        drop(task);
        start_tx.send(()).unwrap();
        let output_path = tokio::time::timeout(Duration::from_secs(2), output_rx)
            .await
            .expect("blocking extraction did not create its output temp")
            .expect("blocking extraction dropped its output signal");

        wait_until_path_is_removed(&archive_path).await;
        assert!(output_path.exists());
        finish_tx.send(()).unwrap();
        wait_until_path_is_removed(&output_path).await;
        assert!(!target.exists());
    }

    #[tokio::test]
    async fn cancelled_blocking_install_removes_uninstalled_temp() {
        let dir = tempfile::tempdir().unwrap();
        let tmp_path = dir.path().join("tmp.bin");
        let target = dir.path().join("target.bin");
        std::fs::create_dir(&target).unwrap();
        let artifact = produced_artifact(&tmp_path, b"content");
        let (entered_tx, entered_rx) = oneshot::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let target_for_task = target.clone();

        let task = tokio::task::spawn_blocking(move || {
            entered_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            install_produced_artifact(artifact, &target_for_task, SETUP_EXECUTABLE_ARTIFACT_MODE)
        });

        tokio::time::timeout(Duration::from_secs(2), entered_rx)
            .await
            .expect("blocking install did not start")
            .expect("blocking install dropped its start signal");
        assert!(tmp_path.exists());

        drop(task);
        release_tx.send(()).unwrap();

        wait_until_path_is_removed(&tmp_path).await;
        assert!(target.is_dir());
    }

    #[tokio::test]
    async fn verify_and_install_replaces_wrong_sha_regular_target() {
        let dir = tempfile::tempdir().unwrap();
        let tmp_path = dir.path().join("tmp.bin");
        let target = dir.path().join("target.bin");
        let artifact = produced_artifact(&tmp_path, b"new content");
        let expected = artifact_identity(b"new content");
        std::fs::write(&target, b"old content").unwrap();

        verify_and_install(
            artifact,
            &expected,
            "test",
            &target,
            SETUP_EXECUTABLE_ARTIFACT_MODE,
        )
        .await
        .unwrap();

        assert_eq!(std::fs::read(&target).unwrap(), b"new content");
        assert_eq!(mode(&target), SETUP_EXECUTABLE_ARTIFACT_MODE);
    }

    #[tokio::test]
    async fn verify_and_install_accepts_verified_target_after_install_failure() {
        let dir = tempfile::tempdir().unwrap();
        let tmp_path = dir.path().join("tmp.bin");
        let target = dir.path().join("target.bin");
        std::fs::write(&target, b"content").unwrap();
        std::fs::set_permissions(
            &target,
            std::fs::Permissions::from_mode(SETUP_EXECUTABLE_ARTIFACT_MODE),
        )
        .unwrap();
        let expected = artifact_identity(b"content");
        let artifact = produced_artifact(&tmp_path, b"content");
        std::fs::remove_file(&tmp_path).unwrap();

        verify_and_install(
            artifact,
            &expected,
            "test",
            &target,
            SETUP_EXECUTABLE_ARTIFACT_MODE,
        )
        .await
        .unwrap();
    }

    #[test]
    fn check_system_ca_bundle_consistent_with_filesystem() {
        let result = check_system_ca_bundle();
        let exists = std::path::Path::new(SYSTEM_CA_BUNDLE).exists();
        assert_eq!(
            result.is_ok(),
            exists,
            "check_system_ca_bundle should succeed iff {} exists",
            SYSTEM_CA_BUNDLE
        );
        if let Err(e) = result {
            let msg = e.to_string();
            assert!(msg.contains(SYSTEM_CA_BUNDLE), "error should mention path");
            assert!(msg.contains("ca-certificates"), "error should suggest fix");
        }
    }
});
