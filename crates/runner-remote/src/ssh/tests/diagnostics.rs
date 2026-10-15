use super::harness::CREATED_AT;
use super::{
    harness::{CONNECTION, Harness, Reply, params},
    terminal,
};
use crate::test_fixtures::remote_inventory;
use serde_json::{Value, json};

#[tokio::test]
async fn disabled_owner_advertises_no_passive_support_without_affecting_legacy_methods() {
    let mut h = Harness::new(Reply::default()).await;
    let capabilities = h
        .raw(
            json!({"version":1,"method":"remote.diagnostics.capabilities","params":{}}).to_string(),
        )
        .await;
    assert_eq!(
        terminal(&capabilities),
        &json!({"schema_version":1,"passive_query":false,"active_check":false})
    );
    assert_eq!(query(&h, json!({})).await["status"], "unavailable");
    let _resolve = h.resolve(h.credential(true)).await;
    assert_eq!(terminal(&h.request(params()).await)["type"], "finished");
    h.shutdown().await;
}

async fn query(h: &Harness, params: Value) -> Value {
    terminal(
        &h.raw(json!({"version":1,"method":"ssh.diagnose","params":params}).to_string())
            .await,
    )
    .clone()
}

#[tokio::test]
async fn ssh_history_survives_failed_connection_cleanup_and_later_success_without_resolving_again()
{
    let mut h = Harness::new(Reply::default()).await;
    h.enable_diagnostics().await;
    let inventory = h
        .api
        .mock_async(|when, then| {
            when.method("GET")
                .path("/api/ssh/hosts")
                .header("authorization", "Bearer diagnostic-agent-token");
            then.status(200)
                .json_body(remote_inventory(&[(CONNECTION, 7)], CREATED_AT));
        })
        .await;
    let bad = h.resolve(json!({"outcome":"unavailable"})).await;
    assert_eq!(
        terminal(&h.request(params()).await)["failure_reason"],
        "unavailable"
    );
    let first = query(&h, json!({})).await;
    assert_eq!(first["status"], "found");
    assert_eq!(
        first["report"]["cause"],
        json!({"source":"ssh","code":"unavailable"})
    );
    bad.assert_calls_async(1).await;
    bad.delete_async().await;
    let good = h.resolve(h.credential(true)).await;
    assert_eq!(terminal(&h.request(params()).await)["type"], "finished");
    h.expire_idle().await;
    let last = query(&h, json!({})).await;
    assert_eq!(last["report"]["attempt_id"], first["report"]["attempt_id"]);
    let exact = query(&h, json!({"attemptId":first["report"]["attempt_id"]})).await;
    assert_eq!(exact["report"]["connection_id"], CONNECTION);
    let missing = query(&h, json!({"sessionId":uuid::Uuid::new_v4()})).await;
    assert_eq!(missing["status"], "not_retained");
    assert!(missing["report"].is_null());
    good.assert_calls_async(1).await;
    inventory.assert_calls_async(4).await;
    assert!(!last.to_string().contains("inventory-host-canary"));
    h.shutdown().await;
}

#[tokio::test]
async fn revoked_host_hides_old_evidence_and_new_run_does_not_inherit_it() {
    let mut h = Harness::new(Reply::default()).await;
    h.enable_diagnostics().await;
    let _bad = h.resolve(json!({"outcome":"unavailable"})).await;
    h.request(params()).await;
    let revoked = h
        .api
        .mock_async(|when, then| {
            when.method("GET").path("/api/ssh/hosts");
            then.status(200)
                .json_body(remote_inventory(&[], CREATED_AT));
        })
        .await;
    let denied = query(&h, json!({})).await;
    assert_eq!(denied["status"], "authority_unavailable");
    assert!(denied["report"].is_null());
    revoked.delete_async().await;
    let _allowed = h
        .api
        .mock_async(|when, then| {
            when.method("GET").path("/api/ssh/hosts");
            then.status(200)
                .json_body(remote_inventory(&[(CONNECTION, 7)], CREATED_AT));
        })
        .await;
    h.restart(runner_types::ids::RunId::new_v4()).await;
    h.enable_diagnostics().await;
    assert_eq!(query(&h, json!({})).await["status"], "no_failure");
    h.shutdown().await;
}

