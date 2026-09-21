use std::ffi::OsString;
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::{RunnerError, RunnerResult};

use super::target::RunnerServiceUnit;

const UNIT_STAGING_MARKER: &str = ".tmp@";
const UNIT_STAGING_MAX_ATTEMPTS: u64 = 32;
pub(super) const RUNNER_SERVICE_NOFILE_LIMIT_DIRECTIVE: &str = "LimitNOFILE=524288:524288";
pub(super) const RUNNER_SERVICE_CPU_DELEGATION_DIRECTIVE: &str = "Delegate=cpu";
pub(super) const RUNNER_SERVICE_CONTROL_SUBGROUP_DIRECTIVE: &str = "DelegateSubgroup=control";
#[cfg(unix)]
const UNIT_FILE_MODE: u32 = 0o600;
static UNIT_STAGING_COUNTER: AtomicU64 = AtomicU64::new(0);

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

        #[cfg(unix)]
        {
            if let Err(e) = file.set_permissions(std::fs::Permissions::from_mode(UNIT_FILE_MODE)) {
                let _ = std::fs::remove_file(&tmp);
                return Err(RunnerError::Internal(format!(
                    "set permissions on staging unit file {}: {e}",
                    tmp.display()
                )));
            }
        }
        if let Err(e) = write(&mut file, content.as_bytes()) {
            let _ = std::fs::remove_file(&tmp);
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
            let _ = std::fs::remove_file(&tmp);
            return Err(RunnerError::Internal(format!(
                "rename {} -> {}: {e}",
                tmp.display(),
                path.display()
            )));
        }
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

