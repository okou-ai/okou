use super::{BinaryLoggingFixture, assert_action_types_present};
use crate::support::{TcpTestServer, create_tar_gz, read_http_request_path, write_manifest};
use httpmock::prelude::*;
use serde_json::{Value, json};
use std::io::{self, Write as _};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

const STORAGE_REMOTE_PREFIX: &str = "storage_download_remote_";
const ARTIFACT_REMOTE_PREFIX: &str = "artifact_download_remote_";

fn operation<'a>(ops: &'a [Value], action: &str) -> Option<&'a Value> {
    ops.iter().find(|entry| entry["action_type"] == action)
}

fn operation_with_dimensions<'a>(
    ops: &'a [Value],
    action: &str,
    outcome: &str,
    reason: &str,
) -> Option<&'a Value> {
    ops.iter().find(|entry| {
        entry["action_type"] == action && entry["outcome"] == outcome && entry["reason"] == reason
    })
}

fn action_precedes(actions: &[String], earlier: &str, later: &str) -> bool {
    let earlier_index = actions.iter().position(|action| action == earlier);
    let later_index = actions.iter().position(|action| action == later);
    earlier_index
        .zip(later_index)
        .is_some_and(|(earlier_index, later_index)| earlier_index < later_index)
}

fn deterministic_bytes(len: usize) -> Vec<u8> {
    let mut state = 0x1234_5678_u32;
    (0..len)
        .map(|_| {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            state.to_be_bytes().into_iter().next().unwrap_or_default()
        })
        .collect()
}

fn start_archive_server(archive: Vec<u8>) -> io::Result<TcpTestServer<()>> {
    TcpTestServer::start(move |server| {
        let mut stream = server.accept()?.ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::Interrupted,
                "archive server stopped before receiving a request",
            )
        })?;
        assert_eq!(read_http_request_path(&mut stream)?, "/archive.tar.gz");
        write!(
            stream,
            "HTTP/1.1 200 OK\r\ncontent-type: application/gzip\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
            archive.len()
        )?;
        stream.write_all(&archive)?;
        stream.flush()
    })
}

