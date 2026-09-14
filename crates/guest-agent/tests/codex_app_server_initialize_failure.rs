//! Real subprocess coverage for initialization failure diagnostics and ownership.

mod common;

use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine;
use guest_agent::cli::codex_app_server::{
    CodexAppServerClient, CodexAppServerConfig, CodexAppServerError,
};
use guest_agent::env::{GuestConfig, GuestConfigRaw};
use guest_agent::error::AgentError;
use guest_agent::masker::SecretMasker;
use guest_agent::run_context::GuestRuntime;

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;
const TEST_TIMEOUT: Duration = Duration::from_secs(5);

#[tokio::test]
async fn initialize_eof_preserves_already_observable_exit() -> TestResult {
    for pidfd in [true, false] {
        for (exit, expected) in [
            ("exit 23", "exit status: 23"),
            ("exit 0", "exit status: 0"),
            ("kill -TERM \"$$\"", "signal: 15"),
        ] {
            let root = tempfile::tempdir()?;
            let binary = write_server(
                root.path(),
                &format!("printf 'initialize evidence\\n' >&2\nkill -STOP \"$$\"\n{exit}"),
            )?;
            let mut config = client_config(&binary, root.path());
            if !pidfd {
                config = config.without_pidfd_exit_notification();
            }
            let mut client = CodexAppServerClient::spawn(config)?;
            let pid = client.process_id().ok_or("missing child PID")?;
            let error = {
                let initialize = client.initialize();
                tokio::pin!(initialize);
                // Stop after reading initialize, then resume only the child. Both
                // EOF and exit must be ready before polling initialize again.
                tokio::select! {
                    result = &mut initialize => panic!("initialize completed before release: {result:?}"),
                    stopped = wait_for_state(pid, 'T') => stopped?,
                }
                let signal_pid = rustix::process::Pid::from_raw(i32::try_from(pid)?)
                    .ok_or("invalid child PID")?;
                rustix::process::kill_process(signal_pid, rustix::process::Signal::CONT)?;
                wait_for_state(pid, 'Z').await?;
                tokio::time::timeout(TEST_TIMEOUT, initialize)
                    .await?
                    .unwrap_err()
            };
            let cleanup = tokio::time::timeout(TEST_TIMEOUT, client.terminate()).await?;
            cleanup?;
            assert!(client.process_id().is_none());
            assert_eq!(client.stderr_tail(), ["initialize evidence"]);
            match error {
                CodexAppServerError::ChildExited { method, status } => {
                    assert_eq!(method, "initialize");
                    assert!(status.contains(expected), "unexpected status: {status}");
                }
                other => panic!("lost observed exit (pidfd={pidfd}, {exit}): {other}"),
            }
        }
    }
    Ok(())
}

#[tokio::test]
async fn initialize_eof_while_alive_does_not_report_cleanup_signal() -> TestResult {
    let root = tempfile::tempdir()?;
    let binary = write_server(
        root.path(),
        "printf 'stdout closed while alive\\n' >&2\nexec 1>&-\nIFS= read -r next_request",
    )?;
    let mut client = CodexAppServerClient::spawn(client_config(&binary, root.path()))?;
    let error = tokio::time::timeout(TEST_TIMEOUT, client.initialize())
        .await?
        .unwrap_err();
    tokio::time::timeout(TEST_TIMEOUT, client.terminate()).await??;
    assert!(client.process_id().is_none());
    assert!(
        matches!(&error, CodexAppServerError::Disconnected { method } if method == "initialize")
    );
    assert!(
        error
            .to_string()
            .contains("child exit not observed before cleanup")
    );
    assert_eq!(client.stderr_tail(), ["stdout closed while alive"]);
    Ok(())
}

