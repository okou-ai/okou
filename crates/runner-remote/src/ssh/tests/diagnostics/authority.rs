use super::super::{
    harness::{CONNECTION, CREATED_AT, Harness, Reply, key},
    terminal,
};
use crate::test_fixtures::{
    diagnostic_text,
    http::{HttpClientConfig, http_client},
    raw_http::{RawHttpAction, RawHttpTestServer},
    remote_inventory,
};
use russh::keys::ssh_key::{Algorithm, LineEnding, PrivateKey};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

const VNC: &str = "ec71882f-380f-49d5-bcbd-5d08a76fa412";
const DENIED: &str = "denied the read request";
const TIMEOUT: &str = "authority lookup timed out";
const TRANSPORT: &str = "request or response could not be transferred";
const SERVICE: &str = "service failure or rate limit";
const INVALID: &str = "invalid or oversized inventory response";
const HIDDEN: &str = "unavailable under current Run, host or dependency read authority";

async fn query(h: &Harness, protocol: &str) -> Value {
    terminal(
        &h.raw(
            json!({"version":1,"method":format!("{protocol}.diagnose"),"params":{}}).to_string(),
        )
        .await,
    )
    .clone()
}

fn assert_failure(result: &Value, category: &str, api_url: &str) {
    assert_eq!(result["status"], "authority_unavailable", "{result}");
    let text = diagnostic_text(result);
    assert!(text.contains(category), "{result}");
    if category != HIDDEN {
        assert!(text.starts_with("Diagnostic history could not be read because"));
    }
    assert!(text.ends_with("Current connectivity has not been checked."));
    assert_eq!(result.as_object().unwrap().len(), 2);
    assert!(text.len() < 8192);
    for secret in [
        CONNECTION,
        VNC,
        "diagnostic-agent-token",
        "private-response-canary",
        "inventory-host-canary",
        "private-key-canary",
        "-----BEGIN OPENSSH PRIVATE KEY-----",
        "ssh.example.com",
        super::super::harness::TOKEN,
        CREATED_AT,
        "/api/ssh/hosts",
        "/api/vnc/hosts",
        api_url,
        "Dependency (ssh)",
    ] {
        assert!(!result.to_string().contains(secret), "leaked {secret}");
    }
}

