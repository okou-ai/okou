use std::sync::Arc;
use std::task::Poll;
use std::time::Duration;

use sandbox::{GuestProcessControlHandle, ProcessControlAck, ProcessControlOutcome};
use tokio::sync::{Notify, mpsc};
use tokio_util::sync::CancellationToken;

use super::ActiveInputForwarder;
use crate::active_input::{ActiveInputSource, local_active_input_delivery_id};
use crate::ids::RunId;
use crate::local_queue::{ActiveInputEntry, LocalQueue};

const TEST_TIMEOUT: Duration = Duration::from_secs(5);

enum CancelForwarding {
    Job,
    Stop,
}

async fn assert_cancelled_local_batch(cancellation: CancelForwarding) {
    let dir = tempfile::tempdir().unwrap();
    let run_id = RunId::new_v4();
    let queue = LocalQueue::new(dir.path().to_path_buf());
    for (sequence, text) in [(1, "first"), (2, "second"), (3, "third")] {
        queue
            .write_active_input_sync(&ActiveInputEntry {
                run_id,
                sequence,
                text: text.to_string(),
            })
            .unwrap();
    }

    let first_id = local_active_input_delivery_id(run_id, 1);
    let gated_id = first_id.clone();
    let release = Arc::new(Notify::new());
    let provider_release = Arc::clone(&release);
    let (requests_tx, mut requests_rx) = mpsc::unbounded_channel();
    let (acknowledged_tx, mut acknowledged_rx) = mpsc::unbounded_channel();
    let control = GuestProcessControlHandle::new_with_outcome(move |message_id, payload, _| {
        let first = message_id == gated_id;
        let release = Arc::clone(&provider_release);
        let requests = requests_tx.clone();
        let acknowledged = acknowledged_tx.clone();
        Box::pin(async move {
            requests.send((message_id.clone(), payload)).unwrap();
            if first {
                release.notified().await;
            }
            acknowledged.send(message_id.clone()).unwrap();
            ProcessControlOutcome::Delivered(ProcessControlAck { message_id })
        })
    });
    let job_cancel = CancellationToken::new();
    let forwarder = ActiveInputForwarder::start(
        run_id,
        Some(ActiveInputSource::local_queue(queue, run_id)),
        Some(control),
        job_cancel.clone(),
    )
    .unwrap();
    let abort = forwarder.task.abort_handle();
    let sandbox = sandbox_mock::MockSandbox::new("active-input-cancellation");

    let first_request = tokio::time::timeout(TEST_TIMEOUT, requests_rx.recv()).await;
    let completion = async {
        match cancellation {
            CancelForwarding::Job => {
                job_cancel.cancel();
                // Observe job cancellation independently: calling stop here
                // would also cancel the private token and mask a missing check.
                forwarder.task.await.map(|()| Vec::new())
            }
            CancelForwarding::Stop => Ok(forwarder.stop(&sandbox).await),
        }
    };
    tokio::pin!(completion);
    // Poll the actual cancellation path before releasing the provider result.
    let first_poll = futures_util::poll!(completion.as_mut());
    let waited_for_in_flight = first_poll.is_pending();
    release.notify_one();
    let completed = match first_poll {
        Poll::Ready(result) => Ok(result),
        Poll::Pending => tokio::time::timeout(TEST_TIMEOUT, completion.as_mut()).await,
    };
    if completed.is_err() {
        abort.abort();
        let _ = completion.await;
    }

    // Assert after releasing the provider and reaping the task, including when
    // the first request or completion deadline failed.
    assert!(waited_for_in_flight);
    assert!(completed.unwrap().unwrap().is_empty());
    assert_eq!(
        first_request.unwrap().unwrap(),
        (
            first_id.clone(),
            guest_contracts::active_input::encode_active_input(&first_id, "first").unwrap(),
        )
    );
    assert_eq!(acknowledged_rx.try_recv().unwrap(), first_id);
    assert_eq!(
        requests_rx.try_recv(),
        Err(mpsc::error::TryRecvError::Disconnected),
        "cancellation must not send the remaining queued prompts"
    );
    assert_eq!(
        acknowledged_rx.try_recv(),
        Err(mpsc::error::TryRecvError::Disconnected)
    );
}

#[tokio::test]
async fn job_cancellation_drains_only_the_in_flight_local_input() {
    assert_cancelled_local_batch(CancelForwarding::Job).await;
}

#[tokio::test]
async fn stop_drains_only_the_in_flight_local_input() {
    assert_cancelled_local_batch(CancelForwarding::Stop).await;
}
