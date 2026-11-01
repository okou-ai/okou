use std::io::{Read, Write};

use guest_control_proto::ExecProcessRole;
use tempfile::{NamedTempFile, TempDir};

use super::*;
use crate::process_containment::ProcessContainmentMode;

fn test_containment(sequence: u32) -> ExecProcessContainment {
    ExecProcessContainment::create(
        sequence,
        ProcessContainmentMode::TestNoop,
        ExecProcessRole::Agent,
    )
    .unwrap()
}

#[test]
fn direct_agent_validation_reports_missing_path() {
    let directory = TempDir::new().unwrap();
    let error = spawn_agent_executable_with_pipes(
        &directory.path().join("missing-agent"),
        &[],
        test_containment(1),
    )
    .err()
    .unwrap();

    assert_eq!(error.kind(), io::ErrorKind::NotFound);
    assert!(error.to_string().contains("guest-agent is missing"));
}

#[test]
fn direct_agent_validation_rejects_non_regular_path() {
    let directory = TempDir::new().unwrap();
    let error = spawn_agent_executable_with_pipes(directory.path(), &[], test_containment(2))
        .err()
        .unwrap();

    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert!(error.to_string().contains("not a regular file"));
}

#[test]
fn direct_agent_validation_rejects_non_executable_file() {
    let mut file = NamedTempFile::new().unwrap();
    file.write_all(b"not executable").unwrap();
    let error = spawn_agent_executable_with_pipes(file.path(), &[], test_containment(3))
        .err()
        .unwrap();

    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    assert!(error.to_string().contains("not executable"));
}

#[test]
fn direct_agent_reports_exec_format_failure() {
    let executable = Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/invalid-executable-image"
    ));
    let error = spawn_agent_executable_with_pipes(executable, &[], test_containment(4))
        .err()
        .unwrap();

    assert_eq!(error.raw_os_error(), Some(libc::ENOEXEC));
}

#[test]
fn direct_agent_merges_stderr_into_streamed_stdout() {
    let executable = Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/agent-stdio-probe.sh"
    ));
    let mut spawned = spawn_agent_executable_with_pipes(
        executable,
        &[("OKOU_TEST_VALUE", "direct-env")],
        test_containment(5),
    )
    .unwrap();
    let mut stdout = String::new();
    let mut stderr = String::new();
    spawned
        .child
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut stdout)
        .unwrap();
    spawned
        .child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .unwrap();
    let status = spawned.child.wait().unwrap();

    assert!(status.success());
    assert_eq!(stdout, "stdout:direct-env\nstderr\n");
    assert!(stderr.is_empty());
    assert!(spawned.env_script.is_none());
}
