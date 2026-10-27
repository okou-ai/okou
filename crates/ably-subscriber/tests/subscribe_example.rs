#![cfg(test)]

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use ably_subscriber::protocol::{
    AblyMessage, ConnectionDetails, ErrorInfo, ProtocolMessage, action, decode_msg, encode_msg,
};
use futures_util::{SinkExt, StreamExt};
use raw_http_test_support::raw_http::read_http_request;
use serde_json::json;
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::{WebSocketStream, tungstenite::Message};

const CHANNEL: &str = "example-test";
const IO_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug)]
enum Scenario {
    ConnectionError,
    ChannelErrorAfterMessage,
    Closed,
    ReconnectAndClose,
}

fn build_subscribe_example() -> PathBuf {
    let test_executable = std::env::current_exe().expect("test executable");
    let profile_dir = test_executable
        .parent()
        .and_then(Path::parent)
        .expect("test profile directory");
    let profile = profile_dir.file_name().expect("profile name");
    let mut command = std::process::Command::new(env!("CARGO"));
    command
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .args([
            "build",
            "--locked",
            "-p",
            "ably-subscriber",
            "--example",
            "subscribe",
            "--message-format=json",
        ])
        .arg("--target-dir")
        .arg(profile_dir.parent().expect("target directory"));
    if profile != "debug" {
        command.arg("--profile").arg(profile);
    }

    // Build once per scenario matrix. Cargo's returned artifact avoids relying
    // on a stale example or a hard-coded target/profile directory.
    let output = command.output().expect("build subscribe example");
    assert!(
        output.status.success(),
        "example build failed: {}",
        String::from_utf8_lossy(&output.stderr),
    );
    serde_json::Deserializer::from_slice(&output.stdout)
        .into_iter::<serde_json::Value>()
        .map(|message| message.expect("Cargo JSON message"))
        .find_map(|message| {
            let is_example = message.get("reason").and_then(|v| v.as_str())
                == Some("compiler-artifact")
                && message
                    .get("target")
                    .and_then(|target| target.get("name"))
                    .and_then(|name| name.as_str())
                    == Some("subscribe");
            is_example
                .then(|| {
                    message
                        .get("executable")
                        .and_then(|value| value.as_str())
                        .map(PathBuf::from)
                })
                .flatten()
        })
        .expect("built subscribe executable")
}

async fn send_protocol(connection: &mut WebSocketStream<TcpStream>, message: ProtocolMessage) {
    connection
        .send(Message::Binary(encode_msg(&message).unwrap().into()))
        .await
        .unwrap();
}

async fn attach(listener: &TcpListener, connection_id: &str) -> WebSocketStream<TcpStream> {
    let (socket, _) = listener.accept().await.unwrap();
    let mut connection = tokio_tungstenite::accept_async(socket).await.unwrap();
    send_protocol(
        &mut connection,
        ProtocolMessage {
            action: action::CONNECTED,
            connection_id: Some(connection_id.into()),
            connection_key: Some(format!("{connection_id}!key")),
            connection_details: Some(ConnectionDetails {
                max_idle_interval: Some(0),
                ..Default::default()
            }),
            ..Default::default()
        },
    )
    .await;
    let frame = connection.next().await.unwrap().unwrap();
    let Message::Binary(bytes) = frame else {
        panic!("expected ATTACH, got {frame:?}");
    };
    let request = decode_msg(&bytes).unwrap();
    assert_eq!(request.action, action::ATTACH);
    assert_eq!(request.channel.as_deref(), Some(CHANNEL));
    send_protocol(
        &mut connection,
        ProtocolMessage {
            action: action::ATTACHED,
            channel: Some(CHANNEL.into()),
            channel_serial: Some("serial-0".into()),
            ..Default::default()
        },
    )
    .await;
    connection
}

