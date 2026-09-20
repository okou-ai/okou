//! Guest runtime-directory overrides resolve before bootstrap side effects.

#![cfg(unix)]

mod common;

use std::ffi::{OsStr, OsString};
use std::os::unix::ffi::OsStringExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use tokio::process::Command;

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

const CHILD_TIMEOUT: Duration = Duration::from_secs(15);
const NON_UNICODE_RUNTIME_CAPTURE_CHILD: &str =
    "guest_agent_captures_a_non_unicode_canonical_runtime_override_in_isolated_child";
const NON_UNICODE_RUNTIME_PARENT_ENV: &str = "OKOU_TEST_NON_UNICODE_RUNTIME_PARENT";
static NEXT_ENDPOINT: AtomicU32 = AtomicU32::new(1);

struct PrivateFiles {
    user_env_path: PathBuf,
    run_payload_path: PathBuf,
}

#[derive(Clone, Copy)]
enum RuntimeInput {
    Absent,
    Empty,
    Selected,
}

fn unique_endpoint(label: u8) -> String {
    let seq = std::process::id().wrapping_add(NEXT_ENDPOINT.fetch_add(1, Ordering::Relaxed));
    let mut nonce = [0_u8; 16];
    nonce[..4].copy_from_slice(&seq.to_le_bytes());
    nonce[4] = label;
    process_control_ipc::endpoint_name(seq, &nonce)
}

fn write_private_files(runtime_dir: &Path, valid_payload: bool) -> TestResult<PrivateFiles> {
    let user_env_dir = runtime_dir.join(guest_contracts::env::USER_ENV_PRIVATE_DIR_NAME);
    let user_env_path = user_env_dir.join(guest_contracts::env::USER_ENV_FILENAME);
    let run_payload_dir = runtime_dir.join(guest_contracts::env::RUN_PAYLOAD_PRIVATE_DIR_NAME);
    let run_payload_path = run_payload_dir.join(guest_contracts::env::RUN_PAYLOAD_FILENAME);
    std::fs::create_dir_all(&user_env_dir)?;
    std::fs::create_dir_all(&run_payload_dir)?;
    std::fs::write(&user_env_path, br#"{"HOME":"/home/user"}"#)?;
    if valid_payload {
        std::fs::write(
            &run_payload_path,
            serde_json::to_vec(&guest_contracts::env::RunPayload::default())?,
        )?;
    } else {
        std::fs::write(&run_payload_path, b"invalid-json")?;
    }
    Ok(PrivateFiles {
        user_env_path,
        run_payload_path,
    })
}

fn guest_agent_command(root: &Path, run_id: &str, private_files: &PrivateFiles) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_guest-agent"));
    command
        .env_clear()
        .env(guest_contracts::env::RUN_ID_ENV, run_id)
        .env("HOME", root.join("process-home"))
        .env(
            guest_contracts::env::CANONICAL_API_URL_ENV,
            "http://127.0.0.1:1",
        )
        .env(guest_contracts::env::CANONICAL_API_TOKEN_ENV, "")
        .env(
            guest_contracts::env::CANONICAL_USER_ENV_FILE_ENV,
            &private_files.user_env_path,
        )
        .env(
            guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
            &private_files.run_payload_path,
        );
    command
}

fn apply_runtime_env(command: &mut Command, canonical: Option<&OsStr>) {
    command.env_remove(guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV);
    if let Some(value) = canonical {
        command.env(
            guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
            value,
        );
    }
}

fn input_value(input: RuntimeInput, selected: &Path) -> Option<&OsStr> {
    match input {
        RuntimeInput::Absent => None,
        RuntimeInput::Empty => Some(OsStr::new("")),
        RuntimeInput::Selected => Some(selected.as_os_str()),
    }
}

async fn command_output(command: &mut Command, context: &str) -> TestResult<std::process::Output> {
    Ok(common::command_output_with_timeout(command, CHILD_TIMEOUT, context).await?)
}

fn assert_value_free(text: &str, forbidden: &[&str], context: &str) {
    for value in forbidden {
        assert!(
            !text.contains(value),
            "{context} exposed guest runtime-directory material"
        );
    }
}

fn assert_listener_idle(listener: &std::os::unix::net::UnixListener, context: &str) -> TestResult {
    listener.set_nonblocking(true)?;
    let error = match listener.accept() {
        Err(error) => error,
        Ok(_) => {
            return Err(
                format!("{context} connected before rejecting the runtime override").into(),
            );
        }
    };
    assert_eq!(error.kind(), std::io::ErrorKind::WouldBlock, "{context}");
    Ok(())
}

