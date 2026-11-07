#![allow(clippy::expect_used, clippy::panic, clippy::unwrap_used)]

use cli_test_support::child::{
    ChildOutputReader as OutputReader, DirectChildWaitOutcome as ChildWaitOutcome,
    collect_child_output as collect_output, wait_child_with_timeout,
};
use std::io::{ErrorKind, Write};
use std::path::Path;
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_guest-write-file");
const USAGE: &str = concat!(
    "usage: guest-write-file [--append] [--] <path>\n",
    "       guest-write-file --create-parents [--] <path>\n",
    "       guest-write-file --private [--append] [--] <path>\n",
    "       guest-write-file --batch [--private]",
);
const HELPER_KILL_TIMEOUT: Duration = Duration::from_secs(1);

fn run_helper(args: &[&str], stdin: &[u8]) -> std::process::Output {
    run_helper_with_current_dir(args, stdin, None)
}

fn run_helper_in_dir(args: &[&str], stdin: &[u8], current_dir: &Path) -> std::process::Output {
    run_helper_with_current_dir(args, stdin, Some(current_dir))
}

fn helper_command(args: &[&str]) -> Command {
    let mut command = Command::new(BIN);
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

fn run_helper_with_current_dir(
    args: &[&str],
    stdin: &[u8],
    current_dir: Option<&Path>,
) -> std::process::Output {
    let mut command = helper_command(args);
    if let Some(current_dir) = current_dir {
        command.current_dir(current_dir);
    }

    run_helper_command(command, stdin)
}

#[cfg(unix)]
fn run_helper_with_umask(args: &[&str], stdin: &[u8], umask: libc::mode_t) -> std::process::Output {
    use std::os::unix::process::CommandExt;

    let mut command = helper_command(args);
    // SAFETY: `pre_exec` runs in the child process after fork and before exec.
    // It only changes that child's umask, leaving the test process unaffected.
    unsafe {
        command.pre_exec(move || {
            libc::umask(umask);
            Ok(())
        });
    }

    run_helper_command(command, stdin)
}

fn run_helper_command(mut command: Command, stdin: &[u8]) -> std::process::Output {
    let mut child = command.spawn().expect("spawn guest-write-file");
    child
        .stdin
        .take()
        .expect("stdin pipe")
        .write_all(stdin)
        .or_else(|e| {
            if e.kind() == ErrorKind::BrokenPipe {
                Ok(())
            } else {
                Err(e)
            }
        })
        .expect("write stdin");
    wait_with_timeout(child, Duration::from_secs(5))
}

fn wait_with_timeout(mut child: Child, timeout: Duration) -> Output {
    let stdout = child.stdout.take().expect("stdout pipe");
    let stderr = child.stderr.take().expect("stderr pipe");
    let stdout_reader = OutputReader::spawn(stdout);
    let stderr_reader = OutputReader::spawn(stderr);
    let output_deadline = Instant::now() + timeout + HELPER_KILL_TIMEOUT;

    match wait_child_with_timeout(child, timeout, HELPER_KILL_TIMEOUT) {
        ChildWaitOutcome::Exited(status) => {
            collect_output(status, stdout_reader, stderr_reader, output_deadline)
                .expect("collect guest-write-file output")
        }
        ChildWaitOutcome::TimedOut(status) => {
            let cleanup_error =
                collect_output(status, stdout_reader, stderr_reader, output_deadline).err();
            if let Some(error) = cleanup_error {
                panic!(
                    "guest-write-file did not exit within {timeout:?}; output cleanup failed: \
                     {error}"
                );
            }
            panic!("guest-write-file did not exit within {timeout:?}");
        }
        ChildWaitOutcome::ReapTimedOut => {
            panic!(
                "guest-write-file did not exit within {timeout:?} or within \
                 {HELPER_KILL_TIMEOUT:?} after SIGKILL"
            );
        }
        ChildWaitOutcome::KillFailed(error) => {
            panic!("guest-write-file did not exit within {timeout:?}; kill failed: {error}");
        }
        ChildWaitOutcome::ReapFailed(error) | ChildWaitOutcome::WaitFailed(error) => {
            panic!("wait for guest-write-file failed: {error}");
        }
    }
}

#[test]
fn create_mode_creates_missing_parents_and_writes_content() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("a/b/c/out.txt");
    let path_str = path.to_str().unwrap();

    let output = run_helper(&["--create-parents", path_str], b"hello");

    assert!(output.status.success(), "stderr={:?}", output.stderr);
    assert_eq!(std::fs::read(path).unwrap(), b"hello");
}

