use super::*;

use tokio::net::UnixListener;

fn exec_request(command: &str) -> ExecRequest {
    ExecRequest {
        expected_run_id: None,
        command: command.into(),
        timeout_secs: 5,
        sudo: false,
    }
}

#[tokio::test]
async fn send_exec_missing_socket_returns_not_found() {
    let dir = tempfile::tempdir().unwrap();
    let sock_path = dir.path().join("nonexistent.sock");

    let result = send_exec(
        &sock_path,
        &exec_request("echo test"),
        Duration::from_millis(100),
    )
    .await;
    let error = result.unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::NotFound);
}

#[tokio::test]
async fn send_exec_oversized_timeout_returns_invalid_input() {
    let dir = tempfile::tempdir().unwrap();
    let sock_path = dir.path().join("control.sock");

    let result = send_exec(&sock_path, &exec_request("echo test"), Duration::MAX).await;
    let error = result.unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
}

#[tokio::test(start_paused = true)]
async fn send_exec_times_out_waiting_for_response() {
    use tokio::sync::oneshot;

    let dir = tempfile::tempdir().unwrap();
    let sock_path = dir.path().join("control.sock");
    let listener = UnixListener::bind(&sock_path).unwrap();
    let (request_seen_tx, request_seen_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let request_json = read_frame(&mut stream).await.unwrap();
        let request: ExecRequest = serde_json::from_slice(&request_json).unwrap();
        assert_eq!(request.command, "echo test");
        request_seen_tx.send(()).unwrap();
        let _stream = stream;
        let _ = release_rx.await;
    });

    let client = tokio::spawn(async move {
        send_exec(
            &sock_path,
            &exec_request("echo test"),
            Duration::from_secs(5),
        )
        .await
    });

    request_seen_rx.await.unwrap();
    tokio::time::advance(Duration::from_secs(5)).await;

    let error = client.await.unwrap().unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    assert_eq!(error.to_string(), "request timed out");

    release_tx.send(()).unwrap();
    server.await.unwrap();
}
