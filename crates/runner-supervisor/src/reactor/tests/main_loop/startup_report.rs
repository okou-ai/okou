use super::super::super::*;
use super::super::support::{
    minimal_context, mock_run_config_with_overrides_and_api_url, push_job, test_profiles,
    wait_budget_count,
};
use crate::test_fixtures::raw_http::{json_response, read_http_request};
use futures_util::FutureExt;
use tokio::io::AsyncWriteExt;

#[tokio::test]
async fn startup_report_drains_after_completion_and_resource_release() {
    const WAIT: Duration = Duration::from_secs(5);
    let run_id = RunId::new_v4();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let api_url = format!("http://{}", listener.local_addr().unwrap());
    let (report_tx, mut reports) = tokio::sync::mpsc::unbounded_channel();
    let (stop_server, mut server_stopped) = tokio::sync::oneshot::channel();
    let mut server_tasks = tokio::task::JoinSet::new();
    server_tasks.spawn(async move {
        loop {
            let (mut socket, _) = tokio::select! {
                _ = &mut server_stopped => break,
                accepted = listener.accept() => accepted.unwrap(),
            };
            let request = read_http_request(&mut socket).await.unwrap();
            let (_, body) = request.split_once("\r\n\r\n").unwrap();
            let payload: serde_json::Value = serde_json::from_str(body).unwrap();
            if request.starts_with(&format!("PUT /api/runners/runs/{run_id}/startup ")) {
                assert_eq!(payload, serde_json::json!({ "sandboxStartupPath": "cold" }));
                // Retain just the unanswered startup socket; other delivery can progress.
                report_tx.send(socket).unwrap();
            } else {
                assert!(request.starts_with("POST /api/webhooks/agent/telemetry "));
                assert!(payload["sandboxOperations"].is_array());
                socket
                    .write_all(&json_response("200 OK", r#"{"success":true,"id":"ok"}"#))
                    .await
                    .unwrap();
            }
        }
    });

    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let guest = sandbox_mock::MockLifecycleGate::new();
    overrides.set_wait_process_lifecycle_gate(guest.clone());
    let (config, env) = mock_run_config_with_overrides_and_api_url(
        test_profiles(),
        8,
        32_768,
        4,
        Arc::clone(&overrides),
        &api_url,
    );
    let budget = Arc::clone(&config.capacity.budget);
    let mut runner = Box::pin(tokio::task::unconstrained(run(config)));
    // Four slots have no blank-pool target, so this Run takes a fresh resource.
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    let mut report_socket = tokio::select! {
        result = &mut runner => panic!("runner exited before the startup request: {result:?}"),
        report = tokio::time::timeout(WAIT, reports.recv()) => report.unwrap().unwrap(),
    };
    guest
        .wait_entered(1, WAIT)
        .await
        .expect("guest must execute with the startup response held");
    assert_eq!(overrides.start_agent_process_calls().len(), 1);

    // Soft drain stops admission without cancelling the Run or its report.
    env.drain();
    guest.release_one();
    tokio::select! {
        result = &mut runner => panic!("runner exited before completing the Run: {result:?}"),
        completion = env.handle.wait_completion(run_id, WAIT) => {
            assert_eq!(completion.expect("completion must not wait for startup HTTP").exit_code, 0);
        },
    }
    tokio::select! {
        result = &mut runner => panic!("runner exited before releasing resources: {result:?}"),
        () = wait_budget_count(&budget, 0, WAIT) => {},
    }
    assert_eq!(budget.allocated(), (0, 0, 0));
    assert!(
        runner.as_mut().now_or_never().is_none(),
        "normal Runner drain must still own the held startup report"
    );

    report_socket
        .write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        .await
        .unwrap();
    drop(report_socket);
    tokio::time::timeout(WAIT, runner)
        .await
        .expect("Runner must finish after the startup response is released")
        .unwrap();
    assert!(matches!(
        reports.try_recv(),
        Err(tokio::sync::mpsc::error::TryRecvError::Empty)
    ));
    stop_server.send(()).unwrap();
    tokio::time::timeout(WAIT, server_tasks.join_next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}
