#![cfg(feature = "test-support")]

//! Real ApiClient/Unix transport contracts; no KVM or Guest completion claim.

mod body_bound;
mod response;
mod routing;

use std::io;
use std::time::Duration;

use futures_util::FutureExt;
use sandbox_firecracker::api_request_gate::{
    FailureStage, RequestControl, RequestOutcome, RequestProducer, Transition, gate_request,
};
use sandbox_firecracker::{ApiClient, ApiError};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};

const RESPONSE: &[u8] = b"HTTP/1.1 204 No Content\r\n\r\n";

struct Fixture {
    _root: tempfile::TempDir,
    front: std::path::PathBuf,
    backend: UnixListener,
    control: RequestControl,
    producer: RequestProducer,
}

impl Fixture {
    fn new(transition: Transition) -> io::Result<Self> {
        let root = tempfile::tempdir()?;
        let front = root.path().join("front.sock");
        let back = root.path().join("back.sock");
        let listener = UnixListener::bind(&front)?;
        let backend = UnixListener::bind(&back)?;
        let (control, producer) = gate_request(listener, back, transition);
        Ok(Self {
            _root: root,
            front,
            backend,
            control,
            producer,
        })
    }

    fn call(
        &self,
        transition: Transition,
    ) -> Result<tokio::task::JoinHandle<Result<(), ApiError>>, ApiError> {
        let api = ApiClient::new(&self.front)?;
        Ok(tokio::spawn(async move {
            match transition {
                Transition::Resume => api.resume().await,
                Transition::Pause => api.pause().await,
            }
        }))
    }
}

async fn actual_request(listener: &UnixListener, expected: &[u8]) -> io::Result<UnixStream> {
    let (mut socket, _) = listener.accept().await?;
    let mut received = vec![0; expected.len()];
    socket.read_exact(&mut received).await?;
    assert_eq!(
        received, expected,
        "relay changed the production request bytes"
    );
    Ok(socket)
}

#[tokio::test]
async fn actual_resume_and_pause_wait_before_dispatch_and_preserve_bytes() {
    for transition in [Transition::Resume, Transition::Pause] {
        let mut fixture = Fixture::new(transition).unwrap();
        let mut client = fixture.call(transition).unwrap();
        let request = (&mut fixture.control.arrived).await.unwrap();
        assert_eq!(request.transition, transition);
        assert!(fixture.backend.accept().now_or_never().is_none());
        assert!((&mut client).now_or_never().is_none());
        assert!(fixture.producer.join().now_or_never().is_none());
        fixture.control.release.send(()).unwrap();
        let mut backend = actual_request(&fixture.backend, &request.raw)
            .await
            .unwrap();
        backend.write_all(RESPONSE).await.unwrap();
        client.await.unwrap().unwrap();
        match fixture.producer.join().await.unwrap() {
            RequestOutcome::ResponseDrained {
                request: actual,
                status,
                response,
                delivery,
            } => {
                assert_eq!(actual, request);
                assert_eq!(status, 204);
                assert_eq!(response, RESPONSE);
                delivery.unwrap();
            }
            outcome => panic!("unexpected outcome: {outcome:?}"),
        }
    }
}

#[tokio::test]
async fn dropped_release_before_dispatch_never_connects_backend() {
    let mut fixture = Fixture::new(Transition::Resume).unwrap();
    let client = fixture.call(Transition::Resume).unwrap();
    let request = (&mut fixture.control.arrived).await.unwrap();
    drop(fixture.control.release);
    match fixture.producer.join().await.unwrap() {
        RequestOutcome::NotForwarded(actual) => assert_eq!(actual, Some(request)),
        outcome => panic!("unexpected outcome: {outcome:?}"),
    }
    assert!(fixture.backend.accept().now_or_never().is_none());
    assert!(client.await.unwrap().is_err());
}

#[tokio::test]
async fn dropped_arrival_observer_does_not_own_dispatch_or_drain() {
    let mut fixture = Fixture::new(Transition::Pause).unwrap();
    let client = fixture.call(Transition::Pause).unwrap();
    drop(fixture.control.arrived);
    fixture.control.release.send(()).unwrap();
    let (backend, _) = fixture.backend.accept().await.unwrap();
    let mut backend = BufReader::new(backend);
    loop {
        let mut line = String::new();
        assert_ne!(backend.read_line(&mut line).await.unwrap(), 0);
        if line == "\r\n" {
            break;
        }
    }
    let expected = br#"{"state":"Paused"}"#;
    let mut body = vec![0; expected.len()];
    backend.read_exact(&mut body).await.unwrap();
    assert_eq!(body, expected);
    backend.get_mut().write_all(RESPONSE).await.unwrap();
    client.await.unwrap().unwrap();
    assert!(matches!(
        fixture.producer.join().await.unwrap(),
        RequestOutcome::ResponseDrained { status: 204, .. }
    ));
}

