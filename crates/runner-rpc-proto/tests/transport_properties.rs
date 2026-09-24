#![cfg(test)]

use std::{
    future::ready,
    io,
    pin::Pin,
    task::{Context, Poll},
};

use proptest::prelude::*;
use proptest::test_runner::{Config as ProptestConfig, RngSeed};
use runner_rpc_proto::{
    Delivery, ErrorCode, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, MAX_RESPONSE_STREAM_BYTES, Request,
    Response, ResponseReader, ResponseWriter, parse_request, read_request, write_request,
};
use serde_json::{Value, json, value::RawValue};
use tokio::io::{AsyncRead, AsyncWriteExt, ReadBuf};

const PROPERTY_CASES: u32 = 128;
const PROPERTY_SEED: u64 = 0x3658_1DEC_2026_0924;

fn property_config() -> ProptestConfig {
    ProptestConfig {
        cases: PROPERTY_CASES,
        rng_seed: RngSeed::Fixed(PROPERTY_SEED),
        ..ProptestConfig::default()
    }
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("create test runtime")
}

/// Return at most one configured chunk per poll; later polls get the remainder.
struct Chunked<'a> {
    remaining: &'a [u8],
    chunks: Vec<usize>,
    next: usize,
}

impl<'a> Chunked<'a> {
    fn new(bytes: &'a [u8], chunks: Vec<usize>) -> Self {
        Self {
            remaining: bytes,
            chunks,
            next: 0,
        }
    }
}

impl AsyncRead for Chunked<'_> {
    fn poll_read(
        self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if this.remaining.is_empty() {
            return Poll::Ready(Ok(()));
        }
        let chunk = this.chunks.get(this.next).copied().unwrap_or(usize::MAX);
        this.next += 1;
        let count = this.remaining.len().min(buf.remaining()).min(chunk.max(1));
        buf.put_slice(&this.remaining[..count]);
        this.remaining = &this.remaining[count..];
        Poll::Ready(Ok(()))
    }
}

fn frame(body: &[u8]) -> Vec<u8> {
    let mut wire = (body.len() as u32).to_be_bytes().to_vec();
    wire.extend_from_slice(body);
    wire
}

fn response(kind: u8, data: &Value) -> Response {
    match kind % 4 {
        0 => Response::Event {
            data: RawValue::from_string(data.to_string()).unwrap(),
        },
        1 => Response::Result {
            data: RawValue::from_string(data.to_string()).unwrap(),
        },
        2 => Response::error(ErrorCode::Protocol, Delivery::NotDispatched),
        _ => Response::error(ErrorCode::Transport, Delivery::Unknown),
    }
}

fn response_frame(response: &Response) -> Vec<u8> {
    frame(&serde_json::to_vec(response).unwrap())
}

fn chunk_strategy() -> impl Strategy<Value = Vec<usize>> {
    proptest::collection::vec(1usize..=32, 0..=24)
}