#[test]
fn binary_records_download_scheduler_attribution() {
    let server = MockServer::start();
    let remote_tar = create_tar_gz(&[("remote.txt", b"remote")]).unwrap();
    let remote_mock = server.mock(|when, then| {
        when.method(GET).path("/remote.tar.gz");
        then.status(200)
            .header("content-type", "application/gzip")
            .body(&remote_tar);
    });

    let fixture = BinaryLoggingFixture::new("scheduler-attribution").unwrap();
    let local_tar = create_tar_gz(&[("local.txt", b"local")]).unwrap();
    let local_archive = fixture.dir.path().join("local.tar.gz");
    std::fs::write(&local_archive, local_tar).unwrap();
    let parent_mount = fixture.dir.path().join("mount");
    let child_mount = parent_mount.join("child");
    let remote_url = server.url("/remote.tar.gz");
    let local_url = format!("file://{}", local_archive.display());
    let manifest = write_manifest(
        &fixture.dir,
        &[(parent_mount.to_str().unwrap(), Some(&remote_url))],
        Some((child_mount.to_str().unwrap(), Some(&local_url))),
    )
    .unwrap();

    let output = fixture.run_manifest_path(&manifest).unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    remote_mock.assert_calls(1);
    assert_eq!(
        std::fs::read_to_string(parent_mount.join("remote.txt")).unwrap(),
        "remote"
    );
    assert_eq!(
        std::fs::read_to_string(child_mount.join("local.txt")).unwrap(),
        "local"
    );

    let actions = fixture.action_types().unwrap();
    let ops = fixture.ops_entries().unwrap();
    assert_action_types_present(
        &actions,
        &[
            "guest_storage_apply_plan_build",
            "guest_storage_apply_cleanup",
            "guest_storage_apply_target_prepare",
            "guest_storage_apply_task_count_2",
            "guest_storage_apply_remote_url_count_1",
            "guest_storage_apply_file_url_count_1",
            "guest_storage_apply_skill_child_task_count_0",
            "guest_storage_apply_framework_home_instructions_task_absent",
            "guest_storage_apply_potential_parent_child_overlap_count_1",
            "guest_storage_apply_mount_conflict_deferral_count_1",
            "guest_storage_apply_instructions_skill_conflict_deferral_count_0",
            "guest_storage_apply_exact_path_conflict_deferral_count_0",
            "guest_storage_apply_other_parent_child_conflict_deferral_count_1",
            "storage_download",
            "storage_download_remote_request_to_response_headers",
            "storage_download_remote_body_read",
            "storage_download_remote_extract_outside_body_read",
            "storage_download_remote_compressed_bytes_consumed_lt_64_kib",
            "storage_download_remote_attempt_count_1",
            "artifact_download",
            "guest_storage_apply_archive_scheduler",
            "guest_storage_apply_instruction_normalize",
            "download_total",
        ],
    );
    let storage_total =
        operation_with_dimensions(&ops, "storage_download", "remote_lt_64_kib", "other").unwrap();
    assert_eq!(storage_total["success"], true);
    assert!(storage_total.get("error").is_none());
    let artifact_total =
        operation_with_dimensions(&ops, "artifact_download", "file_lt_64_kib", "other").unwrap();
    assert_eq!(artifact_total["success"], true);
    assert!(artifact_total.get("error").is_none());
    for phase in [
        "guest_storage_apply_plan_build",
        "guest_storage_apply_cleanup",
        "guest_storage_apply_target_prepare",
        "guest_storage_apply_archive_scheduler",
        "guest_storage_apply_instruction_normalize",
    ] {
        let entry = operation(&ops, phase).unwrap_or_else(|| panic!("missing {phase} in {ops:?}"));
        assert_eq!(entry["success"], true, "unexpected {phase}: {entry:?}");
        assert!(
            entry.get("error").is_none(),
            "unexpected {phase}: {entry:?}"
        );
    }
    assert!(
        action_precedes(
            &actions,
            "guest_storage_apply_plan_build",
            "guest_storage_apply_cleanup"
        ),
        "expected plan build before cleanup in {actions:?}"
    );
    assert!(
        action_precedes(
            &actions,
            "guest_storage_apply_cleanup",
            "guest_storage_apply_target_prepare"
        ),
        "expected cleanup before target preparation in {actions:?}"
    );
    assert!(
        action_precedes(
            &actions,
            "guest_storage_apply_target_prepare",
            "guest_storage_apply_task_count_2"
        ),
        "expected target preparation before batch attribution in {actions:?}"
    );
    assert!(
        action_precedes(
            &actions,
            "guest_storage_apply_task_count_2",
            "storage_download"
        ),
        "expected batch attribution before task attribution in {actions:?}"
    );
    assert!(
        action_precedes(
            &actions,
            "storage_download",
            "storage_download_remote_request_to_response_headers"
        ),
        "expected task total before remote attribution in {actions:?}"
    );
    assert!(
        action_precedes(
            &actions,
            "storage_download_remote_attempt_count_1",
            "guest_storage_apply_mount_conflict_deferral_count_1"
        ),
        "expected remote attribution before conflict totals in {actions:?}"
    );
    assert!(
        action_precedes(
            &actions,
            "artifact_download",
            "guest_storage_apply_mount_conflict_deferral_count_1"
        ),
        "expected task attribution before conflict totals in {actions:?}"
    );
    assert!(
        action_precedes(
            &actions,
            "guest_storage_apply_mount_conflict_deferral_count_1",
            "guest_storage_apply_archive_scheduler"
        ),
        "expected conflict totals before scheduler total in {actions:?}"
    );
    assert!(
        action_precedes(
            &actions,
            "guest_storage_apply_archive_scheduler",
            "guest_storage_apply_instruction_normalize"
        ),
        "expected scheduler total before instruction normalization in {actions:?}"
    );
    assert!(
        action_precedes(
            &actions,
            "guest_storage_apply_instruction_normalize",
            "download_total"
        ),
        "expected instruction normalization before run total in {actions:?}"
    );
    assert!(
        !actions
            .iter()
            .any(|action| action.starts_with(ARTIFACT_REMOTE_PREFIX)),
        "local artifact emitted remote attribution: {actions:?}"
    );
}