#[tokio::test]
async fn release_control_loss_before_client_arrival_joins_without_dispatch() {
    let mut fixture = Fixture::new(Transition::Resume).unwrap();
    drop(fixture.control.release);
    assert!(matches!(
        fixture.producer.join().await.unwrap(),
        RequestOutcome::NotForwarded(None)
    ));
    assert!(fixture.backend.accept().now_or_never().is_none());
}

#[tokio::test]
async fn release_control_loss_during_partial_request_joins_without_dispatch() {
    let mut fixture = Fixture::new(Transition::Resume).unwrap();
    let mut client = UnixStream::connect(&fixture.front).await.unwrap();
    client
        .write_all(b"PATCH /vm HTTP/1.1\r\nContent-Length: 19\r\n\r\n{")
        .await
        .unwrap();
    assert!(fixture.producer.join().now_or_never().is_none());
    drop(fixture.control.release);
    assert!(matches!(
        fixture.producer.join().await.unwrap(),
        RequestOutcome::NotForwarded(None)
    ));
    assert!(fixture.backend.accept().now_or_never().is_none());
}

#[tokio::test]
async fn cancelled_client_and_join_observation_preserve_late_response_custody() {
    let mut fixture = Fixture::new(Transition::Resume).unwrap();
    let client = fixture.call(Transition::Resume).unwrap();
    let request = (&mut fixture.control.arrived).await.unwrap();
    fixture.control.release.send(()).unwrap();
    let mut backend = actual_request(&fixture.backend, &request.raw)
        .await
        .unwrap();
    client.abort();
    assert!(client.await.unwrap_err().is_cancelled());
    tokio::time::pause();
    let header = b"HTTP/1.1 400 Bad Request\r\nContent-Length: 5\r\n\r\n";
    backend.write_all(header).await.unwrap();
    backend.write_all(b"fa").await.unwrap();
    // Timeout owns only a borrow of the handle; the real request remains live.
    assert!(
        tokio::time::timeout(Duration::from_secs(1), fixture.producer.join())
            .await
            .is_err()
    );
    assert!(fixture.producer.join().now_or_never().is_none());
    backend.write_all(b"ult").await.unwrap();
    match fixture.producer.join().await.unwrap() {
        RequestOutcome::ResponseDrained {
            request: actual,
            status: 400,
            response,
            ..
        } => {
            assert_eq!(actual, request);
            assert_eq!(response, [header.as_slice(), b"fault"].concat());
        }
        outcome => panic!("late terminal response was lost: {outcome:?}"),
    }
}

#[tokio::test]
async fn preserves_backend_failure_in_actual_api_client_and_joined_result() {
    let mut fixture = Fixture::new(Transition::Resume).unwrap();
    let client = fixture.call(Transition::Resume).unwrap();
    let request = (&mut fixture.control.arrived).await.unwrap();
    fixture.control.release.send(()).unwrap();
    let mut backend = actual_request(&fixture.backend, &request.raw)
        .await
        .unwrap();
    let body = r#"{"fault_message":"transition refused"}"#;
    let response = format!(
        "HTTP/1.1 400 Bad Request\r\nContent-Length: {}\r\n\r\n{}",
        body.len(),
        body
    );
    backend.write_all(response.as_bytes()).await.unwrap();
    assert!(
        matches!(client.await.unwrap(), Err(ApiError::Http { status: 400, body }) if body == "transition refused")
    );
    assert!(matches!(
        fixture.producer.join().await.unwrap(),
        RequestOutcome::ResponseDrained { status: 400, .. }
    ));
}

#[tokio::test]
async fn disconnected_raw_client_does_not_turn_delivery_failure_into_backend_failure() {
    let mut fixture = Fixture::new(Transition::Resume).unwrap();
    let mut client = UnixStream::connect(&fixture.front).await.unwrap();
    let request = b"PATCH /vm HTTP/1.1\r\nContent-Length: 19\r\n\r\n{\"state\":\"Resumed\"}";
    client.write_all(request).await.unwrap();
    let captured = (&mut fixture.control.arrived).await.unwrap();
    fixture.control.release.send(()).unwrap();
    let mut backend = actual_request(&fixture.backend, &captured.raw)
        .await
        .unwrap();
    drop(client);
    backend.write_all(RESPONSE).await.unwrap();
    match fixture.producer.join().await.unwrap() {
        RequestOutcome::ResponseDrained {
            request: actual,
            status: 204,
            response,
            delivery,
        } => {
            assert_eq!(actual, captured);
            assert_eq!(response, RESPONSE);
            assert!(delivery.is_err());
        }
        outcome => panic!("client delivery incorrectly hid the backend response: {outcome:?}"),
    }
}

