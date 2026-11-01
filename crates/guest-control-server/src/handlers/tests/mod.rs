use super::*;
#[cfg(target_os = "linux")]
use std::io::{BufRead, BufReader};
#[cfg(target_os = "linux")]
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(target_os = "linux")]
use crate::test_support::{kill_pidfd_and_wait, open_pidfd, wait_for_pidfd_exit};
use crate::threading::test_support::FailingThreadSpawner;
use std::sync::Mutex;

static WRITE_FILE_CHILD_TESTS: Mutex<()> = Mutex::new(());

fn spawn_write_file_test_child(script: &str) -> Child {
    // Use a stable shell binary instead of a freshly written temp
    // executable; some CI filesystems can transiently reject immediate exec
    // of a just-created file with ETXTBSY.
    let mut command = Command::new("sh");
    command
        .arg("-c")
        .arg(script)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    spawn_in_own_process_group(&mut command).unwrap()
}

fn pid_alive(pid: u32) -> bool {
    // SAFETY: kill(pid, 0) is the standard process-existence check.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[cfg(unix)]
#[test]
fn write_file_child_starts_as_process_group_leader() {
    let _guard = WRITE_FILE_CHILD_TESTS.lock().unwrap();
    let child = spawn_write_file_test_child("sleep 60");
    let pid = child.id();

    let pgid = unsafe { libc::getpgid(pid as libc::pid_t) };
    kill_and_reap_child(child);

    assert_eq!(pgid, pid as libc::pid_t);
}

#[test]
fn write_file_stderr_drain_spawn_failure_kills_and_reaps_child() {
    let _guard = WRITE_FILE_CHILD_TESTS.lock().unwrap();
    let child = spawn_write_file_test_child("sleep 60");
    let pid = child.id();
    let connection_cancel = AtomicBool::new(false);

    let (success, error) = wait_write_file_child(
        child,
        b"",
        &connection_cancel,
        &crate::file_write_progress::FileWriteProgress::default().start(1),
        FailingThreadSpawner::fail_once(THREAD_WRITE_STDERR),
    );

    assert!(!success);
    assert!(error.contains("stderr drain thread"));
    assert!(!pid_alive(pid), "child pid {pid} should have been reaped");
}

#[test]
fn write_file_command_args_use_private_mode_without_create_parents() {
    let args = write_file_command_args(false, false, true).unwrap();

    assert_eq!(args, vec!["--private"]);
}

#[test]
fn write_file_command_args_use_private_append_mode() {
    let args = write_file_command_args(false, true, true).unwrap();

    assert_eq!(args, vec!["--private", "--append"]);
}

#[test]
fn write_file_command_args_reject_private_sudo() {
    let error = write_file_command_args(true, false, true).unwrap_err();

    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
}

#[test]
fn write_file_timeout_kills_child_while_stdin_writer_is_blocked() {
    let _guard = WRITE_FILE_CHILD_TESTS.lock().unwrap();
    let child = spawn_write_file_test_child("sleep 60; cat >/dev/null");
    let pid = child.id();
    let content = vec![b'x'; 1024 * 1024];
    let connection_cancel = AtomicBool::new(false);

    let (success, error) = wait_write_file_child_with_timeout(
        child,
        &content,
        10,
        &connection_cancel,
        &crate::file_write_progress::FileWriteProgress::default().start(1),
        SystemThreadSpawner,
    );

    assert!(!success);
    assert_eq!(error, "write timed out");
    assert!(!pid_alive(pid), "child pid {pid} should have been reaped");
}

#[cfg(target_os = "linux")]
#[test]
fn write_file_kills_lingering_process_group_after_parent_exit() {
    let _guard = WRITE_FILE_CHILD_TESTS.lock().unwrap();
    let fifo_path = std::env::temp_dir().join(format!(
        "guest-control-write-file-stdin-{}-{}.fifo",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let mut command = Command::new("sh");
    command
        .arg("-c")
        .arg(
            "mkfifo \"$FIFO\"; \
                 exec 3<&0; \
                 sleep 60 <&3 >/dev/null 2>/dev/null & \
                 printf '%s\\n' \"$!\"; \
                 exec 3<&-; \
                 read _ < \"$FIFO\"; \
                 rm -f \"$FIFO\"; \
                 exit 0",
        )
        .env("FIFO", &fifo_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = spawn_in_own_process_group(&mut command).unwrap();
    let pid = child.id();
    let stdout = child.stdout.take().unwrap();
    let mut descendant_pid = String::new();
    BufReader::new(stdout)
        .read_line(&mut descendant_pid)
        .unwrap();
    let descendant_pid = descendant_pid.trim().parse::<libc::pid_t>().unwrap();
    let descendant_pidfd = open_pidfd(descendant_pid).unwrap();
    let mut fifo = std::fs::OpenOptions::new()
        .write(true)
        .open(&fifo_path)
        .unwrap();
    writeln!(fifo, "exit").unwrap();
    drop(fifo);
    let content = vec![b'x'; 1024 * 1024];
    let connection_cancel = AtomicBool::new(false);

    let (success, error) = wait_write_file_child_with_timeout(
        child,
        &content,
        1_000,
        &connection_cancel,
        &crate::file_write_progress::FileWriteProgress::default().start(1),
        SystemThreadSpawner,
    );
    let _ = std::fs::remove_file(&fifo_path);

    assert!(!success);
    assert!(error.contains("Failed to write to stdin"), "got: {error}");
    assert!(!pid_alive(pid), "child pid {pid} should have been reaped");
    match wait_for_pidfd_exit(&descendant_pidfd, Duration::from_secs(2)) {
        Ok(true) => {}
        Ok(false) => {
            kill_pidfd_and_wait(&descendant_pidfd).unwrap_or_else(|cleanup| {
                panic!("failed to clean up lingering descendant pid {descendant_pid}: {cleanup}")
            });
            panic!("lingering descendant pid {descendant_pid} should be terminated");
        }
        Err(error) => {
            let cleanup = kill_pidfd_and_wait(&descendant_pidfd);
            panic!(
                "failed to wait for lingering descendant pid {descendant_pid}: {error}; cleanup={cleanup:?}"
            );
        }
    }
}
