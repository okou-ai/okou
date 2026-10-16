//! Canonical cgroup placement endpoints are captured before capability consumption.

#![cfg(unix)]

use crate::common;

use std::ffi::OsString;
use std::io::{BufRead, Write};
use std::os::fd::AsFd;
use std::os::unix::ffi::OsStringExt;
use std::process::Stdio;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use tokio::process::Command;

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

const CHILD_TIMEOUT: Duration = Duration::from_secs(30);
const ENDPOINT_MARKER: &str = "must-not-leak";
const CAPTURE_CHILD_TEST: &str =
    "bootstrap_cases::cgroup_placement_env::canonical_pair_is_removed_after_capture_isolated";
const CAPTURE_CHILD_GUARD: &str = "OKOU_CGROUP_PLACEMENT_CAPTURE_CHILD";
const CAPTURE_CHILD_GUARD_VALUE: &str = "1";
const CAPTURE_CHILD_MARKER: &str = "cgroup placement capture child active";
const BROKER_CHILD_TEST: &str =
    "bootstrap_cases::cgroup_placement_env::canonical_pair_capture_broker_isolated";
const BROKER_CHILD_GUARD: &str = "OKOU_CGROUP_PLACEMENT_BROKER_CHILD";
const BROKER_CHILD_GUARD_VALUE: &str = "1";
const BROKER_ENDPOINT_ENV: &str = "OKOU_CGROUP_PLACEMENT_BROKER_ENDPOINT";
const BROKER_READY_MARKER: &str = "cgroup placement broker ready";
const ISOLATED_CHILD_PATH: &str = "/usr/local/bin:/usr/bin:/bin";
static NEXT_ENDPOINT: AtomicU32 = AtomicU32::new(1);

fn unique_endpoint() -> String {
    let seq = std::process::id().wrapping_add(NEXT_ENDPOINT.fetch_add(1, Ordering::Relaxed));
    process_control_ipc::endpoint_name(seq, b"cgroup-placement")
}

fn guest_agent_command() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_guest-agent"));
    for key in [
        process_control_ipc::CANONICAL_BOOTSTRAP_ENV,
        guest_contracts::process_containment::CANONICAL_WORKLOAD_CGROUP_PROCS_ENV,
        guest_contracts::process_containment::CANONICAL_TOOL_CGROUP_PROCS_ENV,
        "OKOU_TEST_ALLOW_UNMANAGED_PROCESS_CONTROL",
    ] {
        command.env_remove(key);
    }
    command.env(
        process_control_ipc::CANONICAL_BOOTSTRAP_ENV,
        "process-control-endpoint-must-not-leak",
    );
    command
}

async fn command_output(command: &mut Command, context: &str) -> TestResult<std::process::Output> {
    Ok(common::command_output_with_timeout(command, CHILD_TIMEOUT, context).await?)
}

fn assert_value_free(stderr: &str, endpoint: &str, context: &str) {
    for value in [
        endpoint,
        "process-control-endpoint-must-not-leak",
        "canonical-workload-must-not-leak",
        "canonical-tool-must-not-leak",
    ] {
        assert!(
            !stderr.contains(value),
            "{context} exposed cgroup placement endpoint material"
        );
    }
}

async fn assert_rejected_before_workload_connection<F>(
    name: &str,
    expected_error: &str,
    configure: F,
) -> TestResult
where
    F: FnOnce(&mut Command, &str),
{
    let endpoint = unique_endpoint();
    let listener = process_control_ipc::bind_abstract_listener(&endpoint)?;
    let mut command = guest_agent_command();
    configure(&mut command, &endpoint);

    let output = command_output(
        &mut command,
        &format!("{name} guest-agent scenario did not finish"),
    )
    .await?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(output.status.code(), Some(1), "{name} stderr: {stderr}");
    assert!(stderr.contains(expected_error), "{name} stderr: {stderr}");
    assert_value_free(&stderr, &endpoint, name);

    listener.set_nonblocking(true)?;
    let accept_error = match listener.accept() {
        Err(error) => error,
        Ok(_) => {
            return Err(format!(
                "{name} connected to the workload capability before rejecting invalid input"
            )
            .into());
        }
    };
    assert_eq!(
        accept_error.kind(),
        std::io::ErrorKind::WouldBlock,
        "{name}"
    );
    Ok(())
}