#[test]
fn binary_records_scheduler_attribution_for_failed_download() {
    let server = MockServer::start();
    let remote_mock = server.mock(|when, then| {
        when.method(GET).path("/missing.tar.gz");
        then.status(404);
    });

    let fixture = BinaryLoggingFixture::new("scheduler-attribution-failure").unwrap();
    let local_tar = create_tar_gz(&[("local.txt", b"local")]).unwrap();
    let local_archive = fixture.dir.path().join("local.tar.gz");
    std::fs::write(&local_archive, local_tar).unwrap();
    let parent_mount = fixture.dir.path().join("mount");
    let child_mount = parent_mount.join("child");
    let remote_url = server.url("/missing.tar.gz");
    let local_url = format!("file://{}", local_archive.display());
    let manifest = write_manifest(
        &fixture.dir,
        &[(parent_mount.to_str().unwrap(), Some(&remote_url))],
        Some((child_mount.to_str().unwrap(), Some(&local_url))),
    )
    .unwrap();

    let output = fixture.run_manifest_path(&manifest).unwrap();

    assert!(
        !output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    remote_mock.assert_calls(1);
    assert_eq!(
        std::fs::read_to_string(child_mount.join("local.txt")).unwrap(),
        "local"
    );

    let ops = fixture.ops_entries().unwrap();
    for phase in [
        "guest_storage_apply_plan_build",
        "guest_storage_apply_cleanup",
        "guest_storage_apply_target_prepare",
    ] {
        let entry = operation(&ops, phase).unwrap_or_else(|| panic!("missing {phase} in {ops:?}"));
        assert_eq!(entry["success"], true, "unexpected {phase}: {entry:?}");
        assert!(
            entry.get("error").is_none(),
            "unexpected {phase}: {entry:?}"
        );
    }
    let scheduler = operation(&ops, "guest_storage_apply_archive_scheduler")
        .unwrap_or_else(|| panic!("missing scheduler total in {ops:?}"));
    assert_eq!(scheduler["success"], false);
    assert!(scheduler.get("error").is_none());
    assert!(
        operation(&ops, "guest_storage_apply_instruction_normalize").is_none(),
        "failed download normalized instructions: {ops:?}"
    );
    let conflict = ops
        .iter()
        .find(|entry| entry["action_type"] == "guest_storage_apply_mount_conflict_deferral_count_1")
        .unwrap_or_else(|| panic!("missing mount conflict count in {ops:?}"));
    assert_eq!(conflict["success"], true);
    let other_parent_child_conflict = ops
        .iter()
        .find(|entry| {
            entry["action_type"]
                == "guest_storage_apply_other_parent_child_conflict_deferral_count_1"
        })
        .unwrap_or_else(|| panic!("missing other parent/child conflict count in {ops:?}"));
    assert_eq!(other_parent_child_conflict["success"], true);
    let total = ops
        .iter()
        .find(|entry| entry["action_type"] == "download_total")
        .unwrap_or_else(|| panic!("missing download_total in {ops:?}"));
    assert_eq!(total["success"], false);

    let remote_ops: Vec<&Value> = ops
        .iter()
        .filter(|entry| {
            entry["action_type"]
                .as_str()
                .is_some_and(|action| action.starts_with(STORAGE_REMOTE_PREFIX))
        })
        .collect();
    assert_eq!(remote_ops.len(), 5, "unexpected remote operations: {ops:?}");
    assert!(remote_ops.iter().all(|entry| entry["success"] == false));
    assert!(remote_ops.iter().all(|entry| entry.get("error").is_none()));
    assert_eq!(
        operation(&ops, "storage_download_remote_attempt_count_1").unwrap()["duration_ms"],
        0
    );
    assert_eq!(
        operation(
            &ops,
            "storage_download_remote_compressed_bytes_consumed_zero"
        )
        .unwrap()["duration_ms"],
        0
    );
    let storage_total =
        operation_with_dimensions(&ops, "storage_download", "remote_zero", "other").unwrap();
    assert_eq!(storage_total["success"], false);
    assert!(storage_total["error"].as_str().is_some_and(|error| {
        error.contains("HTTP status 404") && error.contains("urlScheme=http")
    }));
}

#[test]
fn binary_records_redacted_target_preparation_failure() {
    let fixture = BinaryLoggingFixture::new("target-preparation-failure").unwrap();
    let sensitive_target = fixture.dir.path().join("private-target-path");
    std::fs::write(&sensitive_target, "not a directory").unwrap();
    let missing_archive = fixture.dir.path().join("missing.tar.gz");
    let url = format!("file://{}", missing_archive.display());
    let manifest = write_manifest(
        &fixture.dir,
        &[(sensitive_target.to_str().unwrap(), Some(&url))],
        None,
    )
    .unwrap();

    let output = fixture.run_manifest_path(&manifest).unwrap();

    assert!(
        !output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let ops_log = fixture.read_ops_log().unwrap();
    assert!(
        !ops_log.contains(sensitive_target.to_str().unwrap()),
        "sandbox operations leaked target path: {ops_log}"
    );
    let ops = fixture.ops_entries().unwrap();
    for phase in [
        "guest_storage_apply_plan_build",
        "guest_storage_apply_cleanup",
    ] {
        let entry = operation(&ops, phase).unwrap_or_else(|| panic!("missing {phase} in {ops:?}"));
        assert_eq!(entry["success"], true, "unexpected {phase}: {entry:?}");
        assert!(
            entry.get("error").is_none(),
            "unexpected {phase}: {entry:?}"
        );
    }
    assert_eq!(
        ops.iter()
            .filter(|entry| entry["action_type"] == "guest_storage_apply_target_prepare")
            .count(),
        1,
        "unexpected target preparation operations: {ops:?}"
    );
    let target_prepare = operation(&ops, "guest_storage_apply_target_prepare")
        .unwrap_or_else(|| panic!("missing target preparation in {ops:?}"));
    assert_eq!(target_prepare["success"], false);
    assert!(target_prepare.get("error").is_none());
    let actions = fixture.action_types().unwrap();
    assert!(
        !actions
            .iter()
            .any(|action| action.starts_with("guest_storage_apply_task_count_")),
        "target preparation failure reached scheduler attribution: {actions:?}"
    );
    for absent in [
        "guest_storage_apply_archive_scheduler",
        "guest_storage_apply_instruction_normalize",
    ] {
        assert!(
            !actions.iter().any(|action| action == absent),
            "unexpected {absent} in {actions:?}"
        );
    }
    let total = operation(&ops, "download_total")
        .unwrap_or_else(|| panic!("missing download_total in {ops:?}"));
    assert_eq!(total["success"], false);
    assert!(total.get("error").is_none());
}

#[test]
fn binary_records_remote_artifact_attribution_and_compressed_byte_bucket() {
    let server = MockServer::start();
    let content = deterministic_bytes(100_000);
    let archive = create_tar_gz(&[("artifact.bin", &content)]).unwrap();
    assert!(archive.len() >= 65_536, "archive compressed too small");
    assert!(archive.len() < 262_144, "archive compressed too large");
    let archive_mock = server.mock(|when, then| {
        when.method(GET).path("/artifact.tar.gz");
        then.status(200)
            .header("content-type", "application/gzip")
            .body(&archive);
    });

    let fixture = BinaryLoggingFixture::new("artifact-remote-attribution").unwrap();
    let mount = fixture.dir.path().join("artifact");
    let url = server.url("/artifact.tar.gz");
    let manifest = write_manifest(
        &fixture.dir,
        &[],
        Some((mount.to_str().unwrap(), Some(&url))),
    )
    .unwrap();

    let output = fixture.run_manifest_path(&manifest).unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    archive_mock.assert_calls(1);
    assert_eq!(std::fs::read(mount.join("artifact.bin")).unwrap(), content);

    let ops = fixture.ops_entries().unwrap();
    let artifact_total = operation_with_dimensions(
        &ops,
        "artifact_download",
        "remote_64_kib_to_256_kib",
        "other",
    )
    .unwrap();
    assert_eq!(artifact_total["success"], true);
    assert!(artifact_total.get("error").is_none());
    let actions = fixture.action_types().unwrap();
    assert_action_types_present(
        &actions,
        &[
            "artifact_download",
            "artifact_download_remote_request_to_response_headers",
            "artifact_download_remote_body_read",
            "artifact_download_remote_extract_outside_body_read",
            "artifact_download_remote_compressed_bytes_consumed_64_kib_to_256_kib",
            "artifact_download_remote_attempt_count_1",
        ],
    );
    for remote_action in actions
        .iter()
        .filter(|action| action.starts_with(ARTIFACT_REMOTE_PREFIX))
    {
        assert!(
            action_precedes(&actions, "artifact_download", remote_action),
            "expected artifact total before {remote_action} in {actions:?}"
        );
    }
    assert!(
        !actions
            .iter()
            .any(|action| action.starts_with(STORAGE_REMOTE_PREFIX)),
        "artifact emitted storage attribution: {actions:?}"
    );
}

#[test]
fn binary_records_remote_archive_phase_durations() {
    let archive = create_tar_gz(&[("remote.txt", b"remote")]).unwrap();
    let server = start_archive_server(archive).unwrap();
    let url = format!("{}/archive.tar.gz", server.base_url());
    let fixture = BinaryLoggingFixture::new("remote-attribution-durations").unwrap();
    let mount = fixture.dir.path().join("storage");
    let manifest =
        write_manifest(&fixture.dir, &[(mount.to_str().unwrap(), Some(&url))], None).unwrap();

    let output = fixture.run_manifest_path(&manifest).unwrap();
    server.finish().unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        std::fs::read_to_string(mount.join("remote.txt")).unwrap(),
        "remote"
    );
    let ops = fixture.ops_entries().unwrap();
    // Headers and body can already be buffered when the child is scheduled.
    // Read timing boundaries are synchronized in source's reader-level tests.
    for phase in [
        "storage_download_remote_request_to_response_headers",
        "storage_download_remote_body_read",
        "storage_download_remote_extract_outside_body_read",
    ] {
        let entry = operation(&ops, phase).unwrap_or_else(|| panic!("missing {phase} in {ops:?}"));
        assert_eq!(entry["success"], true, "unexpected {phase}: {entry:?}");
        assert!(
            entry["duration_ms"].as_u64().is_some(),
            "invalid {phase} duration: {entry:?}"
        );
    }
    assert_action_types_present(
        &fixture.action_types().unwrap(),
        &[
            "storage_download_remote_compressed_bytes_consumed_lt_64_kib",
            "storage_download_remote_attempt_count_1",
        ],
    );
}

#[test]
fn archive_server_without_request_returns_bounded_error() {
    let server = start_archive_server(Vec::new()).unwrap();
    let (finished_tx, finished_rx) = mpsc::channel();
    let completion = thread::spawn(move || {
        let result = server.finish();
        let _ = finished_tx.send(());
        result
    });

    finished_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    let error = completion.join().unwrap().unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::Interrupted);
}

