use std::io;

use guest_control_client::test_support::request_gate::{
    ConnectionProducer, Controls, ExchangeProducer, RequestKind, ResponseDisposition,
    gate_connection,
};
use guest_control_proto::{
    MAX_MESSAGE_SIZE, MSG_EXEC_OUTPUT, MSG_OPERATIONS_QUIESCED, MSG_PING, MSG_PONG,
    MSG_QUIESCE_OPERATIONS, MSG_WRITE_FILE,
};
use nix::sys::socket::{getsockopt, setsockopt, sockopt::SndBuf};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

use super::support::*;

fn raw_pair() -> TestResult<(Peer, Peer, Controls, ExchangeProducer, ConnectionProducer)> {
    let (host_stream, host) = UnixStream::pair()?;
    let (guest, guest_stream) = UnixStream::pair()?;
    for stream in [&host_stream, &host, &guest_stream, &guest] {
        setsockopt(stream, SndBuf, &4096)?;
        assert!(getsockopt(stream, SndBuf)? < 64 * 1024);
    }
    let (controls, exchange, connection) = gate_connection(host, guest);
    Ok((
        Peer {
            stream: host_stream,
        },
        Peer {
            stream: guest_stream,
        },
        controls,
        exchange,
        connection,
    ))
}

#[tokio::test]
async fn simultaneous_kernel_backpressure_keeps_both_directions_progressing() {
    let (mut host, mut guest, _controls, mut exchange, mut connection) = raw_pair().unwrap();
    let to_guest = guest_control_proto::encode(MSG_WRITE_FILE, 61, &vec![31; 32 * 1024]).unwrap();
    let to_host = guest_control_proto::encode(MSG_EXEC_OUTPUT, 62, &vec![63; 512 * 1024]).unwrap();
    bounded(async {
        tokio::join!(
            async {
                host.stream.write_all(&to_guest).await.unwrap();
                assert_eq!(host.next().await.unwrap().raw, to_host);
            },
            async {
                guest.stream.write_all(&to_host).await.unwrap();
                assert_eq!(guest.next().await.unwrap().raw, to_guest);
            },
        );
    })
    .await
    .unwrap();
    drop(guest);
    bounded(connection.join()).await.unwrap().unwrap();
    assert!(bounded(exchange.join()).await.unwrap().is_err());
    drop(host);
}

#[tokio::test]
async fn partial_frames_survive_both_release_events_and_unrelated_duplex_progress() {
    let (mut host, mut guest, mut controls, mut exchange, mut connection) = raw_pair().unwrap();
    controls.arm(RequestKind::Quiesce).unwrap();
    let original = host.send(MSG_QUIESCE_OPERATIONS, 71, &[]).await.unwrap();
    assert_eq!(
        bounded(&mut controls.captured)
            .await
            .unwrap()
            .unwrap()
            .raw(),
        original
    );

    // More than the kernel send buffer must be read before write_all completes.
    // The incomplete frame therefore has real retained read progress when the
    // opposite-direction frame and release events cancel the read observation.
    let host_frame =
        guest_control_proto::encode(MSG_WRITE_FILE, 72, &vec![23; 128 * 1024]).unwrap();
    bounded(host.stream.write_all(host_frame.get(..64 * 1024).unwrap()))
        .await
        .unwrap()
        .unwrap();
    guest.send(MSG_PONG, 71, &[]).await.unwrap();
    assert_eq!(host.next().await.unwrap().message.msg_type, MSG_PONG);
    controls.dispatch.send(()).unwrap();
    assert_eq!(guest.next().await.unwrap().raw, original);
    let terminal = guest.send(MSG_OPERATIONS_QUIESCED, 71, &[]).await.unwrap();
    assert_eq!(
        bounded(&mut controls.response)
            .await
            .unwrap()
            .unwrap()
            .raw(),
        terminal
    );

    let guest_frame =
        guest_control_proto::encode(MSG_EXEC_OUTPUT, 73, &vec![47; 128 * 1024]).unwrap();
    bounded(
        guest
            .stream
            .write_all(guest_frame.get(..64 * 1024).unwrap()),
    )
    .await
    .unwrap()
    .unwrap();
    let ((), forwarded) = tokio::join!(
        async {
            host.stream
                .write_all(host_frame.get(64 * 1024..).unwrap())
                .await
                .unwrap();
        },
        guest.next(),
    );
    assert_eq!(forwarded.unwrap().raw, host_frame);
    controls
        .delivery
        .send(ResponseDisposition::Deliver)
        .unwrap();
    assert_eq!(host.next().await.unwrap().raw, terminal);
    let ((), forwarded) = tokio::join!(
        async {
            guest
                .stream
                .write_all(guest_frame.get(64 * 1024..).unwrap())
                .await
                .unwrap();
        },
        host.next(),
    );
    assert_eq!(forwarded.unwrap().raw, guest_frame);
    let joined = bounded(exchange.join()).await.unwrap().unwrap();
    assert_eq!(joined.request.raw(), original);
    assert_eq!(joined.response.raw(), terminal);
    drop(guest);
    bounded(connection.join()).await.unwrap().unwrap();
    drop(host);
}