#[test]
fn append_mode_appends_existing_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("out.txt");
    std::fs::write(&path, b"first").unwrap();
    let path_str = path.to_str().unwrap();

    let output = run_helper(&["--append", path_str], b"second");

    assert!(output.status.success(), "stderr={:?}", output.stderr);
    assert_eq!(std::fs::read(path).unwrap(), b"firstsecond");
}

#[test]
fn create_mode_truncates_existing_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("out.txt");
    std::fs::write(&path, b"old longer content").unwrap();
    let path_str = path.to_str().unwrap();

    let output = run_helper(&[path_str], b"new");

    assert!(output.status.success(), "stderr={:?}", output.stderr);
    assert_eq!(std::fs::read(path).unwrap(), b"new");
}

#[test]
fn create_mode_writes_empty_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("empty.txt");
    let path_str = path.to_str().unwrap();

    let output = run_helper(&[path_str], b"");

    assert!(output.status.success(), "stderr={:?}", output.stderr);
    assert_eq!(std::fs::read(path).unwrap(), b"");
}

#[test]
fn batch_mode_creates_missing_parents_and_writes_files() {
    let dir = tempfile::tempdir().unwrap();
    let first = dir.path().join("a/b/one.txt");
    let second = dir.path().join("c/two.txt");
    let payload = guest_control_proto::encode_write_files(&[
        guest_control_proto::WriteFileBatchEntry {
            path: first.to_str().unwrap(),
            content: b"one",
        },
        guest_control_proto::WriteFileBatchEntry {
            path: second.to_str().unwrap(),
            content: b"two",
        },
    ])
    .unwrap();

    let output = run_helper(&["--batch"], &payload);

    assert!(output.status.success(), "stderr={:?}", output.stderr);
    assert_eq!(std::fs::read(first).unwrap(), b"one");
    assert_eq!(std::fs::read(second).unwrap(), b"two");
}

#[test]
fn batch_mode_truncates_existing_files() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("out.txt");
    std::fs::write(&path, b"old longer content").unwrap();
    let payload =
        guest_control_proto::encode_write_files(&[guest_control_proto::WriteFileBatchEntry {
            path: path.to_str().unwrap(),
            content: b"new",
        }])
        .unwrap();

    let output = run_helper(&["--batch"], &payload);

    assert!(output.status.success(), "stderr={:?}", output.stderr);
    assert_eq!(std::fs::read(path).unwrap(), b"new");
}

#[cfg(unix)]
#[test]
fn private_batch_mode_writes_private_files_with_restrictive_umask() {
    use std::os::unix::fs::MetadataExt;

    let dir = tempfile::tempdir().unwrap();
    let connector = dir
        .path()
        .join("run/connector-account-context/context.json");
    let first = dir.path().join("run/user-env/env.json");
    let second = dir.path().join("run/run-payload/payload.json");
    let payload = guest_control_proto::encode_write_files(&[
        guest_control_proto::WriteFileBatchEntry {
            path: connector.to_str().unwrap(),
            content: br#"{"schemaVersion":1,"targets":[]}"#,
        },
        guest_control_proto::WriteFileBatchEntry {
            path: first.to_str().unwrap(),
            content: b"env",
        },
        guest_control_proto::WriteFileBatchEntry {
            path: second.to_str().unwrap(),
            content: b"payload",
        },
    ])
    .unwrap();

    let output = run_helper_with_umask(&["--batch", "--private"], &payload, 0o777);

    assert!(output.status.success(), "stderr={:?}", output.stderr);
    assert_eq!(
        std::fs::read(&connector).unwrap(),
        br#"{"schemaVersion":1,"targets":[]}"#
    );
    assert_eq!(std::fs::read(&first).unwrap(), b"env");
    assert_eq!(std::fs::read(&second).unwrap(), b"payload");
    assert_eq!(mode(&dir.path().join("run")), 0o700);
    assert_eq!(
        mode(&dir.path().join("run/connector-account-context")),
        0o700
    );
    assert_eq!(mode(&dir.path().join("run/user-env")), 0o700);
    assert_eq!(mode(&dir.path().join("run/run-payload")), 0o700);
    assert_eq!(mode(&first), 0o600);
    assert_eq!(mode(&connector), 0o600);
    assert_eq!(mode(&second), 0o600);
    let owner = std::fs::metadata(dir.path()).unwrap();
    for path in [&connector, &first, &second] {
        for owned_path in [path.as_path(), path.parent().unwrap()] {
            let metadata = std::fs::metadata(owned_path).unwrap();
            assert_eq!(metadata.uid(), owner.uid());
            assert_eq!(metadata.gid(), owner.gid());
        }
    }
}

