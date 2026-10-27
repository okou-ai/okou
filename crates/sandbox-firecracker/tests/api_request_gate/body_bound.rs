use super::*;

const BODY_LIMIT: usize = 64 * 1024;

fn json_frame(start_line: &str, json: &[u8], body_len: usize) -> Vec<u8> {
    let mut body = json.to_vec();
    body.resize(body_len, b' ');
    [
        format!("{start_line}\r\nContent-Length: {body_len}\r\n\r\n").as_bytes(),
        &body,
    ]
    .concat()
}

async fn exchange(mut socket: UnixStream, request: Vec<u8>) -> io::Result<Vec<u8>> {
    socket.write_all(&request).await?;
    socket.shutdown().await?;
    let mut received = Vec::new();
    socket.read_to_end(&mut received).await?;
    Ok(received)
}

#[tokio::test]
async fn request_body_bound_accepts_exact_limit_and_rejects_one_more_byte() {
    for body_len in [BODY_LIMIT, BODY_LIMIT + 1] {
        let mut fixture = Fixture::new(Transition::Resume).unwrap();
        let expected = json_frame("PATCH /vm HTTP/1.1", br#"{"state":"Resumed"}"#, body_len);
        let socket = UnixStream::connect(&fixture.front).await.unwrap();
        let client = tokio::spawn(exchange(socket, expected.clone()));
        fixture.control.release.send(()).unwrap();
        let captured = fixture.control.arrived.await;

        // Also finish an incorrectly accepted oversized request before asserting.
        let forwarded = if captured.is_ok() {
            let (mut backend, _) = fixture.backend.accept().await.unwrap();
            let mut received = vec![0; expected.len()];
            backend.read_exact(&mut received).await.unwrap();
            backend.write_all(RESPONSE).await.unwrap();
            Some(received)
        } else {
            None
        };
        let result = fixture.producer.join().await;
        let client_result = client.await.unwrap();

        if body_len == BODY_LIMIT {
            let request = captured.unwrap();
            assert_eq!(request.transition, Transition::Resume);
            assert_eq!(request.raw, expected);
            assert_eq!(forwarded.unwrap(), expected);
            assert_eq!(client_result.unwrap(), RESPONSE);
            match result.unwrap() {
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
        } else {
            let Err(failure) = result else {
                panic!("gate accepted a {body_len}-byte request body");
            };
            assert_eq!(failure.stage, FailureStage::Capture);
            assert_eq!(failure.request, None);
            assert_eq!(failure.error.kind(), io::ErrorKind::InvalidData);
            assert_eq!(failure.error.to_string(), "HTTP body exceeds gate bound");
            assert!(captured.is_err());
            assert!(fixture.backend.accept().now_or_never().is_none());
        }
    }
}

#[tokio::test]
async fn response_body_bound_accepts_exact_limit_and_rejects_one_more_byte() {
    for body_len in [BODY_LIMIT, BODY_LIMIT + 1] {
        let mut fixture = Fixture::new(Transition::Resume).unwrap();
        let raw_request = json_frame("PATCH /vm HTTP/1.1", br#"{"state":"Resumed"}"#, 19);
        let socket = UnixStream::connect(&fixture.front).await.unwrap();
        let client = tokio::spawn(exchange(socket, raw_request.clone()));
        let request = (&mut fixture.control.arrived).await.unwrap();
        fixture.control.release.send(()).unwrap();
        let (mut backend, _) = fixture.backend.accept().await.unwrap();
        let mut forwarded = vec![0; raw_request.len()];
        backend.read_exact(&mut forwarded).await.unwrap();

        let expected = json_frame("HTTP/1.1 200 OK", b"{}", body_len);
        // Early rejection can close the peer during its otherwise-valid write.
        let written = backend.write_all(&expected).await;
        let shutdown = backend.shutdown().await;
        drop(backend);
        let result = fixture.producer.join().await;
        let client_result = client.await.unwrap();

        assert_eq!(request.raw, raw_request);
        assert_eq!(forwarded, raw_request);
        if body_len == BODY_LIMIT {
            written.unwrap();
            shutdown.unwrap();
            assert_eq!(client_result.unwrap(), expected);
            match result.unwrap() {
                RequestOutcome::ResponseDrained {
                    request: actual,
                    status,
                    response,
                    delivery,
                } => {
                    assert_eq!(actual, request);
                    assert_eq!(status, 200);
                    assert_eq!(response, expected);
                    delivery.unwrap();
                }
                outcome => panic!("unexpected outcome: {outcome:?}"),
            }
        } else {
            let Err(failure) = result else {
                panic!("gate accepted a {body_len}-byte response body");
            };
            assert_eq!(failure.stage, FailureStage::BackendResponse);
            assert_eq!(failure.request, Some(request));
            assert_eq!(failure.error.kind(), io::ErrorKind::InvalidData);
            assert_eq!(failure.error.to_string(), "HTTP body exceeds gate bound");
            if let Ok(received) = client_result {
                assert!(received.is_empty());
            }
        }
    }
}