#[tokio::test]
async fn mismatched_actual_transition_is_never_forwarded() {
    let mut fixture = Fixture::new(Transition::Resume).unwrap();
    let client = fixture.call(Transition::Pause).unwrap();
    assert_eq!(
        fixture.producer.join().await.unwrap_err().stage,
        FailureStage::Capture
    );
    assert!(fixture.backend.accept().now_or_never().is_none());
    assert!(client.await.unwrap().is_err());
}

#[tokio::test]
async fn rejects_ambiguous_unsupported_and_truncated_requests() {
    for request in [
        b"PATCH /vm HTTP/1.1\r\nContent-Length: 0\r\ncontent-length: 0\r\n\r\n".to_vec(),
        b"PATCH /vm HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n".to_vec(),
        b"PATCH /vm HTTP/1.1\r\nContent-Length: +19\r\n\r\n".to_vec(),
        b"PATCH /vm HTTP/1.1\r\nContent-Length: 19\nignored\r\n\r\n".to_vec(),
        b"PATCH /vm HTTP/1.1\r\nContent-Length: 19\r\n\r\n{}".to_vec(),
        b"PATCH /vm HTTP/1.1\r\nContent-Length: 2\r\n\r\n{}extra".to_vec(),
        b"PATCH /vm HTTP/1.1\r\n".to_vec(),
        vec![b'x'; 16 * 1024 + 1],
        b"PATCH /vm HTTP/1.1\r\nContent-Length: 36\r\n\r\n{\"state\":\"Paused\",\"state\":\"Resumed\"}".to_vec(),
        b"PATCH /vm HTTP/1.1\r\nContent-Length: 29\r\n\r\n{\"state\":\"Resumed\",\"extra\":1}".to_vec(),
        b"PATCH /vm HTTP/1.1\rignored\r\nContent-Length: 19\r\n\r\n{\"state\":\"Resumed\"}".to_vec(),
    ] {
        let mut fixture = Fixture::new(Transition::Resume).unwrap();
        let mut client = UnixStream::connect(&fixture.front).await.unwrap();
        client.write_all(&request).await.unwrap();
        client.shutdown().await.unwrap();
        assert_eq!(
            fixture.producer.join().await.unwrap_err().stage,
            FailureStage::Capture
        );
        assert!(fixture.backend.accept().now_or_never().is_none());
    }
}

#[tokio::test]
async fn malformed_or_truncated_backend_response_is_uncertainty_not_completion() {
    for response in [
        &b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nx"[..],
        &b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\ncontent-length: 0\r\n\r\n"[..],
        &b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n"[..],
        &b"HTTP/1.1 200 OK\r\n\r\n"[..],
        &b"HTTP/1.1 100 Continue\r\nContent-Length: 0\r\n\r\n"[..],
        &b"HTTP/1.1 204 No Content\r\nContent-Length: 1\r\n\r\nx"[..],
        &b"HTTP/1.0 200 OK\r\nContent-Length: 0\r\n\r\n"[..],
        &b"HTTP/1.1 200 OK\rignored\r\nContent-Length: 0\r\n\r\n"[..],
    ] {
        let mut fixture = Fixture::new(Transition::Resume).unwrap();
        let client = fixture.call(Transition::Resume).unwrap();
        let request = (&mut fixture.control.arrived).await.unwrap();
        fixture.control.release.send(()).unwrap();
        let mut backend = actual_request(&fixture.backend, &request.raw)
            .await
            .unwrap();
        backend.write_all(response).await.unwrap();
        backend.shutdown().await.unwrap();
        let failure = fixture.producer.join().await.unwrap_err();
        assert_eq!(failure.stage, FailureStage::BackendResponse);
        assert_eq!(failure.request, Some(request));
        assert!(client.await.unwrap().is_err());
    }
}

#[tokio::test]
async fn missing_backend_is_not_reported_as_dispatch_or_completion() {
    let root = tempfile::tempdir().unwrap();
    let front = root.path().join("front.sock");
    let listener = UnixListener::bind(&front).unwrap();
    let (mut control, mut producer) = gate_request(
        listener,
        root.path().join("absent.sock"),
        Transition::Resume,
    );
    let api = ApiClient::new(&front).unwrap();
    let client = tokio::spawn(async move { api.resume().await });
    let request = (&mut control.arrived).await.unwrap();
    control.release.send(()).unwrap();
    let failure = producer.join().await.unwrap_err();
    assert_eq!(failure.stage, FailureStage::Connect);
    assert_eq!(failure.error.kind(), io::ErrorKind::NotFound);
    assert_eq!(failure.request, Some(request));
    assert!(client.await.unwrap().is_err());
}