#[cfg(unix)]
#[test]
fn private_batch_mode_truncates_existing_file() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().unwrap();
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let path = dir.path().join("payload.json");
    std::fs::write(&path, b"old longer content").unwrap();
    let payload =
        guest_control_proto::encode_write_files(&[guest_control_proto::WriteFileBatchEntry {
            path: path.to_str().unwrap(),
            content: b"new",
        }])
        .unwrap();

    let output = run_helper(&["--batch", "--private"], &payload);

    assert!(output.status.success(), "stderr={:?}", output.stderr);
    assert_eq!(std::fs::read(&path).unwrap(), b"new");
    assert_eq!(mode(&path), 0o600);
}

#[cfg(unix)]
#[test]
fn private_batch_mode_reports_later_failure_after_partial_progress() {
    let dir = tempfile::tempdir().unwrap();
    let first = dir.path().join("run/user-env/env.json");
    let target = dir.path().join("target");
    let link = dir.path().join("link");
    std::fs::create_dir(&target).unwrap();
    std::os::unix::fs::symlink(&target, &link).unwrap();
    let second = link.join("payload.json");
    let third = dir.path().join("run/last.json");
    let payload = guest_control_proto::encode_write_files(&[
        guest_control_proto::WriteFileBatchEntry {
            path: first.to_str().unwrap(),
            content: b"env",
        },
        guest_control_proto::WriteFileBatchEntry {
            path: second.to_str().unwrap(),
            content: b"payload",
        },
        guest_control_proto::WriteFileBatchEntry {
            path: third.to_str().unwrap(),
            content: b"must not be written",
        },
    ])
    .unwrap();

    let output = run_helper(&["--batch", "--private"], &payload);

    assert!(!output.status.success());
    assert_eq!(std::fs::read(&first).unwrap(), b"env");
    assert_eq!(mode(&first), 0o600);
    assert!(!target.join("payload.json").exists());
    assert!(!third.exists());
}

#[cfg(unix)]
#[test]
fn private_batch_mode_first_failure_preserves_later_files() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target");
    let link = dir.path().join("connector-account-context");
    std::fs::create_dir(&target).unwrap();
    std::os::unix::fs::symlink(&target, &link).unwrap();
    let connector = link.join("context.json");
    let user_env = dir.path().join("env.json");
    let run_payload = dir.path().join("payload.json");
    std::fs::write(&user_env, b"previous env").unwrap();
    std::fs::write(&run_payload, b"previous payload").unwrap();
    let payload = guest_control_proto::encode_write_files(&[
        guest_control_proto::WriteFileBatchEntry {
            path: connector.to_str().unwrap(),
            content: b"context",
        },
        guest_control_proto::WriteFileBatchEntry {
            path: user_env.to_str().unwrap(),
            content: b"new env",
        },
        guest_control_proto::WriteFileBatchEntry {
            path: run_payload.to_str().unwrap(),
            content: b"new payload",
        },
    ])
    .unwrap();

    let output = run_helper(&["--batch", "--private"], &payload);

    assert!(!output.status.success());
    assert!(!target.join("context.json").exists());
    assert_eq!(std::fs::read(&user_env).unwrap(), b"previous env");
    assert_eq!(std::fs::read(&run_payload).unwrap(), b"previous payload");
}

#[test]
fn batch_mode_rejects_malformed_payload() {
    let output = run_helper(&["--batch"], &[0, 0]);

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("file count must be positive"),
        "stderr={stderr}"
    );
}

#[test]
fn batch_mode_rejects_single_file_flags() {
    let output = run_helper(&["--batch", "--create-parents"], b"");

    assert_eq!(output.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("cannot be used"), "stderr={stderr}");
    assert!(stderr.contains(USAGE));
}

#[test]
fn append_mode_creates_missing_file_when_parent_exists() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("out.txt");
    let path_str = path.to_str().unwrap();

    let output = run_helper(&["--append", path_str], b"hello");

    assert!(output.status.success(), "stderr={:?}", output.stderr);
    assert_eq!(std::fs::read(path).unwrap(), b"hello");
}

#[test]
fn append_mode_does_not_create_missing_parents() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("missing/out.txt");
    let path_str = path.to_str().unwrap();

    let output = run_helper(&["--append", path_str], b"hello");

    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("No such file"));
    assert!(!path.exists());
}

#[test]
fn append_mode_rejects_create_parents() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("missing/out.txt");
    let path_str = path.to_str().unwrap();

    let output = run_helper(&["--append", "--create-parents", path_str], b"hello");

    assert_eq!(output.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("cannot be used together"));
    assert!(stderr.contains(USAGE));
    assert!(!path.exists());
}

