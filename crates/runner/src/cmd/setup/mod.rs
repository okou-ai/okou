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

use crate::deps::{FIRECRACKER_VERSION, MITMPROXY_VERSION};
use crate::error::{RunnerError, RunnerResult};
use runner_host::paths::HomePaths;

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
    runner_host::host_file::ensure_dir(
        path,
        runner_host::host_file::DirMode::SharedTrusted,
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

#[cfg(test)]
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
}

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

/// Compute SHA256 of an existing file. Returns hex digest.
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
}

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

#[cfg(test)]
mod tests;
