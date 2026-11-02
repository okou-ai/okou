use std::io;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

const BLOCKING_PATH_SUFFIX: &str = ".vm0-guest-control-tests-block";
const RELEASE_POLL_INTERVAL: Duration = Duration::from_millis(10);

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Some(path) = blocking_path(&args)
        && let Err(error) = wait_for_release(path)
    {
        report_setup_failure(path, &error);
        std::process::exit(1);
    }

    let code = guest_write_file::run_cli(args, io::stdin().lock(), io::stderr().lock());
    std::process::exit(code);
}

fn wait_for_release(path: &Path) -> io::Result<()> {
    write_marker(
        &path_with_suffix(path, ".pid"),
        std::process::id().to_string().as_bytes(),
        "write PID marker",
    )?;
    write_marker(
        &path_with_suffix(path, ".started"),
        b"",
        "write started marker",
    )?;

    let release_path = path_with_suffix(path, ".release");
    loop {
        match std::fs::remove_file(&release_path) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                thread::sleep(RELEASE_POLL_INTERVAL);
            }
            Err(error) => return Err(path_error("consume release marker", &release_path, error)),
        }
    }
}

fn write_marker(path: &Path, content: &[u8], action: &str) -> io::Result<()> {
    std::fs::write(path, content).map_err(|error| path_error(action, path, error))
}

fn report_setup_failure(path: &Path, error: &io::Error) {
    let message = format!("failed to prepare blocking write helper: {error}");
    if let Err(report_error) = publish_failure(path, &message) {
        eprintln!("{message}; failed to publish setup failure: {report_error}");
    } else {
        eprintln!("{message}");
    }
}

fn publish_failure(path: &Path, message: &str) -> io::Result<()> {
    let temporary_path = path_with_suffix(path, ".failed.tmp");
    let failure_path = path_with_suffix(path, ".failed");
    write_marker(
        &temporary_path,
        message.as_bytes(),
        "write temporary failure marker",
    )?;
    std::fs::rename(&temporary_path, &failure_path)
        .map_err(|error| path_error("publish failure marker", &failure_path, error))
}

fn path_error(action: &str, path: &Path, error: io::Error) -> io::Error {
    io::Error::new(
        error.kind(),
        format!("{action} {}: {error}", path.display()),
    )
}

fn blocking_path(args: &[String]) -> Option<&Path> {
    let path = Path::new(args.last()?);
    path.to_string_lossy()
        .ends_with(BLOCKING_PATH_SUFFIX)
        .then_some(path)
}

fn path_with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}