#[test]
fn binary_records_opened_file_size_around_bucket_boundary() {
    let fixture = BinaryLoggingFixture::new("opened-file-size-boundary").unwrap();
    let below_boundary = fixture.dir.path().join("below-boundary.tar.gz");
    let at_boundary = fixture.dir.path().join("at-boundary.tar.gz");
    std::fs::write(&below_boundary, vec![0_u8; 65_535]).unwrap();
    std::fs::write(&at_boundary, vec![0_u8; 65_536]).unwrap();

    let below_mount = fixture.dir.path().join("below-mount");
    let at_mount = fixture.dir.path().join("at-mount");
    let below_url = format!("file://{}", below_boundary.display());
    let at_url = format!("file://{}", at_boundary.display());
    let manifest = write_manifest(
        &fixture.dir,
        &[
            (below_mount.to_str().unwrap(), Some(&below_url)),
            (at_mount.to_str().unwrap(), Some(&at_url)),
        ],
        None,
    )
    .unwrap();

    let output = fixture.run_manifest_path(&manifest).unwrap();

    assert!(!output.status.success());
    let ops = fixture.ops_entries().unwrap();
    for outcome in ["file_lt_64_kib", "file_64_kib_to_256_kib"] {
        let task = operation_with_dimensions(&ops, "storage_download", outcome, "other").unwrap();
        assert_eq!(task["success"], false);
        assert!(
            task["error"]
                .as_str()
                .is_some_and(|error| error.contains("invalid gzip header")),
            "unexpected task entry: {task:?}"
        );
    }
    assert_eq!(
        ops.iter()
            .filter(|entry| entry["action_type"] == "storage_download")
            .count(),
        2,
        "unexpected task totals: {ops:?}"
    );
    assert_eq!(
        operation(&ops, "guest_storage_apply_archive_scheduler").unwrap()["success"],
        false
    );
    assert_eq!(operation(&ops, "download_total").unwrap()["success"], false);
}

