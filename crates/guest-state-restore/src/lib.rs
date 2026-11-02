//! Repair snapshot-sensitive guest state and apply the guest timezone.
//!
//! On ARM64 with Linux 6.1, VMGenID does not automatically reseed the CRNG
//! after snapshot restore because the kernel driver supports ACPI but not
//! DeviceTree until Linux 6.10. This crate accepts fresh host entropy through
//! stdin, writes it to `/dev/urandom`, and forces an immediate reseed through
//! the `RNDRESEEDCRNG` ioctl so restored VMs do not share identical random
//! output. Its timezone-only mode applies the canonical guest timezone policy
//! without changing the clock or reading entropy.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{self, Read, Write};
use std::os::unix::fs::symlink;
use std::os::unix::io::AsRawFd;
use std::path::Path;

/// ioctl request code for RNDRESEEDCRNG.
///
/// Forces an immediate reseed of the kernel CRNG from the input pool.
/// Requires CAP_SYS_ADMIN.
///
/// See `include/uapi/linux/random.h` in the kernel source.
const RNDRESEEDCRNG: libc::Ioctl = 0x5207;
const MAX_ENTROPY_BYTES: usize = 64 * 1024;
const RESTORE_ENTROPY_BYTES: usize = 256;
const RESTORE_MODE_ARG: &str = "--restore-state";
const TIMEZONE_MODE_ARG: &str = "--sync-timezone";
const CLOCK_SYNC_FAILED_MARKER: &str = "guest clock sync failed";
const RESEED_FAILED_MARKER: &str = "guest-state-restore failed";
const TIMEZONE_SYNC_FAILED_MARKER: &str = "guest timezone sync failed";
const TIMEZONE_UNAVAILABLE_MARKER: &str = "guest timezone unavailable";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RestoreTimezoneMode {
    None,
    BestEffort,
    Required,
}

#[derive(Debug, Eq, PartialEq)]
struct RestoreArgs {
    seconds: u64,
    nanoseconds: u32,
    timezone_mode: RestoreTimezoneMode,
    timezone: Option<String>,
}

fn read_entropy(mut input: impl Read) -> io::Result<Vec<u8>> {
    let mut entropy = Vec::new();
    input
        .by_ref()
        .take((MAX_ENTROPY_BYTES + 1) as u64)
        .read_to_end(&mut entropy)
        .map_err(|e| io::Error::new(e.kind(), format!("read stdin: {e}")))?;
    if entropy.is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "empty entropy"));
    }
    if entropy.len() > MAX_ENTROPY_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "entropy too large",
        ));
    }
    Ok(entropy)
}

fn read_restore_entropy(mut input: impl Read) -> io::Result<[u8; RESTORE_ENTROPY_BYTES]> {
    let mut entropy = [0u8; RESTORE_ENTROPY_BYTES];
    input
        .read_exact(&mut entropy)
        .map_err(|error| io::Error::new(error.kind(), format!("read stdin: {error}")))?;
    let mut trailing = [0u8; 1];
    if input
        .read(&mut trailing)
        .map_err(|error| io::Error::new(error.kind(), format!("read stdin: {error}")))?
        != 0
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "restore entropy must contain exactly 256 bytes",
        ));
    }
    Ok(entropy)
}

fn reseed(entropy: &[u8]) -> io::Result<()> {
    if entropy.is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "empty entropy"));
    }
    if entropy.len() > MAX_ENTROPY_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "entropy too large",
        ));
    }

    fs::write("/dev/urandom", entropy)
        .map_err(|e| io::Error::new(e.kind(), format!("write /dev/urandom: {e}")))?;
    let f = fs::File::open("/dev/urandom")
        .map_err(|e| io::Error::new(e.kind(), format!("open /dev/urandom: {e}")))?;

    // SAFETY: fd is a valid open file descriptor for /dev/urandom.
    let ret = unsafe { libc::ioctl(f.as_raw_fd(), RNDRESEEDCRNG) };
    if ret < 0 {
        let err = io::Error::last_os_error();
        return Err(io::Error::new(
            err.kind(),
            format!("RNDRESEEDCRNG failed: {err}"),
        ));
    }
    Ok(())
}

fn set_realtime(seconds: u64, nanoseconds: u32) -> io::Result<()> {
    let timestamp = libc::timespec {
        tv_sec: seconds
            .try_into()
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "seconds exceed time_t"))?,
        tv_nsec: libc::c_long::from(nanoseconds),
    };

    // SAFETY: `timestamp` is fully initialized, nanoseconds are validated by
    // the CLI parser, and CLOCK_REALTIME accepts a pointer to this structure.
    if unsafe { libc::clock_settime(libc::CLOCK_REALTIME, &timestamp) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn is_safe_timezone_name(timezone: &str) -> bool {
    !timezone.is_empty()
        && timezone.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || byte == b'/'
                || byte == b'_'
                || byte == b'-'
                || byte == b'+'
        })
}

