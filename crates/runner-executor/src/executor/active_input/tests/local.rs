use std::collections::BTreeSet;
use std::ffi::OsString;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::time::Duration;

use nix::errno::Errno;
use nix::sys::inotify::{AddWatchFlags, InitFlags, Inotify};
use sandbox::{
    GuestProcessControlHandle, ProcessControlAck, ProcessControlGuestStatus, ProcessControlOutcome,
};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use super::super::run_forwarder;
use super::TEST_TIMEOUT;
use runner_provider::local_queue::{self, ActiveInputEntry, LocalQueue};
use runner_provider::{ActiveInputSource, local_active_input_event_id};
use runner_types::ids::RunId;

#[derive(Debug)]
struct ControlCall {
    id: String,
    payload: Vec<u8>,
    response: oneshot::Sender<ProcessControlOutcome>,
}

impl ControlCall {
    fn accept(self) {
        self.response
            .send(ProcessControlOutcome::Delivered(ProcessControlAck {
                message_id: self.id,
            }))
            .unwrap();
    }
}

fn controlled_guest() -> (
    GuestProcessControlHandle,
    mpsc::UnboundedReceiver<ControlCall>,
) {
    let (requests, receiver) = mpsc::unbounded_channel();
    let control = GuestProcessControlHandle::new_with_outcome(move |id, payload, _| {
        let requests = requests.clone();
        Box::pin(async move {
            let (response, outcome) = oneshot::channel();
            requests
                .send(ControlCall {
                    id,
                    payload,
                    response,
                })
                .unwrap();
            outcome.await.unwrap()
        })
    });
    (control, receiver)
}

async fn next_control(
    mut forwarding: Pin<&mut impl Future<Output = ()>>,
    receiver: &mut mpsc::UnboundedReceiver<ControlCall>,
) -> ControlCall {
    tokio::time::timeout(TEST_TIMEOUT, async {
        tokio::select! {
            biased;
            call = receiver.recv() => call.unwrap(),
            () = forwarding.as_mut() => panic!("forwarding stopped before the expected control"),
        }
    })
    .await
    .expect("expected Guest control request")
}

fn local_queue(group_dir: &Path, run_id: RunId) -> LocalQueue {
    let profile = runner_types::profile_name::DEFAULT_PROFILE;
    local_queue::ensure_profile_jobs_dir(group_dir, profile).unwrap();
    local_queue::write_private_file(
        &local_queue::job_path(group_dir, profile, run_id).unwrap(),
        b"{}",
        "test local job",
    )
    .unwrap();
    LocalQueue::new(group_dir.to_path_buf())
}

fn payload_accesses(watcher: &Inotify) -> BTreeSet<OsString> {
    let mut names = BTreeSet::new();
    loop {
        match watcher.read_events() {
            Ok(events) => {
                for event in events {
                    assert!(!event.mask.contains(AddWatchFlags::IN_Q_OVERFLOW));
                    if let Some(name) = event.name
                        && Path::new(&name)
                            .extension()
                            .is_some_and(|ext| ext == "json")
                    {
                        names.insert(name);
                    }
                }
            }
            Err(Errno::EAGAIN) => return names,
            Err(error) => panic!("read payload access events: {error}"),
        }
    }
}

