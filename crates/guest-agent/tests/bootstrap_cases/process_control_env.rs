//! Process-control bootstrap integration coverage.
//!
//! The CLI environment scenario runs its process-global setup in one exact
//! ignored child process so default-harness sibling tests can run safely.

use crate::common;

use std::path::PathBuf;
use std::time::Duration;
use tokio::process::Command;

const ISOLATED_CHILD_TEST: &str = "bootstrap_cases::process_control_env::process_control_endpoint_is_not_inherited_by_cli_child_isolated";
const ISOLATED_CHILD_GUARD: &str = "OKOU_PROCESS_CONTROL_ENV_ISOLATED_CHILD";
const ISOLATED_CHILD_GUARD_VALUE: &str = "1";
const ISOLATED_CHILD_MOCK_PATH: &str = "OKOU_PROCESS_CONTROL_ENV_ISOLATED_MOCK_PATH";
const ISOLATED_CHILD_MARKER: &str = "vm0 process-control env isolated child active";
const ISOLATED_CHILD_PATH: &str = "/usr/local/bin:/usr/bin:/bin";
const PROCESS_CONTROL_CHILD_TIMEOUT: Duration = Duration::from_secs(30);

#[tokio::test]
async fn canonical_process_control_without_workload_capability_fails_closed()
-> Result<(), Box<dyn std::error::Error>> {
    let mut command = Command::new(env!("CARGO_BIN_EXE_guest-agent"));
    command
        .env_remove(process_control_ipc::CANONICAL_BOOTSTRAP_ENV)
        .env(
            process_control_ipc::CANONICAL_BOOTSTRAP_ENV,
            "missing-capability",
        )
        .env_remove(guest_contracts::process_containment::CANONICAL_WORKLOAD_CGROUP_PROCS_ENV)
        .env_remove(guest_contracts::process_containment::CANONICAL_TOOL_CGROUP_PROCS_ENV)
        .env_remove("OKOU_TEST_ALLOW_UNMANAGED_PROCESS_CONTROL");
    let output = common::command_output_with_timeout(
        &mut command,
        PROCESS_CONTROL_CHILD_TIMEOUT,
        "missing-workload-capability guest-agent scenario did not finish",
    )
    .await?;

    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains(guest_contracts::process_containment::CANONICAL_WORKLOAD_CGROUP_PROCS_ENV),
        "stderr: {stderr}"
    );
    assert!(
        stderr.contains("are required with OKOU_PROCESS_CONTROL_ENDPOINT"),
        "stderr: {stderr}"
    );
    assert!(
        !stderr.contains("missing-capability"),
        "stderr exposed endpoint material"
    );
    Ok(())
}

#[tokio::test]
async fn workload_capability_is_received_over_scm_rights_and_validated()
-> Result<(), Box<dyn std::error::Error>> {
    let nonce = *b"workload-fd-test";
    let endpoint = format!(
        "{}-workload-placement",
        process_control_ipc::endpoint_name(std::process::id(), &nonce)
    );
    let listener = process_control_ipc::bind_abstract_listener(&endpoint).unwrap();
    let broker = std::thread::spawn(move || {
        use std::os::fd::AsFd;

        let stream = process_control_ipc::accept_with_timeout(&listener, Duration::from_secs(5))
            .expect("guest-agent should connect to workload capability broker");
        let invalid_placement = std::fs::OpenOptions::new()
            .write(true)
            .open("/dev/null")
            .unwrap();
        process_control_ipc::send_workload_placement(&stream, invalid_placement.as_fd()).unwrap();
    });

    let mut command = Command::new(env!("CARGO_BIN_EXE_guest-agent"));
    command
        .env_remove(process_control_ipc::CANONICAL_BOOTSTRAP_ENV)
        .env(
            process_control_ipc::CANONICAL_BOOTSTRAP_ENV,
            "process-control-present",
        )
        .env(
            guest_contracts::process_containment::CANONICAL_WORKLOAD_CGROUP_PROCS_ENV,
            endpoint,
        )
        .env(
            guest_contracts::process_containment::CANONICAL_TOOL_CGROUP_PROCS_ENV,
            "test-tool-placement",
        )
        .env_remove("OKOU_TEST_ALLOW_UNMANAGED_PROCESS_CONTROL");
    let output_result = common::command_output_with_timeout(
        &mut command,
        PROCESS_CONTROL_CHILD_TIMEOUT,
        "workload-capability-validation guest-agent scenario did not finish",
    )
    .await;
    let broker_result = broker.join();
    let output = output_result?;
    broker_result.expect("workload capability broker thread panicked");

    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("workload placement fd is not on cgroup v2"),
        "stderr: {stderr}"
    );
    Ok(())
}