#[tokio::test]
async fn host_eof_does_not_cancel_guest_before_actual_terminal_drain() {
    let (mut host, mut guest, mut controls, mut exchange, mut connection) = raw_pair().unwrap();
    controls.arm(RequestKind::Quiesce).unwrap();
    host.send(MSG_QUIESCE_OPERATIONS, 81, &[]).await.unwrap();
    bounded(&mut controls.captured).await.unwrap().unwrap();
    controls.dispatch.send(()).unwrap();
    assert_eq!(guest.next().await.unwrap().message.seq, 81);
    drop(host);
    let mut byte = [0];
    {
        let mut observe_guest_eof = Box::pin(guest.stream.read(&mut byte));
        pending_once(observe_guest_eof.as_mut()).await;
    }
    let terminal = guest.send(MSG_OPERATIONS_QUIESCED, 81, &[]).await.unwrap();
    assert_eq!(
        bounded(&mut controls.response)
            .await
            .unwrap()
            .unwrap()
            .raw(),
        terminal
    );
    controls
        .delivery
        .send(ResponseDisposition::Deliver)
        .unwrap();
    assert!(bounded(exchange.join()).await.unwrap().is_err());
    {
        let mut join = Box::pin(connection.join());
        pending_once(join.as_mut()).await;
    }
    drop(guest);
    assert!(bounded(connection.join()).await.unwrap().is_err());
}

#[tokio::test]
async fn guest_eof_keeps_a_real_held_terminal_until_delivery() {
    let (mut host, mut guest, mut controls, mut exchange, mut connection) = raw_pair().unwrap();
    controls.arm(RequestKind::Quiesce).unwrap();
    host.send(MSG_QUIESCE_OPERATIONS, 91, &[]).await.unwrap();
    bounded(&mut controls.captured).await.unwrap().unwrap();
    controls.dispatch.send(()).unwrap();
    guest.next().await.unwrap();
    let terminal = guest.send(MSG_OPERATIONS_QUIESCED, 91, &[]).await.unwrap();
    bounded(&mut controls.response).await.unwrap().unwrap();
    drop(guest);
    {
        let mut join = Box::pin(exchange.join());
        pending_once(join.as_mut()).await;
    }
    controls
        .delivery
        .send(ResponseDisposition::Deliver)
        .unwrap();
    assert_eq!(host.next().await.unwrap().raw, terminal);
    assert_eq!(
        bounded(exchange.join())
            .await
            .unwrap()
            .unwrap()
            .response
            .raw(),
        terminal
    );
    bounded(connection.join()).await.unwrap().unwrap();
    drop(host);
}

#[tokio::test]
async fn eof_before_terminal_and_missing_selection_are_not_positive_exchange_joins() {
    for selected in [false, true] {
        let (mut host, mut guest, mut controls, mut exchange, mut connection) = raw_pair().unwrap();
        if selected {
            controls.arm(RequestKind::Quiesce).unwrap();
            host.send(MSG_QUIESCE_OPERATIONS, 101, &[]).await.unwrap();
            bounded(&mut controls.captured).await.unwrap().unwrap();
            controls.dispatch.send(()).unwrap();
            guest.next().await.unwrap();
        } else {
            host.send(MSG_PING, 101, &[]).await.unwrap();
            assert_eq!(guest.next().await.unwrap().message.msg_type, MSG_PING);
            guest.send(MSG_PONG, 101, &[]).await.unwrap();
            assert_eq!(host.next().await.unwrap().message.msg_type, MSG_PONG);
        }
        drop(guest);
        assert_eq!(
            bounded(exchange.join()).await.unwrap().unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
        let result = bounded(connection.join()).await.unwrap();
        if selected {
            assert_eq!(result.unwrap_err().kind(), io::ErrorKind::UnexpectedEof);
        } else {
            result.unwrap();
        }
        drop(host);
    }
}

#[tokio::test]
async fn invalid_lengths_and_truncated_original_frames_fail_closed_in_both_directions() {
    let cases = [
        (0u32.to_be_bytes().to_vec(), io::ErrorKind::InvalidData),
        (
            ((MAX_MESSAGE_SIZE + 1) as u32).to_be_bytes().to_vec(),
            io::ErrorKind::InvalidData,
        ),
        (vec![0, 0], io::ErrorKind::UnexpectedEof),
        (
            vec![0, 0, 0, 9, MSG_PING, 0, 0],
            io::ErrorKind::UnexpectedEof,
        ),
    ];
    for from_host in [false, true] {
        for (wire, expected) in &cases {
            let (mut host, mut guest, _controls, mut exchange, mut connection) =
                raw_pair().unwrap();
            if from_host {
                host.stream.write_all(wire).await.unwrap();
                host.stream.shutdown().await.unwrap();
            } else {
                guest.stream.write_all(wire).await.unwrap();
                guest.stream.shutdown().await.unwrap();
            }
            assert_eq!(
                bounded(connection.join())
                    .await
                    .unwrap()
                    .unwrap_err()
                    .kind(),
                *expected
            );
            assert_eq!(
                bounded(exchange.join()).await.unwrap().unwrap_err().kind(),
                *expected
            );
            drop(host);
            drop(guest);
        }
    }
}

#[tokio::test]
async fn predispatch_or_duplicate_terminal_cannot_fabricate_joined_exchange() {
    for dispatch in [false, true] {
        let (mut host, mut guest, mut controls, mut exchange, mut connection) = raw_pair().unwrap();
        controls.arm(RequestKind::Quiesce).unwrap();
        host.send(MSG_QUIESCE_OPERATIONS, 111, &[]).await.unwrap();
        bounded(&mut controls.captured).await.unwrap().unwrap();
        if dispatch {
            controls.dispatch.send(()).unwrap();
            guest.next().await.unwrap();
            guest.send(MSG_OPERATIONS_QUIESCED, 111, &[]).await.unwrap();
            bounded(&mut controls.response).await.unwrap().unwrap();
        }
        guest.send(MSG_OPERATIONS_QUIESCED, 111, &[]).await.unwrap();
        assert_eq!(
            bounded(connection.join())
                .await
                .unwrap()
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(
            bounded(exchange.join()).await.unwrap().unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        drop(host);
        drop(guest);
    }
}