#[tokio::test]
async fn guest_agent_uses_the_canonical_runtime_override() -> TestResult {
    struct Case {
        name: &'static str,
        canonical: RuntimeInput,
        use_canonical: bool,
    }

    let cases = [
        Case {
            name: "absent",
            canonical: RuntimeInput::Absent,
            use_canonical: false,
        },
        Case {
            name: "canonical-empty",
            canonical: RuntimeInput::Empty,
            use_canonical: false,
        },
        Case {
            name: "canonical-absolute",
            canonical: RuntimeInput::Selected,
            use_canonical: true,
        },
    ];

    let root = tempfile::tempdir()?;
    for case in cases {
        let run_id = format!("runtime-env-{}", case.name);
        let fallback_dir = guest_contracts::runtime_paths::run_dir_for_home(
            root.path().join("process-home"),
            &run_id,
        )?;
        let canonical_dir = root
            .path()
            .join(format!("{}-canonical-must-not-leak", case.name));
        let expected_dir = if case.use_canonical {
            &canonical_dir
        } else {
            &fallback_dir
        };
        let private_files = write_private_files(expected_dir, false)?;
        let mut command = guest_agent_command(root.path(), &run_id, &private_files);
        apply_runtime_env(&mut command, input_value(case.canonical, &canonical_dir));

        let output = command_output(
            &mut command,
            &format!("{} runtime scenario did not finish", case.name),
        )
        .await?;
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert_eq!(output.status.code(), Some(1), "{}: {stderr}", case.name);
        assert!(
            stderr.contains("parse OKOU_RUN_PAYLOAD_FILE JSON"),
            "{}: {stderr}",
            case.name
        );

        let log = std::fs::read_to_string(guest_contracts::runtime_paths::system_log_file(
            expected_dir,
        ))?;
        assert_value_free(&stderr, &["canonical-must-not-leak"], case.name);
        assert_value_free(&log, &["canonical-must-not-leak"], case.name);
        if !case.use_canonical {
            assert!(!guest_contracts::runtime_paths::system_log_file(&canonical_dir).exists());
        }
    }

    Ok(())
}

#[tokio::test]
async fn guest_agent_preserves_a_non_unicode_canonical_runtime_override() -> TestResult {
    let root = tempfile::tempdir()?;
    let runtime_dir = root
        .path()
        .join(OsString::from_vec(b"canonical-runtime-\xff".to_vec()));
    let mut command = Command::new(std::env::current_exe()?);
    command
        .env_clear()
        .args([
            "--exact",
            NON_UNICODE_RUNTIME_CAPTURE_CHILD,
            "--ignored",
            "--nocapture",
        ])
        .env(NON_UNICODE_RUNTIME_PARENT_ENV, root.path());
    apply_runtime_env(&mut command, Some(runtime_dir.as_os_str()));

    let output = command_output(
        &mut command,
        "non-Unicode canonical runtime scenario did not finish",
    )
    .await?;
    assert!(
        output.status.success(),
        "isolated capture child failed with status {}\nstdout:\n{}\nstderr:\n{}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
    Ok(())
}

#[test]
#[ignore = "spawned exactly by the non-Unicode runtime capture parent test"]
fn guest_agent_captures_a_non_unicode_canonical_runtime_override_in_isolated_child() {
    let parent = PathBuf::from(
        std::env::var(NON_UNICODE_RUNTIME_PARENT_ENV)
            .expect("isolated capture child requires its Unicode runtime parent"),
    );
    let expected = parent.join(OsString::from_vec(b"canonical-runtime-\xff".to_vec()));
    let captured = guest_contracts::runtime_paths::guest_runtime_dir_env_from_process_env()
        .expect("isolated capture child should accept an absolute runtime override");

    assert_eq!(captured.as_deref(), Some(expected.as_path()));
}

#[tokio::test]
async fn guest_agent_rejects_relative_canonical_runtime_before_bootstrap_side_effects() -> TestResult
{
    let root = tempfile::tempdir()?;
    let run_id = "relative-runtime";
    let fallback_dir =
        guest_contracts::runtime_paths::run_dir_for_home(root.path().join("process-home"), run_id)?;
    let private_files = write_private_files(&fallback_dir, true)?;
    let process_endpoint = unique_endpoint(1);
    let workload_endpoint = unique_endpoint(2);
    let process_listener = process_control_ipc::bind_abstract_listener(&process_endpoint)?;
    let workload_listener = process_control_ipc::bind_abstract_listener(&workload_endpoint)?;
    let mut command = guest_agent_command(root.path(), run_id, &private_files);
    command.current_dir(root.path());
    apply_runtime_env(
        &mut command,
        Some(OsStr::new("relative-runtime-must-not-leak")),
    );
    command
        .env(
            process_control_ipc::CANONICAL_BOOTSTRAP_ENV,
            &process_endpoint,
        )
        .env(
            guest_contracts::process_containment::CANONICAL_WORKLOAD_CGROUP_PROCS_ENV,
            &workload_endpoint,
        )
        .env(
            guest_contracts::process_containment::CANONICAL_TOOL_CGROUP_PROCS_ENV,
            "tool-endpoint-must-not-leak",
        );

    let output = command_output(
        &mut command,
        "relative canonical runtime did not fail before bootstrap side effects",
    )
    .await?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(output.status.code(), Some(1), "stderr: {stderr}");
    assert!(stderr.contains("OKOU_GUEST_RUNTIME_DIR must be an absolute path"));
    assert_value_free(
        &stderr,
        &[
            "relative-runtime-must-not-leak",
            "tool-endpoint-must-not-leak",
            &process_endpoint,
            &workload_endpoint,
        ],
        "relative canonical runtime",
    );
    assert_listener_idle(&process_listener, "process-control socket")?;
    assert_listener_idle(&workload_listener, "workload placement socket")?;
    assert!(private_files.user_env_path.exists());
    assert!(private_files.run_payload_path.exists());
    let relative_dir = root.path().join("relative-runtime-must-not-leak");
    assert!(!guest_contracts::runtime_paths::system_log_file(&relative_dir).exists());
    assert!(!guest_contracts::runtime_paths::sandbox_ops_log_file(&relative_dir).exists());
    Ok(())
}
