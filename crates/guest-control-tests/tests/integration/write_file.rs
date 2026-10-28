use crate::support::{
    Harness, blocking_write_path, blocking_write_pid_path, captured_output_bytes, exec_exit_code,
    finish_raw_guest_connection, join_raw_guest_connection, pid_alive, read_raw_message,
    release_blocking_write, run_exec, start_raw_guest_connection, wait_for_blocking_write,
};
use guest_control_client::{SupervisedExecControl, SupervisedExecRequest, WriteFileEntry};
use guest_control_proto::{
    ExecOutputPolicy, ExecTermination, ExecTimeoutPolicy, MSG_ERROR, MSG_PING, MSG_PONG,
    MSG_SHUTDOWN, MSG_SHUTDOWN_ACK, MSG_WRITE_FILE, MSG_WRITE_FILE_RESULT, MSG_WRITE_FILES,
    WriteFileBatchEntry,
};
use std::fs;
use std::io::{Read, Write};
use std::time::Duration;

#[tokio::test]
async fn long_path_blocked_write_keeps_ping_responsive_and_rejects_overlap() {
    let dir = tempfile::tempdir().expect("create blocked-write temp dir");
    let long_dir = dir.path().join("x".repeat(96));
    fs::create_dir(&long_dir).expect("create long blocked-write directory");
    let blocked_path = blocking_write_path(&long_dir, "blocked");
    let blocked_path_string = blocked_path.to_string_lossy();
    let blocked_content = b"blocked content";
    let overlap_path = dir.path().join("overlap.txt");
    let overlap_path_string = overlap_path.to_string_lossy();
    let (guest, mut stream) = start_raw_guest_connection();

    let payload =
        guest_control_proto::encode_write_file(&blocked_path_string, blocked_content, false, false)
            .expect("encode blocked write");
    stream
        .write_all(
            &guest_control_proto::encode(MSG_WRITE_FILE, 10, &payload)
                .expect("frame blocked write"),
        )
        .expect("send blocked write");
    wait_for_blocking_write(&blocked_path, Duration::from_secs(5))
        .await
        .expect("blocked write helper should start");

    stream
        .write_all(&guest_control_proto::encode(MSG_PING, 11, &[]).expect("encode ping"))
        .expect("send ping");
    let pong = read_raw_message(&mut stream);
    assert_eq!(pong.msg_type, MSG_PONG);
    assert_eq!(pong.seq, 11);

    let overlap_payload = guest_control_proto::encode_write_files(&[WriteFileBatchEntry {
        path: overlap_path_string.as_ref(),
        content: b"rejected",
    }])
    .expect("encode overlapping batch write");
    stream
        .write_all(
            &guest_control_proto::encode(MSG_WRITE_FILES, 12, &overlap_payload)
                .expect("frame overlapping batch write"),
        )
        .expect("send overlapping batch write");
    let busy = read_raw_message(&mut stream);
    assert_eq!(busy.msg_type, MSG_ERROR);
    assert_eq!(busy.seq, 12);
    assert_eq!(
        guest_control_proto::decode_error(&busy.payload).expect("decode busy error"),
        "guest file write already active"
    );
    assert!(!overlap_path.exists());

    release_blocking_write(&blocked_path);
    let first_result = read_raw_message(&mut stream);
    assert_eq!(first_result.msg_type, MSG_WRITE_FILE_RESULT);
    assert_eq!(first_result.seq, 10);
    assert_eq!(
        guest_control_proto::decode_write_file_result(&first_result.payload)
            .expect("decode first write result"),
        (true, "")
    );
    assert_eq!(
        fs::read(&blocked_path).expect("read blocked target"),
        blocked_content
    );

    let later_payload =
        guest_control_proto::encode_write_file(&overlap_path_string, b"accepted", false, false)
            .expect("encode later write");
    stream
        .write_all(
            &guest_control_proto::encode(MSG_WRITE_FILE, 13, &later_payload)
                .expect("frame later write"),
        )
        .expect("send later write");
    let later_result = read_raw_message(&mut stream);
    assert_eq!(later_result.msg_type, MSG_WRITE_FILE_RESULT);
    assert_eq!(later_result.seq, 13);
    assert_eq!(
        guest_control_proto::decode_write_file_result(&later_result.payload)
            .expect("decode later write result"),
        (true, "")
    );
    assert_eq!(
        fs::read(&overlap_path).expect("read later target"),
        b"accepted"
    );

    finish_raw_guest_connection(guest, stream);
}

