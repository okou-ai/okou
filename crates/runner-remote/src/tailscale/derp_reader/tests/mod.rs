use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::codec::Encoder;
use ts_keys::NodeKeyPair;

fn gone(key: ts_keys::NodePublicKey, reason: u8) -> Vec<u8> {
    let body = frame::PeerGone {
        key,
        raw_reason: reason,
    };
    let mut bytes = bytes::BytesMut::new();
    frame::Codec
        .encode(
            (frame::RawFrame::from_body(&body, 0).unwrap(), &[][..]),
            &mut bytes,
        )
        .unwrap();
    bytes.to_vec()
}

#[tokio::test]
async fn fragmented_control_is_observed_only_when_complete_and_correlated_at_capture() {
    let (io, mut server) = tokio::io::duplex(128);
    let regional = Trace::new(true);
    let mut reader = regional.sync(|| Reader::new(io));
    let target = NodeKeyPair::random().public;
    let other = NodeKeyPair::random().public;
    let connection = Trace::new(true);
    connection.relay(regional.clone(), target);
    let frame = gone(target, 1);
    server.write_all(&frame[..frame.len() - 1]).await.unwrap();
    let mut partial = vec![0; frame.len() - 1];
    reader.read_exact(&mut partial).await.unwrap();
    assert_eq!(partial, frame[..frame.len() - 1]);
    assert!(regional.snapshot().unwrap().controls.is_none());
    server.write_all(&frame[frame.len() - 1..]).await.unwrap();
    reader.read_exact(&mut [0]).await.unwrap();
    let captured = connection.snapshot().unwrap();
    let json = serde_json::to_value(&captured).unwrap();
    assert_eq!(
        json["relay"]["controls"]["target_gone"]["reason"],
        "not_here"
    );
    assert!(!json.to_string().contains(&target.to_string()));

    server.write_all(&gone(other, 0)).await.unwrap();
    reader.read_exact(&mut [0; 38]).await.unwrap();
    assert_eq!(serde_json::to_value(&captured).unwrap(), json);
    assert_eq!(
        serde_json::to_value(connection.snapshot().unwrap()).unwrap()["relay"]["controls"]["target_gone"]
            ["reason"],
        "not_here"
    );
    // Replacing the regional incarnation discards its old control observations.
    regional.replace(&regional.fork());
    assert!(
        connection
            .snapshot()
            .unwrap()
            .relay
            .unwrap()
            .controls
            .is_none()
    );
}

#[tokio::test]
async fn truncated_or_invalid_reason_control_never_supplies_a_peer_gone_fact() {
    for truncated in [true, false] {
        let (io, mut server) = tokio::io::duplex(128);
        let trace = Trace::new(true);
        let mut reader = trace.sync(|| Reader::new(io));
        let bytes = gone(NodeKeyPair::random().public, 255);
        server
            .write_all(&bytes[..bytes.len() - usize::from(truncated)])
            .await
            .unwrap();
        server.shutdown().await.unwrap();
        let result = reader.read_to_end(&mut Vec::new()).await;
        if truncated {
            assert_eq!(result.unwrap_err().kind(), io::ErrorKind::UnexpectedEof);
        } else {
            result.unwrap();
        }
        assert!(trace.snapshot().unwrap().controls.is_none());
    }
}

#[test]
fn disabled_reader_has_no_diagnostic_observer() {
    assert!(Reader::new(tokio::io::empty()).observer.is_none());
}
