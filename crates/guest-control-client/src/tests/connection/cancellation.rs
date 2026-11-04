use std::future::Future;
use std::io;
use std::pin::Pin;
use std::time::Duration;

use guest_control_proto::{
    ExecOutputPolicy, ExecProcessRole, ExecTimeoutPolicy, HEADER_SIZE, MIN_BODY_SIZE,
    MSG_EXEC_OUTPUT, MSG_EXEC_START, MSG_EXEC_STARTED, MSG_WRITE_FILE,
};
use nix::sys::socket::{Shutdown, setsockopt, shutdown, sockopt};
use sandbox::OperationCancellationContext;
use tokio::io::AsyncReadExt;
use tokio::time::Instant;
use tracing::Level;
use tracing_subscriber::prelude::*;
use tracing_test_support::CapturedEvents;

use crate::tests::support::{MockGuest, make_pair};
use crate::{
    ConnectionCloseReason, ConnectionClosedAtAdmission, GuestControlClient, SupervisedExecControl,
    SupervisedExecHandle, SupervisedExecRequest,
};

const BOUND: Duration = Duration::from_secs(5);
const CONTENT: &[u8] = &[b'h'; 1024 * 1024];

async fn connection(sandbox_id: &str) -> (GuestControlClient, MockGuest) {
    let (host, peer) = make_pair();
    setsockopt(&host, sockopt::SndBuf, &4096usize).unwrap();
    let mut guest = MockGuest::new(peer);
    let (host, ()) = tokio::join!(
        GuestControlClient::from_stream_for_sandbox(host, Instant::now() + BOUND, sandbox_id),
        guest.complete_handshake(),
    );
    (host.unwrap(), guest)
}

async fn active_workload(
    host: &GuestControlClient,
    guest: &mut MockGuest,
) -> (SupervisedExecHandle, u32) {
    let request = SupervisedExecRequest {
        timeout_is_expected: true,
        role: ExecProcessRole::Workload,
        timeout: ExecTimeoutPolicy::None,
        command: "fixture-prefetch",
        env: &[],
        sudo: false,
        label: "owned-prefetch",
        stdout: ExecOutputPolicy::Stream {
            limit_bytes: 1024,
            chunk_limit_bytes: 16,
        },
        stderr: ExecOutputPolicy::Discard,
        expected_exit_codes: &[],
        control: SupervisedExecControl::Disabled,
        stdin_bytes: None,
        stream_queue_capacity: Some(1),
        start_timeout: BOUND,
    };
    let (handle, seq) = tokio::join!(host.start_supervised_exec(request), async {
        let start = guest.expect_message(MSG_EXEC_START).await;
        guest
            .send_response(
                MSG_EXEC_STARTED,
                start.seq,
                &guest_control_proto::encode_exec_started(123).unwrap(),
            )
            .await;
        start.seq
    });
    (handle.unwrap(), seq)
}

async fn admit_write<F: Future>(write: Pin<&mut F>, guest: &mut MockGuest) {
    let mut prefix = [0u8; HEADER_SIZE + MIN_BODY_SIZE];
    tokio::select! {
        _ = write => panic!("write finished before partial frame admission"),
        result = tokio::time::timeout(BOUND, guest.stream_mut().read_exact(&mut prefix)) => { result.unwrap().unwrap(); },
    }
    assert_eq!(prefix[HEADER_SIZE], MSG_WRITE_FILE);
}

async fn expect_partial_eof(guest: &mut MockGuest) {
    let mut tail = Vec::new();
    tokio::time::timeout(BOUND, guest.stream_mut().read_to_end(&mut tail))
        .await
        .unwrap()
        .unwrap();
    assert!(
        tail.len() < CONTENT.len(),
        "the frame must remain incomplete"
    );
}

async fn closed(host: &GuestControlClient) -> io::Error {
    let error = host.shutdown(BOUND).await.unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::ConnectionReset);
    assert!(ConnectionClosedAtAdmission::from_error(&error).is_some());
    error
}