proptest! {
    #![proptest_config(property_config())]

    #[test]
    fn incomplete_length_headers_fail_closed(
        header in any::<u32>(),
        prefix_len in 0usize..=3,
        chunks in chunk_strategy(),
    ) {
        let header_bytes = header.to_be_bytes();
        let wire = &header_bytes[..prefix_len];
        let request = runtime().block_on(read_request(&mut Chunked::new(wire, chunks.clone())));
        let mut reader = ResponseReader::new(Chunked::new(wire, chunks));
        let response = runtime().block_on(reader.next());
        let expected = if prefix_len == 0 { io::ErrorKind::InvalidData } else { io::ErrorKind::UnexpectedEof };
        prop_assert_eq!(request.err().unwrap().kind(), expected);
        prop_assert_eq!(response.err().unwrap().kind(), expected);
        prop_assert!(runtime().block_on(reader.next()).is_err());
    }

    #[test]
    fn arbitrary_request_frames_obey_lengths_and_validation(
        body in proptest::collection::vec(any::<u8>(), 0..=512),
        advertised in prop_oneof![Just(0_u32), 1_u32..=640, Just(MAX_REQUEST_BYTES as u32 + 1), Just(u32::MAX)],
        chunks in chunk_strategy(),
        trailing in proptest::collection::vec(any::<u8>(), 0..=16),
    ) {
        let mut wire = advertised.to_be_bytes().to_vec();
        wire.extend_from_slice(&body);
        wire.extend_from_slice(&trailing);
        let mut reader = Chunked::new(&wire, chunks);
        let result = runtime().block_on(read_request(&mut reader));

        if advertised == 0 || advertised as usize > MAX_REQUEST_BYTES {
            prop_assert_eq!(result.err().unwrap().kind(), io::ErrorKind::InvalidData);
            prop_assert_eq!(reader.remaining, &wire[4..]);
        } else if advertised as usize > body.len() + trailing.len() {
            prop_assert_eq!(result.err().unwrap().kind(), io::ErrorKind::UnexpectedEof);
        } else {
            let payload = &wire[4..4 + advertised as usize];
            match result {
                Ok(request) => {
                    prop_assert!(parse_request(payload).is_ok());
                    prop_assert!(request.validate().is_ok());
                    prop_assert!(payload.len() <= MAX_REQUEST_BYTES);
                    prop_assert_eq!(reader.remaining, &wire[4 + advertised as usize..]);
                }
                Err(error) => {
                    prop_assert_eq!(error.kind(), io::ErrorKind::InvalidData);
                    prop_assert!(parse_request(payload).is_err());
                }
            }
        }
    }

    #[test]
    fn valid_requests_round_trip_without_consuming_another_frame(
        suffix in proptest::string::string_regex("[a-zA-Z0-9._-]{0,63}").unwrap(),
        number in any::<i64>(),
        text in proptest::collection::vec(any::<char>(), 0..=32),
        remaining_ms in proptest::option::of(any::<u64>()),
        chunks in chunk_strategy(),
        trailing in proptest::collection::vec(any::<u8>(), 0..=16),
    ) {
        let method = format!("a{suffix}");
        let params = json!({"number": number, "text": text.into_iter().collect::<String>()});
        let mut envelope = json!({
            "version": 1,
            "method": method,
            "params": params,
        });
        if let Some(remaining_ms) = remaining_ms {
            envelope["remaining_ms"] = json!(remaining_ms);
        }
        let request: Request = parse_request(&serde_json::to_vec(&envelope).unwrap()).unwrap();
        let mut wire = Vec::new();
        runtime().block_on(write_request(&mut wire, &request)).unwrap();
        let frame_end = wire.len();
        wire.extend_from_slice(&trailing);

        let mut reader = Chunked::new(&wire, chunks);
        let decoded = runtime().block_on(read_request(&mut reader)).unwrap();
        prop_assert_eq!(decoded.method, method);
        prop_assert_eq!(decoded.remaining_ms, remaining_ms);
        prop_assert_eq!(serde_json::from_str::<Value>(decoded.params.get()).unwrap(), params);
        prop_assert_eq!(reader.remaining, &wire[frame_end..]);
        prop_assert!(frame_end - 4 <= MAX_REQUEST_BYTES);
    }

    #[test]
    fn truncated_request_and_response_bodies_fail_at_eof(
        body in proptest::collection::vec(any::<u8>(), 0..=256),
        missing in 1_u32..=32,
        chunks in chunk_strategy(),
    ) {
        let advertised = body.len() as u32 + missing;
        let mut wire = advertised.to_be_bytes().to_vec();
        wire.extend_from_slice(&body);
        let request = runtime().block_on(read_request(&mut Chunked::new(&wire, chunks.clone())));
        prop_assert_eq!(request.err().unwrap().kind(), io::ErrorKind::UnexpectedEof);

        let mut reader = ResponseReader::new(Chunked::new(&wire, chunks));
        let response = runtime().block_on(reader.next());
        prop_assert_eq!(response.err().unwrap().kind(), io::ErrorKind::UnexpectedEof);
        prop_assert_eq!(runtime().block_on(reader.next()).err().unwrap().kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn arbitrary_response_frames_are_bounded_and_fail_closed(
        body in proptest::collection::vec(any::<u8>(), 0..=512),
        advertised in prop_oneof![Just(0_u32), 1_u32..=640, Just(MAX_RESPONSE_BYTES as u32 + 1), Just(u32::MAX)],
        chunks in chunk_strategy(),
    ) {
        let mut wire = advertised.to_be_bytes().to_vec();
        wire.extend_from_slice(&body);
        let mut reader = ResponseReader::new(Chunked::new(&wire, chunks));
        let first = runtime().block_on(reader.next());
        if advertised == 0 || advertised as usize > MAX_RESPONSE_BYTES {
            prop_assert_eq!(first.err().unwrap().kind(), io::ErrorKind::InvalidData);
        } else if advertised as usize > body.len() {
            prop_assert_eq!(first.err().unwrap().kind(), io::ErrorKind::UnexpectedEof);
        } else {
            match first {
                Ok(Some(response)) => {
                    prop_assert!(serde_json::to_vec(&response).unwrap().len() <= MAX_RESPONSE_BYTES);
                    prop_assert!(4 + advertised as usize <= MAX_RESPONSE_STREAM_BYTES);
                    // A lone event cannot satisfy the required terminal-at-EOF contract.
                    if response.is_terminal() && advertised as usize == body.len() {
                        prop_assert!(runtime().block_on(reader.next()).unwrap().is_none());
                    } else {
                        prop_assert!(runtime().block_on(reader.next()).is_err());
                    }
                }
                Ok(None) => prop_assert!(false, "first response frame returned EOF"),
                Err(_) => (),
            }
        }
    }

    #[test]
    fn generated_invalid_envelopes_are_rejected(
        value in any::<i64>(),
        variant in 0_u8..=5,
        chunks in chunk_strategy(),
    ) {
        let request = match variant {
            0 => json!({"version": 2, "method": "fixture.echo", "params": {"value": value}}),
            1 => json!({"version": 1, "method": format!("fixture/{value}"), "params": {}}),
            2 => json!({"version": 1, "method": "fixture.echo", "params": [value]}),
            3 => json!({"version": 1, "method": "fixture.echo", "params": {}, "host": value}),
            4 => json!({"version": 1, "params": {"value": value}}),
            _ => json!({"version": 1, "method": "fixture.echo", "params": {}, "remaining_ms": null}),
        };
        let request_bytes = serde_json::to_vec(&request).unwrap();
        prop_assert_eq!(parse_request(&request_bytes).err().unwrap().kind(), io::ErrorKind::InvalidData);
        let request_wire = frame(&request_bytes);
        let request_result = runtime().block_on(read_request(&mut Chunked::new(&request_wire, chunks.clone())));
        prop_assert_eq!(request_result.err().unwrap().kind(), io::ErrorKind::InvalidData);

        let response = match variant {
            0 => json!({"type": "event"}),
            1 => json!({"type": "result", "data": value, "code": "protocol"}),
            2 => json!({"type": "error", "code": "protocol"}),
            3 => json!({"type": "error", "code": "protocol", "delivery": "unknown", "data": value}),
            4 => json!({"type": "unexpected", "data": value}),
            _ => json!(["result", value]),
        };
        let response_wire = frame(&serde_json::to_vec(&response).unwrap());
        let mut reader = ResponseReader::new(Chunked::new(&response_wire, chunks));
        prop_assert_eq!(runtime().block_on(reader.next()).err().unwrap().kind(), io::ErrorKind::InvalidData);
        prop_assert!(runtime().block_on(reader.next()).is_err());
    }

    #[test]
    fn generated_response_sequences_follow_an_independent_order_model(
        kinds in proptest::collection::vec(0_u8..=3, 0..=12),
        chunks in chunk_strategy(),
    ) {
        let responses: Vec<_> = kinds.iter().map(|kind| response(*kind, &json!({"n": kind}))).collect();
        let wire: Vec<_> = responses.iter().flat_map(response_frame).collect();
        let mut reader = ResponseReader::new(Chunked::new(&wire, chunks));
        let mut seen_event = false;
        let mut seen_terminal = false;
        let mut accepted_bytes = 0;
        let rt = runtime();

        for expected in &responses {
            let invalid = seen_terminal
                || seen_event && matches!(expected, Response::Error { delivery: Delivery::NotDispatched, .. });
            let result = rt.block_on(reader.next());
            if invalid {
                prop_assert_eq!(result.err().unwrap().kind(), io::ErrorKind::InvalidData);
                prop_assert!(rt.block_on(reader.next()).is_err());
                return Ok(());
            }
            let actual = result.unwrap().unwrap();
            prop_assert_eq!(actual.to_ndjson().unwrap(), expected.to_ndjson().unwrap());
            accepted_bytes += response_frame(expected).len();
            prop_assert!(accepted_bytes <= MAX_RESPONSE_STREAM_BYTES);
            seen_event |= !expected.is_terminal();
            seen_terminal = expected.is_terminal();
        }

        if seen_terminal {
            prop_assert!(rt.block_on(reader.next()).unwrap().is_none());
        } else {
            prop_assert_eq!(rt.block_on(reader.next()).err().unwrap().kind(), io::ErrorKind::InvalidData);
            prop_assert!(rt.block_on(reader.next()).is_err());
        }
    }

    #[test]
    fn valid_writer_output_round_trips_through_any_chunks(
        values in proptest::collection::vec(any::<i64>(), 0..=8),
        terminal in 1_u8..=3,
        chunks in chunk_strategy(),
    ) {
        let mut responses: Vec<_> = values.iter().map(|value| response(0, &json!({"value": value}))).collect();
        // Once an event was emitted, only unknown-delivery errors or results are valid terminals.
        let terminal = if !responses.is_empty() && terminal == 2 { 3 } else { terminal };
        responses.push(response(terminal, &json!([true, false, null])));
        let mut wire = Vec::new();
        let rt = runtime();
        {
            let mut writer = ResponseWriter::new(&mut wire);
            for item in &responses {
                rt.block_on(writer.send(item)).unwrap();
            }
            prop_assert!(rt.block_on(writer.send(&response(1, &Value::Null))).is_err());
        }
        prop_assert!(wire.len() <= MAX_RESPONSE_STREAM_BYTES);
        let mut reader = ResponseReader::new(Chunked::new(&wire, chunks));
        for expected in &responses {
            let actual = rt.block_on(reader.next()).unwrap().unwrap();
            prop_assert_eq!(actual.to_ndjson().unwrap(), expected.to_ndjson().unwrap());
        }
        prop_assert!(rt.block_on(reader.next()).unwrap().is_none());
    }
}

proptest! {
    #![proptest_config(ProptestConfig {
        cases: 32,
        rng_seed: RngSeed::Fixed(PROPERTY_SEED ^ 0x00B0_D6E7),
        ..ProptestConfig::default()
    })]

    #[test]
    fn generated_near_limit_events_preserve_terminal_capacity(
        payload_len in 0usize..=MAX_RESPONSE_BYTES - 26,
        attempts in 0usize..=200,
        chunks in chunk_strategy(),
    ) {
        let event = response(0, &json!("x".repeat(payload_len)));
        let terminal = response(1, &Value::Null);
        let mut wire = Vec::new();
        let mut accepted = 0;
        let rt = runtime();
        {
            let mut writer = ResponseWriter::new(&mut wire);
            for _ in 0..attempts {
                if rt.block_on(writer.send(&event)).is_err() {
                    break;
                }
                accepted += 1;
            }
            rt.block_on(writer.send(&terminal)).unwrap();
        }
        prop_assert!(wire.len() <= MAX_RESPONSE_STREAM_BYTES);
        let mut reader = ResponseReader::new(Chunked::new(&wire, chunks));
        for _ in 0..accepted {
            prop_assert!(
                matches!(rt.block_on(reader.next()).unwrap(), Some(Response::Event { .. })),
                "expected event",
            );
        }
        prop_assert!(
            matches!(rt.block_on(reader.next()).unwrap(), Some(Response::Result { .. })),
            "expected terminal result",
        );
        prop_assert!(rt.block_on(reader.next()).unwrap().is_none());
    }
}

