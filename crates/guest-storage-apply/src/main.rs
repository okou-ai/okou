use guest_contracts::{env, runtime_paths};
use guest_telemetry::{log_error, log_info, telemetry::record_sandbox_op};
use std::fs::File;
#[cfg(unix)]
use std::fs::OpenOptions;
use std::io::{self, ErrorKind, Read as _};
use std::time::Instant;

const LOG_TAG: &str = "sandbox:guest-storage-apply";
const MANIFEST_STDIN_ARG: &str = "--manifest-stdin";
const USAGE: &str =
    "Usage: guest-storage-apply <manifest_path> | --manifest-stdin | --storage-files-stdin";

enum ManifestInput {
    Path(String),
    Stdin,
    FilesStdin,
}

fn main() {
    if let Err(error) = install_runtime_log_paths() {
        log_error!(LOG_TAG, "{error}");
        std::process::exit(1);
    }

    let Some(input) = manifest_input_from_args() else {
        log_error!(LOG_TAG, "{USAGE}");
        std::process::exit(1);
    };

    let start = Instant::now();
    let success = run(input);
    let elapsed = start.elapsed();

    record_sandbox_op("download_total", elapsed, success, None);
    if success {
        log_info!(LOG_TAG, "Download completed in {}ms", elapsed.as_millis());
    } else {
        log_error!(LOG_TAG, "Download failed");
        std::process::exit(1);
    }
}

fn install_runtime_log_paths() -> Result<(), String> {
    let run_id = std::env::var(env::RUN_ID_ENV).map_err(|_| {
        format!(
            "{} is required for guest-storage-apply runtime paths",
            env::RUN_ID_ENV
        )
    })?;
    if run_id.is_empty() {
        return Err(format!(
            "{} is required for guest-storage-apply runtime paths",
            env::RUN_ID_ENV
        ));
    }

    let run_dir = runtime_paths::run_dir_from_env(&run_id)
        .map_err(|error| format!("failed to resolve guest-storage-apply runtime paths: {error}"))?;
    guest_telemetry::log::set_system_log_file(runtime_paths::system_log_file(&run_dir));
    guest_telemetry::telemetry::set_sandbox_ops_log_file(runtime_paths::sandbox_ops_log_file(
        run_dir,
    ));
    Ok(())
}

fn manifest_input_from_args() -> Option<ManifestInput> {
    let mut args = std::env::args().skip(1);
    let arg = args.next()?;
    if args.next().is_some() {
        return None;
    }
    if arg == "--storage-files-stdin" {
        Some(ManifestInput::FilesStdin)
    } else if arg == MANIFEST_STDIN_ARG {
        Some(ManifestInput::Stdin)
    } else {
        Some(ManifestInput::Path(arg))
    }
}

fn run(input: ManifestInput) -> bool {
    match input {
        ManifestInput::FilesStdin => {
            if !remove_stale_manifest_file(runtime_paths::STORAGE_MANIFEST_PATH) {
                return false;
            }
            let mut input = Vec::new();
            let limit = guest_contracts::storage_files::MAX_INPUT_BYTES as u64;
            if std::io::stdin()
                .take(limit + 1)
                .read_to_end(&mut input)
                .is_err()
                || input.len() as u64 > limit
            {
                log_error!(LOG_TAG, "Failed to read bounded storage files input");
                return false;
            }
            guest_storage_apply::run_storage_files_bytes(&input)
        }
        ManifestInput::Path(manifest_path) => run_path(&manifest_path),
        ManifestInput::Stdin => {
            if !remove_stale_manifest_file(runtime_paths::STORAGE_MANIFEST_PATH) {
                return false;
            }

            let mut manifest_json = Vec::new();
            if let Err(e) = std::io::stdin().read_to_end(&mut manifest_json) {
                log_error!(LOG_TAG, "Failed to read manifest from stdin: {e}");
                return false;
            }
            guest_storage_apply::run_manifest_bytes(&manifest_json)
        }
    }
}

fn run_path(manifest_path: &str) -> bool {
    if manifest_path == runtime_paths::STORAGE_MANIFEST_PATH {
        run_manifest_file_and_remove(manifest_path)
    } else {
        guest_storage_apply::run(manifest_path)
    }
}

fn run_manifest_file_and_remove(manifest_path: &str) -> bool {
    let manifest_json = match read_manifest_file(manifest_path) {
        Ok(manifest_json) => manifest_json,
        Err(e) => {
            log_error!(LOG_TAG, "Failed to read manifest: {e}");
            let _ = remove_manifest_file(manifest_path);
            return false;
        }
    };

    if !remove_manifest_file(manifest_path) {
        return false;
    }

    guest_storage_apply::run_manifest_bytes(&manifest_json)
}

fn read_manifest_file(path: &str) -> io::Result<Vec<u8>> {
    let mut file = open_manifest_file(path)?;
    let mut manifest_json = Vec::new();
    file.read_to_end(&mut manifest_json)?;
    Ok(manifest_json)
}

