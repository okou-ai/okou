use std::io::{Read, Write};
use std::net::Shutdown;
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::sync::atomic::Ordering;
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};

use guest_control_proto::ExecControlStatus;

use super::super::forward::forward_control_request;
use super::super::sink::ControlSinkInner;
use super::super::{EXEC_REQUEST_TIMEOUT_DIAGNOSTIC, request_deadline};
use super::support::{
    connected_sink, connected_stream_handle, guest_writer_pair, owned_control_request,
    read_exec_control_result,
};

// A version-1 Accepted response for message "m", with no diagnostic.
const RESPONSE: &[u8] = &[0, 0, 0, 8, 1, 3, 0, 1, b'm', 0, 0, 0];
const PEER_TIMEOUT: Duration = Duration::from_secs(3);

fn assert_peer_closed(peer: &mut UnixStream) {
    match peer.read(&mut [0]) {
        Ok(0) => {}
        // Closing with an unread fragment can reset the peer instead of EOF.
        Err(error) => assert_eq!(error.kind(), std::io::ErrorKind::ConnectionReset),
        result => panic!("sink must shut down, got {result:?}"),
    }
}

fn assert_fragmented_response_timeout(fragments: &[&[u8]]) {
    const REQUEST_TIMEOUT_MS: u32 = 1000;
    const FRAGMENT_INTERVAL: Duration = Duration::from_millis(600);
    const COMPLETION_MARGIN: Duration = Duration::from_millis(300);

    let (sink, mut peer) = connected_sink();
    peer.set_read_timeout(Some(PEER_TIMEOUT)).unwrap();
    peer.set_write_timeout(Some(PEER_TIMEOUT)).unwrap();
    let pending_slot = sink.reserve_pending_slot().unwrap();
    let (writer, mut host) = guest_writer_pair();

    std::thread::scope(|scope| {
        let (completed_tx, completed_rx) = mpsc::channel();
        let worker_sink = Arc::clone(&sink);
        let worker = scope.spawn(move || {
            let request = owned_control_request(12, 8, REQUEST_TIMEOUT_MS, "m");
            let deadline = request.deadline;
            forward_control_request(worker_sink, pending_slot, request, writer.clone());
            completed_tx.send((deadline, Instant::now())).unwrap();
            writer
        });

        let request = process_control_ipc::read_request(&mut peer).unwrap();
        assert_eq!(request.message_id, "m");
        assert_eq!(request.payload, b"payload");
        let observation_deadline = Instant::now()
            + Duration::from_millis(u64::from(REQUEST_TIMEOUT_MS))
            + COMPLETION_MARGIN;
        let mut sent = 0;
        for fragment in fragments {
            if sent > 0 {
                std::thread::sleep(FRAGMENT_INTERVAL);
            }
            match peer.write_all(fragment) {
                Ok(()) => sent += fragment.len(),
                Err(error) => {
                    assert_eq!(error.kind(), std::io::ErrorKind::BrokenPipe);
                    break;
                }
            }
        }

        // Keep the response incomplete: a post-decode expiry check cannot
        // satisfy this completion oracle. Renewing each read's budget would
        // instead keep forwarding alive until about 1600 ms.
        let completed = completed_rx
            .recv_timeout(observation_deadline.saturating_duration_since(Instant::now()));
        if completed.is_err() {
            // Unblock the worker before joining even when the deadline regresses.
            peer.shutdown(Shutdown::Both).unwrap();
        }
        let writer = worker.join().unwrap();
        let (deadline, completed_at) = completed
            .expect("forwarding must finish at the total deadline with an incomplete response");
        assert!(
            completed_at <= deadline + COMPLETION_MARGIN,
            "forwarding exceeded the total deadline while the response was incomplete"
        );

        let (_, seq, status, message_id, diagnostic) = read_exec_control_result(&mut host);
        assert_eq!(seq, 12);
        assert_eq!(message_id, "m");
        assert_eq!(status, ExecControlStatus::SinkTimeout);
        assert!(!diagnostic.is_empty());
        assert!(sent > fragments[0].len(), "peer must make partial progress");
        assert_eq!(sink.pending.load(Ordering::Acquire), 0);
        assert!(matches!(
            *sink.inner.lock().unwrap(),
            ControlSinkInner::Failed(_)
        ));
        assert_peer_closed(&mut peer);

        forward_control_request(
            Arc::clone(&sink),
            sink.reserve_pending_slot().unwrap(),
            owned_control_request(13, 8, 5000, "after-timeout"),
            writer,
        );
        let (_, seq, status, message_id, _) = read_exec_control_result(&mut host);
        assert_eq!(seq, 13);
        assert_eq!(message_id, "after-timeout");
        assert_eq!(status, ExecControlStatus::SinkError);
        assert_eq!(sink.pending.load(Ordering::Acquire), 0);
    });
}

#[test]
fn fragmented_control_response_prefix_cannot_extend_request_deadline() {
    assert_fragmented_response_timeout(&[&RESPONSE[..1], &RESPONSE[1..2]]);
}

#[test]
fn fragmented_control_response_body_cannot_extend_request_deadline() {
    assert_fragmented_response_timeout(&[&RESPONSE[..4], &RESPONSE[4..5]]);
}

