use super::*;
use std::fs;

#[tokio::test(start_paused = true)]
async fn final_shutdown_deadline_retires_an_unresponsive_worker() {
    let (tx, mut rx) = mpsc::channel(1);
    let (entered_tx, entered_rx) = oneshot::channel();
    // Fault the worker boundary: it accepts the final command but cannot
    // retire. The public consuming shutdown must bound and join that owner.
    let handle = tokio::spawn(async move {
        let command = rx.recv().await.expect("final command should be queued");
        let _ = entered_tx.send(());
        std::future::pending::<()>().await;
        drop(command);
    });
    let worker = handle.abort_handle();
    let (incident_tx, _) = watch::channel(None);
    let telemetry = Telemetry {
        tx,
        handle,
        incident_reporter: IncidentReporter {
            tx: incident_tx,
            sandbox_id: None,
        },
    };
    let shutdown = tokio::spawn(telemetry.final_flush_and_shutdown());
    entered_rx
        .await
        .expect("worker should accept final shutdown");
    let budget = Duration::from_millis(
        api_contracts::generated::constants::runners::AGENT_FINAL_TELEMETRY_FLUSH_TIMEOUT_MS,
    );
    tokio::time::advance(budget - Duration::from_millis(1)).await;
    assert!(
        !shutdown.is_finished(),
        "the configured budget remains available"
    );
    tokio::time::advance(Duration::from_millis(2)).await;
    let result = tokio::time::timeout(Duration::from_secs(1), shutdown)
        .await
        .expect("aggregate expiry must stop an unresponsive uploader")
        .expect("shutdown task should not panic");
    assert!(matches!(result, Err(AgentError::TelemetryShutdownTimeout)));
    assert!(
        worker.is_finished(),
        "shutdown must join the aborted worker"
    );
}

#[test]
fn save_position_and_read_back() {
    let dir = tempfile::tempdir().unwrap();
    let pos = dir.path().join("test.pos");
    save_position(&pos, 42).unwrap();
    let val: u64 = fs::read_to_string(&pos).unwrap().trim().parse().unwrap();
    assert_eq!(val, 42);
}

#[test]
fn save_position_overwrites_existing() {
    let dir = tempfile::tempdir().unwrap();
    let pos = dir.path().join("overwrite.pos");
    save_position(&pos, 10).unwrap();
    save_position(&pos, 20).unwrap();
    let val: u64 = fs::read_to_string(&pos).unwrap().trim().parse().unwrap();
    assert_eq!(val, 20);
}
