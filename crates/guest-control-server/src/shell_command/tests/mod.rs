use super::*;
use std::path::PathBuf;
use std::sync::{Arc, Barrier};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

struct TempDirGuard(PathBuf);

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn temp_dir(label: &str) -> (PathBuf, TempDirGuard) {
    let dir = std::env::temp_dir().join(format!(
        "guest-control-server-{label}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    let guard = TempDirGuard(dir.clone());
    (dir, guard)
}

#[test]
fn env_script_content_attempts_self_removal_before_exports() {
    let dir = Path::new("/run/vm0-exec/vm0-env-test");
    let path = dir.join("run.sh");
    let script =
        build_env_script_content(dir, &path, "echo \"$FOO\"", &[("FOO", "it's a \"test\"")])
            .unwrap();

    let rm_pos = script.find("rm -f -- \"$script_path\"").unwrap();
    let export_pos = script.find("export FOO=").unwrap();
    assert!(rm_pos < export_pos);
    assert!(script.contains("script_dir='/run/vm0-exec/vm0-env-test'"));
    assert!(script.contains("script_path='/run/vm0-exec/vm0-env-test/run.sh'"));
    assert!(script.contains("rm -f -- \"$script_path\" 2>/dev/null || true"));
    assert!(script.contains("rmdir -- \"$script_dir\" 2>/dev/null || true"));
    assert!(script.contains("export FOO='it'\\''s a \"test\"'"));
    assert!(script.contains("exec /bin/bash -c 'echo \"$FOO\"'"));
}

#[test]
fn env_script_content_rejects_invalid_env_key() {
    let dir = Path::new("/run/vm0-exec/vm0-env-test");
    let path = dir.join("run.sh");
    let err = build_env_script_content(dir, &path, "echo hi", &[("BAD;touch /tmp/pwned", "x")])
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert!(
        err.to_string()
            .contains("invalid environment variable name")
    );
}

#[test]
fn env_script_content_rejects_non_shell_identifier_env_keys() {
    let dir = Path::new("/run/vm0-exec/vm0-env-test");
    let path = dir.join("run.sh");

    for key in ["", "1BAD", "BAD-NAME"] {
        let err = build_env_script_content(dir, &path, "echo hi", &[(key, "x")]).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert!(
            err.to_string()
                .contains("invalid environment variable name"),
            "got: {err}"
        );
    }
}

#[test]
fn env_script_content_rejects_nul_command() {
    let dir = Path::new("/run/vm0-exec/vm0-env-test");
    let path = dir.join("run.sh");
    let err =
        build_env_script_content(dir, &path, "echo before\0after", &[("FOO", "x")]).unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert!(err.to_string().contains("command contains NUL bytes"));
}

#[test]
fn env_script_content_rejects_nul_env_value() {
    let dir = Path::new("/run/vm0-exec/vm0-env-test");
    let path = dir.join("run.sh");
    let err = build_env_script_content(dir, &path, "echo hi", &[("SECRET", "before\0after")])
        .unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert!(
        err.to_string()
            .contains("environment variable value contains NUL bytes: SECRET")
    );
    assert!(!err.to_string().contains("before"));
    assert!(!err.to_string().contains("after"));
}

#[test]
fn create_env_script_cleans_dir_on_script_build_failure() {
    let (dir, _guard) = temp_dir("build-failure-cleanup");
    let err = match create_env_script_in_dir(&dir, "echo hi", &[("BAD;KEY", "x")], true) {
        Ok(_) => panic!("invalid env key unexpectedly created an env script"),
        Err(err) => err,
    };

    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    let entries = std::fs::read_dir(&dir)
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(
        entries.is_empty(),
        "env script entries leaked after build failure: {entries:?}"
    );
}

#[test]
fn env_script_invocation_keeps_secret_out_of_argv() {
    let (dir, _guard) = temp_dir("argv");
    let secret = "secret-value-that-must-not-be-in-argv";
    let script = create_env_script_in_dir(&dir, "echo \"$FOO\"", &[("FOO", secret)], true).unwrap();
    let invocation = script_invocation(script.path().unwrap()).unwrap();
    let command = build_shell_command_program(&invocation, true).unwrap();
    let argv = std::iter::once(command.program.to_string_lossy().to_string())
        .chain(
            command
                .args
                .iter()
                .map(|arg| arg.to_string_lossy().into_owned()),
        )
        .collect::<Vec<_>>()
        .join("\0");

    assert!(!argv.contains(secret));
    assert!(argv.contains("exec /bin/bash"));
    assert!(argv.contains(script.path().unwrap().to_str().unwrap()));
}

#[test]
fn env_script_directory_uses_lowercase_hex_suffix() {
    let (dir, _guard) = temp_dir("suffix");
    let script =
        create_env_script_in_dir(&dir, "echo \"$FOO\"", &[("FOO", "secret")], true).unwrap();
    let script_dir = script.path().unwrap().parent().unwrap();
    let name = script_dir.file_name().unwrap().to_str().unwrap();
    let suffix = name
        .strip_prefix(ENV_SCRIPT_PREFIX)
        .expect("env script directory name should start with prefix");

    assert_eq!(suffix.len(), ENV_SCRIPT_RANDOM_BYTES * 2);
    assert!(
        suffix
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    );
}

#[test]
fn env_script_guard_drop_removes_file_and_directory() {
    let (dir, _guard) = temp_dir("drop-cleanup");
    let script =
        create_env_script_in_dir(&dir, "echo \"$FOO\"", &[("FOO", "secret")], true).unwrap();
    let path = script.path().unwrap().to_path_buf();
    let script_dir = path.parent().unwrap().to_path_buf();

    assert!(path.is_file());
    assert!(script_dir.is_dir());

    drop(script);

    assert!(!path.exists());
    assert!(!script_dir.exists());
}

#[test]
fn env_script_self_removes_when_command_can_write_directory() {
    let (dir, _guard) = temp_dir("self-remove");
    let output = dir.join("output");
    let output_arg = shell_escape_value(output.to_str().unwrap());
    let script = create_env_script_in_dir(
        &dir,
        &format!("printf \"$FOO\" > {output_arg}"),
        &[("FOO", "done")],
        true,
    )
    .unwrap();
    let path = script.path().unwrap().to_path_buf();
    let script_dir = path.parent().unwrap().to_path_buf();
    let invocation = script_invocation(&path).unwrap();

    let status = std::process::Command::new("sh")
        .arg("-c")
        .arg(invocation)
        .status()
        .unwrap();

    assert!(status.success());
    assert_eq!(std::fs::read_to_string(output).unwrap(), "done");
    assert!(!path.exists());
    assert!(!script_dir.exists());
}

#[test]
fn env_diagnostics_do_not_include_values() {
    let diagnostics = format_env_diagnostics(
        "echo hi",
        &[
            ("SMALL", "ok"),
            ("BIG", "secret-value-that-must-not-appear"),
        ],
    );

    assert!(diagnostics.contains("command_bytes=7"));
    assert!(diagnostics.contains("env_count=2"));
    assert!(diagnostics.contains("BIG:33"));
    assert!(!diagnostics.contains("secret-value"));
    assert!(!diagnostics.contains("ok"));
}

#[test]
fn env_diagnostics_reports_largest_five_in_stable_order() {
    let diagnostics = format_env_diagnostics(
        "cmd",
        &[
            ("Z", "1"),
            ("B", "22"),
            ("A", "22"),
            ("C", "333"),
            ("D", "4444"),
            ("E", "55555"),
            ("F", "666666"),
        ],
    );

    assert!(diagnostics.contains("env_count=7"));
    assert!(diagnostics.contains("largest_env=[F:6,E:5,D:4,C:3,A:2]"));
}

#[test]
fn env_script_guard_cleanup_is_idempotent() {
    let (dir, _guard) = temp_dir("cleanup");
    let script_dir = dir.join("vm0-env-cleanup");
    std::fs::create_dir(&script_dir).unwrap();
    let path = script_dir.join("run.sh");
    std::fs::write(&path, "secret").unwrap();
    let mut guard = EnvScriptGuard::new(path.clone(), script_dir.clone());

    guard.cleanup();
    guard.cleanup();

    assert!(!path.exists());
    assert!(!script_dir.exists());
}

#[test]
fn env_script_dir_creation_tolerates_concurrent_first_use() {
    let (base, _guard) = temp_dir("dir-race");
    let dir = base.join("vm0-exec");
    let thread_count = 8;
    let barrier = Arc::new(Barrier::new(thread_count));
    let handles = (0..thread_count)
        .map(|_| {
            let dir = dir.clone();
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                ensure_env_script_dir(&dir)
            })
        })
        .collect::<Vec<_>>();

    for handle in handles {
        handle.join().unwrap().unwrap();
    }
    assert!(dir.is_dir());
}