fn sync_timezone(timezone: &str) -> io::Result<bool> {
    sync_timezone_at(Path::new("/"), timezone)
}

fn sync_timezone_at(root: &Path, timezone: &str) -> io::Result<bool> {
    // The previous shell command appended the validated name to the zoneinfo
    // directory textually. Strip leading separators before `Path::join` so an
    // accepted name such as `/UTC` keeps that behavior instead of replacing
    // the trusted root prefix.
    let zoneinfo = root
        .join("usr/share/zoneinfo")
        .join(timezone.trim_start_matches('/'));
    if !zoneinfo.is_file() {
        return Ok(false);
    }

    fs::write(root.join("etc/timezone"), format!("{timezone}\n"))?;
    let localtime = root.join("etc/localtime");
    match fs::symlink_metadata(&localtime) {
        Ok(_) => fs::remove_file(&localtime)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    symlink(format!("/usr/share/zoneinfo/{timezone}"), &localtime)?;

    let environment_path = root.join("etc/environment");
    let environment = fs::read(&environment_path)?;
    let mut updated = Vec::with_capacity(environment.len() + timezone.len() + 4);
    for line in environment.split_inclusive(|byte| *byte == b'\n') {
        if !line.starts_with(b"TZ=") {
            updated.extend_from_slice(line);
        }
    }
    if !updated.is_empty() && !updated.ends_with(b"\n") {
        updated.push(b'\n');
    }
    updated.extend_from_slice(b"TZ=");
    updated.extend_from_slice(timezone.as_bytes());
    updated.push(b'\n');
    fs::write(environment_path, updated)?;

    Ok(true)
}

fn parse_restore_args(args: &[OsString]) -> Result<RestoreArgs, &'static str> {
    if args.first().and_then(|arg| arg.to_str()) != Some(RESTORE_MODE_ARG) {
        return Err("missing restore mode");
    }
    let seconds = args
        .get(1)
        .and_then(|arg| arg.to_str())
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or("invalid restore seconds")?;
    let nanoseconds = args
        .get(2)
        .and_then(|arg| arg.to_str())
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| *value < 1_000_000_000)
        .ok_or("invalid restore nanoseconds")?;
    let timezone_mode = match args.get(3).and_then(|arg| arg.to_str()) {
        Some("none") => RestoreTimezoneMode::None,
        Some("best-effort") => RestoreTimezoneMode::BestEffort,
        Some("required") => RestoreTimezoneMode::Required,
        _ => return Err("invalid restore timezone mode"),
    };
    let timezone = args.get(4).and_then(|arg| arg.to_str());
    match timezone_mode {
        RestoreTimezoneMode::None if args.len() == 4 => Ok(RestoreArgs {
            seconds,
            nanoseconds,
            timezone_mode,
            timezone: None,
        }),
        RestoreTimezoneMode::BestEffort | RestoreTimezoneMode::Required
            if args.len() == 5 && timezone.is_some_and(is_safe_timezone_name) =>
        {
            Ok(RestoreArgs {
                seconds,
                nanoseconds,
                timezone_mode,
                timezone: timezone.map(ToOwned::to_owned),
            })
        }
        RestoreTimezoneMode::None => Err("restore timezone is not allowed for none mode"),
        RestoreTimezoneMode::BestEffort | RestoreTimezoneMode::Required => {
            Err("restore timezone is missing or invalid")
        }
    }
}

fn parse_timezone_args(args: &[OsString]) -> Result<&str, &'static str> {
    let [mode, timezone] = args else {
        return Err("timezone is missing or invalid");
    };
    if mode != TIMEZONE_MODE_ARG {
        return Err("timezone is missing or invalid");
    }
    timezone
        .to_str()
        .filter(|timezone| is_safe_timezone_name(timezone))
        .ok_or("timezone is missing or invalid")
}

/// Runs the `guest-state-restore` CLI.
///
/// `args` must contain the command-line arguments after the executable name,
/// matching `std::env::args_os().skip(1)`. Entropy-only mode uses:
///
/// ```text
/// guest-state-restore < entropy-bytes
/// ```
///
/// The fixed guest-state operation uses:
///
/// ```text
/// guest-state-restore --restore-state <seconds> <nanoseconds> \
///   <none|best-effort|required> [timezone] < entropy-bytes
/// ```
///
/// The timezone-only operation uses:
///
/// ```text
/// guest-state-restore --sync-timezone <timezone>
/// ```
///
/// Entropy-only input must contain between 1 and 65,536 bytes. Restore input
/// must contain exactly 256 bytes. Timezone-only mode does not read input.
/// `stderr` receives usage and runtime diagnostics.
///
/// Valid input is written to `/dev/urandom`, then the kernel CRNG is force-
/// reseeded through the `RNDRESEEDCRNG` ioctl. This operation requires
/// `CAP_SYS_ADMIN`.
///
/// Restore mode sets the realtime clock, reseeds the CRNG, then optionally
/// applies the timezone. Required timezone failures return non-zero;
/// best-effort application failures emit a marker and return success.
/// Timezone-only mode uses the same best-effort marker contract without
/// setting the clock or reseeding the CRNG.
///
/// Returns process-style exit codes: `0` for success and `1` for argument,
/// input, clock, reseed, or required-timezone failures.
pub fn run_cli<I, A>(input: impl Read, stderr: impl Write, args: I) -> i32
where
    I: IntoIterator<Item = A>,
    A: AsRef<OsStr>,
{
    run_with_operations(input, stderr, args, set_realtime, reseed, sync_timezone)
}

