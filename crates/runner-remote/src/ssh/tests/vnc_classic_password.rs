//! Synthetic Mac RFB 003.889 type-2 peer through the Run-owned SSH stream.
//! No framebuffer is requested or delivered.

use std::{sync::Arc, time::Duration};

use serde_json::json;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::JoinHandle,
};

use super::{
    harness::{CONNECTION, Harness, Reply, TOKEN},
    terminal,
};
use crate::{
    test_fixtures::http::{HttpClientConfig, http_client},
    vnc::VncRuntime,
};

struct BridgeTask(JoinHandle<()>);

#[tokio::test]
async fn mac_classic_password_starts_only_over_verified_ssh_loopback() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        socket.write_all(b"RFB 003.889\n").await.unwrap();
        let mut version = [0; 12];
        socket.read_exact(&mut version).await.unwrap();
        assert_eq!(&version, b"RFB 003.008\n");
        socket.write_all(&[4, 30, 33, 36, 2]).await.unwrap();
        assert_eq!(socket.read_u8().await.unwrap(), 2);
        socket.write_all(b"0123456789abcdef").await.unwrap();
        let mut response = [0; 16];
        socket.read_exact(&mut response).await.unwrap();
        // Independent OpenSSL DES-ECB vector for the exact eight-byte " secret ".
        assert_eq!(
            response,
            [
                0x34, 0x57, 0xe0, 0xfd, 0xf6, 0xe8, 0x42, 0x5e, 0x58, 0xb4, 0xdf, 0x6b, 0x1b, 0xe5,
                0x22, 0x13
            ]
        );
        socket.write_u32(0).await.unwrap();
        assert_eq!(socket.read_u8().await.unwrap(), 1); // ClientInit shared.
        socket.write_u16(2).await.unwrap();
        socket.write_u16(1).await.unwrap();
        socket
            .write_all(&[32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 0, 8, 16, 0, 0, 0])
            .await
            .unwrap();
        socket.write_u32(0).await.unwrap(); // Empty desktop name.
        socket.flush().await.unwrap();
        loop {
            match socket.read_u8().await {
                Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => break,
                Ok(0) => {
                    let mut format = [0; 19];
                    socket.read_exact(&mut format).await.unwrap();
                }
                Ok(2) => {
                    assert_eq!(socket.read_u8().await.unwrap(), 0);
                    let count = socket.read_u16().await.unwrap();
                    assert!(count <= 16);
                    for _ in 0..count {
                        socket.read_i32().await.unwrap();
                    }
                }
                Ok(tag) => {
                    panic!("unexpected RFB message {tag}; no framebuffer or input was requested")
                }
                Err(error) => panic!("unexpected peer read failure: {error}"),
            }
        }
    });

    let mut harness = Harness::new(Reply::default()).await;
    let http = http_client(HttpClientConfig {
        api_url: harness.api.base_url(),
        vercel_bypass: None,
        client_session_id: "mac-classic-vnc-over-ssh-test".into(),
    });
    let vnc = VncRuntime::official(http, TOKEN, harness.identity)
        .unwrap()
        .unwrap();
    harness.restart_with_vnc(Arc::clone(&vnc)).await;
    let ssh_resolve = harness.resolve(harness.credential(true)).await;
    let vnc_resolve = harness
        .api
        .mock_async(|when, then| {
            when.method("POST")
                .path(format!("/api/runners/runs/{}/vnc/resolve", harness.run))
                .header("authorization", format!("Bearer {TOKEN}"))
                .json_body(json!({
                    "connectionId": CONNECTION,
                    "runnerIdentity": {
                        "runnerId": harness.identity.runner_id(),
                        "heartbeatGeneration": 27
                    },
                    "supportedProfiles": [
                        {"authMethod":"vnc_password","securityType":"x509_vnc","transportType":"direct"},
                        {"authMethod":"username_password","securityType":"x509_plain","transportType":"direct"},
                        {"authMethod":"vnc_password","securityType":"x509_vnc","transportType":"ssh"},
                        {"authMethod":"username_password","securityType":"x509_plain","transportType":"ssh"},
                        {"authMethod":"vnc_password","securityType":"apple_vnc_password","transportType":"ssh"},
                        {"authMethod":"apple_dh_username_password","securityType":"apple_dh","transportType":"ssh"},
                        {"authMethod":"apple_srp_username_password","securityType":"apple_srp","transportType":"ssh"},
                        {"authMethod":"apple_rsa_srp_username_password","securityType":"apple_rsa_srp","transportType":"ssh"}
                    ]
                }));
            then.status(200).json_body(json!({
                "outcome": "resolved_apple_vnc_password",
                "host": "127.0.0.1",
                "port": 5900,
                "generation": 11,
                "transport": {"type":"ssh","connectionId":CONNECTION,"generation":7},
                "authentication": {"method":"vnc_password","password":" secret "},
                "security": {"type":"apple_vnc_password"}
            }));
        })
        .await;
    let vnc_check = harness
        .api
        .mock_async(|when, then| {
            when.method("POST")
                .path(format!("/api/runners/runs/{}/vnc/check", harness.run))
                .header("authorization", format!("Bearer {TOKEN}"))
                .json_body(json!({
                    "connectionId": CONNECTION,
                    "runnerIdentity": {
                        "runnerId": harness.identity.runner_id(),
                        "heartbeatGeneration": 27
                    },
                    "expectedGeneration": 11,
                    "expectedTransport": {
                        "type":"ssh","connectionId":CONNECTION,"generation":7
                    }
                }));
            then.status(200).json_body(json!({"outcome":"valid"}));
        })
        .await;

    let start = harness.raw(
        json!({
            "version": 1,
            "method": "vnc.session.start",
            "remaining_ms": 30_000,
            "params": {"connectionId": CONNECTION, "mode": "shared"}
        })
        .to_string(),
    );
    let bridge = async {
        let mut forwarded = harness.accept_forwarded().await;
        let mut target = TcpStream::connect(address).await.unwrap();
        BridgeTask(tokio::spawn(async move {
            let _ = tokio::io::copy_bidirectional(&mut forwarded, &mut target).await;
            let _ = forwarded.shutdown().await;
            let _ = target.shutdown().await;
        }))
    };
    let (started, BridgeTask(bridge)) = tokio::join!(start, bridge);
    assert_eq!(terminal(&started)["outcome"], "started");
    assert_eq!(
        *harness.observed.forwards.lock().unwrap(),
        vec![("127.0.0.1".into(), 5900, "127.0.0.1".into(), 0)]
    );
    let session = terminal(&started)["session"]["sessionId"].as_str().unwrap();
    let closed = harness
        .raw(
            json!({
                "version": 1,
                "method": "vnc.session.close",
                "remaining_ms": 30_000,
                "params": {"sessionId": session}
            })
            .to_string(),
        )
        .await;
    assert_eq!(terminal(&closed)["outcome"], "closed");
    tokio::time::timeout(Duration::from_secs(5), bridge)
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), server)
        .await
        .unwrap()
        .unwrap();
    ssh_resolve.assert_calls_async(1).await;
    vnc_resolve.assert_calls_async(1).await;
    vnc_check.assert_calls_async(1).await;
    harness.shutdown().await;
}