#[tokio::test]
async fn local_backpressure_retries_only_the_expected_payload_then_resumes_in_order() {
    for status in [
        ProcessControlGuestStatus::QueueFull,
        ProcessControlGuestStatus::SinkUnavailable,
    ] {
        let dir = tempfile::tempdir().unwrap();
        let run_id = RunId::new_v4();
        let queue = local_queue(dir.path(), run_id);
        let entry = ActiveInputEntry {
            run_id,
            sequence: 1,
            text: "first".to_owned(),
        };
        queue.write_active_input_sync(&entry).unwrap();
        let large_text = "x".repeat(100 * 1024);
        // Only inputs 2 and 3 are consumed; inotify guards against reading the tail.
        for sequence in 2..=1001 {
            queue
                .write_active_input_sync(&ActiveInputEntry {
                    run_id,
                    sequence,
                    text: if sequence <= 3 {
                        large_text.clone()
                    } else {
                        "unread".to_owned()
                    },
                })
                .unwrap();
        }
        let watcher = Inotify::init(InitFlags::IN_CLOEXEC | InitFlags::IN_NONBLOCK).unwrap();
        watcher
            .add_watch(
                &local_queue::run_inputs_dir(dir.path(), run_id),
                AddWatchFlags::IN_OPEN | AddWatchFlags::IN_ACCESS,
            )
            .unwrap();
        let (control, mut calls) = controlled_guest();
        let stop = CancellationToken::new();
        let forwarding = run_forwarder(
            run_id,
            ActiveInputSource::local_queue(queue, run_id),
            control,
            CancellationToken::new(),
            stop.clone(),
        );
        tokio::pin!(forwarding);

        let first = next_control(forwarding.as_mut(), &mut calls).await;
        let first_id = local_active_input_event_id(run_id, 1);
        let first_payload =
            guest_contracts::active_input::encode_active_input(&first_id, "first").unwrap();
        assert_eq!(first.id, first_id);
        assert_eq!(first.payload, first_payload);
        assert_eq!(
            payload_accesses(&watcher),
            BTreeSet::from([OsString::from(format!("{:020}.json", 1))])
        );

        tokio::time::pause();
        first
            .response
            .send(ProcessControlOutcome::GuestStatus {
                status,
                diagnostic: "backpressure".to_owned(),
            })
            .unwrap();
        // Drive the ready response through to the production poll timer before
        // advancing time; no filesystem read is in flight during this phase.
        assert!(futures_util::poll!(forwarding.as_mut()).is_pending());
        tokio::time::advance(Duration::from_millis(249)).await;
        assert!(futures_util::poll!(forwarding.as_mut()).is_pending());
        assert!(matches!(
            calls.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));
        assert!(payload_accesses(&watcher).is_empty());
        tokio::time::advance(Duration::from_millis(1)).await;
        tokio::time::resume();

        let retry = next_control(forwarding.as_mut(), &mut calls).await;
        assert_eq!(retry.id, first_id);
        assert_eq!(retry.payload, first_payload);
        assert_eq!(
            payload_accesses(&watcher),
            BTreeSet::from([OsString::from(format!("{:020}.json", 1))])
        );
        retry.accept();
        for sequence in 2..=3 {
            let call = next_control(forwarding.as_mut(), &mut calls).await;
            let id = local_active_input_event_id(run_id, sequence);
            assert_eq!(call.id, id);
            assert_eq!(
                call.payload,
                guest_contracts::active_input::encode_active_input(&id, &large_text).unwrap()
            );
            assert_eq!(
                payload_accesses(&watcher),
                BTreeSet::from([OsString::from(format!("{sequence:020}.json"))])
            );
            if sequence == 3 {
                stop.cancel();
            }
            call.accept();
        }
        tokio::time::timeout(TEST_TIMEOUT, forwarding)
            .await
            .unwrap();
        assert!(matches!(
            calls.try_recv(),
            Err(mpsc::error::TryRecvError::Disconnected)
        ));
        assert!(payload_accesses(&watcher).is_empty());
    }
}

#[tokio::test]
async fn accepted_local_inputs_drain_without_advancing_the_poll_clock() {
    let dir = tempfile::tempdir().unwrap();
    let run_id = RunId::new_v4();
    let queue = local_queue(dir.path(), run_id);
    for sequence in 1..=3 {
        queue
            .write_active_input_sync(&ActiveInputEntry {
                run_id,
                sequence,
                text: format!("input {sequence}"),
            })
            .unwrap();
    }
    let (control, mut calls) = controlled_guest();
    let stop = CancellationToken::new();
    let forwarding = run_forwarder(
        run_id,
        ActiveInputSource::local_queue(queue, run_id),
        control,
        CancellationToken::new(),
        stop.clone(),
    );
    tokio::pin!(forwarding);
    let first = next_control(forwarding.as_mut(), &mut calls).await;
    tokio::time::pause();
    let now = tokio::time::Instant::now();
    first.accept();
    for sequence in 2..=3 {
        let call = next_control(forwarding.as_mut(), &mut calls).await;
        assert_eq!(call.id, local_active_input_event_id(run_id, sequence));
        assert_eq!(
            tokio::time::Instant::now(),
            now,
            "healthy delivery must not wait for a poll timer"
        );
        if sequence == 3 {
            stop.cancel();
        }
        call.accept();
    }
    tokio::time::resume();
    tokio::time::timeout(TEST_TIMEOUT, forwarding)
        .await
        .unwrap();
}
