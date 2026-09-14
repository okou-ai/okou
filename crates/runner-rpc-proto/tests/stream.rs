#![cfg(test)]

use std::{io, time::Duration};

use runner_rpc_proto::{Delivery, ErrorCode, Response, stream::*};
use serde_json::value::RawValue;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::UnixStream,
    time::timeout,
};

fn result() -> Frame {
    Frame::Control(Response::Result {
        data: RawValue::from_string("{\"complete\":true}".into()).unwrap(),
    })
}

fn error(delivery: Delivery) -> Frame {
    Frame::Control(Response::error(ErrorCode::Protocol, delivery))
}

fn raw(body: &[u8]) -> Vec<u8> {
    let mut bytes = (body.len() as u32).to_be_bytes().to_vec();
    bytes.extend_from_slice(body);
    bytes
}

#[tokio::test]
async fn binary_and_empty_streams_end_without_transport_eof() {
    for data in [vec![], vec![0, 255, 10, 128, 1]] {
        let (sender, receiver) = UnixStream::pair().unwrap();
        let mut writer = Writer::input(sender);
        let mut reader = Reader::input(receiver);
        let send = async {
            if !data.is_empty() {
                writer.send(&Frame::Data(data.clone())).await.unwrap();
            }
            writer.send(&Frame::End).await.unwrap();
        };
        let read = async {
            let mut received = Vec::new();
            while let Some(frame) = reader.next().await.unwrap() {
                match frame {
                    Frame::Data(data) => received.extend(data),
                    Frame::End => (),
                    Frame::Control(_) => panic!("input control"),
                }
            }
            assert_eq!(received, data);
        };
        timeout(Duration::from_secs(2), async { tokio::join!(send, read) })
            .await
            .unwrap();
        assert!(writer.send(&Frame::Data(vec![2])).await.is_err());
        assert!(writer.send(&Frame::End).await.is_err());
    }
}

#[tokio::test]
async fn response_stream_preserves_opaque_controls_and_requires_end_before_result() {
    let data = "{\"n\":1e9999,\"n\":123456789012345678901234567890}";
    let mut wire = Vec::new();
    let mut writer = Writer::responses(&mut wire);
    writer
        .send(&Frame::Control(Response::Event {
            data: RawValue::from_string(data.into()).unwrap(),
        }))
        .await
        .unwrap();
    writer.send(&Frame::Data(vec![0, 255])).await.unwrap();
    assert!(writer.send(&result()).await.is_err());
    assert!(writer.is_usable());
    assert!(writer.send(&error(Delivery::NotDispatched)).await.is_err());
    writer.send(&Frame::End).await.unwrap();
    writer.send(&result()).await.unwrap();
    assert!(!writer.is_usable());
    assert!(writer.send(&result()).await.is_err());
    let mut reader = Reader::responses(wire.as_slice());
    let Some(Frame::Control(Response::Event { data: received })) = reader.next().await.unwrap()
    else {
        panic!("missing event")
    };
    assert_eq!(received.get(), data);
    assert!(matches!(reader.next().await.unwrap(), Some(Frame::Data(bytes)) if bytes == [0,255]));
    assert!(matches!(reader.next().await.unwrap(), Some(Frame::End)));
    assert!(matches!(
        reader.next().await.unwrap(),
        Some(Frame::Control(Response::Result { .. }))
    ));
    assert!(reader.next().await.unwrap().is_none());
}

#[tokio::test]
async fn early_error_or_failure_after_data_does_not_require_end() {
    for started in [false, true] {
        let mut wire = Vec::new();
        let mut writer = Writer::responses(&mut wire);
        if started {
            writer.send(&Frame::Data(vec![42])).await.unwrap();
        }
        writer
            .send(&error(if started {
                Delivery::Unknown
            } else {
                Delivery::NotDispatched
            }))
            .await
            .unwrap();
        let mut reader = Reader::responses(wire.as_slice());
        if started {
            assert!(matches!(reader.next().await.unwrap(), Some(Frame::Data(_))));
        }
        assert!(matches!(
            reader.next().await.unwrap(),
            Some(Frame::Control(Response::Error { .. }))
        ));
        assert!(reader.next().await.unwrap().is_none());
    }
}