fn response(status: u16, body: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

fn invalid_inventories() -> Vec<String> {
    let valid = remote_inventory(&[(CONNECTION, 7)], CREATED_AT);
    let host = json!({"id":CONNECTION});
    let identity = &valid["identities"][0];
    let mut cases = vec![
        "private-response-canary".into(),
        json!({"hosts":[]}).to_string(),
    ];
    for inventory in [
        json!({"hosts":[host],"identities":[]}),
        json!({"hosts":[host,host],"identities":[identity]}),
        json!({"hosts":[host,{"id":VNC}],"identities":[identity,identity]}),
        json!({"hosts":[host],"identities":[{"id":VNC,"createdAt":CREATED_AT,"generation":7}]}),
    ] {
        cases.push(inventory.to_string());
    }
    for (field, value) in [
        ("generation", json!(0)),
        ("generation", json!(-1)),
        ("generation", json!(i64::from(i32::MAX) + 1)),
        ("createdAt", json!("private-response-canary")),
    ] {
        let mut inventory = valid.clone();
        inventory["identities"][0][field] = value;
        cases.push(inventory.to_string());
    }
    cases
}

fn bad_credential(key: &PrivateKey) -> Vec<u8> {
    use base64::Engine;
    let body = json!({
        "outcome":"resolved", "host":"ssh.example.com", "port":22,
        "username":"private-response-canary", "generation":7,
        "learnedHostKey":{"algorithm":"ssh-ed25519","fingerprint":format!("SHA256:{}",base64::engine::general_purpose::STANDARD_NO_PAD.encode([0_u8;32]))},
        "privateKey":key.to_openssh(LineEnding::LF).unwrap().as_str(), "passphrase":null
    }).to_string();
    format!("HTTP/1.1 200 OK\r\nX-SSH-Connection-Created-At: {CREATED_AT}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).into_bytes()
}

/// Produce retained dependency evidence through real VNC/SSH RPC and an SSH peer.
async fn nested_failure(h: &mut Harness) -> String {
    let vnc = crate::vnc::VncRuntime::official(
        http_client(HttpClientConfig {
            api_url: h.api.base_url(),
            vercel_bypass: None,
            client_session_id: "nested-authority".into(),
        }),
        super::super::harness::TOKEN,
        h.identity,
    )
    .unwrap()
    .unwrap();
    h.restart_with_vnc(Arc::clone(&vnc)).await;
    h.enable_diagnostics().await;
    let resolve = h.api.mock_async(|when, then| {
        when.method("POST").path(format!("/api/runners/runs/{}/vnc/resolve", h.run));
        then.status(200).header("X-VNC-Connection-Created-At", CREATED_AT).json_body(json!({
            "outcome":"resolved_apple_dh", "host":"127.0.0.1", "port":5900, "generation":11,
            "transport":{"type":"ssh","connectionId":CONNECTION,"generation":7},
            "authentication":{"method":"apple_dh_username_password","username":"private-response-canary","password":"private-key-canary"},
            "security":{"type":"apple_dh"}
        }));
    }).await;
    let failure = h.raw(json!({"version":1,"method":"vnc.session.start","remaining_ms":60000,"params":{"connectionId":VNC,"mode":"shared"}}).to_string()).await;
    assert_eq!(terminal(&failure)["reason"], "invalid_credential");
    let text = diagnostic_text(terminal(&failure)).to_owned();
    assert!(text.contains(&format!(
        "- Dependency (ssh): {CONNECTION}; cause: SSH host key mismatch;"
    )));
    resolve.assert_calls_async(1).await;
    text
}

async fn settle_nested_setup(api: &mut RawHttpTestServer, h: &Harness) {
    for endpoint in ["resolve", "observations"] {
        let request = api.next_request("nested SSH operation setup").await;
        assert!(request.starts_with(&format!("POST /api/runners/runs/{}/ssh/{endpoint} ", h.run)));
    }
}

fn inventory(context: &str) -> Vec<u8> {
    let hosts = if context == "dependency" {
        vec![(CONNECTION, 7)]
    } else {
        vec![]
    };
    response(200, &remote_inventory(&hosts, CREATED_AT).to_string())
}

fn push_lookup(actions: &mut Vec<RawHttpAction>, context: &str, action: RawHttpAction) {
    if context == "dependency" {
        actions.push(RawHttpAction::Respond(response(
            200,
            &remote_inventory(&[(VNC, 11)], CREATED_AT).to_string(),
        )));
    }
    actions.push(action);
}

#[tokio::test]
async fn authority_failures_are_distinct_safe_and_recoverable_through_rpc() {
    for context in ["ssh", "vnc", "dependency"] {
        let client_key = key(Algorithm::Ed25519);
        let mut actions = Vec::new();
        if context == "dependency" {
            actions.push(RawHttpAction::Respond(bad_credential(&client_key)));
            actions.push(RawHttpAction::Respond(response(
                200,
                r#"{"outcome":"recorded"}"#,
            )));
        }
        let mut cases = Vec::new();
        for (status, category) in [
            (401, DENIED),
            (403, DENIED),
            (408, TIMEOUT),
            (429, SERVICE),
            (500, SERVICE),
            (503, SERVICE),
            (504, SERVICE),
            (204, INVALID),
            (400, INVALID),
            (404, INVALID),
        ] {
            cases.push(category);
            push_lookup(
                &mut actions,
                context,
                RawHttpAction::Respond(response(status, "private-response-canary")),
            );
            push_lookup(
                &mut actions,
                context,
                RawHttpAction::Respond(inventory(context)),
            );
        }
        for body in invalid_inventories() {
            cases.push(INVALID);
            push_lookup(
                &mut actions,
                context,
                RawHttpAction::Respond(response(200, &body)),
            );
            push_lookup(
                &mut actions,
                context,
                RawHttpAction::Respond(inventory(context)),
            );
        }
        let overflow = "x".repeat(512 * 1024 + 1);
        for (action, category) in [
            (RawHttpAction::Disconnect, TRANSPORT),
            (RawHttpAction::Respond(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\nprivate-response-canary".to_vec()), TRANSPORT),
            (RawHttpAction::Respond(b"HTTP/1.1 200 OK\r\nContent-Length: 524289\r\nConnection: close\r\n\r\n".to_vec()), INVALID),
            (RawHttpAction::Respond(format!("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{overflow}\r\n0\r\n\r\n",overflow.len()).into_bytes()), INVALID),
        ] {
            cases.push(category);
            push_lookup(&mut actions, context, action);
            push_lookup(&mut actions, context, RawHttpAction::Respond(inventory(context)));
        }
        if context == "dependency" {
            for (subject, created_at) in [
                (VNC, None),
                (VNC, Some("2026-09-01T00:00:00.123457Z")),
                (CONNECTION, None),
                (CONNECTION, Some("2026-09-01T00:00:00.123457Z")),
            ] {
                cases.push(HIDDEN);
                let body = match created_at {
                    None => remote_inventory(&[], CREATED_AT),
                    Some(created_at) => remote_inventory(&[(subject, 7)], created_at),
                };
                let action = RawHttpAction::Respond(response(200, &body.to_string()));
                if subject == VNC {
                    actions.push(action);
                } else {
                    push_lookup(&mut actions, context, action);
                }
                push_lookup(
                    &mut actions,
                    context,
                    RawHttpAction::Respond(inventory(context)),
                );
            }
        }
        let mut api = RawHttpTestServer::spawn(actions).await;
        let mut h = Harness::with_api(
            Reply::default(),
            client_key,
            key(Algorithm::Ed25519),
            Some(api.url()),
        )
        .await;
        let expected = if context == "dependency" {
            let text = nested_failure(&mut h).await;
            settle_nested_setup(&mut api, &h).await;
            Some(text)
        } else {
            h.enable_diagnostics().await;
            None
        };
        let protocol = if context == "ssh" { "ssh" } else { "vnc" };
        let attempts = h.observed.attempts.lock().unwrap().len();
        let case_count = cases.len();
        for category in cases {
            assert_failure(&query(&h, protocol).await, category, &api.url());
            let recovered = query(&h, protocol).await;
            if let Some(expected) = &expected {
                assert_eq!(recovered["status"], "found");
                assert_eq!(diagnostic_text(&recovered), expected);
            } else {
                assert_eq!(recovered["status"], "no_failure");
            }
            assert_eq!(h.observed.attempts.lock().unwrap().len(), attempts);
        }
        h.shutdown().await;
        let requests = api.assert_finished_with_requests().await;
        assert_eq!(
            requests.len(),
            if context == "dependency" {
                case_count * 4 - 2
            } else {
                case_count * 2
            }
        );
        if context != "dependency" {
            assert!(
                requests
                    .iter()
                    .all(|request| request.starts_with(&format!("GET /api/{protocol}/hosts ")))
            );
        }
        assert!(
            requests
                .iter()
                .all(|request| request.starts_with("GET /api/ssh/hosts ")
                    || request.starts_with("GET /api/vnc/hosts ")),
            "{context}: unexpected request paths: {:?}",
            requests
                .iter()
                .filter_map(|request| request.lines().next())
                .collect::<Vec<_>>()
        );
        assert!(requests.iter().all(|request| {
            request
                .to_lowercase()
                .contains("authorization: bearer diagnostic-agent-token\r\n")
        }));
    }
}

#[tokio::test]
async fn authority_deadline_bounds_primary_and_dependency_queries_without_target_io() {
    for context in ["ssh", "vnc", "dependency"] {
        let client_key = key(Algorithm::Ed25519);
        let mut actions = Vec::new();
        if context == "dependency" {
            actions.push(RawHttpAction::Respond(bad_credential(&client_key)));
            actions.push(RawHttpAction::Respond(response(
                200,
                r#"{"outcome":"recorded"}"#,
            )));
        }
        push_lookup(&mut actions, context, RawHttpAction::Stall);
        let mut api = RawHttpTestServer::spawn(actions).await;
        let mut h = Harness::with_api(
            Reply::default(),
            client_key,
            key(Algorithm::Ed25519),
            Some(api.url()),
        )
        .await;
        if context == "dependency" {
            nested_failure(&mut h).await;
            settle_nested_setup(&mut api, &h).await;
        } else {
            h.enable_diagnostics().await;
        }
        let protocol = if context == "ssh" { "ssh" } else { "vnc" };
        let attempts = h.observed.attempts.lock().unwrap().len();
        let mut pending = Box::pin(query(&h, protocol));
        for _ in 0..if context == "dependency" { 2 } else { 1 } {
            tokio::select! {
                result = &mut pending => panic!("history returned before the stalled lookup: {result}"),
                _ = api.next_request("armed authority request") => {}
            }
        }
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(5)).await;
        tokio::time::resume();
        assert_failure(&pending.await, TIMEOUT, &api.url());
        assert_eq!(h.observed.attempts.lock().unwrap().len(), attempts);
        h.shutdown().await;
        api.cancel_and_reap().await;
    }
}
