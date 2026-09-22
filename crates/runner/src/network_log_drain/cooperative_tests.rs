use super::*;

use std::sync::Mutex;

use serde_json::json;
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

use crate::network_log_manager::NetworkLogManager;

async fn exhaust_budget() {
    while tokio::task::coop::has_budget_remaining() {
        tokio::task::consume_budget().await;
    }
}

#[tokio::test]
async fn exhausted_budget_drain_awaits_callbacks_and_preserves_partial_input() {
    let (mut writer, reader) = UnixStream::pair().unwrap();
    let input = format!(
        "{}partial",
        "line\n".repeat(READY_LINE_DRAIN_SLICE_SIZE + 1)
    );
    writer.write_all(input.as_bytes()).await.unwrap();
    reader.readable().await.unwrap();
    // Force real I/O refills between lines, rather than draining only BufReader's buffer.
    let mut lines = BufReader::with_capacity(4, reader).lines();
    let cancel = CancellationToken::new();
    let (ack, mut ack_rx) = oneshot::channel();
    let (release, callback_release) = oneshot::channel();
    let mut callback_release = Some(callback_release);
    let handled = Arc::new(Mutex::new(Vec::new()));
    let mut on_line = |line| {
        let callback_release = callback_release.take();
        let handled = handled.clone();
        async move {
            if let Some(callback_release) = callback_release {
                // The readiness probe must restore the caller's exhausted budget,
                // not disable cooperative scheduling for the callback as well.
                assert!(!tokio::task::coop::has_budget_remaining());
                callback_release.await.unwrap();
            }
            handled.lock().unwrap().push(line);
            exhaust_budget().await;
        }
    };

    {
        let mut drain = std::pin::pin!(process_drain_request(
            &mut lines,
            &cancel,
            &mut on_line,
            NetworkLogDrainRequest { ack },
        ));
        exhaust_budget().await;
        let mut cx = Context::from_waker(noop_waker_ref());
        assert!(drain.as_mut().poll(&mut cx).is_pending());
        assert!(handled.lock().unwrap().is_empty());
        assert_eq!(ack_rx.try_recv(), Err(oneshot::error::TryRecvError::Empty));

        release.send(()).unwrap();
        assert!(matches!(
            timeout(Duration::from_secs(1), drain).await.unwrap(),
            DrainReadyLinesOutcome::Continue
        ));
    }

    ack_rx.await.unwrap();
    assert_eq!(
        *handled.lock().unwrap(),
        vec!["line"; READY_LINE_DRAIN_SLICE_SIZE + 1]
    );
    // The still-open socket is genuinely pending, but its incomplete line survives.
    writer.write_all(b"-rest\n").await.unwrap();
    assert_eq!(lines.next_line().await.unwrap().unwrap(), "partial-rest");
}

#[tokio::test]
async fn close_for_upload_keeps_prequeued_row_when_drain_budget_is_exhausted() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("network.jsonl");
    let manager = NetworkLogManager::new();
    let session = manager.register_source_ip("10.200.0.2", path.clone()).await;
    let row = json!({"type": "dns", "host": "prequeued.test"});
    let (mut writer, reader) = UnixStream::pair().unwrap();
    writer
        .write_all(format!("{row}\n").as_bytes())
        .await
        .unwrap();
    reader.readable().await.unwrap();
    let mut lines = BufReader::new(reader).lines();
    let (producer, mut drain_rx) = NetworkLogDrainProducer::channel("dns");
    let coordinator = NetworkLogDrainCoordinator::new(vec![producer]);
    let cancel = CancellationToken::new();
    let mut on_line = |line: String| {
        let manager = manager.clone();
        async move {
            assert!(
                manager
                    .append_for_ip("10.200.0.2", serde_json::from_str(&line).unwrap())
                    .await
            );
        }
    };

    let (observation, outcome) = tokio::join!(
        session.close_for_upload(RunId::from(uuid::Uuid::nil()), &coordinator),
        async {
            let request = drain_rx.recv().await.unwrap();
            // Recreate the budget boundary after receiving the actual close request,
            // without depending on randomized select ordering in the reader loop.
            exhaust_budget().await;
            process_drain_request(&mut lines, &cancel, &mut on_line, request).await
        }
    );

    assert!(matches!(outcome, DrainReadyLinesOutcome::Continue));
    assert_eq!(observation.drain_status("dns"), "acknowledged");
    assert!(!observation.writer_failed());
    let content = std::fs::read_to_string(&path).unwrap();
    let rows: Vec<serde_json::Value> = content
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(rows, vec![row]);
    assert!(
        !manager
            .append_for_ip("10.200.0.2", json!({"type": "dns", "host": "late.test"}))
            .await
    );
    // Keep the producer open until after close; EOF must not make this test pass.
    drop(writer);
}
