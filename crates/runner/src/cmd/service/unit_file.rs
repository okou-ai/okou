use std::ffi::OsString;
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::{RunnerError, RunnerResult};

use runner_host::service::RunnerServiceUnit;

const UNIT_STAGING_MARKER: &str = ".tmp@";
const UNIT_STAGING_MAX_ATTEMPTS: u64 = 32;
pub(super) const RUNNER_SERVICE_NOFILE_LIMIT_DIRECTIVE: &str = "LimitNOFILE=524288:524288";
pub(super) const RUNNER_SERVICE_CPU_DELEGATION_DIRECTIVE: &str = "Delegate=cpu";
pub(super) const RUNNER_SERVICE_CONTROL_SUBGROUP_DIRECTIVE: &str = "DelegateSubgroup=control";
#[cfg(unix)]
const UNIT_FILE_MODE: u32 = 0o600;
static UNIT_STAGING_COUNTER: AtomicU64 = AtomicU64::new(0);

struct UnitStagingCleanup<'a> {
    path: Option<&'a Path>,
}

impl<'a> UnitStagingCleanup<'a> {
    fn new(path: &'a Path) -> Self {
        Self { path: Some(path) }
    }

    fn disarm(mut self) {
        self.path = None;
    }
}

impl Drop for UnitStagingCleanup<'_> {
    fn drop(&mut self) {
        if let Some(path) = self.path {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Resolve a config path to an absolute path.
pub(super) fn resolve_config_path(path: &Path) -> RunnerResult<PathBuf> {
    std::fs::canonicalize(path).map_err(|e| {
        RunnerError::Config(format!(
            "cannot resolve config path {}: {e}",
            path.display()
        ))
    })
}

/// Escape a string for use inside a double-quoted systemd value.
///
/// Three characters need escaping:
/// - `\` and `"`: required by systemd's quoted-string syntax; without
///   escape, the closing `"` is misparsed and the unit file is corrupted.
/// - `%`: systemd performs **specifier expansion** on directive values
///   (`%H` → hostname, `%n` → unit name, `%i` → instance, etc.), so an
///   unescaped `%` followed by a specifier letter gets silently rewritten.
///   `%%` is the literal-`%` escape and is safe across all systemd versions.
///
/// Single-pass iteration intentionally avoids chained `replace` calls:
/// the previous `\\` → `"` order was a hidden contract that future
/// additions to this set could easily get wrong.
fn escape_systemd_value(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for c in input.chars() {
        match c {
            '\\' => out.push_str(r"\\"),
            '"' => out.push_str("\\\""),
            '%' => out.push_str("%%"),
            _ => out.push(c),
        }
    }
    out
}

/// Generate the systemd unit file content.
///
/// User-controllable values (`ExecStart=` paths, `Environment=` values) go
/// through [`escape_systemd_value`] so that input cannot break out of the
/// quotes or trigger systemd specifier expansion. The `:` command prefix also
/// disables environment expansion for `ExecStart=`, preserving literal dollar
/// signs in paths without changing `Environment=` values. `unit` is not
/// escaped because [`RunnerServiceUnit`] already restricts it to lowercase
/// alphanumeric, hyphens, and dots — no `%`, `\`, `"`, or other systemd
/// special chars can reach `Description=` or `SyslogIdentifier=`.
pub(super) fn generate_unit_file(
    unit: &RunnerServiceUnit,
    exe_path: &Path,
    config_path: &Path,
    env_vars: &[String],
    local: bool,
) -> String {
    let mut env_lines = String::new();
    for entry in env_vars {
        let escaped = escape_systemd_value(entry);
        env_lines.push_str(&format!("Environment=\"{escaped}\"\n"));
    }
    let local_flag = if local { " --local" } else { "" };
    let exe = escape_systemd_value(&exe_path.display().to_string());
    let config = escape_systemd_value(&config_path.display().to_string());
    let unit_name = unit.unit_name();
    format!(
        "\
[Unit]
Description=Okou Runner ({unit_name})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=:\"{exe}\" start --config \"{config}\"{local_flag}
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=300
{RUNNER_SERVICE_NOFILE_LIMIT_DIRECTIVE}
{RUNNER_SERVICE_CPU_DELEGATION_DIRECTIVE}
{RUNNER_SERVICE_CONTROL_SUBGROUP_DIRECTIVE}
StandardOutput=journal
StandardError=journal
SyslogIdentifier={unit_name}
{env_lines}
[Install]
WantedBy=multi-user.target
",
    )
}

/// Validate that each env entry has a systemd-compatible key and contains no
/// characters that would silently corrupt the generated systemd unit file.
///
/// Bare newlines / carriage returns / NUL bytes anywhere in an assignment break the
/// `Environment=` directive even with proper quote/backslash escaping
/// (a literal newline terminates the directive line). Reject these before
/// service setup rather than allowing systemd to fail obscurely later.
pub(super) fn validate_env_vars(vars: &[String]) -> RunnerResult<()> {
    for entry in vars {
        // Check directive-breaking bytes before parsing key/value syntax.
        if entry.contains(['\n', '\r', '\0']) {
            return Err(RunnerError::Config(
                "invalid --env value: newline or NUL characters are not allowed".to_string(),
            ));
        }
        let Some((key, _)) = entry.split_once('=') else {
            return Err(RunnerError::Config(
                "invalid --env value: expected KEY=VALUE format".to_string(),
            ));
        };
        if key.is_empty() {
            return Err(RunnerError::Config(
                "invalid --env value: expected KEY=VALUE format".to_string(),
            ));
        }
        if !guest_contracts::env::is_shell_identifier_env_key(key) {
            let key = guest_contracts::env::sanitize_env_key_for_diagnostic(key);
            return Err(RunnerError::Config(format!(
                "invalid --env key {key:?}: expected [_A-Za-z][_A-Za-z0-9]*"
            )));
        }
    }
    Ok(())
}

pub(super) fn validate_systemd_path(label: &str, path: &Path) -> RunnerResult<()> {
    let value = path.display().to_string();
    if value.contains(['\n', '\r', '\0']) {
        return Err(RunnerError::Config(format!(
            "{label} cannot contain newline or NUL characters"
        )));
    }
    Ok(())
}

pub(super) fn validate_current_exe_path(path: PathBuf) -> RunnerResult<PathBuf> {
    let meta = std::fs::metadata(&path).map_err(|e| {
        RunnerError::Internal(format!("stat current executable {}: {e}", path.display()))
    })?;
    if !meta.is_file() {
        return Err(RunnerError::Internal(format!(
            "current executable {} is not a file",
            path.display()
        )));
    }
    #[cfg(unix)]
    if meta.permissions().mode() & 0o111 == 0 {
        return Err(RunnerError::Internal(format!(
            "current executable {} is not executable",
            path.display()
        )));
    }
    Ok(path)
}

fn unit_staging_path(path: &Path, attempt: u64) -> RunnerResult<PathBuf> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = path.file_name().ok_or_else(|| {
        RunnerError::Internal(format!(
            "unit file path has no file name: {}",
            path.display()
        ))
    })?;
    let mut staging_name = OsString::from(file_name);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos());
    staging_name.push(format!(
        "{UNIT_STAGING_MARKER}{}.{}.{}",
        std::process::id(),
        nanos,
        attempt
    ));
    Ok(parent.join(staging_name))
}