#[tokio::test]
async fn blocked_write_reports_helper_setup_failure() {
    let h = Harness::new().await;
    let blocked_path = blocking_write_path(&h.dir, "setup-failure");
    let blocked_path_string = blocked_path.to_string_lossy().to_string();
    fs::create_dir(blocking_write_pid_path(&blocked_path))
        .expect("create conflicting PID marker directory");

    let write = h.host().write_file(&blocked_path_string, b"content", false);
    let readiness = wait_for_blocking_write(&blocked_path, Duration::from_secs(2));
    let (write_result, readiness_result) = tokio::join!(write, readiness);

    let readiness_error = readiness_result.expect_err("helper setup should fail");
    assert!(
        readiness_error.to_string().contains("write PID marker"),
        "unexpected readiness error: {readiness_error}"
    );
    let write_error = write_result.expect_err("blocked write should report helper failure");
    assert!(
        write_error
            .to_string()
            .contains("failed to prepare blocking write helper: write PID marker"),
        "unexpected write error: {write_error}"
    );

    h.finish();
}

#[tokio::test]
async fn blocked_write_allows_exec_cancel_and_quiesce() {
    let h = Harness::new().await;
    let handle = h
        .host()
        .start_supervised_exec(SupervisedExecRequest {
            timeout_is_expected: false,
            role: guest_control_proto::ExecProcessRole::Workload,
            timeout: ExecTimeoutPolicy::None,
            command: "exec sleep 60",
            env: &[],
            sudo: false,
            label: "blocked-write-control",
            stdout: ExecOutputPolicy::Discard,
            stderr: ExecOutputPolicy::Discard,
            expected_exit_codes: &[],
            stdin_bytes: None,
            control: SupervisedExecControl::Disabled,
            stream_queue_capacity: None,
            start_timeout: Duration::from_secs(5),
        })
        .await
        .expect("start supervised exec");
    let blocked_path = blocking_write_path(&h.dir, "control-blocked");
    let blocked_path_string = blocked_path.to_string_lossy().to_string();

    let write = h
        .host()
        .write_file(&blocked_path_string, b"control content", false);
    let control = async {
        wait_for_blocking_write(&blocked_path, Duration::from_secs(5))
            .await
            .expect("blocked write helper should start");
        tokio::time::timeout(
            Duration::from_secs(2),
            h.host().quiesce_operations(Duration::from_secs(1)),
        )
        .await
        .expect("quiesce should respond while write helper is blocked")
        .expect_err("quiesce should report the active write as pending");
        let cancel_result = tokio::time::timeout(
            Duration::from_secs(3),
            handle.cancel_and_wait(Duration::from_secs(2)),
        )
        .await
        .expect("exec cancel should not wait for blocked write")
        .expect("cancel supervised exec");
        release_blocking_write(&blocked_path);
        cancel_result
    };

    let (write_result, cancel_result) = tokio::join!(write, control);
    write_result.expect("blocked write should finish after release");
    assert_eq!(cancel_result.termination, ExecTermination::Cancelled);

    h.host()
        .quiesce_operations(Duration::from_secs(2))
        .await
        .expect("quiesce should succeed after write completion");
    h.host()
        .resume_operations(Duration::from_secs(2))
        .await
        .expect("resume operations");
    h.finish();
}

