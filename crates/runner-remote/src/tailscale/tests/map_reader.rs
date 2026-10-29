//! The guarded map byte stream's size and pre-SDK validation contract.

use crate::tailscale::map_reader::MapReader;
use std::{
    io::{self, Cursor},
    pin::Pin,
    task::{Context, Poll},
};
use tokio::io::{AsyncRead, AsyncReadExt, ReadBuf};

// Pin the wire contract independently of the production size constant.
const ONE_MIB: usize = 1_048_576;

struct BodyMustNotBeRead;

impl AsyncRead for BodyMustNotBeRead {
    fn poll_read(
        self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        _buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        panic!("invalid map length must be rejected before attempting a body read");
    }
}

fn valid_frame(length: usize) -> Vec<u8> {
    let mut frame = u32::try_from(length).unwrap().to_le_bytes().to_vec();
    frame.extend_from_slice(b"{}");
    frame.resize(4 + length, b' ');
    frame
}

#[tokio::test]
async fn invalid_lengths_reject_before_reading_a_body_or_releasing_a_header() {
    for length in [0u32, 1_048_577, u32::MAX] {
        let input = Cursor::new(length.to_le_bytes()).chain(BodyMustNotBeRead);
        let mut reader = MapReader::new(input);
        let mut bytes = [0xa5; 4];
        assert_eq!(
            reader.read_exact(&mut bytes).await.unwrap_err().kind(),
            io::ErrorKind::InvalidData,
            "invalid length {length} must not be mistaken for a truncated body"
        );
        assert_eq!(
            bytes, [0xa5; 4],
            "invalid header must not reach SDK allocation"
        );
    }
}

#[tokio::test]
async fn a_complete_valid_frame_at_one_mib_is_preserved_byte_for_byte() {
    let frame = valid_frame(ONE_MIB);
    let mut reader = MapReader::new(Cursor::new(&frame));
    let mut output = Vec::new();
    reader.read_to_end(&mut output).await.unwrap();
    assert_eq!(output, frame);
}

#[tokio::test]
async fn a_complete_valid_frame_one_byte_over_one_mib_releases_nothing() {
    let frame = valid_frame(ONE_MIB + 1);
    let mut reader = MapReader::new(Cursor::new(frame));
    let mut output = Vec::new();
    assert_eq!(
        reader.read_to_end(&mut output).await.unwrap_err().kind(),
        io::ErrorKind::InvalidData
    );
    assert!(output.is_empty(), "rejected frame must release no bytes");
}

#[tokio::test]
async fn regional_node_limit_is_enforced_before_releasing_map_bytes() {
    for count in [8, 9] {
        let nodes: Vec<_> = (0..count)
            .map(|index| {
                serde_json::json!({
                    "Name": format!("1-{index}"),
                    "RegionID": 1,
                    "HostName": "derp.synthetic.invalid",
                    "DERPPort": 443,
                    "IPv4": "127.0.0.1",
                    "IPv6": "none"
                })
            })
            .collect();
        let body = serde_json::to_vec(&serde_json::json!({
            "DERPMap": {"Regions": {"1": {
                "RegionID": 1,
                "RegionCode": "synthetic",
                "RegionName": "Synthetic",
                "Nodes": nodes
            }}}
        }))
        .unwrap();
        let mut frame = u32::try_from(body.len()).unwrap().to_le_bytes().to_vec();
        frame.extend_from_slice(&body);
        let mut reader = MapReader::new(Cursor::new(&frame));
        let mut output = Vec::new();
        let result = reader.read_to_end(&mut output).await;
        if count == 8 {
            result.unwrap();
            assert_eq!(output, frame);
        } else {
            assert_eq!(result.unwrap_err().kind(), io::ErrorKind::InvalidData);
            assert!(output.is_empty(), "oversized region must release no bytes");
        }
    }
}

#[tokio::test]
async fn an_allowed_length_with_a_truncated_body_reports_unexpected_eof() {
    let mut reader = MapReader::new(Cursor::new(2u32.to_le_bytes()));
    let mut output = Vec::new();
    assert_eq!(
        reader.read_to_end(&mut output).await.unwrap_err().kind(),
        io::ErrorKind::UnexpectedEof
    );
    assert!(output.is_empty());
}

#[tokio::test]
async fn interleaved_map_readers_retain_only_their_own_failure_and_disabled_collects_nothing() {
    use crate::tailscale::evidence::{Detail, Stage, Status, Trace};
    let first = Trace::new(true);
    let second = Trace::new(true);
    let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(2));
    let a = first.clone().scope(async {
        let mut reader = MapReader::new(Cursor::new(2u32.to_le_bytes()));
        barrier.wait().await;
        let mut output = Vec::new();
        assert_eq!(
            reader.read_to_end(&mut output).await.unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
        assert!(output.is_empty());
    });
    let b = second.clone().scope(async {
        let mut reader = MapReader::new(Cursor::new(1_048_577u32.to_le_bytes()));
        barrier.wait().await;
        let mut output = Vec::new();
        assert_eq!(
            reader.read_to_end(&mut output).await.unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert!(output.is_empty());
    });
    tokio::join!(a, b);
    let a = first.snapshot().unwrap();
    let b = second.snapshot().unwrap();
    assert_ne!(a.attempt_id, b.attempt_id);
    assert!(a.steps.iter().any(|s| s.stage == Stage::MapBody
        && s.status == Status::Failed
        && s.detail == Detail::Truncated));
    assert!(b.steps.iter().any(|s| s.stage == Stage::MapHeader
        && s.status == Status::Failed
        && s.detail == Detail::Limit));
    assert!(!b.steps.iter().any(|s| s.stage == Stage::MapBody));
    assert!(Trace::current().snapshot().is_none());
    let disabled = Trace::new(false);
    disabled
        .clone()
        .scope(async {
            let mut reader = MapReader::new(Cursor::new(0u32.to_le_bytes()));
            assert!(reader.read_u32_le().await.is_err());
        })
        .await;
    assert!(disabled.snapshot().is_none());
}
