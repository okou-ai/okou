use std::sync::Arc;

use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tracing_subscriber::prelude::*;
use tracing_test_support::CapturedEvents;

use super::{
    harness::{CONNECTION, CREATED_AT, Harness, PASSWORD, Reply, TOKEN},
    terminal,
};
use crate::{
    test_fixtures::http::{HttpClientConfig, http_client},
    vnc::VncRuntime,
};

#[tokio::test]
async fn forwarded_apple_dh_rejection_records_header_checks_and_preserves_protocol_result() {
    apple_dh_failure(false).await;
}

#[tokio::test]
async fn forwarded_silent_apple_peer_retains_the_authentication_timeout_stage() {
    apple_dh_failure(true).await;
}

async fn apple_dh_failure(stalled: bool) {
    const VNC: &str = "06cc8159-9bf4-4f47-8ca5-e8891c96c140";
    const USER: &str = "vnc-user-canary";
    const SECRET: &str = "vnc-password-canary";
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry()
        .with(tracing_subscriber::filter::filter_fn(|metadata| {
            metadata.target().starts_with("runner_remote::vnc")
        }))
        .with(captured.clone());
    let _subscriber = tracing::subscriber::set_default(subscriber);
    let mut h = Harness::new(Reply::Process).await;
    let vnc = VncRuntime::official(
        http_client(HttpClientConfig {
            api_url: h.api.base_url(),
            vercel_bypass: None,
            client_session_id: "vnc-diagnostics".into(),
        }),
        TOKEN,
        h.identity,
    )
    .unwrap()
    .unwrap();
    h.restart_with_vnc(Arc::clone(&vnc)).await;
    let ssh_resolve = h.resolve(h.credential(true)).await;
    let vnc_resolve = h.api.mock_async(|when, then| {
        when.method("POST").path(format!("/api/runners/runs/{}/vnc/resolve", h.run));
        then.status(200).header("X-VNC-Connection-Created-At", CREATED_AT).json_body(json!({
            "outcome":"resolved_apple_dh", "host":"127.0.0.1", "port":5900, "generation":11,
            "transport":{"type":"ssh", "connectionId":CONNECTION, "generation":7},
            "authentication":{"method":"apple_dh_username_password", "username":USER, "password":SECRET},
            "security":{"type":"apple_dh"}
        }));
    }).await;
    let request = h.raw(
        json!({
            "version":1,"method":"vnc.session.start","remaining_ms":if stalled {2000} else {60000},
            "params":{"connectionId":VNC,"mode":"shared"}
        })
        .to_string(),
    );
    let peer = async {
        let mut socket = h.accept_forwarded().await;
        if !stalled {
            socket.write_all(b"RFB 003.889\n").await.unwrap();
            let mut banner = [0; 12];
            socket.read_exact(&mut banner).await.unwrap();
            assert_eq!(&banner, b"RFB 003.008\n");
            socket.write_all(&[1, 30]).await.unwrap();
            assert_eq!(socket.read_u8().await.unwrap(), 30);
            socket.write_u16(5).await.unwrap();
            socket.write_u16(128).await.unwrap();
            socket.flush().await.unwrap();
        }
        let mut byte = [0; 1];
        assert_eq!(
            socket.read(&mut byte).await.unwrap(),
            0,
            "rejection must close without credential bytes"
        );
    };
    let (reply, ()) = tokio::join!(request, peer);
    assert_eq!(
        terminal(&reply),
        &json!({"outcome":"failed","reason":if stalled {"timed_out"} else {"protocol"}})
    );
    ssh_resolve.assert_calls_async(1).await;
    vnc_resolve.assert_calls_async(1).await;
    h.shutdown().await;

    let records: Vec<_> = captured
        .entries()
        .into_iter()
        .filter(|event| {
            event.fields.get("message").map(String::as_str)
                == Some("VNC connection attempt finished")
        })
        .collect();
    assert_eq!(records.len(), 1);
    let fields = &records[0].fields;
    for (name, value) in [
        ("connection_id", VNC),
        ("vnc_auth_profile", "apple_dh"),
        ("vnc_transport", "ssh"),
        ("vnc_connection_stage", "authentication"),
    ] {
        assert_eq!(fields.get(name).map(String::as_str), Some(value));
    }
    assert_eq!(fields.get("run_id"), Some(&h.run.to_string()));
    if stalled {
        assert_eq!(
            fields.get("rfb_error_code").map(String::as_str),
            Some("authentication_deadline_exceeded")
        );
        assert_eq!(
            fields.get("vnc_authentication_stage").map(String::as_str),
            Some("rfb_version")
        );
        assert!(!fields.contains_key("apple_dh_key_bytes"));
    } else {
        for (name, value) in [
            ("rfb_error_code", "invalid_apple_dh_parameters"),
            ("vnc_authentication_stage", "apple_dh_authentication"),
            ("apple_dh_parameter_check", "key_length"),
            ("apple_dh_generator", "5"),
            ("apple_dh_key_bytes", "128"),
        ] {
            assert_eq!(fields.get(name).map(String::as_str), Some(value));
        }
        assert_eq!(
            records[0].field_kinds.get("apple_dh_key_bytes"),
            Some(&"u64")
        );
    }
    let diagnostics = format!("{:?}", captured.entries());
    for secret in [USER, SECRET, PASSWORD, TOKEN] {
        assert!(!diagnostics.contains(secret));
    }
}