#[tokio::test]
async fn oversized_advertised_lengths_fail_before_waiting_for_a_body() {
    for size in [MAX_REQUEST_BYTES as u32 + 1, u32::MAX] {
        let (mut sender, mut receiver) = tokio::io::duplex(4);
        sender.write_all(&size.to_be_bytes()).await.unwrap();
        tokio::select! {
            biased;
            outcome = read_request(&mut receiver) => {
                assert_eq!(outcome.err().unwrap().kind(), io::ErrorKind::InvalidData);
            }
            () = ready(()) => panic!("oversized request waited for a body"),
        }
    }
    for size in [MAX_RESPONSE_BYTES as u32 + 1, u32::MAX] {
        let (mut sender, receiver) = tokio::io::duplex(4);
        sender.write_all(&size.to_be_bytes()).await.unwrap();
        let mut reader = ResponseReader::new(receiver);
        tokio::select! {
            biased;
            outcome = reader.next() => {
                assert_eq!(outcome.err().unwrap().kind(), io::ErrorKind::InvalidData);
            }
            () = ready(()) => panic!("oversized response waited for a body"),
        }
    }
}

#[tokio::test]
async fn local_sequence_rejection_preserves_wire_and_writer_usability() {
    let mut wire = Vec::new();
    let mut writer = ResponseWriter::new(&mut wire);
    let event = response(0, &json!(1));
    writer.send(&event).await.unwrap();
    assert!(writer.send(&response(2, &Value::Null)).await.is_err());
    writer.send(&response(3, &Value::Null)).await.unwrap();
    assert_eq!(
        wire.len(),
        response_frame(&event).len() + response_frame(&response(3, &Value::Null)).len()
    );
    let mut reader = ResponseReader::new(wire.as_slice());
    assert!(matches!(
        reader.next().await.unwrap(),
        Some(Response::Event { .. })
    ));
    assert!(matches!(
        reader.next().await.unwrap(),
        Some(Response::Error {
            delivery: Delivery::Unknown,
            ..
        })
    ));
    assert!(reader.next().await.unwrap().is_none());
}

proptest! {
    #![proptest_config(property_config())]

    #[test]
    fn cancelled_partial_response_frame_cannot_resume(
        value in any::<i64>(),
        prefix_selector in any::<usize>(),
    ) {
        let wire = response_frame(&response(1, &json!(value)));
        let prefix_len = 1 + prefix_selector % (wire.len() - 1);
        runtime().block_on(async {
            let (mut sender, receiver) = tokio::io::duplex(wire.len());
            sender.write_all(&wire[..prefix_len]).await.unwrap();
            let mut reader = ResponseReader::new(receiver);
            tokio::select! {
                biased;
                result = reader.next() => panic!("partial frame returned: {result:?}"),
                () = ready(()) => (),
            }
            sender.write_all(&wire[prefix_len..]).await.unwrap();
            prop_assert_eq!(reader.next().await.err().unwrap().kind(), io::ErrorKind::InvalidData);
            Ok(())
        })?;
    }
}
