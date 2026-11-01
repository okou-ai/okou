//! Builds and spawns guest shell commands while preserving the command-launch
//! security contract.
//!
//! Commands without environment variables are executed directly through the
//! configured shell wrapper. Commands with environment variables use a
//! transient env script: the outer command only references the script path, and
//! the script exports the environment before `exec`ing the requested command.
//! This keeps environment values out of the outer argv and start-failure
//! diagnostics. Command text is still caller-provided command text and is not
//! treated as secret material by this module.
//!
//! The wrapper depends on build mode and `sudo`. Production non-`sudo` commands
//! run through a non-login `/bin/sh` as the sandbox user after explicitly
//! loading the root-owned system profile, production `sudo` commands run as
//! root, and debug/test-support builds run as the current user unless `sudo`
//! requests the local `sudo sh -c` wrapper. The production wrapper must stay
//! non-login: sandbox-owned profile files may persist across sandbox reuse and must
//! never run before the trusted command bootstrap.
//!
//! The env-script path is one security boundary. Env keys must be shell
//! identifiers, command/env values reject NUL bytes, the parent directory must
//! have trusted ownership and must not be group/world-writable, and each launch
//! uses a random per-run directory with a newly-created script opened with
//! `O_NOFOLLOW`. In production non-`sudo` execution, the per-run directory and
//! script stay root-owned while the sandbox group only receives the read/traverse
//! access needed for bash to open the script. That prevents an existing
//! same-UID sandbox process from replacing the script after its path appears in
//! argv but before bash opens it.
//!
//! Cleanup is intentionally layered and mode-dependent. Before exporting env
//! values, the generated script makes best-effort attempts to remove its own
//! file and directory. Those attempts succeed when the command identity can
//! write the per-run directory, including same-user and privileged execution.
//! In production non-`sudo` execution, the root-owned directory deliberately
//! denies that access to the sandbox user, so the root-side `EnvScriptGuard`
//! owns normal cleanup and the restricted script remains until operation
//! teardown. `PreparedShellCommand` and `SpawnedCommand` carry that guard
//! through the prepare-to-spawn handoff and for the spawned operation. Callers
//! must retain it while the shell wrapper may still need to open the script;
//! dropping it too early can remove the script before bash reads it.
//!
//! Guard cleanup and later-launch stale cleanup are best effort. If guest
//! termination bypasses destructors, a script can remain until a later launch
//! removes it after the stale threshold.
//!
//! `SpawnedCommand` also returns exec process-containment ownership
//! only after a successful spawn. Setup failures clean that containment before
//! returning the original spawn error.

use crate::contained_command::{
    CommandStdio, ContainedChild as Child, ContainedCommand as Command, ContainedCommandExt,
};
use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};

use shell_quote::quote_shell_arg;

use crate::process_containment::{ExecProcessContainment, ProcessContainmentCleanupMode};

/// Maximum length for command preview in logs
const COMMAND_PREVIEW_MAX_LEN: usize = 100;
const ENV_SCRIPT_PREFIX: &str = "vm0-env-";
const ENV_SCRIPT_RANDOM_BYTES: usize = 16;
const ENV_SCRIPT_SUFFIX: &str = ".sh";
const ENV_SCRIPT_STALE_AFTER: Duration = Duration::from_secs(60 * 60);
const CHOWN_UNCHANGED_UID: libc::uid_t = !0;

fn shell_command_user_home() -> io::Result<Option<PathBuf>> {
    #[cfg(any(debug_assertions, feature = "test-support"))]
    {
        Ok(None)
    }

    #[cfg(not(any(debug_assertions, feature = "test-support")))]
    {
        // Default user for command execution (UID 1000)
        crate::user::sandbox_user_home().map(Some)
    }
}

/// Shell-escape a value by wrapping in single quotes and escaping embedded `'`.
fn shell_escape_value(val: &str) -> String {
    quote_shell_arg(val)
}

/// Build a Command to execute a shell command as the appropriate user.
///
/// When `sudo` is true the command runs as root.
///
/// In production-style builds, non-sudo commands run through a non-login
/// `/bin/sh` selected explicitly rather than the sandbox user's login shell.
/// The command sources only `/etc/profile` so rootfs-provided runtime
/// environment such as `RUSTUP_HOME` remains available without executing
/// persisted sandbox-owned profile files before the trusted command bootstrap.
/// In debug/test-support builds, local tests run as the current user unless
/// `sudo` explicitly requests elevation through `sudo sh -c`.
fn build_shell_command_program(command: &str, sudo: bool) -> io::Result<Command> {
    let user_home = shell_command_user_home()?;
    Ok(build_shell_command_for_user(
        command,
        sudo,
        user_home.as_deref(),
    ))
}