#[test]
fn env_script_dir_rejects_existing_file() {
    let (base, _guard) = temp_dir("dir-file");
    let path = base.join("vm0-exec");
    std::fs::write(&path, "not a directory").unwrap();

    let err = ensure_env_script_dir(&path).unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
    assert!(path.is_file());
}

#[test]
fn env_script_dir_rejects_group_or_world_writable_directory() {
    let (base, _guard) = temp_dir("dir-mode");
    let dir = base.join("vm0-exec");
    std::fs::create_dir(&dir).unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o777)).unwrap();

    let err = ensure_env_script_dir(&dir).unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
}

#[test]
fn stale_env_script_cleanup_only_removes_matching_entries() {
    let (dir, _guard) = temp_dir("stale");
    let stale = dir.join(format!("{ENV_SCRIPT_PREFIX}stale{ENV_SCRIPT_SUFFIX}"));
    let other = dir.join("other.sh");
    std::fs::write(&stale, "secret").unwrap();
    std::fs::write(&other, "not ours").unwrap();

    let removed = cleanup_stale_env_scripts_in(&dir, SystemTime::now(), Duration::ZERO).unwrap();

    assert_eq!(removed, 1);
    assert!(!stale.exists());
    assert!(other.exists());
}

#[test]
fn stale_env_script_cleanup_preserves_recent_directories() {
    let (dir, _guard) = temp_dir("recent-dir");
    let active = dir.join(format!("{ENV_SCRIPT_PREFIX}active"));
    std::fs::create_dir(&active).unwrap();
    std::fs::write(active.join("run.sh"), "secret").unwrap();

    let removed =
        cleanup_stale_env_scripts_in(&dir, SystemTime::now(), Duration::from_secs(60 * 60))
            .unwrap();

    assert_eq!(removed, 0);
    assert!(active.exists());
}

