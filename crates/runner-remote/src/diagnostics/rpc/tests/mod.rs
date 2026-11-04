use super::*;
use crate::diagnostics::{Cause, Dependency, Identity, Operation};
use crate::test_fixtures::http::{HttpClientConfig, http_client};
use crate::test_fixtures::remote_inventory;
use httpmock::MockServer;
const CREATED_AT: &str = "2026-09-01T00:00:00.123456Z";

#[tokio::test]
async fn successful_authority_response_cannot_disclose_a_replaced_assignment() {
    use crate::test_fixtures::raw_http::{RawHttpAction, RawHttpTestServer, json_response};
    let host = Uuid::new_v4();
    let ssh = Uuid::new_v4();
    let inventory = json_response(
        "200 OK",
        &remote_inventory(&[(&host.to_string(), 7)], CREATED_AT).to_string(),
    );
    let dependency_inventory = json_response(
        "200 OK",
        &remote_inventory(&[(&ssh.to_string(), 7)], CREATED_AT).to_string(),
    );
    let (release, response) = tokio::sync::oneshot::channel();
    let mut server = RawHttpTestServer::spawn(vec![
        RawHttpAction::Respond(inventory.clone()),
        RawHttpAction::Respond(dependency_inventory.clone()),
        RawHttpAction::Respond(inventory),
        RawHttpAction::WaitThenRespond {
            release: response,
            response: dependency_inventory,
        },
    ])
    .await;
    let authority = Authority::new(
        http_client(HttpClientConfig {
            api_url: server.url(),
            vercel_bypass: None,
            client_session_id: "assignment-race".into(),
        }),
        "agent",
    );
    let handle = Handle::new(runner_types::ids::RunId::new_v4(), true);
    let recorded = handle
        .record(super::super::Record {
            effects: None,
            protocol: Protocol::Vnc,
            connection: host,
            operation: Operation::Capture,
            identity: Identity {
                created_at: Some(CREATED_AT.parse().unwrap()),
                generation: Some(7),
                session: None,
            },
            cause: Some(Cause::Vnc(crate::vnc::Failure::Disconnected)),
            dependency: Some(Dependency {
                protocol: Protocol::Ssh,
                connection_id: ssh,
                cause: Some(Cause::Ssh(crate::ssh::FailureReason::HostKeyMismatch)),
                configuration_created_at: Some(CREATED_AT.parse().unwrap()),
                configuration_generation: Some(7),
            }),
            native: None,
            ssh: None,
            vnc: None,
        })
        .unwrap();
    let control = handle
        .query(Protocol::Vnc, Selector::default(), Some(&authority))
        .await;
    assert!(matches!(control.status, Status::Found));
    assert!(control.message.contains(&host.to_string()));
    assert!(control.message.contains(&ssh.to_string()));
    assert!(control.message.contains(&recorded.attempt_id.to_string()));
    for path in ["/api/vnc/hosts", "/api/ssh/hosts"] {
        assert!(
            server
                .next_request("current assignment authority")
                .await
                .starts_with(&format!("GET {path} "))
        );
    }

    let query = handle.query(Protocol::Vnc, Selector::default(), Some(&authority));
    tokio::pin!(query);
    for path in ["/api/vnc/hosts", "/api/ssh/hosts"] {
        let request = tokio::select! {
            request = server.next_request("held authority across assignment replacement") => request,
            _ = &mut query => panic!("history query must wait for its authority response"),
        };
        assert!(request.starts_with(&format!("GET {path} ")));
    }
    // Native RPC cancellation is covered by the VNC integration case.
    // Dependency authorization occurs after the report is selected. Replace
    // the assignment here to exercise its final fence against disclosure.
    let _replacement = handle.replacement(true);
    release.send(()).unwrap();
    let result = query.await;
    assert!(matches!(result.status, Status::Unavailable));
    assert!(!result.message.contains(&host.to_string()));
    assert!(!result.message.contains(&ssh.to_string()));
    assert!(!result.message.contains(&recorded.attempt_id.to_string()));
    server.assert_finished().await;
}

#[tokio::test]
async fn active_check_authority_is_bound_to_the_installed_run_execution_claims() {
    use base64::Engine;
    let api = MockServer::start_async().await;
    let http = http_client(HttpClientConfig {
        api_url: api.base_url(),
        vercel_bypass: None,
        client_session_id: "check-authority".into(),
    });
    let run = runner_types::ids::RunId::new_v4();
    let valid = serde_json::json!({"scope":"okou","runId":run,"capabilities":["ssh:write"],"exp":chrono::Utc::now().timestamp()+3600});
    for (field, value) in [
        ("scope", serde_json::json!("other")),
        (
            "runId",
            serde_json::json!(runner_types::ids::RunId::new_v4()),
        ),
        ("exp", serde_json::json!(0)),
        ("capabilities", serde_json::json!(["ssh:read", "vnc:write"])),
    ] {
        let mut claims = valid.clone();
        claims[field] = value;
        let token = format!(
            "vm0_sandbox_e30.{}.signature",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(claims.to_string())
        );
        assert!(
            !Authority::new(http.clone(), &token).permits_check(run, Protocol::Ssh),
            "{field}"
        );
    }
    let token = crate::test_fixtures::check_token(run, &["ssh:write"]);
    let authority = Authority::new(http, &token);
    assert!(authority.permits_check(run, Protocol::Ssh));
    assert!(!authority.permits_check(run, Protocol::Vnc));
}

