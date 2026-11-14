use guest_contracts::{env, runtime_paths};
use guest_storage_apply::input_telemetry::{InputPhase, record_payload_size, record_phase};
use guest_telemetry::{log_error, log_info, telemetry::record_sandbox_op};
use std::fs::File;
#[cfg(unix)]
use std::fs::OpenOptions;
use std::io::{self, ErrorKind, Read as _};
use std::path::{Path, PathBuf};
use std::time::Instant;

const LOG_TAG: &str = "sandbox:guest-storage-apply";
const MANIFEST_STDIN_ARG: &str = "--manifest-stdin";
const USAGE: &str = "Usage: guest-storage-apply <manifest_path> | --manifest-stdin | --storage-files-stdin | --instructions-stdin | --instructions-check-stdin";

enum ManifestInput {
    InstructionsStdin { check: bool },
    Path(String),
    Stdin,
    FilesStdin,
}

fn main() {
    let runtime_dir = install_runtime_log_paths().unwrap_or_else(|error| {
        log_error!(LOG_TAG, "{error}");
        std::process::exit(1);
    });

    let Some(input) = manifest_input_from_args() else {
        log_error!(LOG_TAG, "{USAGE}");
        std::process::exit(1);
    };

    if matches!(&input, ManifestInput::InstructionsStdin { check: true }) {
        match read_instruction_metadata(
            guest_contracts::agent_instructions::MAX_CHECK_METADATA_BYTES,
        )
        .and_then(|metadata| {
            guest_storage_apply::check_agent_instructions(
                std::path::Path::new("/home/user"),
                &metadata,
            )
        }) {
            Ok(present) => println!("{present}"),
            Err(error) => {
                log_error!(LOG_TAG, "Instruction file check failed: {error}");
                std::process::exit(1);
            }
        }
        return;
    }

    let start = Instant::now();
    let success = run(input, &runtime_dir);
    let elapsed = start.elapsed();

    record_sandbox_op("download_total", elapsed, success, None);
    if success {
        log_info!(LOG_TAG, "Download completed in {}ms", elapsed.as_millis());
    } else {
        log_error!(LOG_TAG, "Download failed");
        std::process::exit(1);
    }
}

fn install_runtime_log_paths() -> Result<PathBuf, String> {
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
        &run_dir,
    ));
    Ok(run_dir)
}

fn manifest_input_from_args() -> Option<ManifestInput> {
    let mut args = std::env::args().skip(1);
    let arg = args.next()?;
    if matches!(
        arg.as_str(),
        "--instructions-stdin" | "--instructions-check-stdin"
    ) {
        return args
            .next()
            .is_none()
            .then_some(ManifestInput::InstructionsStdin {
                check: arg == "--instructions-check-stdin",
            });
    }
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

fn read_instruction_metadata(limit: usize) -> io::Result<Vec<u8>> {
    let mut metadata = Vec::new();
    io::stdin()
        .take(limit as u64 + 1)
        .read_to_end(&mut metadata)?;
    if metadata.len() > limit {
        return Err(io::Error::other("Instruction metadata exceeds bound"));
    }
    Ok(metadata)
}

fn run(input: ManifestInput, runtime_dir: &Path) -> bool {
    match input {
        ManifestInput::InstructionsStdin { .. } => {
            let Ok(metadata) =
                read_instruction_metadata(guest_contracts::agent_instructions::MAX_METADATA_BYTES)
            else {
                return false;
            };
            guest_storage_apply::apply_agent_instructions(
                std::path::Path::new("/home/user"),
                &metadata,
            )
        }
        ManifestInput::FilesStdin => {
            let stale_start = Instant::now();
            let stale_removed = remove_stale_manifest_file(runtime_paths::STORAGE_MANIFEST_PATH);
            record_phase(InputPhase::StaleCleanup, stale_start, stale_removed);
            if !stale_removed {
                record_payload_size(None);
                return false;
            }
            let mut input = Vec::new();
            let limit = guest_contracts::storage_files::MAX_INPUT_BYTES as u64;
            let read_start = Instant::now();
            let read_ok = std::io::stdin()
                .take(limit + 1)
                .read_to_end(&mut input)
                .is_ok()
                && input.len() as u64 <= limit;
            record_phase(InputPhase::Read, read_start, read_ok);
            if !read_ok {
                record_payload_size(None);
                log_error!(LOG_TAG, "Failed to read bounded storage files input");
                return false;
            }
            guest_storage_apply::run_storage_files_bytes_in_runtime(&input, runtime_dir)
        }
        ManifestInput::Path(manifest_path) => run_path(&manifest_path, runtime_dir),
        ManifestInput::Stdin => {
            if !remove_stale_manifest_file(runtime_paths::STORAGE_MANIFEST_PATH) {
                return false;
            }

            let mut manifest_json = Vec::new();
            if let Err(e) = std::io::stdin().read_to_end(&mut manifest_json) {
                log_error!(LOG_TAG, "Failed to read manifest from stdin: {e}");
                return false;
            }
            guest_storage_apply::run_manifest_bytes_in_runtime(&manifest_json, runtime_dir)
        }
    }
}

fn run_path(manifest_path: &str, runtime_dir: &Path) -> bool {
    if manifest_path == runtime_paths::STORAGE_MANIFEST_PATH {
        run_manifest_file_and_remove(manifest_path, runtime_dir)
    } else {
        guest_storage_apply::run_in_runtime(manifest_path, runtime_dir)
    }
}

fn run_manifest_file_and_remove(manifest_path: &str, runtime_dir: &Path) -> bool {
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

    guest_storage_apply::run_manifest_bytes_in_runtime(&manifest_json, runtime_dir)
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

    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;

    let stat = nix::sys::stat::fstat(&file)?;
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
mod tests;
