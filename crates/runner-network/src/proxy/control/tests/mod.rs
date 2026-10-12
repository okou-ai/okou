use std::os::fd::AsRawFd;
use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::net::UnixListener;

use super::*;

fn private_directory() -> tempfile::TempDir {
    tempfile::Builder::new()
        .permissions(std::fs::Permissions::from_mode(0o700))
        .tempdir()
        .unwrap()
}

fn listener(directory: &Path) -> UnixListener {
    let directory = std::fs::File::open(directory).unwrap();
    UnixListener::bind(format!(
        "/proc/self/fd/{}/{SOCKET_NAME}",
        directory.as_raw_fd()
    ))
    .unwrap()
}

async fn request(stream: &mut UnixStream) -> Value {
    let size = stream.read_u32().await.unwrap() as usize;
    assert!(size <= MAX_FRAME_BYTES);
    let mut bytes = vec![0; size];
    stream.read_exact(&mut bytes).await.unwrap();
    let request: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(request["method"], "proxy.status");
    assert_eq!(request["params"], json!({}));
    request
}

async fn reply(stream: &mut UnixStream, value: Value) {
    let bytes = serde_json::to_vec(&value).unwrap();
    stream.write_u32(bytes.len() as u32).await.unwrap();
    stream.write_all(&bytes).await.unwrap();
}

fn result(request: &Value) -> Value {
    json!({
        "requestId": request["requestId"],
        "generation": request["generation"],
        "type": "result",
        "data": {"state": "running"}
    })
}

#[tokio::test]
async fn status_round_trip_supports_long_launch_paths() {
    let root = tempfile::tempdir().unwrap();
    let directory = tempfile::Builder::new()
        .prefix(&"long-launch-".repeat(12))
        .permissions(std::fs::Permissions::from_mode(0o700))
        .tempdir_in(root.path())
        .unwrap();
    let listener = listener(directory.path());
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let request = request(&mut stream).await;
        reply(&mut stream, result(&request)).await;
    });

    status(
        directory.path(),
        "generation-1",
        Instant::now() + Duration::from_secs(2),
    )
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(2), server)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn status_rejects_incoherent_or_invalid_responses() {
    #[derive(Clone, Copy, Debug, PartialEq)]
    enum Defect {
        Id,
        Generation,
        State,
        Extra,
        Error,
        Trailing,
        Oversized,
        Empty,
        Truncated,
        Malformed,
    }
    for defect in [
        Defect::Id,
        Defect::Generation,
        Defect::State,
        Defect::Extra,
        Defect::Error,
        Defect::Trailing,
        Defect::Oversized,
        Defect::Empty,
        Defect::Truncated,
        Defect::Malformed,
    ] {
        let directory = private_directory();
        let listener = listener(directory.path());
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request = request(&mut stream).await;
            let mut response = result(&request);
            match defect {
                Defect::Id => response["requestId"] = json!("another-request"),
                Defect::Generation => response["generation"] = json!("old-generation"),
                Defect::State => response["data"]["state"] = json!("starting"),
                Defect::Extra => response["unexpected"] = json!(true),
                Defect::Error => {
                    response = json!({
                        "requestId": request["requestId"],
                        "generation": request["generation"],
                        "type": "error", "code": "invalid_request"
                    });
                }
                Defect::Oversized => {
                    stream.write_u32(MAX_FRAME_BYTES as u32 + 1).await.unwrap();
                    return;
                }
                Defect::Empty => {
                    stream.write_u32(0).await.unwrap();
                    return;
                }
                Defect::Truncated => {
                    stream.write_u32(10).await.unwrap();
                    stream.write_all(b"{").await.unwrap();
                    return;
                }
                Defect::Malformed => {
                    stream.write_u32(1).await.unwrap();
                    stream.write_all(b"\xff").await.unwrap();
                    return;
                }
                Defect::Trailing => {}
            }
            reply(&mut stream, response).await;
            if defect == Defect::Trailing {
                stream.write_all(b"x").await.unwrap();
            }
        });

        assert!(
            status(
                directory.path(),
                "generation-1",
                Instant::now() + Duration::from_secs(2)
            )
            .await
            .is_err(),
            "accepted {defect:?} response"
        );
        tokio::time::timeout(Duration::from_secs(2), server)
            .await
            .unwrap()
            .unwrap();
    }
}

#[tokio::test]
async fn response_without_terminal_eof_remains_bounded() {
    let directory = private_directory();
    let listener = listener(directory.path());
    let (release, hold) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let request = request(&mut stream).await;
        reply(&mut stream, result(&request)).await;
        let _ = hold.await;
    });

    let error = status(
        directory.path(),
        "generation-1",
        Instant::now() + Duration::from_millis(100),
    )
    .await
    .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    let _ = release.send(());
    tokio::time::timeout(Duration::from_secs(2), server)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn cancelling_status_closes_its_connection() {
    let directory = private_directory();
    let listener = listener(directory.path());
    let (accepted, observed) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        request(&mut stream).await;
        accepted.send(()).unwrap();
        assert_eq!(stream.read(&mut [0]).await.unwrap(), 0);
    });
    let path = directory.path().to_path_buf();
    let client = tokio::spawn(async move {
        status(
            &path,
            "generation-1",
            Instant::now() + Duration::from_secs(5),
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(2), observed)
        .await
        .unwrap()
        .unwrap();
    client.abort();
    assert!(client.await.unwrap_err().is_cancelled());
    tokio::time::timeout(Duration::from_secs(2), server)
        .await
        .unwrap()
        .unwrap();
}