fn unit_staging_prefix(path: &Path) -> RunnerResult<String> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            RunnerError::Internal(format!(
                "unit file path has no UTF-8 file name: {}",
                path.display()
            ))
        })?;
    Ok(format!("{file_name}{UNIT_STAGING_MARKER}"))
}

fn is_generated_unit_staging_suffix(value: &str) -> bool {
    let mut parts = value.split('.');
    let Some(pid) = parts.next() else {
        return false;
    };
    let Some(nanos) = parts.next() else {
        return false;
    };
    let Some(attempt) = parts.next() else {
        return false;
    };
    parts.next().is_none()
        && pid.parse::<u32>().is_ok()
        && nanos.parse::<u128>().is_ok()
        && attempt.parse::<u64>().is_ok()
}

fn remove_unit_staging_file(path: &Path) -> RunnerResult<()> {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => {
            return Err(RunnerError::Internal(format!(
                "stat unit staging file {}: {e}",
                path.display()
            )));
        }
    };
    let file_type = meta.file_type();
    if !meta.is_file() && !file_type.is_symlink() {
        return Ok(());
    }
    std::fs::remove_file(path).map_err(|e| {
        RunnerError::Internal(format!("remove unit staging file {}: {e}", path.display()))
    })
}

pub(super) fn cleanup_unit_staging_files(path: &Path) -> RunnerResult<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let prefix = unit_staging_prefix(path)?;

    // The original atomic writer used this exact sibling path. No supported
    // runner creates it now, so remove any file or symlink left behind.
    remove_unit_staging_file(&path.with_extension("tmp"))?;

    let entries = match std::fs::read_dir(parent) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => {
            return Err(RunnerError::Internal(format!(
                "read unit directory {}: {e}",
                parent.display()
            )));
        }
    };
    for entry in entries {
        let entry = entry.map_err(|e| {
            RunnerError::Internal(format!("read unit directory {}: {e}", parent.display()))
        })?;
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else {
            continue;
        };
        let Some(suffix) = name.strip_prefix(&prefix) else {
            continue;
        };
        if is_generated_unit_staging_suffix(suffix) {
            remove_unit_staging_file(&entry.path())?;
        }
    }
    Ok(())
}