fn run_with_operations<R, W, I, A, C, S, T>(
    input: R,
    mut stderr: W,
    args: I,
    clock_fn: C,
    reseed_fn: S,
    timezone_fn: T,
) -> i32
where
    R: Read,
    W: Write,
    I: IntoIterator<Item = A>,
    A: AsRef<OsStr>,
    C: FnOnce(u64, u32) -> io::Result<()>,
    S: FnOnce(&[u8]) -> io::Result<()>,
    T: FnOnce(&str) -> io::Result<bool>,
{
    let args = args
        .into_iter()
        .map(|arg| arg.as_ref().to_owned())
        .collect::<Vec<_>>();
    if args.is_empty() {
        return run_entropy_only(input, &mut stderr, reseed_fn);
    }
    if args
        .first()
        .and_then(|arg| arg.to_str())
        .is_some_and(|arg| arg == TIMEZONE_MODE_ARG)
    {
        let timezone = match parse_timezone_args(&args) {
            Ok(timezone) => timezone,
            Err(error) => {
                let _ = writeln!(stderr, "guest-state-restore: {error}");
                let _ = writeln!(
                    stderr,
                    "usage: guest-state-restore --sync-timezone <timezone>"
                );
                return 1;
            }
        };
        return report_timezone_result(timezone_fn(timezone), false, &mut stderr);
    }

    let restore = match parse_restore_args(&args) {
        Ok(restore) => restore,
        Err(error) => {
            let _ = writeln!(stderr, "guest-state-restore: {error}");
            let _ = writeln!(
                stderr,
                "usage: guest-state-restore --restore-state <seconds> <nanoseconds> <none|best-effort|required> [timezone] < entropy-bytes"
            );
            return 1;
        }
    };
    let entropy = match read_restore_entropy(input) {
        Ok(entropy) => entropy,
        Err(error) => {
            let _ = writeln!(stderr, "guest-state-restore: {error}");
            return 1;
        }
    };
    if let Err(error) = clock_fn(restore.seconds, restore.nanoseconds) {
        let _ = writeln!(stderr, "{CLOCK_SYNC_FAILED_MARKER}: {error}");
        return 1;
    }
    if let Err(error) = reseed_fn(&entropy) {
        let _ = writeln!(stderr, "{RESEED_FAILED_MARKER}: {error}");
        return 1;
    }

    let Some(timezone) = restore.timezone.as_deref() else {
        return 0;
    };
    report_timezone_result(
        timezone_fn(timezone),
        restore.timezone_mode == RestoreTimezoneMode::Required,
        &mut stderr,
    )
}

fn report_timezone_result(result: io::Result<bool>, required: bool, mut stderr: impl Write) -> i32 {
    match result {
        Ok(true) => 0,
        Ok(false) => {
            let _ = writeln!(stderr, "{TIMEZONE_UNAVAILABLE_MARKER}");
            i32::from(required)
        }
        Err(error) => {
            let _ = writeln!(stderr, "{TIMEZONE_SYNC_FAILED_MARKER}: {error}");
            i32::from(required)
        }
    }
}

fn run_entropy_only(
    input: impl Read,
    mut stderr: impl Write,
    reseed_fn: impl FnOnce(&[u8]) -> io::Result<()>,
) -> i32 {
    let entropy = match read_entropy(input) {
        Ok(entropy) => entropy,
        Err(e) => {
            let _ = writeln!(stderr, "guest-state-restore: {e}");
            return 1;
        }
    };

    match reseed_fn(&entropy) {
        Ok(()) => 0,
        Err(e) => {
            let _ = writeln!(stderr, "guest-state-restore: {e}");
            1
        }
    }
}

#[cfg(test)]
fn run_with_reseed<R, W, I, A, F>(input: R, stderr: W, args: I, reseed_fn: F) -> i32
where
    R: Read,
    W: Write,
    I: IntoIterator<Item = A>,
    A: AsRef<OsStr>,
    F: FnOnce(&[u8]) -> io::Result<()>,
{
    let args = args.into_iter().collect::<Vec<_>>();
    if !args.is_empty() {
        let mut stderr = stderr;
        let _ = writeln!(stderr, "usage: guest-state-restore < entropy-bytes");
        return 1;
    }
    run_entropy_only(input, stderr, reseed_fn)
}

#[cfg(test)]
mod tests;