runner_test_group!(cmd_service; #[cfg(test)]
mod tests {
    use super::*;

    fn service_unit(suffix: &str) -> RunnerServiceUnit {
        RunnerServiceUnit::from_suffix(suffix).unwrap()
    }

    #[test]
    fn test_max_length_suffix_derived_basenames_fit_name_max() {
        const COMMON_LINUX_NAME_MAX: usize = 255;

        let suffix = "a".repeat(crate::runner_dirname::MAX_NAME_BYTES);
        let unit = RunnerServiceUnit::from_suffix(&suffix).unwrap();
        let unit_file = unit.service_name().to_string();
        let service_lock = unit.lock_file_name().to_string();
        let current_staging = format!(
            "{unit_file}{UNIT_STAGING_MARKER}{}.{}.{}",
            u32::MAX,
            u128::MAX,
            u64::MAX
        );

        for (label, basename) in [
            ("unit file", unit_file),
            ("service lock", service_lock),
            ("current unit staging", current_staging),
        ] {
            assert!(
                basename.len() <= COMMON_LINUX_NAME_MAX,
                "{label} basename is {} bytes: {basename}",
                basename.len()
            );
        }
    }

    #[test]
    fn test_unit_file_path() {
        let path = service_unit("v0.1.0").unit_file_path().to_path_buf();
        assert_eq!(
            path,
            PathBuf::from("/etc/systemd/system/vm0-runner-v0.1.0.service")
        );
    }

    #[cfg(unix)]
    #[test]
    fn validate_current_exe_path_accepts_executable_file() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vm0-runner");
        std::fs::write(&path, "binary").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();

        assert_eq!(validate_current_exe_path(path.clone()).unwrap(), path);
    }

    #[cfg(unix)]
    #[test]
    fn validate_current_exe_path_rejects_non_executable_file() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vm0-runner");
        std::fs::write(&path, "binary").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();

        assert!(validate_current_exe_path(path).is_err());
    }

    #[test]
    fn validate_current_exe_path_rejects_missing_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missing-runner");

        assert!(validate_current_exe_path(path).is_err());
    }

    #[test]
    fn validate_current_exe_path_rejects_directory() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vm0-runner");
        std::fs::create_dir(&path).unwrap();

        assert!(validate_current_exe_path(path).is_err());
    }

    #[test]
    fn test_generate_unit_file() {
        let content = generate_unit_file(
            &service_unit("v0.1.0"),
            Path::new("/var/lib/vm0-runner/bin/v0.1.0/vm0-runner"),
            Path::new("/home/ubuntu/runner.yaml"),
            &[],
            false,
        );
        assert!(content.contains("Description=Okou Runner (vm0-runner-v0.1.0)"));
        assert!(content.contains(
            "ExecStart=:\"/var/lib/vm0-runner/bin/v0.1.0/vm0-runner\" start --config \"/home/ubuntu/runner.yaml\"\n"
        ));
        assert!(!content.contains("User="));
        assert!(content.contains("SyslogIdentifier=vm0-runner-v0.1.0"));
        assert!(!content.contains("EnvironmentFile="));
        assert!(content.contains("Restart=on-failure"));
        assert!(content.contains("TimeoutStopSec=300"));
        assert!(content.contains("LimitNOFILE=524288:524288"));
        assert!(content.contains("Delegate=cpu"));
        assert!(content.contains("DelegateSubgroup=control"));
        assert!(content.contains("[Install]"));
        assert!(content.contains("WantedBy=multi-user.target"));
        assert!(!content.contains("Environment="));
        assert!(!content.contains("--local"));
    }

    #[test]
    fn test_generate_unit_file_with_env() {
        let env = vec![
            "VERCEL_AUTOMATION_BYPASS_SECRET=xxx".to_string(),
            "USE_MOCK_CLAUDE=true".to_string(),
            "MY_DESC=hello world".to_string(),
        ];
        let content = generate_unit_file(
            &service_unit("v0.1.0"),
            Path::new("/var/lib/vm0-runner/bin/v0.1.0/vm0-runner"),
            Path::new("/home/ubuntu/runner.yaml"),
            &env,
            false,
        );
        assert!(!content.contains("EnvironmentFile="));
        assert!(content.contains("Environment=\"VERCEL_AUTOMATION_BYPASS_SECRET=xxx\""));
        assert!(content.contains("Environment=\"USE_MOCK_CLAUDE=true\""));
        assert!(content.contains("Environment=\"MY_DESC=hello world\""));
        let first_env_pos = content
            .find("Environment=\"VERCEL_AUTOMATION_BYPASS_SECRET=xxx\"")
            .unwrap();
        let install_pos = content.find("[Install]").unwrap();
        assert!(first_env_pos < install_pos);
        assert!(content.contains("\n\n[Install]"));
    }

    #[test]
    fn test_generate_unit_file_special_chars() {
        let content = generate_unit_file(
            &service_unit("v0.1.0"),
            Path::new("/opt/my runner/vm0-runner"),
            Path::new("/opt/my config/runner.yaml"),
            &[],
            false,
        );
        assert!(content.contains(
            "ExecStart=:\"/opt/my runner/vm0-runner\" start --config \"/opt/my config/runner.yaml\""
        ));
        assert!(!content.contains("User="));
    }

    #[test]
    fn test_generate_unit_file_local_flag() {
        let content = generate_unit_file(
            &service_unit("v0.1.0"),
            Path::new("/usr/bin/runner"),
            Path::new("/etc/runner.yaml"),
            &[],
            true,
        );
        assert!(content.contains(
            "ExecStart=:\"/usr/bin/runner\" start --config \"/etc/runner.yaml\" --local\n"
        ));
    }

    #[test]
    fn test_escape_systemd_value() {
        // Empty input — degenerate but callable (helper is independent of
        // validate); guards against future implementation changes.
        assert_eq!(escape_systemd_value(""), "");

        // No special chars — identity.
        assert_eq!(escape_systemd_value("KEY=value"), "KEY=value");

        // Double quotes.
        assert_eq!(escape_systemd_value(r#"MSG=say "hi""#), r#"MSG=say \"hi\""#,);

        // Backslashes.
        assert_eq!(
            escape_systemd_value(r"PATH=C:\Users\test"),
            r"PATH=C:\\Users\\test",
        );

        // Mixed `\` and `"` — regressions here catch reversed-order bugs
        // (each character alone would still pass the tests above).
        assert_eq!(escape_systemd_value(r#"K=a\b"c"#), r#"K=a\\b\"c"#);

        // Trailing `\`: without escape, the generated line `"K=foo\"` would
        // swallow the closing quote and corrupt the unit file.
        assert_eq!(escape_systemd_value(r"K=foo\"), r"K=foo\\");

        // Single `%` — without escape, systemd would treat `%X` as a
        // specifier (e.g. `%H` → hostname). `%%` is the literal-`%` escape.
        assert_eq!(escape_systemd_value("MSG=50% done"), "MSG=50%% done");

        // `%` followed by a known specifier letter — concrete reproduction
        // of issue #9470: without escape, systemd silently rewrites this
        // to the host's actual hostname.
        assert_eq!(escape_systemd_value("MSG=host=%H"), "MSG=host=%%H");

        // Already-escaped `%%` in user input — must be doubled again to
        // `%%%%`, otherwise systemd unescapes it back to a single `%`
        // which then specifier-expands.
        assert_eq!(escape_systemd_value("K=100%%"), "K=100%%%%");

        // All three escape classes in one value — catches any single-char
        // regression that the targeted tests would miss.
        assert_eq!(escape_systemd_value(r#"K=a\b"c%d"#), r#"K=a\\b\"c%%d"#,);

        // Trailing `%`: arguably the most version-sensitive case. Older
        // systemd may preserve a trailing `%`, newer versions may warn or
        // error; escaping to `%%` is safe everywhere.
        assert_eq!(escape_systemd_value("KEY=trailing%"), "KEY=trailing%%");

        // Non-ASCII / UTF-8 input: characters outside the escape set must
        // pass through as their original UTF-8 bytes. Guards against any
        // future refactor that switches from `chars()` to byte-level
        // iteration and breaks multi-byte characters.
        assert_eq!(escape_systemd_value("MSG=任务完成 ✓"), "MSG=任务完成 ✓");
    }

    #[test]
    fn test_generate_unit_file_escapes_env_values() {
        let env = vec![
            r#"MSG=say "hi""#.to_string(),
            r"PATH=C:\Users".to_string(),
            // Both `"` and `\` in a single entry — catches regressions in
            // the helper-to-format! interaction that the helper-only test
            // would miss (e.g. accidental extra escaping at the call site).
            r#"K=a"\b"#.to_string(),
            // `%H` in user input must reach the runner process literally,
            // not be expanded to the host's hostname by systemd. See #9470.
            "MSG=job %H done".to_string(),
        ];
        let content = generate_unit_file(
            &service_unit("v0.1.0"),
            Path::new("/usr/bin/runner"),
            Path::new("/etc/runner.yaml"),
            &env,
            false,
        );
        assert!(content.contains(r#"Environment="MSG=say \"hi\"""#));
        assert!(content.contains(r#"Environment="PATH=C:\\Users""#));
        assert!(content.contains(r#"Environment="K=a\"\\b""#));
        assert!(content.contains(r#"Environment="MSG=job %%H done""#));
    }

    #[test]
    fn test_generate_unit_file_escapes_exec_paths() {
        // A `%` in the config or exe path would otherwise be subject to
        // systemd specifier expansion (e.g. `%H` → hostname), pointing
        // ExecStart at the wrong file. Same root cause as #9470.
        let content = generate_unit_file(
            &service_unit("v0.1.0"),
            Path::new("/opt/runner-v1%2.0/bin/runner"),
            Path::new("/etc/cache%20.yaml"),
            &[],
            false,
        );
        assert!(content.contains(
            r#"ExecStart=:"/opt/runner-v1%%2.0/bin/runner" start --config "/etc/cache%%20.yaml""#
        ));
    }

    #[test]
    fn generated_exec_start_preserves_literal_dollar_paths() {
        let config_path = Path::new("/srv/vm0-${TENANT}/runner.yaml");
        let content = generate_unit_file(
            &service_unit("v0.1.0"),
            Path::new("/opt/vm0-${BUILD}/vm0-runner"),
            config_path,
            &["LITERAL=${VALUE}".to_string()],
            false,
        );

        assert!(content.contains(
            r#"ExecStart=:"/opt/vm0-${BUILD}/vm0-runner" start --config "/srv/vm0-${TENANT}/runner.yaml""#
        ));
        assert!(content.contains(r#"Environment="LITERAL=${VALUE}""#));
        assert_eq!(
            crate::cmd::service::unit_config::parse_unit_config_path(&content),
            Some(config_path.to_path_buf())
        );
    }

    #[test]
    fn test_validate_env_vars_valid() {
        for entry in ["KEY=VALUE", "_KEY=VALUE", "API_KEY_1=VALUE", "K=", "K=V=W"] {
            assert!(
                validate_env_vars(&[entry.to_string()]).is_ok(),
                "expected valid environment assignment: {entry}"
            );
        }
        assert!(validate_env_vars(&[]).is_ok());
        // `"`, `\`, and `%` are valid at the validate layer — they get
        // escaped later in `escape_systemd_value`.
        assert!(validate_env_vars(&[r#"MSG=say "hi""#.to_string()]).is_ok());
        assert!(validate_env_vars(&[r"PATH=C:\Users".to_string()]).is_ok());
        assert!(validate_env_vars(&["MSG=50% done".to_string()]).is_ok());
        // Tab is intentionally NOT rejected: it is valid inside a systemd
        // quoted `Environment=` value. Locking this in so a future "let's
        // reject all whitespace control chars" change is an explicit choice.
        assert!(validate_env_vars(&["KEY=with\ttab".to_string()]).is_ok());
    }

    #[test]
    fn test_validate_env_vars_invalid() {
        const SECRET: &str = "sentinel-service-env-secret";

        let malformed = validate_env_vars(&[SECRET.to_string()])
            .unwrap_err()
            .to_string();
        assert!(malformed.contains("expected KEY=VALUE format"));
        assert!(!malformed.contains(SECRET));

        assert!(validate_env_vars(&["=VALUE".to_string()]).is_err());
        assert!(validate_env_vars(&["".to_string()]).is_err());
        for key in ["1INVALID", "API-KEY", "API KEY", "密钥"] {
            let entry = format!("{key}={SECRET}");
            let error = validate_env_vars(&[entry]).unwrap_err().to_string();
            assert!(
                error.contains(&format!("invalid --env key {key:?}")),
                "unexpected error for key {key:?}: {error}"
            );
            assert!(!error.contains(SECRET), "error exposed value: {error}");
        }
        // Bare newline / CR / NUL would silently corrupt the unit file.
        assert!(validate_env_vars(&["KEY=line1\nline2".to_string()]).is_err());
        assert!(validate_env_vars(&["KEY=foo\rbar".to_string()]).is_err());
        assert!(validate_env_vars(&["KEY=with\0nul".to_string()]).is_err());
    }

    #[test]
    fn validate_systemd_path_rejects_line_breaks() {
        assert!(validate_systemd_path("config path", Path::new("/tmp/runner config.yaml")).is_ok());
        assert!(
            validate_systemd_path("config path", Path::new("/tmp/runner\nconfig.yaml")).is_err()
        );
        assert!(
            validate_systemd_path("config path", Path::new("/tmp/runner\rconfig.yaml")).is_err()
        );
        assert!(
            validate_systemd_path("config path", Path::new("/tmp/runner\0config.yaml")).is_err()
        );
    }

    #[test]
    fn write_unit_file_creates_target() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vm0-runner-test.service");
        write_unit_file(&path, "[Unit]\nDescription=test\n").unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "[Unit]\nDescription=test\n"
        );
    }

    #[test]
    fn write_unit_file_overwrites_existing() {
        // Verifies the rename step replaces an existing file rather than
        // failing — POSIX rename(2) over an existing file is the atomic
        // swap we rely on for race-free updates.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vm0-runner-test.service");
        std::fs::write(&path, "old content").unwrap();
        write_unit_file(&path, "new content").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new content");
    }

    #[cfg(unix)]
    #[test]
    fn write_unit_file_uses_restrictive_permissions_for_new_unit() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vm0-runner-test.service");

        write_unit_file(&path, "content").unwrap();

        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn write_unit_file_tightens_existing_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vm0-runner-test.service");
        std::fs::write(&path, "old content").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

        write_unit_file(&path, "new content").unwrap();

        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new content");
    }

    #[test]
    fn write_unit_file_allows_concurrent_writers() {
        use std::sync::{Arc, Barrier};

        let dir = tempfile::tempdir().unwrap();
        let path = Arc::new(dir.path().join("vm0-runner-test.service"));
        let writer_count = 16;
        let barrier = Arc::new(Barrier::new(writer_count));
        let contents: Vec<String> = (0..writer_count)
            .map(|idx| format!("content-{idx}-{}", "x".repeat(4096)))
            .collect();

        let handles: Vec<_> = contents
            .iter()
            .cloned()
            .map(|content| {
                let path = Arc::clone(&path);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    write_unit_file(path.as_path(), &content)
                })
            })
            .collect();

        for handle in handles {
            handle.join().unwrap().unwrap();
        }

        let final_content = std::fs::read_to_string(path.as_path()).unwrap();
        assert!(contents.contains(&final_content));
        assert_no_unit_staging_files(dir.path(), "vm0-runner-test.service");
    }

    #[test]
    fn write_unit_file_does_not_leave_tmp_on_success() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vm0-runner-test.service");
        write_unit_file(&path, "content").unwrap();
        assert_no_unit_staging_files(dir.path(), "vm0-runner-test.service");
    }

    #[test]
    fn write_unit_file_cleans_up_staging_on_partial_write_failure() {
        const SECRET: &str = "sentinel-partial-unit-secret";

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vm0-runner-test.service");
        let original = b"[Unit]\nDescription=existing\n";
        std::fs::write(&path, original).unwrap();
        let secret_prefix = format!("[Service]\nEnvironment=\"TOKEN={SECRET}");
        let replacement = format!("{secret_prefix}\"\nExecStart=/bin/true\n");

        let result = write_unit_file_with(&path, &replacement, |file, content| {
            file.write_all(content.get(..secret_prefix.len()).unwrap())?;
            Err(std::io::Error::other("injected partial write failure"))
        });

        let error = result.unwrap_err().to_string();
        assert!(
            error.contains("injected partial write failure"),
            "unexpected error: {error}"
        );
        assert_eq!(std::fs::read(&path).unwrap(), original);
        assert_no_unit_staging_files(dir.path(), "vm0-runner-test.service");
        for entry in std::fs::read_dir(dir.path()).unwrap() {
            let entry = entry.unwrap();
            if !entry.file_type().unwrap().is_file() {
                continue;
            }
            let content = std::fs::read(entry.path()).unwrap();
            assert!(
                !content
                    .windows(SECRET.len())
                    .any(|window| window == SECRET.as_bytes()),
                "residual file {} contains the secret",
                entry.path().display()
            );
        }
    }

    #[test]
    fn cleanup_unit_staging_files_removes_only_owned_staging_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vm0-runner-test.service");
        let fixed_staging = path.with_extension("tmp");
        let current_staging = dir.path().join("vm0-runner-test.service.tmp@123.456.0");
        let retired_staging = dir
            .path()
            .join(".vm0-runner-test.service.tmp.00000000-0000-4000-8000-000000000000");
        let invalid_staging = dir.path().join("vm0-runner-test.service.tmp@manual");
        let other_unit_staging = dir.path().join("vm0-runner-other.service.tmp@123.456.0");
        let colliding_unit_staging = dir
            .path()
            .join("vm0-runner-test.service.tmp.other.service.tmp@123.456.0");
        let staging_dir = dir.path().join("vm0-runner-test.service.tmp@321.654.0");

        std::fs::write(&path, "current").unwrap();
        std::fs::write(&fixed_staging, "fixed staging").unwrap();
        std::fs::write(&current_staging, "current staging").unwrap();
        std::fs::write(&retired_staging, "retired staging").unwrap();
        std::fs::write(&invalid_staging, "manual").unwrap();
        std::fs::write(&other_unit_staging, "other").unwrap();
        std::fs::write(&colliding_unit_staging, "colliding").unwrap();
        std::fs::create_dir(&staging_dir).unwrap();

        cleanup_unit_staging_files(&path).unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "current");
        assert!(!fixed_staging.exists(), "fixed staging must be removed");
        assert!(
            !current_staging.exists(),
            "current-format staging must be removed"
        );
        assert!(
            retired_staging.exists(),
            "retired staging names must not be recognized"
        );
        assert!(
            invalid_staging.exists(),
            "invalid staging-like files must not be removed"
        );
        assert!(
            other_unit_staging.exists(),
            "other unit staging must not be removed"
        );
        assert!(
            colliding_unit_staging.exists(),
            "dot-prefixed unit names must not collide with this unit staging"
        );
        assert!(staging_dir.exists(), "directories must not be removed");
    }

    #[test]
    fn cleanup_unit_staging_files_preserves_fixed_staging_directory() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vm0-runner-test.service");
        let fixed_staging = path.with_extension("tmp");
        std::fs::create_dir(&fixed_staging).unwrap();

        cleanup_unit_staging_files(&path).unwrap();

        assert!(
            fixed_staging.is_dir(),
            "fixed staging directories must not be removed"
        );
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_unit_staging_files_unlinks_fixed_symlink_without_following_target() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vm0-runner-test.service");
        let fixed_staging = path.with_extension("tmp");
        let target = dir.path().join("symlink-target");
        std::fs::write(&target, "target content").unwrap();
        std::os::unix::fs::symlink(&target, &fixed_staging).unwrap();

        cleanup_unit_staging_files(&path).unwrap();

        assert!(
            std::fs::symlink_metadata(&fixed_staging).is_err(),
            "fixed staging symlinks must be unlinked"
        );
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "target content",
            "fixed staging symlink targets must not be removed"
        );
    }

    #[test]
    fn write_unit_file_cleans_up_staging_on_rename_failure() {
        // Rename fails when the target path is an existing directory
        // (EISDIR). Verifies the staged content — which may contain
        // Environment= secrets — is removed so it doesn't persist in
        // /etc/systemd/system/.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("target.service");
        std::fs::create_dir(&path).unwrap();
        let result = write_unit_file(&path, "secret=xyz");
        assert!(result.is_err(), "rename onto existing dir must fail");
        assert_no_unit_staging_files(dir.path(), "target.service");
    }

    #[test]
    fn remove_unit_file_if_exists_removes_regular_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("target.service");
        std::fs::write(&path, "unit").unwrap();

        remove_unit_file_if_exists(&path).unwrap();

        assert!(!path.exists());
    }

    #[test]
    fn remove_unit_file_if_exists_ignores_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("target.service");

        remove_unit_file_if_exists(&path).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn remove_unit_file_if_exists_removes_broken_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("target.service");
        std::os::unix::fs::symlink(dir.path().join("missing-target"), &path).unwrap();

        remove_unit_file_if_exists(&path).unwrap();

        assert!(
            std::fs::symlink_metadata(&path).is_err(),
            "broken unit symlink should be removed"
        );
    }

    fn assert_no_unit_staging_files(dir: &Path, unit_file_name: &str) {
        let staging_prefix = format!("{unit_file_name}{UNIT_STAGING_MARKER}");
        let staging_files: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(&staging_prefix))
            .collect();
        assert!(
            staging_files.is_empty(),
            "staging files must be cleaned up: {staging_files:?}"
        );
    }
});