fn build_shell_command_for_user(command: &str, sudo: bool, user_home: Option<&Path>) -> Command {
    match user_home {
        Some(home) => {
            if sudo {
                // Release: already root — run directly
                let mut c = Command::new("sh");
                c.arg("-c").arg(command);
                c
            } else {
                let command = format!(". /etc/profile\n{command}");
                let mut c = Command::new("/bin/sh");
                c.arg("-c").arg(command);
                c.current_dir(home);
                c
            }
        }
        None => {
            if sudo {
                // Debug: not root — elevate with sudo
                let mut c = Command::new("sudo");
                c.arg("sh").arg("-c").arg(command);
                c
            } else {
                let mut c = Command::new("sh");
                c.arg("-c").arg(command);
                c
            }
        }
    }
}

pub(crate) struct EnvScriptGuard {
    path: Option<PathBuf>,
    dir: Option<PathBuf>,
}

impl EnvScriptGuard {
    fn new(path: PathBuf, dir: PathBuf) -> Self {
        Self {
            path: Some(path),
            dir: Some(dir),
        }
    }

    pub(crate) fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    fn cleanup(&mut self) {
        if let Some(path) = self.path.take() {
            let _ = fs::remove_file(path);
        }
        if let Some(dir) = self.dir.take() {
            let _ = fs::remove_dir(dir);
        }
    }
}

impl Drop for EnvScriptGuard {
    fn drop(&mut self) {
        self.cleanup();
    }
}

pub(crate) struct PreparedShellCommand {
    pub(crate) command: Command,
    pub(crate) env_script: Option<EnvScriptGuard>,
}

pub(crate) struct SpawnedCommand {
    pub(crate) child: Child,
    pub(crate) env_script: Option<EnvScriptGuard>,
    pub(crate) process_containment: ExecProcessContainment,
}

impl SpawnedCommand {
    /// Transfer successful setup ownership, or retire containment before returning its error.
    pub(crate) fn from_spawn_result(
        spawn_result: io::Result<(Child, Option<EnvScriptGuard>)>,
        process_containment: ExecProcessContainment,
    ) -> io::Result<Self> {
        match spawn_result {
            Ok((child, env_script)) => Ok(Self {
                child,
                env_script,
                process_containment,
            }),
            Err(error) => {
                let _ = process_containment.cleanup(ProcessContainmentCleanupMode::Forced);
                Err(error)
            }
        }
    }
}

fn effective_uid() -> libc::uid_t {
    // SAFETY: `geteuid` is a simple libc getter with no preconditions.
    unsafe { libc::geteuid() }
}

fn default_env_script_dir() -> PathBuf {
    if effective_uid() == 0 {
        PathBuf::from("/run/vm0-exec")
    } else if Path::new("/dev/shm").is_dir() {
        PathBuf::from("/dev/shm/vm0-exec")
    } else {
        std::env::temp_dir().join("vm0-exec")
    }
}

fn format_env_key_for_log(key: &str) -> String {
    truncate_command_preview(&key.escape_debug().to_string())
}

fn compare_env_diagnostic_entries(
    left: &(&str, usize),
    right: &(&str, usize),
) -> std::cmp::Ordering {
    right.1.cmp(&left.1).then_with(|| left.0.cmp(right.0))
}

pub(crate) fn format_env_diagnostics(command: &str, env: &[(&str, &str)]) -> String {
    let mut env_bytes = 0;
    let mut largest: Vec<(&str, usize)> = Vec::with_capacity(env.len().min(5));
    for (key, value) in env {
        env_bytes += key.len() + value.len();
        let entry = (*key, value.len());
        match largest
            .iter()
            .position(|existing| compare_env_diagnostic_entries(&entry, existing).is_lt())
        {
            Some(index) => largest.insert(index, entry),
            None if largest.len() < 5 => largest.push(entry),
            None => {}
        }
        if largest.len() > 5 {
            largest.pop();
        }
    }
    let largest = largest
        .into_iter()
        .map(|(key, len)| format!("{}:{len}", format_env_key_for_log(key)))
        .collect::<Vec<_>>()
        .join(",");

    format!(
        "command_bytes={}, env_count={}, env_bytes={}, largest_env=[{}]",
        command.len(),
        env.len(),
        env_bytes,
        largest,
    )
}

fn validate_env_keys(env: &[(&str, &str)]) -> io::Result<()> {
    for (key, _) in env {
        if !guest_contracts::env::is_shell_identifier_env_key(key) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "invalid environment variable name: {}",
                    format_env_key_for_log(key)
                ),
            ));
        }
    }
    Ok(())
}

fn validate_env_values(env: &[(&str, &str)]) -> io::Result<()> {
    for (key, value) in env {
        if value.as_bytes().contains(&0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "environment variable value contains NUL bytes: {}",
                    format_env_key_for_log(key)
                ),
            ));
        }
    }
    Ok(())
}