#[tokio::test]
async fn retained_ssh_process_failure_remains_after_authority_prunes_its_session() {
    use super::{sessions, wait_for};
    use std::sync::atomic::Ordering;
    let mut h = Harness::new(Reply::Process).await;
    h.enable_diagnostics().await;
    let _resolve = h.resolve(h.credential(true)).await;
    let _inventory = h
        .api
        .mock_async(|when, then| {
            when.method("GET").path("/api/ssh/hosts");
            then.status(200)
                .json_body(remote_inventory(&[(CONNECTION, 7)], CREATED_AT));
        })
        .await;
    let session = sessions::start(&h, json!({"type":"shell"}), false).await;
    sessions::state(&h, &session, "running").await;
    h.notifications()
        .send(Some(ably_subscriber::Event::Message(
            ably_subscriber::Message {
                name: Some("ssh-authority-invalidated".into()),
                data: json!({"runId":h.run,"connectionId":CONNECTION}),
                id: None,
                client_id: None,
                timestamp: None,
            },
        )))
        .await;
    wait_for(|| h.observed.closed.load(Ordering::SeqCst) > 0).await;
    h.ssh().prune();
    let last = query(&h, json!({"sessionId":session})).await;
    assert_eq!(last["status"], "found");
    assert_eq!(last["report"]["session_id"], session);
    assert_eq!(last["report"]["cause"]["code"], "configuration_changed");
    assert_eq!(last["report"]["configuration_generation"], 7);
    assert!(last["report"]["configuration_created_at"].is_string());
    h.shutdown().await;
}

#[tokio::test]
async fn vnc_history_preserves_ssh_host_key_failure_before_business_conversion() {
    use crate::{
        test_fixtures::http::{HttpClientConfig, http_client},
        vnc::VncRuntime,
    };
    use base64::Engine;
    use std::sync::Arc;
    const VNC: &str = "ec71882f-380f-49d5-bcbd-5d08a76fa412";
    let mut h = Harness::new(Reply::default()).await;
    let vnc = VncRuntime::official(
        http_client(HttpClientConfig {
            api_url: h.api.base_url(),
            vercel_bypass: None,
            client_session_id: "nested-history".into(),
        }),
        super::harness::TOKEN,
        h.identity,
    )
    .unwrap()
    .unwrap();
    h.restart_with_vnc(Arc::clone(&vnc)).await;
    h.enable_diagnostics().await;
    let mut credential = h.credential(true);
    credential["learnedHostKey"]["fingerprint"] = json!(format!(
        "SHA256:{}",
        base64::engine::general_purpose::STANDARD_NO_PAD.encode([0_u8; 32])
    ));
    let resolve = h.resolve(credential).await;
    let vnc_resolve = h.api.mock_async(|when, then| {
        when.method("POST").path(format!("/api/runners/runs/{}/vnc/resolve", h.run));
        then.status(200).header("X-VNC-Connection-Created-At", super::harness::CREATED_AT).json_body(json!({
            "outcome":"resolved_apple_dh", "host":"127.0.0.1", "port":5900, "generation":11,
            "transport":{"type":"ssh","connectionId":CONNECTION,"generation":7},
            "authentication":{"method":"apple_dh_username_password","username":"user-canary","password":"password-canary"},
            "security":{"type":"apple_dh"}
        }));
    }).await;
    let _vnc_inventory = h
        .api
        .mock_async(|when, then| {
            when.method("GET").path("/api/vnc/hosts");
            then.status(200)
                .json_body(remote_inventory(&[(VNC, 11)], CREATED_AT));
        })
        .await;
    let _ssh_inventory = h
        .api
        .mock_async(|when, then| {
            when.method("GET").path("/api/ssh/hosts");
            then.status(200)
                .json_body(remote_inventory(&[(CONNECTION, 7)], CREATED_AT));
        })
        .await;
    let failure = h.raw(json!({"version":1,"method":"vnc.session.start","remaining_ms":60000,"params":{"connectionId":VNC,"mode":"shared"}}).to_string()).await;
    assert_eq!(
        terminal(&failure),
        &json!({"outcome":"failed","reason":"invalid_credential"})
    );
    let history = h
        .raw(json!({"version":1,"method":"vnc.diagnose","params":{}}).to_string())
        .await;
    let report = terminal(&history);
    assert_eq!(report["status"], "found");
    assert_eq!(
        report["report"]["dependencies"][0]["cause"],
        json!({"source":"ssh","code":"host_key_mismatch"})
    );
    assert_eq!(
        report["report"]["dependencies"][0]["connection_id"],
        CONNECTION
    );
    assert!(!report.to_string().contains("password-canary"));
    assert!(!report.to_string().contains("user-canary"));
    resolve.assert_calls_async(1).await;
    vnc_resolve.assert_calls_async(1).await;
    h.shutdown().await;
}