#[cfg(unix)]
fn open_manifest_file(path: &str) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    use std::os::unix::io::AsRawFd;

    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;

    let fd = file.as_raw_fd();
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: `stat` points to valid writable memory and `fd` comes from a live
    // File. On success, fstat initializes the whole struct.
    let result = unsafe { libc::fstat(fd, stat.as_mut_ptr()) };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fstat succeeded and initialized `stat`.
    let stat = unsafe { stat.assume_init() };
    if stat.st_mode & libc::S_IFMT != libc::S_IFREG {
        return Err(io::Error::new(
            ErrorKind::InvalidInput,
            "storage manifest is not a regular file",
        ));
    }

    Ok(file)
}

#[cfg(not(unix))]
fn open_manifest_file(path: &str) -> io::Result<File> {
    let file = File::open(path)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::new(
            ErrorKind::InvalidInput,
            "storage manifest is not a regular file",
        ));
    }
    Ok(file)
}

fn remove_manifest_file(path: &str) -> bool {
    match std::fs::remove_file(path) {
        Ok(()) => true,
        Err(e) if e.kind() == ErrorKind::NotFound => true,
        Err(e) => {
            log_error!(LOG_TAG, "Failed to remove storage manifest {path}: {e}");
            false
        }
    }
}

fn remove_stale_manifest_file(path: &str) -> bool {
    match std::fs::remove_file(path) {
        Ok(()) => true,
        Err(e) if e.kind() == ErrorKind::NotFound => true,
        Err(e) if e.kind() == ErrorKind::IsADirectory => {
            log_info!(
                LOG_TAG,
                "Skipping stale storage manifest cleanup because {path} is a directory"
            );
            true
        }
        Err(e) => {
            log_error!(LOG_TAG, "Failed to remove storage manifest {path}: {e}");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{remove_manifest_file, remove_stale_manifest_file, run_manifest_file_and_remove};

    #[test]
    fn remove_manifest_file_removes_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("storage-manifest.json");
        std::fs::write(&path, br#"{"secret":"old"}"#).unwrap();

        assert!(remove_manifest_file(path.to_str().unwrap()));

        assert!(!path.exists());
    }

    #[test]
    fn remove_manifest_file_allows_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missing-storage-manifest.json");

        assert!(remove_manifest_file(path.to_str().unwrap()));

        assert!(!path.exists());
    }

    #[test]
    fn remove_manifest_file_fails_for_non_removable_path() {
        let dir = tempfile::tempdir().unwrap();

        assert!(!remove_manifest_file(dir.path().to_str().unwrap()));
    }

    #[test]
    fn remove_stale_manifest_file_allows_directory_without_removing_it() {
        let dir = tempfile::tempdir().unwrap();

        assert!(remove_stale_manifest_file(dir.path().to_str().unwrap()));

        assert!(dir.path().is_dir());
    }

    #[test]
    fn run_manifest_file_and_remove_removes_file_on_success() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("storage-manifest.json");
        std::fs::write(&path, br#"{"storageMounts":[]}"#).unwrap();

        assert!(run_manifest_file_and_remove(path.to_str().unwrap()));

        assert!(!path.exists());
    }

    #[test]
    fn run_manifest_file_and_remove_removes_file_on_parse_failure() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("storage-manifest.json");
        std::fs::write(&path, br#"{{not valid json secret-body"#).unwrap();

        assert!(!run_manifest_file_and_remove(path.to_str().unwrap()));

        assert!(!path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn run_manifest_file_and_remove_removes_symlink_on_read_failure() {
        let dir = tempfile::tempdir().unwrap();
        let target_dir = dir.path().join("target-dir");
        let path = dir.path().join("storage-manifest.json");
        std::fs::create_dir(&target_dir).unwrap();
        std::os::unix::fs::symlink(&target_dir, &path).unwrap();

        assert!(!run_manifest_file_and_remove(path.to_str().unwrap()));

        assert!(!path.exists());
        assert!(target_dir.exists());
    }

    #[cfg(unix)]
    #[test]
    fn run_manifest_file_and_remove_rejects_symlink_to_regular_file() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target-manifest.json");
        let path = dir.path().join("storage-manifest.json");
        std::fs::write(&target, br#"{"storageMounts":[]}"#).unwrap();
        std::os::unix::fs::symlink(&target, &path).unwrap();

        assert!(!run_manifest_file_and_remove(path.to_str().unwrap()));

        assert!(!path.exists());
        assert!(target.exists());
    }

    #[cfg(unix)]
    #[test]
    fn run_manifest_file_and_remove_rejects_fifo_without_blocking() {
        use std::ffi::CString;
        use std::io;
        use std::os::unix::ffi::OsStrExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("storage-manifest.json");
        let c_path = CString::new(path.as_os_str().as_bytes()).unwrap();

        // SAFETY: `c_path` is a valid, NUL-terminated filesystem path.
        let result = unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) };
        assert_eq!(result, 0, "mkfifo failed: {}", io::Error::last_os_error());

        assert!(!run_manifest_file_and_remove(path.to_str().unwrap()));

        assert!(!path.exists());
    }
}
