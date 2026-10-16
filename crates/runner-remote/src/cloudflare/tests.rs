use super::{ByteStream, Message, WebSocketStream};
use crate::diagnostics::trace::Trace;
use futures_util::SinkExt;
use std::{
    io,
    sync::{Arc, atomic::AtomicBool},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::UnixStream,
};
use tokio_tungstenite::tungstenite::protocol::Role;

#[tokio::test]
async fn first_protocol_failure_survives_later_carrier_write_failure() {
    let (client, server) = UnixStream::pair().unwrap();
    let client = WebSocketStream::from_raw_socket(client, Role::Client, None).await;
    let mut peer = WebSocketStream::from_raw_socket(server, Role::Server, None).await;
    let trace = Trace::new(true);
    let mut stream = ByteStream::new(client, Arc::new(AtomicBool::new(false)));
    stream.trace = trace.clone();

    peer.send(Message::Text("provider-body-canary".into()))
        .await
        .unwrap();
    let mut byte = [0];
    assert_eq!(
        stream.read(&mut byte).await.unwrap_err().kind(),
        io::ErrorKind::InvalidData
    );
    // A later transport error must not reclassify the observed protocol failure.
    drop(peer);
    let write = stream.write_all(b"unsent").await;
    let flush = AsyncWriteExt::flush(&mut stream).await;
    assert!(write.is_err() || flush.is_err());

    let snapshot = serde_json::to_value(trace.snapshot().unwrap()).unwrap();
    assert_eq!(
        snapshot
            .get("access_failure")
            .and_then(serde_json::Value::as_str),
        Some("protocol")
    );
    assert!(!snapshot.to_string().contains("canary"));
}