#[test]
fn private_mode_rejects_create_parents() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("missing/out.txt");
    let path_str = path.to_str().unwrap();

    let output = run_helper(&["--private", "--create-parents", path_str], b"hello");

    assert_eq!(output.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("cannot be used together"));
    assert!(stderr.contains(USAGE));
    assert!(!path.exists());
}

#[test]
fn path_starting_with_dash_is_treated_as_path_after_separator() {
    let dir = tempfile::tempdir().unwrap();

    let output = run_helper_in_dir(
        &["--create-parents", "--", "-literal.txt"],
        b"hello",
        dir.path(),
    );

    assert!(output.status.success(), "stderr={:?}", output.stderr);
    assert_eq!(
        std::fs::read(dir.path().join("-literal.txt")).unwrap(),
        b"hello"
    );
}

#[test]
fn create_mode_without_create_parents_does_not_create_missing_parents() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("missing/out.txt");
    let path_str = path.to_str().unwrap();

    let output = run_helper(&[path_str], b"hello");

    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("No such file"));
    assert!(!path.exists());
}

#[test]
fn create_parents_fails_when_parent_component_is_file() {
    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("not-a-dir");
    std::fs::write(&parent, b"file").unwrap();
    let path = parent.join("out.txt");
    let path_str = path.to_str().unwrap();

    let output = run_helper(&["--create-parents", path_str], b"hello");

    assert!(!output.status.success());
    assert!(parent.is_file());
    assert!(!path.exists());
}

#[test]
fn create_mode_rejects_directory_target() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("target");
    std::fs::create_dir(&path).unwrap();
    let path_str = path.to_str().unwrap();

    let output = run_helper(&[path_str], b"hello");

    assert!(!output.status.success());
    assert!(path.is_dir());
}

#[cfg(unix)]
#[test]
fn private_mode_creates_private_parent_dirs_and_writes_content() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("run/user-env/env.json");
    let path_str = path.to_str().unwrap();

    let output = run_helper(&["--private", path_str], b"hello");

    assert!(output.status.success(), "stderr={:?}", output.stderr);
    assert_eq!(std::fs::read(&path).unwrap(), b"hello");
    assert_eq!(mode(&dir.path().join("run")), 0o700);
    assert_eq!(mode(&dir.path().join("run/user-env")), 0o700);
    assert_eq!(mode(&path), 0o600);
}

#[cfg(unix)]
#[test]
fn private_mode_chmods_existing_parent_and_writes_content() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("run");
    std::fs::create_dir(&parent).unwrap();
    std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o777)).unwrap();
    let path = parent.join("env.json");
    let path_str = path.to_str().unwrap();

    let output = run_helper(&["--private", path_str], b"hello");

    assert!(output.status.success(), "stderr={:?}", output.stderr);
    assert_eq!(std::fs::read(&path).unwrap(), b"hello");
    assert_eq!(mode(&parent), 0o700);
    assert_eq!(mode(&path), 0o600);
}

#[cfg(unix)]
#[test]
fn private_mode_forces_parent_modes_with_restrictive_umask() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("run/logs/system.log");
    let path_str = path.to_str().unwrap();

    let output = run_helper_with_umask(&["--private", path_str], b"hello", 0o777);

    assert!(output.status.success(), "stderr={:?}", output.stderr);
    assert_eq!(std::fs::read(&path).unwrap(), b"hello");
    assert_eq!(mode(&dir.path().join("run")), 0o700);
    assert_eq!(mode(&dir.path().join("run/logs")), 0o700);
    assert_eq!(mode(&path), 0o600);
}

#[cfg(unix)]
#[test]
fn private_append_mode_appends_with_private_mode() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("run/logs/system.log");
    let path_str = path.to_str().unwrap();

    let first = run_helper(&["--private", path_str], b"first");
    assert!(first.status.success(), "stderr={:?}", first.stderr);
    let second = run_helper(&["--private", "--append", path_str], b"second");

    assert!(second.status.success(), "stderr={:?}", second.stderr);
    assert_eq!(std::fs::read(&path).unwrap(), b"firstsecond");
    assert_eq!(mode(&path), 0o600);
}

#[cfg(unix)]
#[test]
fn private_append_mode_creates_missing_private_parent_dirs() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("run/logs/system.log");
    let path_str = path.to_str().unwrap();

    let output = run_helper(&["--private", "--append", path_str], b"hello");

    assert!(output.status.success(), "stderr={:?}", output.stderr);
    assert_eq!(std::fs::read(&path).unwrap(), b"hello");
    assert_eq!(mode(&dir.path().join("run")), 0o700);
    assert_eq!(mode(&dir.path().join("run/logs")), 0o700);
    assert_eq!(mode(&path), 0o600);
}