#[test]
fn backpressured_control_request_stops_before_the_frame_is_complete() {
    let (sink, mut peer) = connected_sink();
    peer.set_read_timeout(Some(PEER_TIMEOUT)).unwrap();
    let stream_handle = connected_stream_handle(&sink);
    let stream = stream_handle
        .lock_until(request_deadline(5000), &sink.active)
        .unwrap();
    let send_buffer: libc::c_int = 4096;
    // SAFETY: the guard keeps the socket live, and the option points to an
    // initialized integer with the correct length for SO_SNDBUF.
    let result = unsafe {
        libc::setsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_SNDBUF,
            (&raw const send_buffer).cast(),
            std::mem::size_of_val(&send_buffer) as libc::socklen_t,
        )
    };
    assert_eq!(result, 0, "{}", std::io::Error::last_os_error());
    drop(stream);

    let pending_slot = sink.reserve_pending_slot().unwrap();
    let (writer, mut host) = guest_writer_pair();
    let mut request = owned_control_request(12, 8, 5000, "m");
    request.payload = vec![0xA5; process_control_ipc::MAX_CONTROL_PAYLOAD_BYTES];
    let frame_len = 4 + 2 + 2 + 1 + 4 + request.payload.len();

    std::thread::scope(|scope| {
        let worker_sink = Arc::clone(&sink);
        let worker = scope.spawn(move || {
            request.deadline = request_deadline(400);
            forward_control_request(worker_sink, pending_slot, request, writer);
        });

        let mut buffer = [0; 4096];
        let mut received = peer.read(&mut buffer).unwrap();
        assert!(
            received > 0,
            "request must start before the slow-drain window"
        );
        let started = Instant::now();
        while received < frame_len {
            // Keep making progress below the per-call timeout, but take much
            // longer than the total budget. Bound even the broken-code path.
            if started.elapsed() < Duration::from_secs(2) {
                std::thread::sleep(Duration::from_millis(40));
            }
            let count = peer.read(&mut buffer).unwrap();
            if count == 0 {
                break;
            }
            received += count;
        }

        let (_, seq, status, message_id, diagnostic) = read_exec_control_result(&mut host);
        worker.join().unwrap();
        assert_eq!(seq, 12);
        assert_eq!(message_id, "m");
        assert_eq!(status, ExecControlStatus::SinkTimeout);
        assert!(!diagnostic.is_empty());
        assert!(received > buffer.len(), "peer must make partial progress");
        assert!(
            received < frame_len,
            "expired request must stop writing, received {received}/{frame_len} bytes"
        );
        assert_eq!(sink.pending.load(Ordering::Acquire), 0);
        assert!(matches!(
            *sink.inner.lock().unwrap(),
            ControlSinkInner::Failed(_)
        ));
        assert_peer_closed(&mut peer);
    });
}

#[test]
fn pre_io_timeout_preserves_sink_for_fragmented_delivery_within_budget() {
    let (sink, mut peer) = connected_sink();
    let (writer, mut host) = guest_writer_pair();
    forward_control_request(
        Arc::clone(&sink),
        sink.reserve_pending_slot().unwrap(),
        owned_control_request(12, 8, 0, "expired"),
        writer.clone(),
    );
    let (_, _, status, _, diagnostic) = read_exec_control_result(&mut host);
    assert_eq!(status, ExecControlStatus::SinkTimeout);
    assert_eq!(diagnostic, EXEC_REQUEST_TIMEOUT_DIAGNOSTIC);
    assert_eq!(sink.pending.load(Ordering::Acquire), 0);
    peer.set_nonblocking(true).unwrap();
    assert_eq!(
        peer.read(&mut [0]).unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock,
        "expired request must not write or shut down the socket"
    );
    peer.set_nonblocking(false).unwrap();
    peer.set_read_timeout(Some(PEER_TIMEOUT)).unwrap();
    peer.set_write_timeout(Some(PEER_TIMEOUT)).unwrap();

    for seq in [13, 14] {
        let pending_slot = sink.reserve_pending_slot().unwrap();
        std::thread::scope(|scope| {
            let worker_sink = Arc::clone(&sink);
            let worker_writer = writer.clone();
            let worker = scope.spawn(move || {
                forward_control_request(
                    worker_sink,
                    pending_slot,
                    owned_control_request(seq, 8, 5000, "m"),
                    worker_writer,
                );
            });
            let request = process_control_ipc::read_request(&mut peer).unwrap();
            assert_eq!(request.message_id, "m");
            assert_eq!(request.payload, b"payload");
            for byte in RESPONSE.chunks(1) {
                peer.write_all(byte).unwrap();
                std::thread::sleep(Duration::from_millis(5));
            }
            let (_, result_seq, status, message_id, diagnostic) =
                read_exec_control_result(&mut host);
            worker.join().unwrap();
            assert_eq!(result_seq, seq);
            assert_eq!(message_id, "m");
            assert_eq!(status, ExecControlStatus::Delivered);
            assert_eq!(diagnostic, "");
            assert_eq!(sink.pending.load(Ordering::Acquire), 0);
            assert!(matches!(
                *sink.inner.lock().unwrap(),
                ControlSinkInner::Connected(_)
            ));
        });
    }
}