#[tokio::test]
async fn shutdown_cancels_blocked_write_helper_before_connection_exit() {
    let dir = tempfile::tempdir().expect("create shutdown temp dir");
    let blocked_path = blocking_write_path(dir.path(), "shutdown-blocked");
    let blocked_path_string = blocked_path.to_string_lossy();
    let (guest, mut stream) = start_raw_guest_connection();
    let payload =
        guest_control_proto::encode_write_file(&blocked_path_string, b"shutdown", false, false)
            .expect("encode shutdown blocked write");
    stream
        .write_all(
            &guest_control_proto::encode(MSG_WRITE_FILE, 20, &payload)
                .expect("frame shutdown blocked write"),
        )
        .expect("send shutdown blocked write");
    wait_for_blocking_write(&blocked_path, Duration::from_secs(5))
        .await
        .expect("blocked write helper should start");
    let pid: u32 = fs::read_to_string(blocking_write_pid_path(&blocked_path))
        .expect("read shutdown helper pid")
        .parse()
        .expect("parse shutdown helper pid");

    stream
        .write_all(&guest_control_proto::encode(MSG_SHUTDOWN, 21, &[]).expect("encode shutdown"))
        .expect("send shutdown");
    let ack = read_raw_message(&mut stream);
    assert_eq!(ack.msg_type, MSG_SHUTDOWN_ACK);
    assert_eq!(ack.seq, 21);

    tokio::time::timeout(Duration::from_secs(5), async {
        while pid_alive(pid) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("shutdown helper should be reaped before host disconnect");
    assert!(
        !guest.is_finished(),
        "guest connection should remain active until host disconnect"
    );

    stream.set_nonblocking(true).unwrap();
    let mut trailing = [0u8; 1];
    let trailing_read = stream.read(&mut trailing);
    assert!(
        matches!(&trailing_read, Err(error) if error.kind() == std::io::ErrorKind::WouldBlock),
        "no write result or connection close may follow shutdown acknowledgement: {trailing_read:?}"
    );

    drop(stream);
    join_raw_guest_connection(guest);
    assert!(
        !pid_alive(pid),
        "shutdown helper pid {pid} should be reaped"
    );
}

#[tokio::test]
async fn disconnect_cancels_blocked_write_helper_before_connection_exit() {
    let dir = tempfile::tempdir().expect("create disconnect temp dir");
    let blocked_path = blocking_write_path(dir.path(), "disconnect-blocked");
    let blocked_path_string = blocked_path.to_string_lossy();
    let (guest, mut stream) = start_raw_guest_connection();
    let payload =
        guest_control_proto::encode_write_file(&blocked_path_string, b"disconnect", false, false)
            .expect("encode disconnect blocked write");
    stream
        .write_all(
            &guest_control_proto::encode(MSG_WRITE_FILE, 30, &payload)
                .expect("frame disconnect blocked write"),
        )
        .expect("send disconnect blocked write");
    wait_for_blocking_write(&blocked_path, Duration::from_secs(5))
        .await
        .expect("blocked write helper should start");
    let pid: u32 = fs::read_to_string(blocking_write_pid_path(&blocked_path))
        .expect("read disconnect helper pid")
        .parse()
        .expect("parse disconnect helper pid");

    drop(stream);
    join_raw_guest_connection(guest);
    assert!(
        !pid_alive(pid),
        "disconnect helper pid {pid} should be reaped"
    );
}
// ── write_file ───────────────────────────────────────────────────────

#[tokio::test]
async fn test_write_file() {
    let h = Harness::new().await;

    let file_path = h.dir.join("testfile.txt");
    let file_path_str = file_path.to_string_lossy().to_string();
    let content = b"hello from guest-control-tests";

    h.host()
        .write_file(&file_path_str, content, false)
        .await
        .expect("write_file failed");

    // Verify by reading the file back via exec
    let result = run_exec(
        h.host(),
        &format!("cat '{file_path_str}'"),
        5000,
        &[],
        false,
    )
    .await
    .expect("exec cat failed");

    assert_eq!(exec_exit_code(&result), Some(0));
    assert_eq!(captured_output_bytes(&result.stdout), content);
    h.finish();
}

#[tokio::test]
async fn test_write_files() {
    let h = Harness::new().await;

    let first_path = h.dir.join("batch-first.txt");
    let second_path = h.dir.join("batch/nested/second.bin");
    let first_path_str = first_path.to_string_lossy().to_string();
    let second_path_str = second_path.to_string_lossy().to_string();
    let first_content = b"first batch file";
    let second_content = b"second\0batch\nfile";

    h.host()
        .write_files(&[
            WriteFileEntry {
                path: &first_path_str,
                content: first_content,
            },
            WriteFileEntry {
                path: &second_path_str,
                content: second_content,
            },
        ])
        .await
        .expect("write_files failed");

    assert_eq!(
        std::fs::read(&first_path).expect("failed to read first batch file"),
        first_content
    );
    assert_eq!(
        std::fs::read(&second_path).expect("failed to read second batch file"),
        second_content
    );
    h.finish();
}

#[tokio::test]
async fn test_write_file_special_characters() {
    let h = Harness::new().await;

    let file_path = h.dir.join("special.txt");
    let file_path_str = file_path.to_string_lossy().to_string();
    let content = b"Line1\nLine2\tTabbed\n\"Quoted\"";

    h.host()
        .write_file(&file_path_str, content, false)
        .await
        .expect("write_file failed");

    let written = std::fs::read(&file_path).expect("failed to read written file");
    assert_eq!(written, content);
    h.finish();
}

#[tokio::test]
async fn test_write_file_path_with_shell_metacharacters() {
    let h = Harness::new().await;

    let file_path = h.dir.join("dash - quote ' dollar $ semi ;.txt");
    let file_path_str = file_path.to_string_lossy().to_string();
    let content = b"path should be passed as an argv value";

    h.host()
        .write_file(&file_path_str, content, false)
        .await
        .expect("write_file failed");

    let written = std::fs::read(&file_path).expect("failed to read written file");
    assert_eq!(written, content);
    h.finish();
}

#[tokio::test]
async fn test_write_file_creates_parent_dirs() {
    let h = Harness::new().await;

    let file_path = h.dir.join("a/b/c/nested.txt");
    let file_path_str = file_path.to_string_lossy().to_string();
    let content = b"nested content";

    h.host()
        .write_file(&file_path_str, content, false)
        .await
        .expect("write_file failed");

    let written = std::fs::read(&file_path).expect("failed to read written file");
    assert_eq!(written, content);
    h.finish();
}

#[tokio::test]
async fn test_write_file_sudo_create_does_not_create_parent_dirs() {
    let h = Harness::new().await;

    let file_path = h.dir.join("sudo/missing/parent.txt");
    let file_path_str = file_path.to_string_lossy().to_string();

    h.host()
        .write_file(&file_path_str, b"content", true)
        .await
        .expect_err("sudo write_file should fail when parent is missing");

    assert!(!file_path.exists());
    h.finish();
}

#[tokio::test]
async fn test_write_file_unwritable_path_fails() {
    let h = Harness::new().await;

    let path = format!("/proc/vm0-write-file-denied-{}", std::process::id());
    h.host()
        .write_file(&path, b"content", false)
        .await
        .expect_err("write_file should fail under /proc");

    h.finish();
}
// ── write_file (large) ──────────────────────────────────────────────

#[tokio::test]
async fn test_write_file_large() {
    let h = Harness::new().await;

    let file_path = h.dir.join("large.txt");
    let file_path_str = file_path.to_string_lossy().to_string();
    // 100KB content
    let content = vec![b'x'; 100_000];

    h.host()
        .write_file(&file_path_str, &content, false)
        .await
        .expect("write_file failed");

    let written = std::fs::read(&file_path).expect("failed to read written file");
    assert_eq!(written.len(), 100_000);
    assert_eq!(written, content);
    h.finish();
}

// ── write_file (chunked — exceeds single-message limit) ────────────

#[tokio::test]
async fn test_write_file_chunked() {
    let h = Harness::new().await;

    let file_name = format!("{}'x", "a".repeat(253));
    assert_eq!(file_name.len(), 255);
    let file_path = h.dir.join(file_name);
    let file_path_str = file_path.to_string_lossy().to_string();
    // 16 MB content exceeds the 15 MB chunk limit, triggering the staging +
    // shell rename path. The maximum-length file name covers NAME_MAX, and
    // its quote covers shell escaping of the unchanged rename target.
    let content = vec![0xABu8; 16 * 1024 * 1024];

    h.host()
        .write_file(&file_path_str, &content, false)
        .await
        .expect("chunked write_file failed");

    let written = std::fs::read(&file_path).expect("failed to read written file");
    assert_eq!(written.len(), content.len());
    assert_eq!(written, content);

    // Temp file should not remain
    let temp_remains = std::fs::read_dir(file_path.parent().unwrap())
        .expect("failed to read temp dir")
        .flatten()
        .any(|entry| entry.file_name().to_string_lossy().starts_with(".vm0tmp-"));
    assert!(!temp_remains, "temp file was not cleaned up");

    let result = run_exec(h.host(), "printf reusable", 5000, &[], false)
        .await
        .expect("connection should accept exec after chunked write");
    assert_eq!(exec_exit_code(&result), Some(0));
    assert_eq!(captured_output_bytes(&result.stdout), b"reusable");
    h.finish();
}

#[tokio::test]
async fn test_write_file_chunked_directory_target_fails() {
    let h = Harness::new().await;

    let target_dir = h.dir.join("chunked-target-dir");
    fs::create_dir(&target_dir).expect("create target directory");
    let target_dir_str = target_dir.to_string_lossy().to_string();
    let content = vec![0xCD; 16 * 1024 * 1024];

    h.host()
        .write_file(&target_dir_str, &content, false)
        .await
        .expect_err("chunked write_file should fail when target is a directory");

    assert!(target_dir.is_dir());
    let nested_entries = fs::read_dir(&target_dir)
        .expect("read target directory")
        .count();
    assert_eq!(
        nested_entries, 0,
        "temp file must not be moved into target directory"
    );

    let sibling_temp_remains = fs::read_dir(target_dir.parent().unwrap())
        .expect("read parent directory")
        .flatten()
        .any(|entry| entry.file_name().to_string_lossy().starts_with(".vm0tmp-"));
    assert!(!sibling_temp_remains, "temp file was not cleaned up");

    h.finish();
}

#[tokio::test]
#[ignore = "local performance comparison only; no stable timing assertion"]
async fn bench_write_file_many_small_files() {
    let h = Harness::new().await;

    let start = std::time::Instant::now();
    for i in 0..100 {
        let file_path = h.dir.join(format!("bench/{i}.txt"));
        let file_path_str = file_path.to_string_lossy().to_string();
        h.host()
            .write_file(&file_path_str, b"small content", false)
            .await
            .expect("write_file failed");
    }
    eprintln!("100 small write_file calls took {:?}", start.elapsed());

    h.finish();
}