#[tokio::test]
async fn cancelled_partial_write_attributes_active_work_and_initial_closed_admission() {
    let captured = CapturedEvents::default();
    let _subscriber =
        tracing::subscriber::set_default(tracing_subscriber::registry().with(captured.clone()));
    let (host, mut guest) = connection("sandbox-a").await;
    let (handle, _) = active_workload(&host, &mut guest).await;
    let owner = OperationCancellationContext::new("run-a", "sandbox-a", "history_restore");
    let mut write = Box::pin(owner.scope(host.write_file("/tmp/history", CONTENT, false)));
    admit_write(write.as_mut(), &mut guest).await;

    owner.mark_cancelled();
    drop(write);
    expect_partial_eof(&mut guest).await;
    assert_eq!(
        handle.wait(BOUND).await.unwrap_err().kind(),
        io::ErrorKind::ConnectionReset
    );
    let error = closed(&host).await;
    let info = ConnectionClosedAtAdmission::from_error(&error)
        .unwrap()
        .close_info();
    assert_eq!(info.connection_id(), host.connection_id());
    assert_eq!(info.reason(), ConnectionCloseReason::FrameWriteAbandoned);
    assert_eq!(info.cancelled_owner().unwrap().run_id(), "run-a");
    assert_eq!(info.cancelled_owner().unwrap().phase(), "history_restore");
    let events = captured.entries();
    let event = events
        .iter()
        .find(|e| e.fields.get("close_origin").map(String::as_str) == Some("frame_write_abandoned"))
        .unwrap();
    assert_eq!(event.level, Level::INFO);
    assert_eq!(
        event.fields.get("active_count").map(String::as_str),
        Some("1")
    );
    assert_eq!(
        event.fields.get("connection_id").unwrap(),
        &host.connection_id().to_string()
    );
    assert!(!events.iter().any(|e| e.level == Level::WARN
        && e.fields.get("message").map(String::as_str)
            == Some("closing connection with active exec operations")));
}

#[tokio::test]
async fn cancelling_one_future_does_not_annotate_another_connection() {
    let (host_a, mut guest_a) = connection("sandbox-a").await;
    let (host_b, mut guest_b) = connection("sandbox-b").await;
    assert_ne!(host_a.connection_id(), host_b.connection_id());
    let owner = OperationCancellationContext::new("run-a", "sandbox-a", "history_restore");
    let mut a = Box::pin(owner.scope(host_a.write_file("/tmp/a", CONTENT, false)));
    let mut b = Box::pin(host_b.write_file("/tmp/b", CONTENT, false));
    admit_write(a.as_mut(), &mut guest_a).await;
    admit_write(b.as_mut(), &mut guest_b).await;
    owner.mark_cancelled();
    drop(a);
    drop(b);
    expect_partial_eof(&mut guest_a).await;
    expect_partial_eof(&mut guest_b).await;
    let a_error = closed(&host_a).await;
    let b_error = closed(&host_b).await;
    assert!(
        ConnectionClosedAtAdmission::from_error(&a_error)
            .unwrap()
            .close_info()
            .cancelled_owner()
            .is_some()
    );
    assert!(
        ConnectionClosedAtAdmission::from_error(&b_error)
            .unwrap()
            .close_info()
            .cancelled_owner()
            .is_none()
    );
}

#[tokio::test]
async fn a_cancelled_owner_for_another_sandbox_stays_unattributed() {
    let (host, mut guest) = connection("sandbox-a").await;
    let owner = OperationCancellationContext::new("run-b", "sandbox-b", "history_restore");
    let mut write = Box::pin(owner.scope(host.write_file("/tmp/history", CONTENT, false)));
    admit_write(write.as_mut(), &mut guest).await;
    owner.mark_cancelled();
    drop(write);
    expect_partial_eof(&mut guest).await;
    let error = closed(&host).await;
    assert!(
        ConnectionClosedAtAdmission::from_error(&error)
            .unwrap()
            .close_info()
            .cancelled_owner()
            .is_none()
    );
}

