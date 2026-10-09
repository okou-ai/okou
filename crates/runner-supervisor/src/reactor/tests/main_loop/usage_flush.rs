use super::super::super::*;
use super::super::support::{
    minimal_context, mock_run_config, mock_run_config_with_api_url, push_job, shutdown,
    test_profiles, wait_discover_entered, wait_usage_flush_requested,
};
use std::sync::Arc;

async fn install_usage_flush_child(
    config: &mut RunConfig,
    hold_flush_reply: bool,
) -> tokio::io::Lines<tokio::io::BufReader<tokio::process::ChildStdout>> {
    use std::os::unix::fs::PermissionsExt;
    use tokio::io::AsyncBufReadExt;

    let directory = config.paths.base_dir.join("addon-control");
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
    config
        .proxy
        .mitm
        .set_control_directory_for_test(directory.clone());
    let mut child = tokio::process::Command::new("python3")
        .arg("-u").arg("-c").arg(r#"
import json, os, socket, struct, sys, threading, time
from pathlib import Path
root = Path(sys.argv[1])
hold = sys.argv[2] == 'true'
fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
listener.bind(f'/proc/self/fd/{fd}/control.sock')
listener.listen(8)

def read_exact(conn, size):
    result = b''
    while len(result) < size:
        data = conn.recv(size - len(result))
        if not data:
            raise EOFError()
        result += data
    return result

def handle(conn):
    with conn:
        conn.settimeout(5)
        size, = struct.unpack('!I', read_exact(conn, 4))
        req = json.loads(read_exact(conn, size))
        assert req['generation'] == 'test-usage-state-id'
        method = req['method']
        if method == 'delivery.flush':
            assert req['params'] == {}
            print('flush-received', flush=True)
            until = time.monotonic() + 5
            while hold and not (root / 'release').exists():
                assert time.monotonic() < until
                time.sleep(0.01)
            data = {'state': 'admitted'}
        elif method == 'delivery.drain':
            data = {'state': 'quiescent', 'snapshot': {
                'flows': 0, 'buffered': 0, 'reports': 0,
                'workerActive': False, 'wakePending': False, 'closed': False,
                'drainActive': True, 'flushFailures': 0,
                'outcomes': {'success': 0, 'retryable_failure': 0, 'permanent_failure': 0}}}
        elif method == 'logs.flush':
            params = req['params']
            path = Path(params['path'])
            assert path.name == 'network-' + params['runId'] + '.jsonl'
            with path.open('a') as output:
                output.write(json.dumps({'timestamp':'2026-01-01T00:00:02Z', 'type':'dns', 'host':'addon.example', 'port':53}) + '\n')
            data = dict(params, boundary=1, pending=0, state='processed')
        else:
            raise AssertionError(method)
        payload = json.dumps({'requestId':req['requestId'], 'generation':req['generation'], 'type':'result', 'data':data}).encode()
        conn.sendall(struct.pack('!I', len(payload)) + payload)
print('ready', flush=True)
while True:
    conn, _ = listener.accept()
    threading.Thread(target=handle, args=(conn,), daemon=True).start()
"#)
        .arg(directory).arg(hold_flush_reply.to_string())
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped())
        .kill_on_drop(true).spawn().unwrap();
    let mut lines = tokio::io::BufReader::new(child.stdout.take().unwrap()).lines();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), lines.next_line())
            .await
            .unwrap()
            .unwrap()
            .as_deref(),
        Some("ready")
    );
    config.proxy.mitm.set_child_for_test(child);
    lines
}

#[tokio::test]
async fn job_completion_requests_proxy_usage_flush_without_waiting() {
    let (mut config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let mut child_lines = install_usage_flush_child(&mut config, true).await;
    let release = config.paths.base_dir.join("addon-control/release");
    let run_handle = tokio_util::task::AbortOnDropHandle::new(tokio::spawn(run(config)));
    wait_discover_entered(&env, Duration::from_secs(2)).await;
    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    assert!(
        env.handle
            .wait_completion(run_id, Duration::from_secs(5))
            .await
            .is_some(),
        "job completion must not wait for proxy delivery"
    );
    wait_usage_flush_requested(&env, Duration::from_secs(5)).await;
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), child_lines.next_line())
            .await
            .unwrap()
            .unwrap()
            .as_deref(),
        Some("flush-received")
    );
    // The real control request reached the child, but its reply is still held.
    std::fs::write(release, b"release").unwrap();
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
    // Keep the control peer's diagnostic pipe open until the child is stopped.
    let _child_lines = install_usage_flush_child(&mut config, false).await;
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
}
