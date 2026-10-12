use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use sandbox::GuestProcessControlHandle;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::super::{
    ACTIVE_INPUT_SHUTDOWN_GRACE, ActiveInputForwarder, DeliveryMode, ForwardDisposition, forward,
};
use super::TEST_TIMEOUT;
use crate::test_fixtures::guest_control::GuestControlFixture;
use runner_provider::ActiveInputSource;
use runner_provider::local_queue::{self, ActiveInputEntry, LocalQueue};
use runner_types::ids::RunId;

struct Dropped(Arc<AtomicBool>);

impl Drop for Dropped {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

#[tokio::test(start_paused = true)]
async fn shutdown_expiry_has_unknown_delivery_and_never_becomes_retryable() {
    for (mode, cancel_job) in [(DeliveryMode::Api, true), (DeliveryMode::Local, false)] {
        let dropped = Arc::new(AtomicBool::new(false));
        let control = GuestProcessControlHandle::new_with_outcome({
            let dropped = Arc::clone(&dropped);
            move |_, _, _| {
                let guard = Dropped(Arc::clone(&dropped));
                Box::pin(async move {
                    let _guard = guard;
                    std::future::pending().await
                })
            }
        });
        let job_cancel = CancellationToken::new();
        let stop = CancellationToken::new();
        let mut operation = Box::pin(forward(
            RunId::new_v4(),
            RunId::new_v4().to_string(),
            "input".to_owned(),
            mode,
            &control,
            &job_cancel,
            &stop,
        ));
        assert!(futures_util::poll!(operation.as_mut()).is_pending());
        if cancel_job {
            job_cancel.cancel();
        } else {
            stop.cancel();
        }
        let disposition = tokio::time::timeout(
            ACTIVE_INPUT_SHUTDOWN_GRACE + Duration::from_secs(1),
            operation,
        )
        .await
        .expect("shutdown must drain for a bounded grace");
        assert!(matches!(disposition, ForwardDisposition::Stop));
        assert!(
            dropped.load(Ordering::Acquire),
            "provider I/O must be dropped before completion"
        );
    }
}

fn queued_source(dir: &std::path::Path, run_id: RunId) -> ActiveInputSource {
    let profile = runner_types::profile_name::DEFAULT_PROFILE;
    local_queue::ensure_profile_jobs_dir(dir, profile).unwrap();
    local_queue::write_private_file(
        &local_queue::job_path(dir, profile, run_id).unwrap(),
        b"{}",
        "shutdown test job",
    )
    .unwrap();
    let queue = LocalQueue::new(dir.to_path_buf());
    for sequence in [1, 2] {
        queue
            .write_active_input_sync(&ActiveInputEntry {
                run_id,
                sequence,
                text: format!("input {sequence}"),
            })
            .unwrap();
    }
    ActiveInputSource::local_queue(queue, run_id)
}

#[tokio::test]
async fn stop_reaps_control_queued_behind_a_real_partial_write_without_poisoning_it() {
    let mut socket = GuestControlFixture::start(None).await;
    let control = socket.control.clone();
    let mut blocker = Box::pin(control.control_owned(
        "blocking-control".to_owned(),
        vec![b'x'; 512 * 1024],
        Duration::from_secs(60),
    ));
    let remaining = tokio::select! {
        result = blocker.as_mut() => panic!("large write must block: {result:?}"),
        remaining = socket.observe_partial_control() => remaining,
    };
    let dir = tempfile::tempdir().unwrap();
    let run_id = RunId::new_v4();
    let (calls_tx, mut calls_rx) = mpsc::unbounded_channel();
    let queued_control = GuestProcessControlHandle::new_with_outcome({
        let control = socket.process_control.clone();
        move |message_id, payload, timeout| {
            let control = control.clone();
            let calls = calls_tx.clone();
            Box::pin(async move {
                calls.send(message_id.clone()).unwrap();
                control
                    .control_owned_outcome(message_id, payload, timeout)
                    .await
            })
        }
    });
    let forwarder = ActiveInputForwarder::start(
        run_id,
        Some(queued_source(dir.path(), run_id)),
        Some(queued_control),
        CancellationToken::new(),
    )
    .unwrap();
    let abort = forwarder.task.abort_handle();
    let mut completion = Box::pin(forwarder.stop());
    let mut completed = false;
    let assertions = std::panic::AssertUnwindSafe(async {
        tokio::time::timeout(TEST_TIMEOUT, calls_rx.recv())
            .await
            .unwrap()
            .unwrap();
        tokio::time::timeout(TEST_TIMEOUT, completion.as_mut())
            .await
            .expect("queued control shutdown must not wait for the unrelated frame");
        completed = true;
        assert_eq!(
            calls_rx.try_recv(),
            Err(mpsc::error::TryRecvError::Disconnected)
        );
        assert!(
            socket.client.reserve_external_operation().is_ok(),
            "a never-written queued control must not poison another frame"
        );
    });
    use futures_util::FutureExt;
    let result = assertions.catch_unwind().await;
    if !completed {
        abort.abort();
        tokio::time::timeout(TEST_TIMEOUT, completion)
            .await
            .unwrap();
    }
    // Cancellation of the unrelated writer is a separate cleanup boundary.
    drop(blocker);
    socket.assert_partial_write_closed(remaining).await;
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}

#[tokio::test]
async fn job_cancellation_reaps_a_real_response_wait_without_replay_or_reuse() {
    let mut socket = GuestControlFixture::start(None).await;
    let dir = tempfile::tempdir().unwrap();
    let run_id = RunId::new_v4();
    let control = GuestProcessControlHandle::new_with_outcome({
        let control = socket.process_control.clone();
        move |message_id, payload, _| {
            let control = control.clone();
            Box::pin(async move {
                // A provider with a longer response wait must still obey the
                // forwarder's shutdown ownership budget.
                control
                    .control_owned_outcome(message_id, payload, Duration::from_secs(60))
                    .await
            })
        }
    });
    let job_cancel = CancellationToken::new();
    let forwarder = ActiveInputForwarder::start(
        run_id,
        Some(queued_source(dir.path(), run_id)),
        Some(control),
        job_cancel.clone(),
    )
    .unwrap();
    let mut task = forwarder.task;
    let mut completed = false;
    let assertions = std::panic::AssertUnwindSafe(async {
        let message = socket.read_control().await;
        job_cancel.cancel();
        tokio::time::timeout(TEST_TIMEOUT, &mut task)
            .await
            .expect("job cancellation must bound an in-flight response wait")
            .unwrap();
        completed = true;
        assert!(
            socket.client.reserve_external_operation().is_err(),
            "abandoned response ownership must prevent reuse"
        );
        assert_eq!(
            socket.guest.try_read(&mut [0u8; 1]).unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock,
            "no second input or socket close is expected after a complete frame"
        );
        socket.acknowledge(&message).await;
        socket.finish().await;
        assert!(
            socket.client.reserve_external_operation().is_err(),
            "late acknowledgement must not restore reuse"
        );
    });
    use futures_util::FutureExt;
    let result = assertions.catch_unwind().await;
    if !completed {
        task.abort();
        let _ = tokio::time::timeout(TEST_TIMEOUT, task).await.unwrap();
    }
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}