#[tokio::test]
async fn malformed_frames_and_order_poison_readers() {
    let terminal = raw(br#"{"type":"result","data":null}"#);
    let missing_end = [raw(&[0, 2]), terminal.clone()].concat();
    for bytes in [
        vec![],
        vec![0, 0],
        vec![0, 0, 0, 0],
        raw(&[0]),
        raw(&[1, 2]),
        raw(&[2]),
        raw(br#"{"type":"result","data":null,"extra":0}"#),
        raw(br#"{"type":"result","type":"result","data":null}"#),
        raw(br#"["result",null]"#),
        [raw(&[1]), raw(&[0, 42])].concat(),
        [raw(&[1]), raw(&[1])].concat(),
        missing_end,
        [terminal.clone(), terminal.clone()].concat(),
        [terminal, vec![0]].concat(),
        [
            raw(&[0, 42]),
            raw(br#"{"type":"error","code":"protocol","delivery":"not_dispatched"}"#),
        ]
        .concat(),
        raw(&[1]),
    ] {
        let mut reader = Reader::responses(bytes.as_slice());
        loop {
            match reader.next().await {
                Ok(Some(_)) => (),
                Ok(None) => panic!("malformed stream accepted"),
                Err(_) => break,
            }
        }
        assert!(reader.next().await.is_err());
    }
    for bytes in [
        vec![],
        raw(&[0, 1]),
        raw(br#"{"type":"result","data":null}"#),
    ] {
        let mut reader = Reader::input(bytes.as_slice());
        while let Ok(Some(_)) = reader.next().await {}
        assert!(reader.next().await.is_err());
    }
}

#[tokio::test]
async fn advertised_oversize_is_rejected_without_receiving_body() {
    for (size, tag) in [
        (u32::MAX, None),
        ((MAX_DATA_BYTES + 2) as u32, None),
        (
            (runner_rpc_proto::MAX_RESPONSE_BYTES + 1) as u32,
            Some(b'{'),
        ),
    ] {
        let (mut sender, receiver) = UnixStream::pair().unwrap();
        sender.write_all(&size.to_be_bytes()).await.unwrap();
        if let Some(tag) = tag {
            sender.write_u8(tag).await.unwrap();
        }
        let mut reader = Reader::responses(receiver);
        let result = timeout(Duration::from_secs(1), reader.next())
            .await
            .unwrap();
        assert_eq!(result.err().unwrap().kind(), io::ErrorKind::InvalidData);
    }
}

#[tokio::test]
async fn frame_and_total_data_limits_preserve_end_and_error_capacity() {
    let mut writer = Writer::responses(tokio::io::sink());
    assert!(writer.send(&Frame::Data(vec![])).await.is_err());
    assert!(
        writer
            .send(&Frame::Data(vec![0; MAX_DATA_BYTES + 1]))
            .await
            .is_err()
    );
    let frame = Frame::Data(vec![0; MAX_DATA_BYTES]);
    // Sink keeps this a bounded-memory byte-accounting test, not a 1 GiB fixture.
    for _ in 0..MAX_STREAM_BYTES / MAX_DATA_BYTES as u64 {
        writer.send(&frame).await.unwrap();
    }
    assert!(writer.send(&Frame::Data(vec![0])).await.is_err());
    writer.send(&Frame::End).await.unwrap();
    writer.send(&result()).await.unwrap();

    let mut wire = Vec::new();
    let mut writer = Writer::responses(&mut wire);
    for _ in 0..MAX_STREAM_FRAMES - 1 {
        writer.send(&Frame::Data(vec![7])).await.unwrap();
    }
    assert!(writer.send(&Frame::Data(vec![8])).await.is_err());
    writer.send(&Frame::End).await.unwrap();
    writer.send(&result()).await.unwrap();
    let mut reader = Reader::responses(wire.as_slice());
    let mut count = 0;
    while let Some(frame) = reader.next().await.unwrap() {
        if matches!(frame, Frame::Data(_)) {
            count += 1;
        }
    }
    assert_eq!(count, MAX_STREAM_FRAMES - 1);
}

#[tokio::test]
async fn control_budget_is_independent_of_binary_and_reserves_terminal() {
    let mut wire = Vec::new();
    let mut writer = Writer::responses(&mut wire);
    let event = Frame::Control(Response::Event {
        data: RawValue::from_string(format!("\"{}\"", "x".repeat(16 * 1024))).unwrap(),
    });
    while writer.send(&event).await.is_ok() {}
    writer
        .send(&Frame::Data(vec![255; MAX_DATA_BYTES]))
        .await
        .unwrap();
    writer.send(&error(Delivery::Unknown)).await.unwrap();
    let mut reader = Reader::responses(wire.as_slice());
    while reader.next().await.unwrap().is_some() {}
}

#[tokio::test]
async fn partial_reads_and_writes_cannot_resume_after_cancellation() {
    let (mut peer, receiver) = UnixStream::pair().unwrap();
    peer.write_all(&[0, 0]).await.unwrap();
    let mut reader = Reader::responses(receiver);
    tokio::select! {
        biased;
        _ = reader.next() => panic!("incomplete header returned"),
        () = std::future::ready(()) => (),
    }
    assert!(reader.next().await.is_err());

    let (sender, mut receiver) = tokio::io::duplex(5);
    let mut writer = Writer::responses(sender);
    let frame = Frame::Data(vec![0; 100]);
    tokio::select! {
        biased;
        _ = writer.send(&frame) => panic!("blocked write completed"),
        () = std::future::ready(()) => (),
    }
    assert!(!writer.is_usable());
    assert!(writer.send(&error(Delivery::Unknown)).await.is_err());
    drop(writer);
    let mut received = Vec::new();
    receiver.read_to_end(&mut received).await.unwrap();
    assert_eq!(received.len(), 5);
}
