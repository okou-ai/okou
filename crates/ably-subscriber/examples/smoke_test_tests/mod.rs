use super::*;
use httpmock::prelude::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const TEST_PUBLISH_TIMEOUT: Duration = Duration::from_secs(1);
const TEST_TIMEOUT: Duration = Duration::from_secs(20);

async fn stalled_publish_error(scheme: &str, response: Option<&[u8]>) -> String {
    tokio::time::timeout(TEST_TIMEOUT, async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let rest_url = format!("{scheme}://{}", listener.local_addr().unwrap());
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let data = serde_json::json!("payload");
        let publish = publish_message_with_timeout(
            &client,
            &rest_url,
            "test-channel",
            "test-auth",
            PublishMessage {
                name: Some("test"),
                data: &data,
                encoding: None,
            },
            TEST_PUBLISH_TIMEOUT,
        );
        tokio::pin!(publish);

        let (mut socket, _) = tokio::select! {
            accepted = listener.accept() => accepted.unwrap(),
            result = &mut publish => panic!("publish finished before connecting: {result:?}"),
        };

        // Observe actual client traffic before withholding the response. No
        // sleep or spawned server task is needed to establish the stall.
        let mut prefix = [0; 5];
        tokio::select! {
            read = socket.read_exact(&mut prefix) => { read.unwrap(); }
            result = &mut publish => panic!("publish finished before sending: {result:?}"),
        }
        if scheme == "https" {
            assert_eq!(prefix[0], 0x16, "expected a TLS handshake record");
        } else {
            assert_eq!(&prefix, b"POST ");
        }

        if let Some(response) = response {
            socket.write_all(response).await.unwrap();
        }

        // Keep the peer open until the publish ends; closing it early would
        // test an EOF/reset instead of a deadline.
        let error = publish.await.unwrap_err().to_string();
        drop(socket);
        error
    })
    .await
    .expect("publish did not finish within the test guard")
}

#[tokio::test]
async fn publish_times_out_during_tls_handshake() {
    assert_eq!(
        stalled_publish_error("https", None).await,
        "publish timed out after 1s"
    );
}

#[tokio::test]
async fn publish_times_out_waiting_for_response_headers() {
    assert_eq!(
        stalled_publish_error("http", None).await,
        "publish timed out after 1s"
    );
}

#[tokio::test]
async fn publish_times_out_reading_error_body() {
    let response = b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 100\r\n\r\npartial";
    assert_eq!(
        stalled_publish_error("http", Some(response)).await,
        "publish timed out after 1s"
    );
}

#[test]
fn publish_timeout_matches_documented_contract() {
    assert_eq!(PUBLISH_TIMEOUT, Duration::from_secs(10));
}

#[tokio::test]
async fn publish_preserves_auth_and_json_payload() {
    let server = MockServer::start_async().await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let data = serde_json::json!("aGVsbG8=");

    for (name, encoding, expected) in [
        (
            Some("binary"),
            Some("base64"),
            serde_json::json!({"name": "binary", "encoding": "base64", "data": data}),
        ),
        (None, None, serde_json::json!({"data": data})),
    ] {
        let mock = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path("/channels/test-channel/messages")
                    .header("authorization", "Basic test-auth")
                    .json_body(expected);
                then.status(201);
            })
            .await;

        tokio::time::timeout(
            TEST_TIMEOUT,
            publish_message(
                &client,
                &server.base_url(),
                "test-channel",
                "test-auth",
                name,
                &data,
                encoding,
            ),
        )
        .await
        .unwrap()
        .unwrap();
        mock.assert_calls_async(1).await;
        mock.delete_async().await;
    }
}

#[tokio::test]
async fn publish_reports_http_error_with_body() {
    let server = MockServer::start_async().await;
    let mock = server
        .mock_async(|when, then| {
            when.method(POST).path("/channels/test-channel/messages");
            then.status(401).body("invalid key");
        })
        .await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();

    let error = tokio::time::timeout(
        TEST_TIMEOUT,
        publish_message(
            &client,
            &server.base_url(),
            "test-channel",
            "test-auth",
            None,
            &serde_json::json!("payload"),
            None,
        ),
    )
    .await
    .unwrap()
    .unwrap_err();

    assert_eq!(
        error.to_string(),
        "publish failed: HTTP 401 Unauthorized — invalid key"
    );
    mock.assert_calls_async(1).await;
}