#[test]
fn binary_records_framework_home_instructions_role() {
    let fixture = BinaryLoggingFixture::new("framework-home-instructions-role").unwrap();
    let archive = create_tar_gz(&[("AGENTS.md", b"runtime instructions")]).unwrap();
    assert!(archive.len() < 65_536);
    let archive_path = fixture.dir.path().join("instructions.tar.gz");
    std::fs::write(&archive_path, archive).unwrap();

    let framework_home = fixture.dir.path().join(".codex");
    let extract_path = fixture.dir.path().join("instructions-stage");
    let manifest_path = fixture.dir.path().join("instructions-manifest.json");
    let manifest = json!({
        "storageMounts": [{
            "mountPath": framework_home,
            "extractPath": extract_path,
            "archiveUrl": format!("file://{}", archive_path.display()),
            "instructionsTargetFilename": "AGENTS.md"
        }]
    });
    std::fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();

    let output = fixture.run_manifest_path(&manifest_path).unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        std::fs::read_to_string(framework_home.join("AGENTS.md")).unwrap(),
        "runtime instructions"
    );
    assert!(!extract_path.exists());
    let ops = fixture.ops_entries().unwrap();
    let task = operation_with_dimensions(
        &ops,
        "storage_download",
        "file_lt_64_kib",
        "framework_home_instructions",
    )
    .unwrap();
    assert_eq!(task["success"], true);
    assert!(task.get("error").is_none());
    assert_eq!(
        operation(&ops, "guest_storage_apply_instruction_normalize").unwrap()["success"],
        true
    );
    assert_eq!(operation(&ops, "download_total").unwrap()["success"], true);
}
