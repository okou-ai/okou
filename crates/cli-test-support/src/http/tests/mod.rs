use super::{ControlledHttpServer, RecordingServer};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const DEADLINE: Duration = Duration::from_secs(5);

async fn request(base_url: &str) -> TcpStream {
    let mut peer = TcpStream::connect(base_url.strip_prefix("http://").unwrap())
        .await
        .unwrap();
    peer.write_all(
        b"POST /channels/fixture HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
    )
    .await
    .unwrap();
    peer
}

async fn assert_retired(peer: &mut TcpStream) {
    let mut byte = [0];
    let read = tokio::time::timeout(DEADLINE, peer.read(&mut byte))
        .await
        .expect("fixture drop must retire its accepted HTTP socket")
        .unwrap();
    assert_eq!(read, 0, "fixture drop must close the pending response");
}

#[tokio::test]
async fn recording_server_drop_retires_accepted_response() {
    let server = RecordingServer::start(200, Duration::from_secs(60))
        .await
        .unwrap();
    let mut peer = request(&server.base_url).await;
    tokio::time::timeout(DEADLINE, async {
        while server.requests().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the recording must observe this real request before fixture drop");

    drop(server);
    assert_retired(&mut peer).await;
}

async fn controlled_drop(record: bool) {
    let mut server = if record {
        ControlledHttpServer::start().await.unwrap()
    } else {
        ControlledHttpServer::start_without_recording()
            .await
            .unwrap()
    };
    let mut peer = request(&server.base_url).await;
    let response_gate = server.next_request(DEADLINE).await.unwrap();

    drop(server);
    assert_retired(&mut peer).await;
    // Keep the caller's response gate alive through physical peer retirement.
    drop(response_gate);
}

#[tokio::test]
async fn controlled_server_drop_retires_accepted_response() {
    controlled_drop(true).await;
}

#[tokio::test]
async fn unrecorded_server_drop_retires_accepted_response() {
    controlled_drop(false).await;
}