pub(crate) fn validate_exec_environment(env: &[(&str, &str)]) -> io::Result<()> {
    validate_env_keys(env)?;
    validate_env_values(env)
}

fn build_env_script_content(
    script_dir: &Path,
    script_path: &Path,
    command: &str,
    env: &[(&str, &str)],
) -> io::Result<String> {
    if command.as_bytes().contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "command contains NUL bytes",
        ));
    }
    validate_exec_environment(env)?;
    let script_dir = script_dir.to_str().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "env script directory path must be valid UTF-8",
        )
    })?;
    let script_path = script_path.to_str().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "env script path must be valid UTF-8",
        )
    })?;

    let mut script = String::new();
    script.push_str("#!/bin/bash\n");
    script.push_str("set +e\n");
    script.push_str("script_dir=");
    script.push_str(&shell_escape_value(script_dir));
    script.push('\n');
    script.push_str("script_path=");
    script.push_str(&shell_escape_value(script_path));
    script.push('\n');
    script.push_str("rm -f -- \"$script_path\" 2>/dev/null || true\n");
    script.push_str("rmdir -- \"$script_dir\" 2>/dev/null || true\n");
    for (key, value) in env {
        script.push_str("export ");
        script.push_str(key);
        script.push('=');
        script.push_str(&shell_escape_value(value));
        script.push('\n');
    }
    script.push_str("exec /bin/bash -c ");
    script.push_str(&shell_escape_value(command));
    script.push('\n');
    Ok(script)
}

fn random_env_script_suffix() -> io::Result<String> {
    let mut raw = [0_u8; ENV_SCRIPT_RANDOM_BYTES];
    File::open("/dev/urandom")?.read_exact(&mut raw)?;
    let mut out = String::with_capacity(ENV_SCRIPT_RANDOM_BYTES * 2);
    for byte in raw {
        for nibble in [byte >> 4, byte & 0x0f] {
            let digit = if nibble < 10 {
                b'0' + nibble
            } else {
                b'a' + (nibble - 10)
            };
            out.push(char::from(digit));
        }
    }
    Ok(out)
}

fn validate_env_script_dir(dir: &Path, euid: libc::uid_t) -> io::Result<()> {
    let metadata = fs::symlink_metadata(dir)?;
    if !metadata.file_type().is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("env script path is not a directory: {}", dir.display()),
        ));
    }
    let expected_owner = if euid == 0 { 0 } else { euid };
    if metadata.uid() != expected_owner {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "env script directory has unexpected owner: {}",
                dir.display()
            ),
        ));
    }
    if metadata.permissions().mode() & 0o022 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "env script directory is writable by group/other: {}",
                dir.display()
            ),
        ));
    }
    Ok(())
}

fn ensure_env_script_dir(dir: &Path) -> io::Result<()> {
    let euid = effective_uid();
    let mode = if euid == 0 { 0o711 } else { 0o700 };
    match validate_env_script_dir(dir, euid) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            match DirBuilder::new().mode(mode).create(dir) {
                Ok(()) => {}
                Err(create_err) if create_err.kind() == io::ErrorKind::AlreadyExists => {
                    validate_env_script_dir(dir, euid)?;
                }
                Err(create_err) => return Err(create_err),
            }
        }
        Err(e) => return Err(e),
    }

    fs::set_permissions(dir, fs::Permissions::from_mode(mode))?;
    Ok(())
}