#[tokio::test]
async fn guest_agent_accepts_the_canonical_pair_and_preserves_endpoint_bytes() -> TestResult {
    let endpoint = unique_endpoint();
    let listener = process_control_ipc::bind_abstract_listener(&endpoint)?;
    let broker = std::thread::spawn(move || -> std::io::Result<()> {
        let stream = process_control_ipc::accept_with_timeout(&listener, Duration::from_secs(5))?;
        let invalid_placement = std::fs::OpenOptions::new().write(true).open("/dev/null")?;
        process_control_ipc::send_workload_placement(&stream, invalid_placement.as_fd())
    });
    let tool_endpoint = format!("canonical-tool-{ENDPOINT_MARKER}");
    let mut command = guest_agent_command();
    command
        .env(
            guest_contracts::process_containment::CANONICAL_WORKLOAD_CGROUP_PROCS_ENV,
            &endpoint,
        )
        .env(
            guest_contracts::process_containment::CANONICAL_TOOL_CGROUP_PROCS_ENV,
            &tool_endpoint,
        );

    let output = command_output(
        &mut command,
        "canonical cgroup placement scenario did not finish",
    )
    .await?;
    broker
        .join()
        .map_err(|_| "workload placement broker thread panicked")??;
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(output.status.code(), Some(1), "stderr: {stderr}");
    assert!(
        stderr.contains("workload placement fd is not on cgroup v2"),
        "stderr: {stderr}"
    );
    assert_value_free(&stderr, &endpoint, "canonical pair");
    assert!(!stderr.contains(&tool_endpoint));
    Ok(())
}

#[tokio::test]
async fn guest_agent_rejects_invalid_canonical_input_before_capability_consumption() -> TestResult {
    let workload_canonical =
        guest_contracts::process_containment::CANONICAL_WORKLOAD_CGROUP_PROCS_ENV;
    let tool_canonical = guest_contracts::process_containment::CANONICAL_TOOL_CGROUP_PROCS_ENV;
    let pair_required = format!("{workload_canonical} and {tool_canonical} are required with");
    let workload_empty =
        format!("invalid cgroup placement environment: key={workload_canonical} state=empty");
    let tool_empty =
        format!("invalid cgroup placement environment: key={tool_canonical} state=empty");

    assert_rejected_before_workload_connection(
        "missing-canonical-tool",
        &pair_required,
        |command, endpoint| {
            command.env(workload_canonical, endpoint);
        },
    )
    .await?;
    assert_rejected_before_workload_connection(
        "missing-canonical-workload",
        &pair_required,
        |command, _endpoint| {
            command.env(tool_canonical, "canonical-tool-must-not-leak");
        },
    )
    .await?;
    assert_rejected_before_workload_connection(
        "workload-empty",
        &workload_empty,
        |command, _endpoint| {
            command
                .env(workload_canonical, "")
                .env(tool_canonical, "canonical-tool-must-not-leak");
        },
    )
    .await?;
    assert_rejected_before_workload_connection("tool-empty", &tool_empty, |command, endpoint| {
        command
            .env(workload_canonical, endpoint)
            .env(tool_canonical, "");
    })
    .await?;
    assert_rejected_before_workload_connection(
        "workload-non-unicode",
        &format!("{workload_canonical} must be valid UTF-8"),
        |command, _endpoint| {
            command
                .env(workload_canonical, OsString::from_vec(vec![0xff]))
                .env(tool_canonical, "canonical-tool-must-not-leak");
        },
    )
    .await?;
    assert_rejected_before_workload_connection(
        "tool-non-unicode-after-workload-resolution",
        &format!("{tool_canonical} must be valid UTF-8"),
        |command, endpoint| {
            command
                .env(workload_canonical, endpoint)
                .env(tool_canonical, OsString::from_vec(vec![0xff]));
        },
    )
    .await?;
    assert_rejected_before_workload_connection(
        "cgroup-endpoints-without-process-control",
        "require OKOU_PROCESS_CONTROL_ENDPOINT",
        |command, endpoint| {
            command
                .env_remove(process_control_ipc::CANONICAL_BOOTSTRAP_ENV)
                .env(workload_canonical, endpoint)
                .env(tool_canonical, "canonical-tool-must-not-leak");
        },
    )
    .await?;

    Ok(())
}