#[cfg(unix)]
#[test]
fn private_mode_rejects_symlink_parent_without_touching_target() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target");
    let link = dir.path().join("link");
    std::fs::create_dir(&target).unwrap();
    std::os::unix::fs::symlink(&target, &link).unwrap();
    let path = link.join("env.json");
    let path_str = path.to_str().unwrap();

    let output = run_helper(&["--private", path_str], b"hello");

    assert!(!output.status.success());
    assert!(!target.join("env.json").exists());
}

#[cfg(unix)]
#[test]
fn private_mode_rejects_directory_target() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().unwrap();
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let path = dir.path().join("target");
    std::fs::create_dir(&path).unwrap();
    let path_str = path.to_str().unwrap();

    let output = run_helper(&["--private", path_str], b"hello");

    assert!(!output.status.success());
    assert!(path.is_dir());
}

#[cfg(unix)]
#[test]
fn private_mode_rejects_trailing_separator_without_creating_target() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("run/session-id");
    let path_with_trailing_separator = format!("{}/", path.display());

    let output = run_helper(&["--private", &path_with_trailing_separator], b"hello");

    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("directory separator"));
    assert!(!dir.path().join("run").exists());
    assert!(!path.exists());
}

#[cfg(unix)]
#[test]
fn private_mode_rejects_trailing_current_dir_without_creating_target() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("run/session-id");
    let path_with_trailing_current_dir = path.join(".");
    let path_str = path_with_trailing_current_dir.to_str().unwrap();

    let output = run_helper(&["--private", path_str], b"hello");

    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("no file name"));
    assert!(!dir.path().join("run").exists());
    assert!(!path.exists());
}

#[cfg(unix)]
#[test]
fn private_mode_rejects_fifo_with_reader() {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

    let dir = tempfile::tempdir().unwrap();
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let path = dir.path().join("fifo");
    mkfifo(&path);
    let _reader = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(&path)
        .unwrap();
    let path_str = path.to_str().unwrap();

    let output = run_helper(&["--private", path_str], b"");

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("not a regular"), "stderr={stderr}");
}

#[cfg(unix)]
#[test]
fn create_mode_rejects_character_device_target() {
    let output = run_helper(&["/dev/null"], b"hello");

    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("not a regular file"));
}

#[cfg(unix)]
#[test]
fn create_mode_rejects_symlink_target_without_truncating_target() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target.txt");
    let link = dir.path().join("link.txt");
    std::fs::write(&target, b"keep").unwrap();
    std::os::unix::fs::symlink(&target, &link).unwrap();

    let output = run_helper(&[link.to_str().unwrap()], b"replace");

    assert!(!output.status.success());
    assert_eq!(std::fs::read(&target).unwrap(), b"keep");
    assert!(link.symlink_metadata().unwrap().file_type().is_symlink());
}

#[cfg(unix)]
#[test]
fn append_mode_rejects_symlink_target_without_appending_target() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target.txt");
    let link = dir.path().join("link.txt");
    std::fs::write(&target, b"keep").unwrap();
    std::os::unix::fs::symlink(&target, &link).unwrap();

    let output = run_helper(&["--append", link.to_str().unwrap()], b"append");

    assert!(!output.status.success());
    assert_eq!(std::fs::read(&target).unwrap(), b"keep");
    assert!(link.symlink_metadata().unwrap().file_type().is_symlink());
}

#[cfg(unix)]
#[test]
fn create_mode_fails_fast_for_fifo_without_reader() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("fifo");
    mkfifo(&path);
    let path_str = path.to_str().unwrap();

    let output = run_helper(&[path_str], b"hello");

    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("guest-write-file"));
}

#[cfg(unix)]
#[test]
fn create_mode_rejects_fifo_with_reader() {
    use std::os::unix::fs::OpenOptionsExt;

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("fifo");
    mkfifo(&path);
    let _reader = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(&path)
        .unwrap();
    let path_str = path.to_str().unwrap();

    let output = run_helper(&[path_str], b"");

    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("not a regular file"));
}

#[cfg(unix)]
fn mkfifo(path: &std::path::Path) {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let c_path = CString::new(path.as_os_str().as_bytes()).unwrap();
    let result = unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) };
    assert_eq!(
        result,
        0,
        "mkfifo failed: {}",
        std::io::Error::last_os_error()
    );
}

#[cfg(unix)]
fn mode(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;

    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}