fn fchown_group(fd: RawFd, gid: libc::gid_t) -> io::Result<()> {
    // SAFETY: `fd` comes from an open file/directory descriptor and `-1`
    // as uid asks fchown to leave the owner unchanged.
    let ret = unsafe { libc::fchown(fd, CHOWN_UNCHANGED_UID, gid) };
    if ret != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn cleanup_stale_env_scripts_in(
    dir: &Path,
    now: SystemTime,
    stale_after: Duration,
) -> io::Result<usize> {
    let mut removed = 0;
    let Ok(entries) = fs::read_dir(dir) else {
        return Ok(0);
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with(ENV_SCRIPT_PREFIX) {
            continue;
        }
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.file_type().is_dir() && !name.ends_with(ENV_SCRIPT_SUFFIX) {
            continue;
        }
        if !metadata.file_type().is_file()
            && !metadata.file_type().is_symlink()
            && !metadata.file_type().is_dir()
        {
            continue;
        }
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        if now
            .duration_since(modified)
            .is_ok_and(|age| age >= stale_after)
        {
            let removed_entry = if metadata.file_type().is_dir() {
                fs::remove_dir_all(&path).is_ok()
            } else {
                fs::remove_file(&path).is_ok()
            };
            if removed_entry {
                removed += 1;
            }
        }
    }
    Ok(removed)
}

fn create_env_script_in_dir(
    dir: &Path,
    command: &str,
    env: &[(&str, &str)],
    sudo: bool,
) -> io::Result<EnvScriptGuard> {
    ensure_env_script_dir(dir)?;
    let _ = cleanup_stale_env_scripts_in(dir, SystemTime::now(), ENV_SCRIPT_STALE_AFTER);

    for _ in 0..16 {
        let script_dir = dir.join(format!(
            "{}{}",
            ENV_SCRIPT_PREFIX,
            random_env_script_suffix()?
        ));
        match DirBuilder::new().mode(0o700).create(&script_dir) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }

        let path = script_dir.join(format!("run{ENV_SCRIPT_SUFFIX}"));
        let guard = EnvScriptGuard::new(path.clone(), script_dir.clone());
        fs::set_permissions(&script_dir, fs::Permissions::from_mode(0o700))?;

        let script = build_env_script_content(&script_dir, &path, command, env)?;

        let mut options = OpenOptions::new();
        options
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
        let mut file = match options.open(&path) {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        };

        let result = (|| -> io::Result<()> {
            file.write_all(script.as_bytes())?;
            if effective_uid() == 0 && !sudo && shell_command_user_home()?.is_some() {
                // Keep the per-run directory and script root-owned. The
                // sandbox user only gets group read/traverse access; if it
                // owned either path, an existing same-UID process could
                // chmod/replace run.sh after the path appears in argv but
                // before bash opens it.
                let sandbox_gid = crate::user::sandbox_user_gid()?;
                let script_dir_file = File::open(&script_dir)?;
                fchown_group(file.as_raw_fd(), sandbox_gid)?;
                file.set_permissions(fs::Permissions::from_mode(0o440))?;
                fchown_group(script_dir_file.as_raw_fd(), sandbox_gid)?;
                fs::set_permissions(&script_dir, fs::Permissions::from_mode(0o710))?;
            } else {
                file.set_permissions(fs::Permissions::from_mode(0o400))?;
            }
            Ok(())
        })();

        result?;
        drop(file);
        return Ok(guard);
    }

    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "failed to allocate a unique env script path",
    ))
}

fn create_env_script(
    command: &str,
    env: &[(&str, &str)],
    sudo: bool,
) -> io::Result<EnvScriptGuard> {
    create_env_script_in_dir(&default_env_script_dir(), command, env, sudo)
}

fn script_invocation(path: &Path) -> io::Result<String> {
    let path = path.to_str().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "env script path must be valid UTF-8",
        )
    })?;
    Ok(format!("exec /bin/bash {}", shell_escape_value(path)))
}

pub(crate) fn build_shell_command_with_env(
    command: &str,
    env: &[(&str, &str)],
    sudo: bool,
) -> io::Result<PreparedShellCommand> {
    if env.is_empty() {
        return Ok(PreparedShellCommand {
            command: build_shell_command_program(command, sudo)?,
            env_script: None,
        });
    }

    let env_script = create_env_script(command, env, sudo)?;
    let script_path = env_script
        .path()
        .ok_or_else(|| io::Error::other("env script path missing"))?;
    let invocation = script_invocation(script_path)?;
    Ok(PreparedShellCommand {
        command: build_shell_command_program(&invocation, sudo)?,
        env_script: Some(env_script),
    })
}

/// Truncate a command string for logging, preserving UTF-8 boundaries
pub(crate) fn truncate_command_preview(s: &str) -> String {
    if s.len() <= COMMAND_PREVIEW_MAX_LEN {
        return s.to_string();
    }
    // Find a safe UTF-8 boundary at or before the max length.
    let mut end = COMMAND_PREVIEW_MAX_LEN;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...", &s[..end])
}

/// Spawn a shell command with stdout/stderr piped for buffered and streaming
/// spawned processes.
pub(crate) fn spawn_shell_command_with_pipes(
    command: &str,
    env: &[(&str, &str)],
    sudo: bool,
    pipe_stdin: bool,
    process_containment: ExecProcessContainment,
) -> io::Result<SpawnedCommand> {
    let spawn_result = (|| -> io::Result<(Child, Option<EnvScriptGuard>)> {
        let PreparedShellCommand {
            mut command,
            env_script,
        } = build_shell_command_with_env(command, env, sudo)?;
        command
            .stdout(CommandStdio::Piped)
            .stderr(CommandStdio::Piped);
        if pipe_stdin {
            command.stdin(CommandStdio::Piped);
        }
        let child = command.spawn(sudo, &process_containment)?;
        Ok((child, env_script))
    })();

    SpawnedCommand::from_spawn_result(spawn_result, process_containment)
}

#[cfg(test)]
mod tests;
