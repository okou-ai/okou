//! First-completion attribution with a genuinely exhausted private home mount.

use super::*;
use std::fs::File;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

const CHILD_ENV: &str = "OKOU_TEST_FULL_HOME_COMPLETION_CHILD";
const TEST_NAME: &str =
    "tests::disk_failure::first_completion_attributes_disk_full_without_writable_diagnostics";
const HOME_BYTES: u64 = 8 * 1024 * 1024;
const TMPFS_MAGIC: rustix::fs::FsWord = 0x0102_1994;
const ENOSPC_MESSAGE: &str = "ENOSPC: no space left on device, write";
const SESSION_ID: &str = "48210000-0000-4000-8000-000000000001";

// Both mounts exist only in the child namespace. Preserve the original home
// first because Cargo may have placed this test executable below /home/user.
const PRIVATE_HOME_CHILD: &str = r#"
set -eu
/usr/bin/mount --make-rprivate /
/usr/bin/mount --bind /home/user "$OKOU_TEST_ORIGINAL_HOME"
/usr/bin/mount -t tmpfs -o size=8m,nr_inodes=256 tmpfs /home/user
exec "$OKOU_TEST_BINARY" --ignored --exact "$OKOU_TEST_NAME" --test-threads=1 --nocapture
"#;

#[test]
#[ignore = "requires private mount namespaces; selected by guest-home-cleanup-test CI"]
fn first_completion_attributes_disk_full_without_writable_diagnostics() -> TestResult {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    if std::env::var_os(CHILD_ENV).is_some() {
        let _test_state_guard = lock_test_state();
        return runtime.block_on(assert_full_home_completions());
    }

    let output = runtime.block_on(run_private_home_child())?;
    assert!(
        output.status.success(),
        "private-home completion failed: {}\nstdout: {}\nstderr: {}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(())
}

async fn run_private_home_child() -> TestResult<std::process::Output> {
    // The preserved binary alias must survive replacement of /home/user even
    // when the caller puts its ordinary temporary files on that home mount.
    let root = tempfile::tempdir_in("/tmp")?;
    let home = Path::new("/home/user");
    std::fs::create_dir_all(home)?;
    let original_home = root.path().join("original-home");
    std::fs::create_dir(&original_home)?;
    let binary = std::env::current_exe()?;
    let child_binary = match binary.strip_prefix(home) {
        Ok(relative) => original_home.join(relative),
        Err(_) => binary,
    };
    let mut command = tokio::process::Command::new("/usr/bin/unshare");
    command
        .env_clear()
        .current_dir(root.path())
        .env("PATH", "/usr/bin:/bin")
        .env(CHILD_ENV, "1")
        .env("OKOU_TEST_ORIGINAL_HOME", &original_home)
        .env("OKOU_TEST_BINARY", child_binary)
        .env("OKOU_TEST_NAME", TEST_NAME)
        .args([
            "--user",
            "--map-root-user",
            "--mount",
            "/bin/sh",
            "-c",
            PRIVATE_HOME_CHILD,
        ]);
    Ok(cli_test_support::command::command_output_with_timeout(
        &mut command,
        Duration::from_secs(30),
        "private-home completion exceeded its test budget",
    )
    .await?)
}

async fn assert_full_home_completions() -> TestResult {
    let server = &*COMPLETE_EXECUTION_MOCK_SERVER;
    server.reset_async().await;
    let _runtime_root_guard = TestRuntimeRootGuard::new();
    let scratch = tempfile::tempdir()?;
    let _system_log = SystemLogOverrideGuard::set(&scratch.path().join("system.log"));
    let _sandbox_ops = SandboxOpsOverrideGuard::set(scratch.path().join("sandbox-ops.jsonl"));

    let guest_paths = paths::GuestPaths::from_runtime_dir(
        "/home/user/.vm0/guest-agent/runs/full-home-completion",
    );
    paths::write_private(guest_paths.finalization_error_file(), "")?;
    paths::write_private(guest_paths.failure_diagnostic_file(), "")?;
    let session_path = native_pi_history()?;
    let native_history = std::fs::read(&session_path)?;
    let metadata = session_metadata::CapturedSessionMetadata::for_test(SESSION_ID);
    let mut config = test_guest_config(server, Some("continue after the tool failure"));
    config.framework = env::Framework::Pi;
    config.cli_agent_type = "pi".to_string();
    fill_private_home()?;

    // These are the production diagnostic destinations. Both writes really
    // fail, so no terminal cause can be recovered from either local artifact.
    for path in [
        guest_paths.finalization_error_file(),
        guest_paths.failure_diagnostic_file(),
    ] {
        let error = paths::write_private(path, ENOSPC_MESSAGE)
            .err()
            .ok_or_else(|| io::Error::other("full-home diagnostic write unexpectedly succeeded"))?;
        assert_eq!(error.raw_os_error(), Some(libc::ENOSPC));
    }

    // Reuse this one exhausted filesystem to retain the existing cause
    // precedence and successful/cancelled completion contracts under pressure.
    for (index, (label, exit_code, reason, termination, expected_reason)) in [
        (
            "disk-full",
            1,
            None,
            None,
            Some("guest_home_filesystem_full"),
        ),
        (
            "provider-rate-limit",
            1,
            Some(FailureReason::ProviderRateLimited),
            None,
            Some("provider_rate_limited"),
        ),
        (
            "timeout",
            AGENT_EXECUTION_TIMEOUT_EXIT_CODE,
            Some(FailureReason::ExecutionTimeout),
            Some(CliTerminationReason::ExecutionTimeout),
            Some("execution_timeout"),
        ),
        (
            "cancelled",
            1,
            None,
            Some(CliTerminationReason::UserCancellation),
            None,
        ),
        ("completed", 0, None, None, None),
    ]
    .into_iter()
    .enumerate()
    {
        let mut config = config.clone();
        let run_id = format!("48210000-0000-4000-8000-{index:012}");
        config.run_id.clone_from(&run_id);
        let mut diagnostic = FailureDiagnostic::new(
            FailureClass::CliNonzero,
            AgentFramework::Pi,
            PromptMetadata::from_prompt(&config.prompt),
        )
        .with_cli_exit_code(exit_code)
        .with_failure_detail_source(FailureDetailSource::PiResult);
        if let Some(reason) = reason {
            diagnostic = diagnostic.with_failure_reason(reason);
        }
        if let Some(termination) = termination {
            diagnostic =
                diagnostic.with_cli_termination(CliTerminationDiagnostic::new(termination));
        }
        let request = record_first_completion(
            server,
            &guest_paths,
            config,
            &metadata,
            exit_code,
            (exit_code != 0).then_some(diagnostic),
        )
        .await?;
        assert_eq!(request["runId"], run_id, "{label}");
        assert_eq!(request["exitCode"], exit_code);
        assert_eq!(
            request
                .get("failureReason")
                .and_then(serde_json::Value::as_str),
            expected_reason,
            "{label}"
        );
        assert_eq!(request["completion"]["cliAgentType"], "pi");
        assert_eq!(request["completion"]["cliAgentSessionId"], SESSION_ID);
        assert_eq!(
            request["completion"]["cliAgentSessionHistoryDisposition"],
            "native_only"
        );
    }

    assert_eq!(std::fs::read(session_path)?, native_history);
    assert!(std::fs::read(guest_paths.finalization_error_file())?.is_empty());
    assert!(std::fs::read(guest_paths.failure_diagnostic_file())?.is_empty());
    Ok(())
}

fn native_pi_history() -> TestResult<PathBuf> {
    let directory =
        Path::new(api_contracts::generated::constants::runners::paths::CANONICAL_PI_SESSION_DIR);
    std::fs::create_dir_all(directory)?;
    let path = directory.join(format!("{SESSION_ID}.jsonl"));
    let header = json!({
        "type": "session",
        "version": 3,
        "id": SESSION_ID,
        "timestamp": "2026-11-17T07:02:27Z",
        "cwd": paths::CANONICAL_WORKING_DIR,
    });
    std::fs::write(&path, format!("{header}\n"))?;
    Ok(path)
}

fn fill_private_home() -> TestResult {
    let root_capacity = rustix::fs::fstatvfs(File::open("/")?)?;
    assert!(root_capacity.f_bavail * root_capacity.f_frsize > 1024 * 1024);
    let home = File::open("/home/user")?;
    assert_eq!(rustix::fs::fstatfs(&home)?.f_type, TMPFS_MAGIC);
    let capacity = rustix::fs::fstatvfs(&home)?;
    assert_eq!(capacity.f_blocks * capacity.f_frsize, HOME_BYTES);
    let mut filler = File::create("/home/user/pressure")?;
    let block = [0u8; 4096];
    for _ in 0..=HOME_BYTES / 4096 {
        if let Err(error) = filler.write_all(&block) {
            assert_eq!(error.raw_os_error(), Some(libc::ENOSPC));
            assert_eq!(rustix::fs::fstatvfs(&home)?.f_bavail, 0);
            return Ok(());
        }
    }
    Err(io::Error::other("private home did not reach ENOSPC within its size bound").into())
}

async fn record_first_completion(
    server: &MockServer,
    guest_paths: &paths::GuestPaths,
    config: env::GuestConfig,
    metadata: &session_metadata::CapturedSessionMetadata,
    exit_code: i32,
    diagnostic: Option<FailureDiagnostic>,
) -> TestResult<serde_json::Value> {
    server.reset_async().await;
    let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
    let recorded = Arc::clone(&requests);
    let complete = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/run/complete");
        then.respond_with(move |request| {
            recorded
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(request.body_vec());
            HttpMockResponse::builder()
                .status(200)
                .header("Content-Type", "application/json")
                .body(if exit_code == 0 {
                    r#"{"success":true,"status":"completed"}"#
                } else {
                    r#"{"success":true,"status":"failed"}"#
                })
                .build()
        });
    });
    let _telemetry = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/run/telemetry");
        then.status(200).json_body(json!({}));
    });
    let masker = Arc::new(masker::SecretMasker::from_config(&config));
    let http = test_http_client(server);
    let telemetry = Telemetry::spawn_for_paths(
        config.run_id.clone(),
        guest_paths,
        Arc::clone(&masker),
        http.clone(),
    );
    let runtime = GuestRuntime {
        config,
        paths: guest_paths.clone(),
        http,
        workload_containment: None,
        process_control_endpoint: None,
    };
    let (actual_exit, _) = complete_execution(
        &masker,
        exit_code,
        exit_code,
        Duration::ZERO,
        CompletionState {
            last_event_sequence: Some(23),
            failure_message: (exit_code != 0).then_some(ENOSPC_MESSAGE),
            failure_diagnostic: diagnostic,
            session_metadata: Some(metadata),
        },
        &telemetry,
        &runtime,
    )
    .await;
    telemetry.shutdown().await;
    assert_eq!(actual_exit, exit_code);
    complete.assert_calls_async(1).await;
    let requests = requests
        .lock()
        .map_err(|_| io::Error::other("completion recorder was poisoned"))?;
    let [first] = requests.as_slice() else {
        return Err(io::Error::other("expected exactly the first completion request").into());
    };
    Ok(serde_json::from_slice(first)?)
}