#[test]
fn stale_env_script_cleanup_removes_matching_directories() {
    let (dir, _guard) = temp_dir("stale-dir");
    let stale = dir.join(format!("{ENV_SCRIPT_PREFIX}stale-dir"));
    let nested = stale.join("run.sh");
    std::fs::create_dir(&stale).unwrap();
    std::fs::write(&nested, "secret").unwrap();

    let removed = cleanup_stale_env_scripts_in(&dir, SystemTime::now(), Duration::ZERO).unwrap();

    assert_eq!(removed, 1);
    assert!(!stale.exists());
}

#[cfg(unix)]
#[test]
fn stale_env_script_cleanup_removes_symlink_without_following_it() {
    let (dir, _guard) = temp_dir("stale-symlink");
    let target = dir.join("target");
    let link = dir.join(format!("{ENV_SCRIPT_PREFIX}link{ENV_SCRIPT_SUFFIX}"));
    std::fs::write(&target, "keep").unwrap();
    std::os::unix::fs::symlink(&target, &link).unwrap();

    let removed = cleanup_stale_env_scripts_in(&dir, SystemTime::now(), Duration::ZERO).unwrap();

    assert_eq!(removed, 1);
    assert!(std::fs::symlink_metadata(&link).is_err());
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "keep");
}

#[test]
fn truncate_command_preview_short_string() {
    let s = "echo hello";
    assert_eq!(truncate_command_preview(s), "echo hello");
}

#[test]
fn truncate_command_preview_exact_limit() {
    let s = "x".repeat(COMMAND_PREVIEW_MAX_LEN);
    assert_eq!(truncate_command_preview(&s), s);
}

#[test]
fn truncate_command_preview_over_limit() {
    let s = "y".repeat(COMMAND_PREVIEW_MAX_LEN + 50);
    let result = truncate_command_preview(&s);
    // Single-byte ASCII: truncates to exactly COMMAND_PREVIEW_MAX_LEN + "..."
    assert_eq!(
        result,
        format!("{}{}", "y".repeat(COMMAND_PREVIEW_MAX_LEN), "...")
    );
}

#[test]
fn truncate_command_preview_multibyte_utf8() {
    // Each '🔥' is 4 bytes. Fill to just over the limit.
    let emoji = "🔥".repeat(COMMAND_PREVIEW_MAX_LEN / 4 + 5);
    let result = truncate_command_preview(&emoji);
    assert!(result.ends_with("..."));
    // Must not panic from slicing in the middle of a UTF-8 sequence
    assert!(result.is_char_boundary(result.len() - 3));

    let boundary = format!("{}🔥tail", "a".repeat(COMMAND_PREVIEW_MAX_LEN - 4));
    assert_eq!(
        truncate_command_preview(&boundary),
        format!("{}🔥...", "a".repeat(COMMAND_PREVIEW_MAX_LEN - 4))
    );

    let crossing = format!("{}🔥tail", "a".repeat(COMMAND_PREVIEW_MAX_LEN - 1));
    assert_eq!(
        truncate_command_preview(&crossing),
        format!("{}...", "a".repeat(COMMAND_PREVIEW_MAX_LEN - 1))
    );
}

fn assert_command(command: Command, expected_program: &str, expected_args: &[&str]) {
    assert_eq!(command.program, std::ffi::OsStr::new(expected_program));
    assert_eq!(
        command
            .args
            .iter()
            .map(|arg| arg.as_os_str())
            .collect::<Vec<_>>(),
        expected_args
            .iter()
            .map(std::ffi::OsStr::new)
            .collect::<Vec<_>>()
    );
}

#[test]
fn build_shell_command_for_local_user() {
    assert_command(
        build_shell_command_for_user("echo hello", false, None),
        "sh",
        &["-c", "echo hello"],
    );
}

#[test]
fn build_privileged_shell_command_for_local_user() {
    assert_command(
        build_shell_command_for_user("reboot", true, None),
        "sudo",
        &["sh", "-c", "reboot"],
    );
}

#[test]
fn build_shell_command_for_sandbox_user() {
    let command =
        build_shell_command_for_user("echo hello", false, Some(Path::new("/home/sandbox")));
    assert_eq!(
        command.directory.as_deref(),
        Some(Path::new("/home/sandbox"))
    );
    assert_command(command, "/bin/sh", &["-c", ". /etc/profile\necho hello"]);
}

#[test]
fn build_privileged_shell_command_for_sandbox_user() {
    assert_command(
        build_shell_command_for_user("reboot", true, Some(Path::new("/home/sandbox"))),
        "sh",
        &["-c", "reboot"],
    );
}
