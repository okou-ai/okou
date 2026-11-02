use std::io;
use std::time::Duration;

use guest_control_client::{
    ConnectionClosedAtAdmission, FrameWriteObserver, GuestControlClient,
    NormalOperationFenceRejection,
};
use guest_control_proto::{
    MSG_PING, MSG_PONG, MSG_READY, MSG_SHUTDOWN, MSG_SHUTDOWN_ACK, MSG_WRITE_FILE,
    MSG_WRITE_FILE_RESULT, MSG_WRITE_PRIVATE_FILES,
};
use nix::sys::socket::{setsockopt, sockopt};
use sandbox::OperationCancellationContext;
use tokio::io::AsyncReadExt;
use tokio::net::UnixStream;
use tokio_util::sync::CancellationToken;

use super::super::run_pre_spawn_phase;
use crate::test_fixtures::guest_control::{read_frame, send_frame};

const BOUND: Duration = Duration::from_secs(5);
const CONTENT: &[u8] = &[b'h'; 1024 * 1024];
const SANDBOX: &str = "preparation-sandbox";

#[tokio::test]
async fn cancelled_private_bootstrap_batch_fences_reuse_and_never_replays() {
    let (client, mut guest) = connection().await;
    let cancel = CancellationToken::new();
    let owner =
        OperationCancellationContext::new("bootstrap-run", SANDBOX, "guest_agent_bootstrap_files");
    let files = [
        guest_control_client::WriteFileEntry {
            path: "/tmp/instructions",
            content: b"current",
        },
        guest_control_client::WriteFileEntry {
            path: "/tmp/context",
            content: b"context",
        },
        guest_control_client::WriteFileEntry {
            path: "/tmp/environment",
            content: b"environment",
        },
        guest_control_client::WriteFileEntry {
            path: "/tmp/payload",
            content: b"payload",
        },
    ];
    let mut phase = Box::pin(run_pre_spawn_phase(
        &cancel,
        &owner,
        client.write_private_files(&files),
    ));
    tokio::select! {
        _ = &mut phase => panic!("batch finished before its terminal acknowledgement"),
        request = read_frame(&mut guest) => assert_eq!(request.msg_type, MSG_WRITE_PRIVATE_FILES),
    }
    cancel.cancel();
    assert!(phase.await.is_none());
    assert_eq!(owner.cancelled_owner().unwrap().run_id(), "bootstrap-run");
    // A fully written batch awaiting its terminal result leaves the existing
    // tracker not parkable. Unlike an interrupted frame write, this
    // state does not promise immediate socket EOF; normal work is fenced.
    assert!(matches!(
        client.try_fence_normal_operations(),
        Err(NormalOperationFenceRejection::NotParkable)
    ));
    let error = client
        .write_private_file("/tmp/later", b"never sent")
        .await
        .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::ConnectionReset);
    acknowledge_shutdown(&client, &mut guest).await;
}

async fn connection() -> (GuestControlClient, UnixStream) {
    let (host, mut guest) = UnixStream::pair().unwrap();
    setsockopt(&host, sockopt::SndBuf, &4096usize).unwrap();
    let (client, ()) = tokio::join!(
        guest_control_client::test_support::from_stream_for_sandbox(host, BOUND, SANDBOX),
        async {
            send_frame(&mut guest, MSG_READY, 0, &[]).await;
            let ping = read_frame(&mut guest).await;
            assert_eq!(ping.msg_type, MSG_PING);
            send_frame(&mut guest, MSG_PONG, ping.seq, &[]).await;
        }
    );
    (client.unwrap(), guest)
}

async fn acknowledge_shutdown(client: &GuestControlClient, guest: &mut UnixStream) {
    let (result, ()) = tokio::join!(client.shutdown(BOUND), async {
        let request = read_frame(guest).await;
        assert_eq!(
            request.msg_type, MSG_SHUTDOWN,
            "no abandoned preparation frame may be sent"
        );
        send_frame(guest, MSG_SHUTDOWN_ACK, request.seq, &[]).await;
    });
    result.unwrap();
}

