use super::super::super::*;
use super::super::support::{
    minimal_context, mock_run_config, mock_run_config_with_api_url, push_job, shutdown,
    test_profiles, wait_discover_entered, wait_usage_flush_requested,
};
use std::sync::Arc;

fn usage_pending_path(base_dir: &std::path::Path) -> std::path::PathBuf {
    base_dir.join("mitm-addon").join("usage-pending")
}

fn usage_test_now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn write_usage_pending_state(
    base_dir: &std::path::Path,
    usage_state_id: &str,
    flows: u32,
    buffered: u32,
    reports: u32,
) {
    let addon_dir = base_dir.join("mitm-addon");
    std::fs::create_dir_all(&addon_dir).unwrap();
    std::fs::write(
        usage_pending_path(base_dir),
        serde_json::json!({
            "pid": std::process::id(),
            "usageStateId": usage_state_id,
            "updatedAtMs": usage_test_now_millis(),
            "flows": flows,
            "buffered": buffered,
            "reports": reports,
        })
        .to_string(),
    )
    .unwrap();
}

async fn install_usage_flush_child(
    config: &mut RunConfig,
) -> tokio::io::Lines<tokio::io::BufReader<tokio::process::ChildStdout>> {
    use tokio::io::AsyncBufReadExt;

    std::fs::create_dir_all(config.paths.base_dir.join("mitm-addon")).unwrap();
    let mut child = tokio::process::Command::new("bash")
        .arg("-c")
        .arg(
            r#"
set -euo pipefail
base_dir="$1"
fifo="$base_dir/usage-flush-child.fifo"
request="$base_dir/mitm-addon/usage-flush-request"
pending="$base_dir/mitm-addon/usage-pending"
write_pending_snapshot() {
  [[ -f "$request" ]] || return 0
  flush_id="$(sed -n 's/.*"flushRequestId":"\([^"]*\)".*/\1/p' "$request")"
  state_id="$(sed -n 's/.*"usageStateId":"\([^"]*\)".*/\1/p' "$request")"
  [[ -n "$flush_id" && -n "$state_id" ]] || return 0
  now_ms="$(date +%s%3N)"
  printf '{"pid":%s,"usageStateId":"%s","updatedAtMs":%s,"flows":0,"buffered":0,"reports":0,"flushRequestId":"%s"}' "$$" "$state_id" "$now_ms" "$flush_id" > "$pending"
}
mkfifo "$fifo"
exec 3<>"$fifo"
# SIGUSR1 only wakes the usage work owned by this external process.
trap 'printf "signaled\n"; printf "\n" >&3' USR1
trap 'exit 0' TERM
echo ready
while true; do
  if read -r -t 0.05 _ <&3; then
    write_pending_snapshot
  fi
done
"#,
        )
        .arg("usage-flush-child")
        .arg(&config.paths.base_dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let mut ready_lines = tokio::io::BufReader::new(stdout).lines();
    let ready = tokio::time::timeout(Duration::from_secs(2), ready_lines.next_line())
        .await
        .expect("usage flush child did not print ready")
        .unwrap()
        .expect("usage flush child stdout closed before ready");
    assert_eq!(ready, "ready");
    config.proxy.mitm.set_child_for_test(child);
    ready_lines
}

#[tokio::test]
async fn job_completion_requests_proxy_usage_flush_without_waiting() {
    let (mut config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let mut child_lines = install_usage_flush_child(&mut config).await;
    let usage_state_id = config.proxy.mitm.usage_state_id_for_test().to_string();
    write_usage_pending_state(&config.paths.base_dir, &usage_state_id, 0, 0, 1);
    let base_dir = config.paths.base_dir.clone();
    let run_handle = tokio_util::task::AbortOnDropHandle::new(tokio::spawn(run(config)));

    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(
        completion.is_some(),
        "job completion must not wait for proxy usage drain"
    );
    wait_usage_flush_requested(&env, Duration::from_secs(5)).await;

    // The observer precedes the signal call. Require receipt in the child
    // before shutdown can independently signal it or usage delivery is released.
    let signaled = tokio::time::timeout(Duration::from_secs(5), child_lines.next_line())
        .await
        .expect("proxy child must receive SIGUSR1 after job completion")
        .unwrap();
    assert_eq!(signaled.as_deref(), Some("signaled"));
    let pending: serde_json::Value =
        serde_json::from_slice(&std::fs::read(usage_pending_path(&base_dir)).unwrap()).unwrap();
    assert_eq!(
        pending["reports"], 1,
        "job completion and signal receipt must not require usage delivery"
    );

    write_usage_pending_state(&base_dir, &usage_state_id, 0, 0, 0);
    shutdown(&env, run_handle.detach()).await;
}

/// Regression guard: the post-complete deferred network-log upload (moved
/// out of `post_job_cleanup` by #9828) must still reach the telemetry
/// endpoint, AND the drain shutdown must actually block on it — catching a
/// `tokio::spawn` fire-and-forget refactor that would silently lose the
/// upload on runtime drop.
///
/// Hold the response to an observed upload until the runner reaches its
/// running-job drain. The runner must not pass that drain until the test
/// releases the response, regardless of scheduling before shutdown.
#[tokio::test]
async fn deferred_network_log_upload_drains_after_stopping_signal() {
    use crate::test_fixtures::raw_http::{json_response, read_http_request};
    use futures_util::FutureExt;
    use tokio::io::AsyncWriteExt;

    const WAIT: Duration = Duration::from_secs(5);
    const RESPONSE_BODY: &str = r#"{"success":true,"id":"ok"}"#;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let api_url = format!("http://{}", listener.local_addr().unwrap());
    let (upload_tx, mut uploads) = tokio::sync::mpsc::unbounded_channel();
    let (stop_server, mut server_stopped) = tokio::sync::oneshot::channel();
    // JoinSet owns the server even when an assertion fails. Handing the
    // unanswered socket to the test leaves other telemetry free to finish.
    let mut server_tasks = tokio::task::JoinSet::new();
    server_tasks.spawn(async move {
        loop {
            let (mut socket, _) = tokio::select! {
                _ = &mut server_stopped => break,
                accepted = listener.accept() => accepted.unwrap(),
            };
            let request = read_http_request(&mut socket).await.unwrap();
            assert!(request.starts_with("POST /api/webhooks/agent/telemetry "));
            let (_, body) = request.split_once("\r\n\r\n").unwrap();
            let payload: serde_json::Value = serde_json::from_str(body).unwrap();
            if payload.get("networkLogs").is_some() {
                upload_tx.send((socket, payload)).unwrap();
            } else {
                assert!(payload["sandboxOperations"].is_array());
                tokio::time::timeout(
                    WAIT,
                    socket.write_all(&json_response("200 OK", RESPONSE_BODY)),
                )
                .await
                .unwrap()
                .unwrap();
            }
        }
    });

    let (mut config, env) = mock_run_config_with_api_url(test_profiles(), 8, 32768, 4, &api_url);
    // Keep the signal acknowledgement pipe open until the child is stopped.
    let _child_lines = install_usage_flush_child(&mut config).await;
    let addon_dir = config.paths.base_dir.join("mitm-addon");
    std::fs::set_permissions(
        &addon_dir,
        std::os::unix::fs::PermissionsExt::from_mode(0o700),
    )
    .unwrap();
    config
        .proxy
        .mitm
        .set_control_directory_for_test(addon_dir.clone());
    let mitm_jsonl_flush = config.proxy.mitm.jsonl_flush_handle();
    let write_started = Arc::new(tokio::sync::Notify::new());
    let release_write = Arc::new(tokio::sync::Semaphore::new(0));
    let network_log_manager =
        NetworkLogManager::new_with_write_gate(write_started.clone(), release_write.clone());
    let exec_config = Arc::get_mut(&mut config.exec_config)
        .expect("test config should not share exec_config before run starts");
    exec_config.network_log_manager = network_log_manager.clone();
    exec_config.mitm_jsonl_flush = Some(mitm_jsonl_flush);

    // Seed a network log file so `upload_network_logs` has a payload to POST
    // (otherwise it early-returns on NotFound).
    let run_id = RunId::new_v4();
    let mut addon_tasks = tokio::task::JoinSet::new();
    let addon_listener = tokio::net::UnixListener::bind(addon_dir.join("control.sock")).unwrap();
    let addon_path = config.exec_config.log_paths.network_log(run_id);
    addon_tasks.spawn(async move {
        use tokio::io::AsyncReadExt;
        let (mut socket, _) = addon_listener.accept().await.unwrap();
        let size = socket.read_u32().await.unwrap() as usize;
        assert!(size <= 64 * 1024);
        let mut bytes = vec![0; size];
        socket.read_exact(&mut bytes).await.unwrap();
        let request: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(request["method"], "logs.flush");
        assert_eq!(request["params"]["runId"], run_id.to_string());
        assert_eq!(request["params"]["path"], addon_path.to_string_lossy().as_ref());
        // Model the external addon boundary: this record becomes available only
        // after the deferred upload sends the exact run's flush request.
        let mut file = tokio::fs::OpenOptions::new().append(true).open(&addon_path).await.unwrap();
        file.write_all(br#"{"timestamp":"2026-01-01T00:00:02Z","type":"dns","host":"addon.example","port":53}
"#).await.unwrap();
        file.flush().await.unwrap();
        let response = serde_json::to_vec(&serde_json::json!({
            "requestId": request["requestId"], "generation": request["generation"],
            "type": "result", "data": {
                "runId": run_id, "path": addon_path, "boundary": 1, "pending": 0, "state": "processed"
            }
        })).unwrap();
        socket.write_u32(response.len() as u32).await.unwrap();
        socket.write_all(&response).await.unwrap();
    });
    let network_log_path = config.exec_config.log_paths.network_log(run_id);
    std::fs::create_dir_all(network_log_path.parent().unwrap()).unwrap();
    std::fs::write(
            &network_log_path,
            concat!(
                r#"{"timestamp":"2026-01-01T00:00:00","action":"ALLOW","host":"example.com","method":"GET","url":"https://example.com/","status":200}"#,
                "\n",
            ),
        )
        .unwrap();
    let _network_log_session = network_log_manager
        .register_source_ip("10.200.0.200", network_log_path.clone())
        .await;
    assert!(
        network_log_manager
            .append_for_ip(
                "10.200.0.200",
                serde_json::json!({
                    "timestamp": "2026-01-01T00:00:01Z",
                    "type": "dns",
                    "host": "pending.example",
                    "port": 53,
                }),
            )
            .await
    );
    tokio::time::timeout(WAIT, write_started.notified())
        .await
        .expect("accepted network-log write should reach its gate");

    // Poll the real runner directly, without cooperative-budget yields that
    // could make a ready job completion look like an unfinished drain.
    let mut runner = Box::pin(tokio::task::unconstrained(run(config)));
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    // The finalizer now closes Rust-side network-log attribution before
    // completing the job, so release the accepted write before waiting for
    // completion. The upload itself is still deferred until after the
    // completion request below.
    release_write.add_permits(1);
    tokio::select! {
        result = &mut runner => panic!("runner exited before job completion: {result:?}"),
        completion = env.handle.wait_completion(run_id, WAIT) => {
            assert!(completion.is_some(), "job should complete");
        }
    }

    let (mut upload_socket, payload) = tokio::select! {
        result = &mut runner => panic!("runner exited before the upload request: {result:?}"),
        upload = tokio::time::timeout(WAIT, uploads.recv()) => {
            upload.expect("network-log upload should start")
                .expect("HTTP server should retain the upload response")
        }
    };
    assert_eq!(payload["runId"], run_id.to_string());
    let logs = payload["networkLogs"].as_array().unwrap();
    assert_eq!(logs.len(), 3);
    assert_eq!(logs[0]["host"], "example.com");
    assert_eq!(logs[1]["host"], "pending.example");
    assert_eq!(logs[2]["host"], "addon.example");

    // The job has reported completion; teardown must still join its deferred
    // upload. Enter Stopping through the real signal handler. Combining natural
    // drain with discovery cancellation races: a Draining reactor disables
    // discovery and cannot reach teardown until this held upload is released.
    env.trigger_stopping().await;
    tokio::select! {
        // Consume ready runner work before checking the retained entry event.
        biased;
        result = &mut runner => panic!("runner exited with the upload response held: {result:?}"),
        () = env.start_observer.wait_for(WAIT, "running-job drain", |event| {
            matches!(event, StartLoopEvent::RunningJobsDrainEntered).then_some(())
        }) => {}
    }
    assert!(
        env.start_observer
            .wait_destroy_tasks_drain_entered(WAIT)
            .now_or_never()
            .is_none(),
        "runner must not pass the running-job drain while the upload response is held",
    );

    tokio::time::timeout(
        WAIT,
        upload_socket.write_all(&json_response("200 OK", RESPONSE_BODY)),
    )
    .await
    .expect("held upload response should be writable")
    .unwrap();
    drop(upload_socket);
    tokio::time::timeout(Duration::from_secs(10), runner)
        .await
        .expect("runner should finish after the upload response is released")
        .unwrap();

    assert!(
        matches!(
            uploads.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ),
        "network logs should be uploaded exactly once",
    );
    stop_server.send(()).unwrap();
    tokio::time::timeout(WAIT, server_tasks.join_next())
        .await
        .expect("HTTP server should stop")
        .unwrap()
        .unwrap();

    tokio::time::timeout(WAIT, addon_tasks.join_next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}