/// Write a unit file atomically: stage to a unique sibling file, then rename.
///
/// `rename(2)` is atomic on the same filesystem, so a concurrent
/// `systemctl daemon-reload` (possibly triggered by unrelated unit changes
/// on the host) sees either the old file or the new file — never a
/// half-written one. Without this, the truncate+write window inside
/// `std::fs::write` could let systemd parse a partial unit file and leave
/// the unit in a broken state. The staging file is unique so concurrent
/// installs for the same unit do not share a writable temp path.
pub(super) fn write_unit_file(path: &Path, content: &str) -> RunnerResult<()> {
    write_unit_file_with(path, content, |file, content| file.write_all(content))
}

fn write_unit_file_with(
    path: &Path,
    content: &str,
    write: impl Fn(&mut std::fs::File, &[u8]) -> std::io::Result<()>,
) -> RunnerResult<()> {
    for _ in 0..UNIT_STAGING_MAX_ATTEMPTS {
        let attempt = UNIT_STAGING_COUNTER.fetch_add(1, Ordering::Relaxed);
        let tmp = unit_staging_path(path, attempt)?;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            options.mode(UNIT_FILE_MODE);
        }
        let mut file = match options.open(&tmp) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => {
                return Err(RunnerError::Internal(format!(
                    "create staging unit file {}: {e}",
                    tmp.display()
                )));
            }
        };
        // Acquire cleanup only after exclusive creation. Declare it after the
        // file so earlier failures unlink staging before closing the descriptor.
        let staging_cleanup = UnitStagingCleanup::new(&tmp);

        #[cfg(unix)]
        {
            if let Err(e) = file.set_permissions(std::fs::Permissions::from_mode(UNIT_FILE_MODE)) {
                return Err(RunnerError::Internal(format!(
                    "set permissions on staging unit file {}: {e}",
                    tmp.display()
                )));
            }
        }
        if let Err(e) = write(&mut file, content.as_bytes()) {
            return Err(RunnerError::Internal(format!(
                "write {}: {e}",
                tmp.display()
            )));
        }
        #[cfg(not(unix))]
        drop(file);
        if let Err(e) = std::fs::rename(&tmp, path) {
            // Unlike short-lived dirs elsewhere in the crate, unit files live
            // in /etc/systemd/system/ which no GC path sweeps, and the staged
            // content contains Environment= secrets.
            return Err(RunnerError::Internal(format!(
                "rename {} -> {}: {e}",
                tmp.display(),
                path.display()
            )));
        }
        staging_cleanup.disarm();
        return Ok(());
    }

    Err(RunnerError::Internal(format!(
        "create unique staging unit file for {}: exhausted {UNIT_STAGING_MAX_ATTEMPTS} attempts",
        path.display()
    )))
}

pub(super) fn remove_unit_file_if_exists(path: &Path) -> RunnerResult<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(RunnerError::Internal(format!(
            "remove unit file {}: {e}",
            path.display()
        ))),
    }
}

#[cfg(test)]
mod tests;