#[tokio::test]
async fn selected_pre_spawn_cancellation_marks_owner_before_frame_drop() {
    let (client, mut guest) = connection().await;
    let cancel = CancellationToken::new();
    let owner =
        OperationCancellationContext::new("cancelled-run", SANDBOX, "guest_agent_preparation");
    let mut prefix = [0u8; guest_control_proto::HEADER_SIZE + guest_control_proto::MIN_BODY_SIZE];
    let mut phase = Box::pin(run_pre_spawn_phase(
        &cancel,
        &owner,
        client.write_file("/tmp/history", CONTENT, false),
    ));
    tokio::select! {
        _ = &mut phase => panic!("preparation finished before file admission"),
        result = tokio::time::timeout(BOUND, guest.read_exact(&mut prefix)) => { result.unwrap().unwrap(); assert_eq!(prefix[guest_control_proto::HEADER_SIZE], MSG_WRITE_FILE); },
    }
    cancel.cancel();
    assert!(phase.await.is_none());
    let mut tail = Vec::new();
    tokio::time::timeout(BOUND, guest.read_to_end(&mut tail))
        .await
        .unwrap()
        .unwrap();
    assert!(
        tail.len() < CONTENT.len(),
        "the frame must remain incomplete"
    );
    let error = client.shutdown(BOUND).await.unwrap_err();
    let close = ConnectionClosedAtAdmission::from_error(&error)
        .unwrap()
        .close_info();
    assert_eq!(close.cancelled_owner().unwrap().run_id(), "cancelled-run");
    assert_eq!(close.connection_id(), client.connection_id());
}

#[tokio::test]
async fn a_ready_preparation_error_wins_over_concurrent_cancellation() {
    let (client, mut guest) = connection().await;
    let cancel = CancellationToken::new();
    let owner = OperationCancellationContext::new("failed-run", SANDBOX, "guest_agent_preparation");
    let observer = FrameWriteObserver::new({
        let cancel = cancel.clone();
        move || {
            cancel.cancel();
            Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "fixture write rejection",
            ))
        }
    });
    let result = run_pre_spawn_phase(
        &cancel,
        &owner,
        client.write_file_with_write_observer("/tmp/history", b"history", false, observer),
    )
    .await;
    assert_eq!(
        result.unwrap().unwrap_err().kind(),
        io::ErrorKind::InvalidInput
    );
    assert!(cancel.is_cancelled());
    assert!(owner.cancelled_owner().is_none());
    acknowledge_shutdown(&client, &mut guest).await;
}

#[tokio::test]
async fn already_cancelled_preparation_keeps_the_unused_transport_healthy() {
    let (client, mut guest) = connection().await;
    let cancel = CancellationToken::new();
    cancel.cancel();
    let owner =
        OperationCancellationContext::new("cancelled-run", SANDBOX, "guest_agent_preparation");
    assert!(
        run_pre_spawn_phase(
            &cancel,
            &owner,
            client.write_file("/tmp/history", b"history", false)
        )
        .await
        .is_none()
    );
    acknowledge_shutdown(&client, &mut guest).await;
}

#[tokio::test]
async fn a_reused_transport_records_the_owner_of_the_cancelled_assignment() {
    let (client, mut guest) = connection().await;
    let connection_id = client.connection_id();
    let first = OperationCancellationContext::new("first-run", SANDBOX, "guest_agent_preparation");
    let first_cancel = CancellationToken::new();
    let (result, ()) = tokio::join!(
        run_pre_spawn_phase(
            &first_cancel,
            &first,
            client.write_file("/tmp/first", b"first", false)
        ),
        async {
            let request = read_frame(&mut guest).await;
            assert_eq!(request.msg_type, MSG_WRITE_FILE);
            send_frame(
                &mut guest,
                MSG_WRITE_FILE_RESULT,
                request.seq,
                &guest_control_proto::encode_write_file_result(true, ""),
            )
            .await;
        }
    );
    result.unwrap().unwrap();
    let second =
        OperationCancellationContext::new("second-run", SANDBOX, "guest_agent_preparation");
    let cancel = CancellationToken::new();
    let mut prefix = [0u8; guest_control_proto::HEADER_SIZE + guest_control_proto::MIN_BODY_SIZE];
    let mut phase = Box::pin(run_pre_spawn_phase(
        &cancel,
        &second,
        client.write_file("/tmp/second", CONTENT, false),
    ));
    tokio::select! {
        _ = &mut phase => panic!("second preparation completed before admission"),
        result = tokio::time::timeout(BOUND, guest.read_exact(&mut prefix)) => { result.unwrap().unwrap(); assert_eq!(prefix[guest_control_proto::HEADER_SIZE], MSG_WRITE_FILE); },
    }
    cancel.cancel();
    assert!(phase.await.is_none());
    let error = client.shutdown(BOUND).await.unwrap_err();
    let close = ConnectionClosedAtAdmission::from_error(&error)
        .unwrap()
        .close_info();
    assert_eq!(close.connection_id(), connection_id);
    assert_eq!(close.cancelled_owner().unwrap().run_id(), "second-run");
}