#[tokio::test]
async fn nested_evidence_requires_both_current_inventories_and_drops_provider_text() {
    let api = MockServer::start_async().await;
    let authority = Authority::new(
        http_client(HttpClientConfig {
            api_url: api.base_url(),
            vercel_bypass: None,
            client_session_id: "history-authority".into(),
        }),
        "agent-token-canary",
    );
    let vnc = Uuid::new_v4();
    let ssh = Uuid::new_v4();
    let inventory = api
        .mock_async(|when, then| {
            when.method("GET")
                .path("/api/vnc/hosts")
                .header("authorization", "Bearer agent-token-canary");
            then.status(200)
                .json_body(remote_inventory(&[(&vnc.to_string(), 7)], CREATED_AT));
        })
        .await;
    let denied = api
        .mock_async(|when, then| {
            when.method("GET").path("/api/ssh/hosts");
            then.status(403).body("credential-canary");
        })
        .await;
    let handle = Handle::new(runner_types::ids::RunId::new_v4(), true);
    let _ = handle.record(super::super::Record {
        effects: None,
        protocol: Protocol::Vnc,
        connection: vnc,
        operation: Operation::Start,
        identity: Identity {
            created_at: Some(CREATED_AT.parse().unwrap()),
            generation: Some(7),
            session: None,
        },
        cause: Some(Cause::Vnc(crate::vnc::Failure::InvalidCredential)),
        dependency: Some(Dependency {
            protocol: Protocol::Ssh,
            connection_id: ssh,
            cause: Some(Cause::Ssh(crate::ssh::FailureReason::HostKeyMismatch)),
            configuration_created_at: Some(CREATED_AT.parse().unwrap()),
            configuration_generation: Some(7),
        }),
        native: None,
        ssh: None,
        vnc: None,
    });
    let hidden = handle
        .query(Protocol::Vnc, Selector::default(), Some(&authority))
        .await;
    assert_eq!(
        serde_json::to_value(&hidden).unwrap()["status"],
        "authority_unavailable"
    );
    assert!(!hidden.message.contains(&ssh.to_string()));
    denied.delete_async().await;
    let allowed = api
        .mock_async(|when, then| {
            when.method("GET").path("/api/ssh/hosts");
            then.status(200)
                .json_body(remote_inventory(&[(&ssh.to_string(), 7)], CREATED_AT));
        })
        .await;
    let result = serde_json::to_value(
        handle
            .query(Protocol::Vnc, Selector::default(), Some(&authority))
            .await,
    )
    .unwrap();
    assert_eq!(result["status"], "found");
    assert!(
        crate::test_fixtures::diagnostic_text(&result).contains(&format!(
            "- Dependency (ssh): {ssh}; cause: SSH host key mismatch;"
        ))
    );
    for secret in [
        "inventory-host-canary",
        "credential-canary",
        "agent-token-canary",
    ] {
        assert!(!result.to_string().contains(secret));
    }
    inventory.assert_calls_async(2).await;
    allowed.assert_calls_async(1).await;
}

#[tokio::test]
async fn creation_precision_and_missing_identity_fail_closed() {
    let api = MockServer::start_async().await;
    let authority = Authority::new(
        http_client(HttpClientConfig {
            api_url: api.base_url(),
            vercel_bypass: None,
            client_session_id: "creation-authority".into(),
        }),
        "agent",
    );
    let host = Uuid::new_v4();
    let handle = Handle::new(runner_types::ids::RunId::new_v4(), true);
    let _ = handle.record(super::super::Record {
        effects: None,
        protocol: Protocol::Ssh,
        connection: host,
        operation: Operation::Exec,
        identity: Identity {
            created_at: Some(CREATED_AT.parse().unwrap()),
            generation: Some(7),
            session: None,
        },
        cause: Some(Cause::Ssh(crate::ssh::FailureReason::HostKeyMismatch)),
        dependency: None,
        native: None,
        ssh: None,
        vnc: None,
    });
    for created_at in ["2026-09-01T00:00:00.123457Z", CREATED_AT] {
        let inventory = api
            .mock_async(|when, then| {
                when.method("GET").path("/api/ssh/hosts");
                then.status(200)
                    .json_body(remote_inventory(&[(&host.to_string(), 99)], created_at));
            })
            .await;
        let result = serde_json::to_value(
            handle
                .query(Protocol::Ssh, Selector::default(), Some(&authority))
                .await,
        )
        .unwrap();
        assert_eq!(
            result["status"],
            if created_at == CREATED_AT {
                "found"
            } else {
                "authority_unavailable"
            }
        );
        inventory.delete_async().await;
    }
    let missing_identity = api
        .mock_async(|when, then| {
            when.method("GET").path("/api/ssh/hosts");
            then.status(200)
                .json_body(serde_json::json!({"hosts":[{"id":host}]}));
        })
        .await;
    let unavailable = handle
        .query(Protocol::Ssh, Selector::default(), Some(&authority))
        .await;
    assert!(!unavailable.message.contains(&host.to_string()));
    assert_eq!(
        serde_json::to_value(&unavailable).unwrap()["status"],
        "authority_unavailable"
    );
    missing_identity.assert_calls_async(1).await;
}