#[tokio::test]
async fn process_control_endpoint_is_not_inherited_by_cli_child()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let mut command = Command::new(std::env::current_exe()?);
    command
        .arg("--exact")
        .arg(ISOLATED_CHILD_TEST)
        .arg("--ignored")
        .arg("--nocapture")
        .env_clear()
        .env("PATH", ISOLATED_CHILD_PATH)
        .env(ISOLATED_CHILD_GUARD, ISOLATED_CHILD_GUARD_VALUE)
        .env(ISOLATED_CHILD_MOCK_PATH, mock);
    if let Some(llvm_profile_file) = std::env::var_os("LLVM_PROFILE_FILE") {
        command.env("LLVM_PROFILE_FILE", llvm_profile_file);
    }

    let output = common::command_output_with_timeout(
        &mut command,
        PROCESS_CONTROL_CHILD_TIMEOUT,
        "isolated process-control environment test did not finish",
    )
    .await?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "isolated process-control environment test failed with {}; stdout:\n{stdout}\nstderr:\n{stderr}",
        output.status
    );
    assert!(
        stdout.contains(ISOLATED_CHILD_MARKER),
        "isolated process-control environment test did not activate; stdout:\n{stdout}\nstderr:\n{stderr}"
    );
    Ok(())
}

#[tokio::test]
#[ignore = "spawned exactly by the process-control environment parent test"]
async fn process_control_endpoint_is_not_inherited_by_cli_child_isolated()
-> Result<(), Box<dyn std::error::Error>> {
    if std::env::var(ISOLATED_CHILD_GUARD).ok().as_deref() != Some(ISOLATED_CHILD_GUARD_VALUE) {
        return Ok(());
    }
    println!("isolated child output: {ISOLATED_CHILD_MARKER}; continuing");

    let mock = std::env::var_os(ISOLATED_CHILD_MOCK_PATH)
        .map(PathBuf::from)
        .ok_or("isolated process-control environment mock path is required")?;
    let tmp = tempfile::tempdir()?;
    unsafe {
        common::setup_env(
            &mock,
            tmp.path(),
            r#"if [ -n "${OKOU_PROCESS_CONTROL_ENDPOINT:-}" ]; then echo "process control endpoint leaked" >&2; exit 42; fi"#,
            3,
            1,
        )?;
    }

    let runtime = common::guest_runtime_from_process_env()?;
    unsafe {
        std::env::set_var(
            process_control_ipc::CANONICAL_BOOTSTRAP_ENV,
            "stale-canonical-process-control-endpoint",
        );
    }

    let masker = guest_agent::masker::SecretMasker::from_raw("");
    let heartbeat = common::spawn_dummy_heartbeat();

    let result = tokio::time::timeout(
        Duration::from_secs(15),
        common::execute_cli_for_runtime(&runtime, &masker, heartbeat),
    )
    .await
    .expect("execute_cli did not return within 15s");

    let result = result.expect("execute_cli returned Err");
    assert_eq!(
        result.exit_code,
        common::CLEAN_EXIT,
        "CLI child inherited the process-control endpoint"
    );
    Ok(())
}
