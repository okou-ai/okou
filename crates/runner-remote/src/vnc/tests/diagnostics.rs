use std::sync::atomic::Ordering;

use serde_json::json;
use tracing_subscriber::prelude::*;
use tracing_test_support::{CapturedEvent, CapturedEvents};

use super::{
    closed,
    harness::{CONNECTION, Harness},
    mode,
    peer::{PLAIN_PASSWORD, PLAIN_USERNAME, Peer},
};

fn attempts(captured: &CapturedEvents) -> Vec<CapturedEvent> {
    captured
        .entries()
        .into_iter()
        .filter(|event| {
            event.fields.get("message").map(String::as_str)
                == Some("VNC connection attempt finished")
        })
        .collect()
}

#[tokio::test]
async fn actual_failure_and_recovery_have_correlated_secret_free_terminal_records() {
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry()
        .with(tracing_subscriber::filter::filter_fn(|metadata| {
            metadata.target().starts_with("runner_remote::vnc")
        }))
        .with(captured.clone());
    let _subscriber = tracing::subscriber::set_default(subscriber);
    let mut h = Harness::new_plain().await;
    let _resolve = h.resolve_plain().await;
    let _check = h.check("valid", 200).await;
    h.peer.refuse.store(true, Ordering::SeqCst);
    assert_eq!(
        h.start("shared").await.result()["reason"],
        "authentication_failed"
    );
    closed(&h).await;
    h.peer.refuse.store(false, Ordering::SeqCst);
    let session = h.start("shared").await.session();
    mode(&h, 1).await;
    h.run
        .request("vnc.session.status", json!({"sessionId":session}))
        .await;
    h.run.request("vnc.session.list", json!({})).await;
    h.run
        .request("vnc.session.close", json!({"sessionId":session}))
        .await;
    closed(&h).await;
    h.run.shutdown().await;

    let records = attempts(&captured);
    assert_eq!(
        records.len(),
        2,
        "session operations must not fabricate attempts"
    );
    for record in &records {
        assert_eq!(record.level, tracing::Level::INFO);
        assert_eq!(record.fields.get("run_id"), Some(&h.run.id.to_string()));
        assert_eq!(
            record.fields.get("connection_id").map(String::as_str),
            Some(CONNECTION)
        );
        assert_eq!(
            record.fields.get("vnc_auth_profile").map(String::as_str),
            Some("x509_plain")
        );
        assert_eq!(
            record.fields.get("vnc_transport").map(String::as_str),
            Some("direct")
        );
        assert_eq!(record.field_kinds.get("elapsed_ms"), Some(&"u64"));
    }
    assert_eq!(
        records[0].fields.get("outcome").map(String::as_str),
        Some("failed")
    );
    assert_eq!(
        records[0]
            .fields
            .get("vnc_connection_stage")
            .map(String::as_str),
        Some("authentication")
    );
    assert_eq!(
        records[0].fields.get("rfb_error_code").map(String::as_str),
        Some("authentication_failed")
    );
    assert_eq!(
        records[1].fields.get("outcome").map(String::as_str),
        Some("started")
    );
    assert_eq!(
        records[1]
            .fields
            .get("vnc_connection_stage")
            .map(String::as_str),
        Some("session_admission")
    );
    assert!(!records[1].fields.contains_key("rfb_error_code"));
    let diagnostics = format!("{:?}", captured.entries());
    for secret in [
        PLAIN_USERNAME,
        PLAIN_PASSWORD,
        "vm0_official_vnc-test",
        &h.peer.ca,
    ] {
        assert!(!diagnostics.contains(secret));
    }
}

#[tokio::test]
async fn post_authentication_authority_failure_keeps_its_stage_without_provider_text() {
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry()
        .with(tracing_subscriber::filter::filter_fn(|metadata| {
            metadata.target().starts_with("runner_remote::vnc")
        }))
        .with(captured.clone());
    let _subscriber = tracing::subscriber::set_default(subscriber);
    let mut h = Harness::new().await;
    h.run.enable_diagnostics(&h.runtime).await;
    let _resolve = h.resolve().await;
    let _check = h.check("provider-error-canary", 500).await;
    let failed = h.start("shared").await;
    assert_eq!(failed.result()["reason"], "authority_failure");
    let explanation = crate::test_fixtures::diagnostic_text(failed.result());
    assert!(explanation.contains("VNC authority recheck: failed."));
    assert!(explanation.contains("VNC initialization: passed."));
    assert!(!explanation.contains("provider-error-canary"));
    h.run.shutdown().await;
    let records = attempts(&captured);
    assert_eq!(records.len(), 1);
    assert_eq!(
        records[0]
            .fields
            .get("vnc_connection_stage")
            .map(String::as_str),
        Some("authority_recheck")
    );
    assert!(!records[0].fields.contains_key("rfb_error_code"));
    assert!(!format!("{:?}", captured.entries()).contains("provider-error-canary"));
    assert!(!format!("{:?}", captured.entries()).contains(" secret "));
}

#[tokio::test]
async fn invalid_server_init_preserves_the_engine_category_and_initialization_stage() {
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry()
        .with(tracing_subscriber::filter::filter_fn(|metadata| {
            metadata.target().starts_with("runner_remote::vnc")
        }))
        .with(captured.clone());
    let _subscriber = tracing::subscriber::set_default(subscriber);
    let mut h = Harness::with_authority(Peer::invalid_framebuffer().await, None).await;
    h.run.enable_diagnostics(&h.runtime).await;
    let _resolve = h
        .resolve_response(json!({
            "outcome":"resolved_transport", "host":"vnc.example.test", "port":5900, "generation":7,
            "serverName":"vnc.example.test", "transport":{"type":"direct"},
            "authentication":{"method":"none"},
            "security":{"type":"x509_none", "trust":{"mode":"custom_ca","caBundle":h.peer.ca}}
        }))
        .await;
    let failed = h.start("shared").await;
    assert_eq!(failed.result()["reason"], "protocol");
    let explanation = crate::test_fixtures::diagnostic_text(failed.result());
    assert!(explanation.contains("VNC initialization: failed."));
    assert!(explanation.contains("VNC authentication: passed."));
    assert!(explanation.contains("VNC RFB error: invalid_framebuffer;"));
    h.run.shutdown().await;
    let records = attempts(&captured);
    assert_eq!(records.len(), 1);
    assert_eq!(
        records[0]
            .fields
            .get("vnc_connection_stage")
            .map(String::as_str),
        Some("initialization")
    );
    assert_eq!(
        records[0].fields.get("rfb_error_code").map(String::as_str),
        Some("invalid_framebuffer")
    );
}