async fn serve_scenario(listener: TcpListener, scenario: Scenario) -> WebSocketStream<TcpStream> {
    // The example's HOST option sends both token HTTP and WebSocket traffic to
    // this listener, so exercise its ordinary startup without production hooks.
    let (mut token_socket, _) = listener.accept().await.unwrap();
    let request = read_http_request(&mut token_socket).await.unwrap();
    assert!(request.starts_with("POST /keys/testKey.testId/requestToken HTTP/1.1\r\n"));
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let token = json!({
        "token": "synthetic-example-token",
        "issued": now,
        "expires": now + 3_600_000,
    })
    .to_string();
    token_socket
        .write_all(
            format!(
                "HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{token}",
                token.len(),
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    token_socket.shutdown().await.unwrap();
    drop(token_socket);

    let mut connection = attach(&listener, "initial").await;
    if matches!(scenario, Scenario::ReconnectAndClose) {
        send_protocol(
            &mut connection,
            ProtocolMessage {
                action: action::DISCONNECTED,
                ..Default::default()
            },
        )
        .await;
        drop(connection);
        connection = attach(&listener, "reconnected").await;
    }

    if matches!(
        scenario,
        Scenario::ChannelErrorAfterMessage | Scenario::ReconnectAndClose
    ) {
        send_protocol(
            &mut connection,
            ProtocolMessage {
                action: action::MESSAGE,
                channel: Some(CHANNEL.into()),
                messages: Some(vec![AblyMessage {
                    data: Some(json!({"message": "delivered"})),
                    ..Default::default()
                }]),
                ..Default::default()
            },
        )
        .await;
    }

    let terminal = match scenario {
        Scenario::ConnectionError | Scenario::ChannelErrorAfterMessage => ProtocolMessage {
            action: action::ERROR,
            channel: matches!(scenario, Scenario::ChannelErrorAfterMessage).then(|| CHANNEL.into()),
            error: Some(ErrorInfo {
                code: if matches!(scenario, Scenario::ConnectionError) {
                    40000
                } else {
                    50000
                },
                message: "synthetic terminal failure".into(),
                status_code: None,
            }),
            ..Default::default()
        },
        Scenario::Closed | Scenario::ReconnectAndClose => ProtocolMessage {
            action: action::CLOSED,
            ..Default::default()
        },
    };
    send_protocol(&mut connection, terminal).await;
    // Keep the peer socket alive until the child has consumed its final frame.
    connection
}

#[tokio::test]
async fn subscribe_example_reports_terminal_failures_and_preserves_recovery() {
    let executable = build_subscribe_example();
    for scenario in [
        Scenario::ConnectionError,
        Scenario::ChannelErrorAfterMessage,
        Scenario::Closed,
        Scenario::ReconnectAndClose,
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let host = listener.local_addr().unwrap().to_string();
        let mut command = tokio::process::Command::new(&executable);
        command
            .args([CHANNEL, &host])
            .env("ABLY_API_KEY", "testKey.testId:synthetic-secret")
            .env("RUST_LOG", "off")
            .env("NO_PROXY", "127.0.0.1")
            .env("no_proxy", "127.0.0.1")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let (output, _connection) = tokio::time::timeout(IO_TIMEOUT, async {
            tokio::join!(command.output(), serve_scenario(listener, scenario))
        })
        .await
        .expect("example and protocol peer complete within deadline");
        let output = output.expect("run subscribe example");
        let stdout = String::from_utf8(output.stdout).unwrap();
        let stderr = String::from_utf8(output.stderr).unwrap();
        let failed = matches!(
            scenario,
            Scenario::ConnectionError | Scenario::ChannelErrorAfterMessage
        );
        assert_eq!(output.status.success(), !failed, "{scenario:?}: {stderr}");
        assert!(
            output.status.code().is_some(),
            "{scenario:?}: process killed"
        );
        assert!(stderr.contains("[connected]"), "{scenario:?}: {stderr}");
        if failed {
            let code = if matches!(scenario, Scenario::ConnectionError) {
                "40000"
            } else {
                "50000"
            };
            assert!(stderr.contains(code), "{scenario:?}: {stderr}");
            assert!(
                stderr.contains("synthetic terminal failure"),
                "{scenario:?}: {stderr}",
            );
        }
        if matches!(scenario, Scenario::ReconnectAndClose) {
            assert!(stderr.contains("[disconnected]"), "{stderr}");
            assert_eq!(stderr.matches("[connected]").count(), 2, "{stderr}");
        }
        let messages: Vec<serde_json::Value> = stdout
            .lines()
            .map(|line| serde_json::from_str(line).expect("stdout contains only message JSON"))
            .collect();
        let expected = if matches!(
            scenario,
            Scenario::ChannelErrorAfterMessage | Scenario::ReconnectAndClose
        ) {
            vec![json!({"message": "delivered"})]
        } else {
            Vec::new()
        };
        assert_eq!(messages, expected, "{scenario:?}: {stdout}");
    }
}