#[tokio::test]
async fn backend_retains_masked_bounded_initialize_stderr() -> TestResult {
    let root = tempfile::tempdir()?;
    let binary = write_server(
        root.path(),
        "/bin/cat \"$CODEX_HOME/stderr-fixture\" >&2\nexit 23",
    )?;
    let secret = "fixture-private-token";
    std::fs::write(
        root.path().join("stderr-fixture"),
        format!(
            "{}\ninitialize rejected token={secret}\n",
            "界".repeat(2000)
        ),
    )?;
    let runtime = backend_runtime(root.path(), &binary)?;
    let encoded_secret = base64::engine::general_purpose::STANDARD.encode(secret);
    let error = tokio::time::timeout(
        TEST_TIMEOUT,
        common::execute_cli_for_runtime(&runtime, &SecretMasker::from_raw(&encoded_secret), None),
    )
    .await?
    .unwrap_err();
    assert!(matches!(error, AgentError::Execution(_)));
    let message = error.to_string();
    assert!(message.contains("waiting for initialize"), "{message}");
    let (_, stderr) = message
        .split_once("; stderr tail: ")
        .ok_or("missing stderr tail")?;
    assert!(stderr.len() <= 4096, "stderr exceeded output budget");
    assert!(stderr.starts_with("[truncated] "));
    assert!(stderr.contains("initialize rejected token=***"), "{stderr}");
    assert!(!stderr.contains(secret));
    assert!(!stderr.contains('\n'));
    let requests = std::fs::read_to_string(root.path().join("requests"))?;
    let requests: Vec<serde_json::Value> = requests
        .lines()
        .map(serde_json::from_str)
        .collect::<Result<_, _>>()?;
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["method"], "initialize");
    Ok(())
}

fn client_config(binary: &Path, home: &Path) -> CodexAppServerConfig {
    CodexAppServerConfig::new(binary, home).with_child_env(
        home.to_string_lossy(),
        &HashMap::new(),
        "http://127.0.0.1:1",
    )
}

fn write_server(root: &Path, action: &str) -> TestResult<PathBuf> {
    let binary = root.join("codex-fixture");
    std::fs::write(
        &binary,
        format!(
            "#!/bin/sh\nset -eu\nIFS= read -r request\nprintf '%s\\n' \"$request\" >> \"$CODEX_HOME/requests\"\n{action}\n"
        ),
    )?;
    std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700))?;
    Ok(binary)
}

async fn wait_for_state(pid: u32, expected: char) -> TestResult {
    tokio::time::timeout(TEST_TIMEOUT, async {
        loop {
            let stat = tokio::fs::read_to_string(format!("/proc/{pid}/stat")).await?;
            let (_, fields) = stat.rsplit_once(") ").ok_or("invalid process stat")?;
            if fields.starts_with(expected) {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await?
}

fn backend_runtime(root: &Path, binary: &Path) -> TestResult<GuestRuntime> {
    let runtime_dir = root.join("runtime");
    let payload = common::write_run_payload_file_for_test(
        &runtime_dir,
        &guest_contracts::env::RunPayload {
            prompt: "initialize failure fixture".to_string(),
            ..Default::default()
        },
    )?;
    let mut config = GuestConfig::from_raw(GuestConfigRaw {
        run_id: "initialize-failure".to_string(),
        api_url: "http://127.0.0.1:1".to_string(),
        sandbox_id: "00000000-0000-4000-8000-000000000abc".to_string(),
        sandbox_reuse_result: "reused".to_string(),
        cli_agent_type: "codex".to_string(),
        use_mock_codex: "true".to_string(),
        mock_codex_path: Some(binary.to_string_lossy().into_owned()),
        home: Some(root.to_string_lossy().into_owned()),
        guest_runtime_dir: Some(runtime_dir.clone()),
        run_payload_file: payload.to_string_lossy().into_owned(),
        ..Default::default()
    })
    .map_err(std::io::Error::other)?;
    config.codex_home_dir = root.to_string_lossy().into_owned();
    let http = guest_agent::http::HttpClient::for_config(&config)?;
    Ok(GuestRuntime {
        config,
        paths: guest_agent::paths::GuestPaths::from_runtime_dir(runtime_dir),
        http,
        workload_containment: None,
        process_control_endpoint: None,
    })
}