#[tokio::test]
async fn guest_agent_removes_canonical_endpoints_after_capture() -> TestResult {
    let mut command = Command::new(std::env::current_exe()?);
    command
        .arg("--exact")
        .arg(CAPTURE_CHILD_TEST)
        .arg("--ignored")
        .arg("--nocapture")
        .arg("--test-threads=1")
        .env_clear()
        .env("PATH", ISOLATED_CHILD_PATH)
        .env(CAPTURE_CHILD_GUARD, CAPTURE_CHILD_GUARD_VALUE);
    if let Some(llvm_profile_file) = std::env::var_os("LLVM_PROFILE_FILE") {
        command.env("LLVM_PROFILE_FILE", llvm_profile_file);
    }

    let output = command_output(
        &mut command,
        "isolated cgroup placement capture test did not finish",
    )
    .await?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "isolated capture test failed with {}; stdout:\n{stdout}\nstderr:\n{stderr}",
        output.status
    );
    assert!(stdout.contains(CAPTURE_CHILD_MARKER), "stdout:\n{stdout}");
    Ok(())
}

#[test]
#[ignore = "spawned exactly by the cgroup placement capture parent test"]
fn canonical_pair_is_removed_after_capture_isolated() -> TestResult {
    if std::env::var(CAPTURE_CHILD_GUARD).ok().as_deref() != Some(CAPTURE_CHILD_GUARD_VALUE) {
        return Ok(());
    }

    let canonical_endpoint = unique_endpoint();
    let workload_canonical =
        guest_contracts::process_containment::CANONICAL_WORKLOAD_CGROUP_PROCS_ENV;
    let tool_canonical = guest_contracts::process_containment::CANONICAL_TOOL_CGROUP_PROCS_ENV;

    // SAFETY: this exact ignored test is the only active test in its process,
    // and no thread exists while the environment is configured or captured.
    unsafe {
        std::env::set_var(workload_canonical, &canonical_endpoint);
        std::env::set_var(tool_canonical, "canonical-tool-must-not-leak");
    }

    let mut broker_command = std::process::Command::new(std::env::current_exe()?);
    broker_command
        .arg("--exact")
        .arg(BROKER_CHILD_TEST)
        .arg("--ignored")
        .arg("--nocapture")
        .arg("--test-threads=1")
        .env_clear()
        .env("PATH", ISOLATED_CHILD_PATH)
        .env(BROKER_CHILD_GUARD, BROKER_CHILD_GUARD_VALUE)
        .env(BROKER_ENDPOINT_ENV, &canonical_endpoint)
        .stdout(Stdio::piped());
    if let Some(llvm_profile_file) = std::env::var_os("LLVM_PROFILE_FILE") {
        broker_command.env("LLVM_PROFILE_FILE", llvm_profile_file);
    }
    let mut broker = broker_command.spawn()?;
    let mut broker_stdout = std::io::BufReader::new(
        broker
            .stdout
            .take()
            .ok_or("cgroup placement broker stdout is unavailable")?,
    );
    let mut readiness = String::new();
    loop {
        let read = broker_stdout.read_line(&mut readiness)?;
        if readiness.contains(BROKER_READY_MARKER) {
            break;
        }
        if read == 0 {
            return Err("cgroup placement broker exited before readiness".into());
        }
    }

    let error = guest_agent::workload_containment::WorkloadContainment::from_process_env(true)
        .expect_err("invalid placement descriptor should reject canonical bootstrap");
    assert!(
        error.contains("workload placement fd is not on cgroup v2"),
        "unexpected canonical bootstrap error: {error}"
    );
    assert_value_free(&error, &canonical_endpoint, "canonical capture child");

    let broker_status = broker.wait()?;
    assert!(broker_status.success(), "broker status: {broker_status}");
    for key in [workload_canonical, tool_canonical] {
        assert!(
            std::env::var_os(key).is_none(),
            "Guest Agent retained {key} after canonical capture"
        );
    }

    println!("{CAPTURE_CHILD_MARKER}");
    Ok(())
}

#[test]
#[ignore = "spawned exactly by the cgroup placement capture child test"]
fn canonical_pair_capture_broker_isolated() -> TestResult {
    if std::env::var(BROKER_CHILD_GUARD).ok().as_deref() != Some(BROKER_CHILD_GUARD_VALUE) {
        return Ok(());
    }

    let endpoint = std::env::var(BROKER_ENDPOINT_ENV)?;
    let listener = process_control_ipc::bind_abstract_listener(&endpoint)?;
    println!("{BROKER_READY_MARKER}");
    std::io::stdout().flush()?;
    let stream = process_control_ipc::accept_with_timeout(&listener, Duration::from_secs(5))?;
    let invalid_placement = std::fs::OpenOptions::new().write(true).open("/dev/null")?;
    process_control_ipc::send_workload_placement(&stream, invalid_placement.as_fd())?;
    Ok(())
}
