use super::harness::CREATED_AT;
use super::{
    harness::{CONNECTION, Harness, Reply, params},
    terminal,
};
use crate::test_fixtures::remote_inventory;
use crate::test_fixtures::{diagnostic_attempt, diagnostic_text};
use runner_provider::AblySideMessageHandler;
use serde_json::{Value, json};

mod authority;

#[tokio::test]
async fn installation_requires_trusted_agent_token_without_disrupting_ssh() {
    let mut h = Harness::new(Reply::default()).await;
    let token = crate::test_fixtures::check_token(h.run, &["ssh:read", "ssh:write"]);
    let mut context =
        crate::test_fixtures::execution_context::diagnostic_context_for_test(h.run, &token);
    context.sandbox_token = token.clone();
    context
        .environment
        .as_mut()
        .unwrap()
        .insert("OKOU_TOKEN".into(), token);
    context.platform_environment.remove("OKOU_TOKEN");
    h.install_context(&context).await;
    let inventory = h
        .api
        .mock_async(|when, then| {
            when.method("GET").path("/api/ssh/hosts");
            then.status(200)
                .json_body(remote_inventory(&[(CONNECTION, 7)], CREATED_AT));
        })
        .await;
    let resolve = h.resolve(h.credential(true)).await;
    assert_eq!(query(&h, json!({})).await["status"], "unavailable");
    assert_eq!(
        h.raw(
            json!({"version":1,"method":"ssh.check","remaining_ms":10000,
            "params":{"connectionId":CONNECTION}})
            .to_string()
        )
        .await,
        vec![json!({"type":"error","code":"unavailable","delivery":"not_dispatched"})],
    );
    inventory.assert_calls_async(0).await;
    resolve.assert_calls_async(0).await;
    assert!(h.observed.attempts.lock().unwrap().is_empty());
    assert_eq!(terminal(&h.request(params()).await)["type"], "finished");
    resolve.assert_calls_async(1).await;
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
    assert!(diagnostic_text(&first).starts_with("Failure: SSH unavailable during exec."));
    bad.assert_calls_async(1).await;
    bad.delete_async().await;
    let good = h.resolve(h.credential(true)).await;
    assert_eq!(terminal(&h.request(params()).await)["type"], "finished");
    h.expire_idle().await;
    let last = query(&h, json!({})).await;
    assert_eq!(diagnostic_attempt(&last), diagnostic_attempt(&first));
    let exact = query(&h, json!({"attemptId":diagnostic_attempt(&first)})).await;
    assert!(diagnostic_text(&exact).contains(&format!("Connection: {CONNECTION}\n")));
    let missing = query(&h, json!({"sessionId":uuid::Uuid::new_v4()})).await;
    assert_eq!(missing["status"], "not_retained");
    assert!(!diagnostic_text(&missing).contains(CONNECTION));
    good.assert_calls_async(1).await;
    inventory.assert_calls_async(4).await;
    assert!(!last.to_string().contains("inventory-host-canary"));
    h.shutdown().await;
}

#[tokio::test]
async fn closing_running_ssh_session_preserves_the_previous_operational_failure() {
    use super::{sessions, wait_for};
    use std::sync::atomic::Ordering;

    let mut h = Harness::new(Reply::Hold).await;
    h.enable_diagnostics().await;
    let _inventory = h
        .api
        .mock_async(|when, then| {
            when.method("GET").path("/api/ssh/hosts");
            then.status(200)
                .json_body(remote_inventory(&[(CONNECTION, 7)], CREATED_AT));
        })
        .await;
    let bad = h.resolve(json!({"outcome":"unavailable"})).await;
    assert_eq!(
        terminal(&h.request(params()).await)["failure_reason"],
        "unavailable"
    );
    let original = query(&h, json!({})).await;
    assert_eq!(original["status"], "found");
    bad.delete_async().await;

    let resolve = h.resolve(h.credential(true)).await;
    let session = sessions::start(&h, json!({"type":"exec","command":"hold"}), false).await;
    sessions::state(&h, &session, "running").await;
    assert_eq!(
        sessions::rpc(&h, "close", json!({"sessionId":session})).await["type"],
        "closed"
    );
    wait_for(|| h.observed.closed.load(Ordering::SeqCst) > 0).await;
    assert_eq!(
        sessions::rpc(&h, "status", json!({"sessionId":session})).await["failure_reason"],
        "unavailable"
    );
    let retained = query(&h, json!({})).await;
    assert_eq!(retained["status"], "found");
    assert_eq!(diagnostic_text(&retained), diagnostic_text(&original));
    resolve.assert_calls_async(1).await;
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
    assert!(!diagnostic_text(&denied).contains(CONNECTION));
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
    assert!(h.runtime.handle(&ably_subscriber::Message {
        name: Some("ssh-authority-invalidated".into()),
        data: json!({"runId":h.run,"connectionId":CONNECTION}),
        id: None,
        client_id: None,
        timestamp: None,
    }));
    wait_for(|| h.observed.closed.load(Ordering::SeqCst) > 0).await;
    h.ssh().prune();
    let last = query(&h, json!({"sessionId":session})).await;
    assert_eq!(last["status"], "found");
    assert!(diagnostic_text(&last).contains(&format!("Session: {}\n", session.as_str().unwrap())));
    assert!(
        diagnostic_text(&last).starts_with("Failure: SSH configuration changed during session.")
    );
    assert!(diagnostic_text(&last).contains(&format!(
        "Configuration: created at {CREATED_AT}; generation 7."
    )));
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
    assert_eq!(terminal(&failure)["outcome"], "failed");
    assert_eq!(terminal(&failure)["reason"], "invalid_credential");
    let automatic = diagnostic_text(terminal(&failure));
    assert!(automatic.contains("VNC transport: failed."), "{automatic}");
    assert!(
        automatic.contains("VNC authentication: not reached."),
        "{automatic}"
    );
    assert!(automatic.contains("ssh trust: failed."), "{automatic}");
    assert!(
        automatic.contains("Verify the dependency's SSH server host key"),
        "{automatic}"
    );
    let history = h
        .raw(json!({"version":1,"method":"vnc.diagnose","params":{}}).to_string())
        .await;
    let report = terminal(&history);
    assert_eq!(report["status"], "found");
    assert_eq!(diagnostic_text(report), automatic);
    assert!(diagnostic_text(report).contains(&format!("- Dependency (ssh): {CONNECTION}; cause: SSH host key mismatch; configuration created at {CREATED_AT}; generation 7.")));
    assert!(!report.to_string().contains("password-canary"));
    assert!(!report.to_string().contains("user-canary"));
    resolve.assert_calls_async(1).await;
    vnc_resolve.assert_calls_async(1).await;
    h.shutdown().await;
}