#[tokio::test]
async fn dispatch_fault_is_not_relabelled_by_later_cancellation() {
    let captured = CapturedEvents::default();
    let _subscriber =
        tracing::subscriber::set_default(tracing_subscriber::registry().with(captured.clone()));
    let (host, mut guest) = connection("sandbox-a").await;
    let (handle, workload_seq) = active_workload(&host, &mut guest).await;
    let owner = OperationCancellationContext::new("run-a", "sandbox-a", "history_restore");
    let mut write = Box::pin(owner.scope(host.write_file("/tmp/history", CONTENT, false)));
    admit_write(write.as_mut(), &mut guest).await;
    guest
        .send_response(MSG_EXEC_OUTPUT, workload_seq, &[])
        .await;
    host.wait_until_closed(BOUND).await.unwrap();
    owner.mark_cancelled();
    drop(write);
    expect_partial_eof(&mut guest).await;
    assert!(handle.wait(BOUND).await.is_err());
    let error = closed(&host).await;
    let info = ConnectionClosedAtAdmission::from_error(&error)
        .unwrap()
        .close_info();
    assert!(matches!(
        info.reason(),
        ConnectionCloseReason::DispatchError(_)
    ));
    assert!(info.cancelled_owner().is_none());
    let event = captured
        .entries()
        .into_iter()
        .find(|e| e.fields.get("close_origin").map(String::as_str) == Some("dispatch_error"))
        .unwrap();
    assert_eq!(event.level, Level::WARN);
}

#[tokio::test]
async fn cancelled_context_does_not_demote_a_concrete_frame_write_error() {
    let captured = CapturedEvents::default();
    let _subscriber =
        tracing::subscriber::set_default(tracing_subscriber::registry().with(captured.clone()));
    let (host, mut guest) = connection("sandbox-a").await;
    let (handle, _) = active_workload(&host, &mut guest).await;
    shutdown(host.shared.fd, Shutdown::Write).unwrap();
    let owner = OperationCancellationContext::new("run-a", "sandbox-a", "history_restore");
    owner.mark_cancelled();
    let error = owner
        .scope(host.write_file("/tmp/history", b"history", false))
        .await
        .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::BrokenPipe);
    guest.expect_eof().await;
    let error = closed(&host).await;
    let info = ConnectionClosedAtAdmission::from_error(&error)
        .unwrap()
        .close_info();
    assert_eq!(
        info.reason(),
        ConnectionCloseReason::FrameWriteError(io::ErrorKind::BrokenPipe)
    );
    assert!(info.cancelled_owner().is_none());
    assert!(handle.wait(BOUND).await.is_err());
    let event = captured
        .entries()
        .into_iter()
        .find(|e| e.fields.get("close_origin").map(String::as_str) == Some("frame_write_error"))
        .unwrap();
    assert_eq!(event.level, Level::WARN);
}

#[tokio::test]
async fn partial_frame_cancellation_keeps_an_admitted_shutdown_failure_distinct() {
    let (host, mut guest) = connection("sandbox-a").await;
    let owner = OperationCancellationContext::new("run-a", "sandbox-a", "history_restore");
    let content = vec![b'x'; 4 * 1024 * 1024];
    let mut write = Box::pin(owner.scope(host.write_file("/tmp/history", &content, false)));
    let mut prefix = [0u8; HEADER_SIZE + MIN_BODY_SIZE];
    tokio::select! {
        result = &mut write => panic!("write completed without the guest draining it: {result:?}"),
        result = guest.stream_mut().read_exact(&mut prefix) => { result.unwrap(); },
    }
    assert_eq!(prefix[HEADER_SIZE], MSG_WRITE_FILE);
    let mut shutdown_request = Box::pin(host.shutdown(BOUND));
    // The frame owns the writer, so this poll registers shutdown but cannot write it.
    tokio::select! {
        biased;
        result = &mut shutdown_request => panic!("shutdown completed behind a partial frame: {result:?}"),
        () = async {} => {},
    }
    owner.mark_cancelled();
    drop(write);
    let error = shutdown_request.await.unwrap_err();
    assert!(ConnectionClosedAtAdmission::from_error(&error).is_none());
    let mut tail = Vec::new();
    tokio::time::timeout(BOUND, guest.stream_mut().read_to_end(&mut tail))
        .await
        .unwrap()
        .unwrap();
    assert!(
        tail.len() < content.len(),
        "the write was an incomplete frame"
    );
    let error = closed(&host).await;
    let info = ConnectionClosedAtAdmission::from_error(&error)
        .unwrap()
        .close_info();
    assert_eq!(info.reason(), ConnectionCloseReason::FrameWriteAbandoned);
    assert!(info.cancelled_owner().is_some());
}
