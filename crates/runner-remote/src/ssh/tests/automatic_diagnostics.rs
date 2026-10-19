use super::{
    harness::{CONNECTION, CREATED_AT, Harness, Reply, params},
    terminal,
};
use crate::test_fixtures::{diagnostic_attempt, diagnostic_text, remote_inventory};
use serde_json::{Value, json};
use std::sync::atomic::Ordering;

async fn rpc(h: &Harness, method: &str, params: Value) -> Value {
    terminal(
        &h.raw(
            json!({"version":1,"method":method,"remaining_ms":60000,"params":params}).to_string(),
        )
        .await,
    )
    .clone()
}
fn assert_stage(text: &str, name: &str, status: &str) {
    let fact = format!(
        "- {}: {}.\n",
        name.replace('_', " "),
        status.replace('_', " ")
    );
    assert!(text.contains(&fact), "missing {fact:?} in {text}");
}

#[tokio::test]
async fn successful_results_preserve_nonzero_exit_with_diagnostics_enabled_or_disabled() {
    let mut h = Harness::new(Reply::default()).await;
    let resolve = h.resolve(h.credential(true)).await;
    let disabled = rpc(&h, "ssh.exec", params()).await;
    assert_eq!(disabled["type"], "finished");
    assert!(disabled.get("diagnostic_text").is_none());
    resolve.assert_calls_async(1).await;
    h.enable_diagnostics().await;
    let enabled = rpc(&h, "ssh.exec", params()).await;
    assert_eq!(enabled["type"], "finished");
    assert_eq!(enabled["exit"]["code"], 7);
    assert!(enabled.get("diagnostic_text").is_none());
    h.shutdown().await;
}

#[tokio::test]
async fn concurrent_failures_return_their_own_committed_report_and_exact_query() {
    const OTHER: &str = "bbaea49d-2ac7-4509-a2f0-1fbcac8b578b";
    let mut h = Harness::new(Reply::Reject).await;
    h.enable_diagnostics().await;
    let _a = h.resolve(h.credential(true)).await;
    let _b = h.resolve_connection(OTHER, h.credential(true)).await;
    let _inventory = h
        .api
        .mock_async(|when, then| {
            when.method("GET").path("/api/ssh/hosts");
            then.status(200)
                .json_body(remote_inventory(&[(CONNECTION, 7), (OTHER, 7)], CREATED_AT));
        })
        .await;
    let mut b = params();
    b["sshConnectionId"] = OTHER.into();
    let (a, b) = tokio::join!(rpc(&h, "ssh.exec", params()), rpc(&h, "ssh.exec", b));
    for (reply, id) in [(&a, CONNECTION), (&b, OTHER)] {
        assert_eq!(reply["failure_reason"], "exec_rejected");
        assert_eq!(reply["effects"], "not_started");
        let text = diagnostic_text(reply);
        assert!(text.contains(&format!("Connection: {id}\n")));
        assert!(reply["diagnostic_text"].as_str().unwrap().len() <= 8192);
        assert!(text.contains(&format!("Configuration: created at {CREATED_AT};")));
        assert_stage(text, "ssh_proof", "passed");
        assert_stage(text, "ssh_trust", "passed");
        assert_stage(text, "authentication", "passed");
        assert_stage(text, "operation", "failed");
        let query = rpc(
            &h,
            "ssh.diagnose",
            json!({"attemptId":diagnostic_attempt(reply)}),
        )
        .await;
        assert_eq!(diagnostic_text(&query), text);
    }
    assert_ne!(diagnostic_attempt(&a), diagnostic_attempt(&b));
    h.shutdown().await;
}

#[tokio::test]
async fn strict_parameters_prevent_dispatch_and_feature_gate_controls_failure_text() {
    let mut h = Harness::new(Reply::default()).await;
    let resolve = h.resolve(json!({"outcome":"unavailable"})).await;
    for params in [
        format!(r#"{{"sshConnectionId":"{CONNECTION}","command":true}}"#),
        format!(r#"{{"sshConnectionId":"{CONNECTION}","command":"first","command":"second"}}"#),
    ] {
        let frames = h
            .raw(format!(
                r#"{{"version":1,"method":"ssh.exec","remaining_ms":60000,"params":{params}}}"#
            ))
            .await;
        assert_eq!(frames.last().unwrap()["code"], "invalid_request");
        assert_eq!(frames.last().unwrap()["delivery"], "not_dispatched");
    }
    resolve.assert_calls_async(0).await;
    let disabled = terminal(&h.request(params()).await).clone();
    assert_eq!(disabled["failure_reason"], "unavailable");
    assert!(disabled.get("diagnostic_text").is_none());
    resolve.assert_calls_async(1).await;
    h.enable_diagnostics().await;
    let enabled = rpc(&h, "ssh.exec", params()).await;
    assert_eq!(enabled["failure_reason"], "unavailable");
    let text = diagnostic_text(&enabled);
    assert!(text.contains(&format!("Connection: {CONNECTION}\n")));
    for section in [
        "Failure:",
        "Evidence:",
        "Unknown:",
        "Next step:",
        "Context:",
    ] {
        assert!(text.contains(section));
    }
    h.shutdown().await;
}

#[tokio::test]
async fn actual_dns_policy_and_tcp_failures_keep_not_reached_stages_and_selected_family() {
    for case in ["dns", "policy", "tcp4", "tcp6"] {
        let mut h = Harness::new(Reply::default()).await;
        h.enable_diagnostics().await;
        let _resolve = h.resolve(h.credential(true)).await;
        match case {
            "dns" => h.network.resolve_failed.store(true, Ordering::SeqCst),
            "policy" => *h.network.answers.lock().unwrap() = vec!["127.0.0.1:22".parse().unwrap()],
            "tcp6" => {
                *h.network.answers.lock().unwrap() =
                    vec!["[2606:4700:4700::1111]:22".parse().unwrap()];
                h.network.connect_failed.store(true, Ordering::SeqCst);
            }
            _ => h.network.connect_failed.store(true, Ordering::SeqCst),
        }
        let result = rpc(&h, "ssh.exec", params()).await;
        let text = diagnostic_text(&result);
        assert_eq!(result["effects"], "not_started");
        assert_stage(text, "authentication", "not_reached");
        match case {
            "dns" => {
                assert_stage(text, "dns", "failed");
                assert_stage(text, "tcp", "not_reached");
                assert!(
                    result["diagnostic_text"]
                        .as_str()
                        .unwrap()
                        .contains("Check destination DNS")
                );
            }
            "policy" => {
                assert_stage(text, "destination_policy", "failed");
                assert_stage(text, "tcp", "not_reached");
            }
            _ => {
                assert_stage(text, "dns", "passed");
                assert_stage(text, "destination_policy", "passed");
                assert_stage(text, "tcp", "failed");
                let family = if case == "tcp6" { "ipv6" } else { "ipv4" };
                assert!(text.contains(&format!("- Address family: {family}.")));
                assert!(
                    result["diagnostic_text"]
                        .as_str()
                        .unwrap()
                        .contains("Check the selected address")
                );
            }
        }
        assert_eq!(h.observed.auth.load(Ordering::SeqCst), 0);
        h.shutdown().await;
    }
}

#[tokio::test]
async fn pooled_transport_retains_selected_address_without_fabricating_new_setup() {
    let mut h = Harness::new(Reply::default()).await;
    h.enable_diagnostics().await;
    let _resolve = h.resolve(h.credential(true)).await;
    rpc(&h, "ssh.exec", params()).await;
    h.observed
        .reject_reused_channels
        .store(true, Ordering::SeqCst);
    let result = rpc(&h, "ssh.exec", params()).await;
    let text = diagnostic_text(&result);
    assert!(text.contains("- Route: direct; transport: reused."));
    assert!(text.contains("- Selected address: 93.184.216.34."));
    assert_stage(text, "authentication", "reused");
    assert_stage(text, "dns", "reused");
    assert_eq!(h.observed.auth.load(Ordering::SeqCst), 1);
    h.shutdown().await;
}

#[tokio::test]
async fn key_decode_rejection_reports_credential_failure_before_network() {
    let mut h = Harness::new(Reply::default()).await;
    h.enable_diagnostics().await;
    let mut credential = h.credential(true);
    credential["privateKey"] = "invalid-key-canary".into();
    let resolve = h.resolve(credential).await;
    let result = rpc(&h, "ssh.exec", params()).await;
    assert_eq!(result["failure_reason"], "unsupported_credential");
    assert_eq!(result["effects"], "not_started");
    let text = diagnostic_text(&result);
    assert!(text.contains(&format!("Configuration: created at {CREATED_AT};")));
    assert!(text.contains("generation 7."));
    assert_stage(text, "authority", "passed");
    assert_stage(text, "credential_preparation", "failed");
    for stage in ["dns", "tcp", "ssh_proof", "ssh_trust", "authentication"] {
        assert_stage(text, stage, "not_reached");
    }
    assert!(h.observed.queries.lock().unwrap().is_empty());
    assert!(h.observed.attempts.lock().unwrap().is_empty());
    assert_eq!(h.observed.auth.load(Ordering::SeqCst), 0);
    assert!(h.observed.commands.lock().unwrap().is_empty());
    assert!(!result.to_string().contains("canary"));
    resolve.assert_calls_async(1).await;
    h.shutdown().await;
}

#[tokio::test]
async fn trust_rejection_precedes_authentication_and_credential_rejection_keeps_proven_trust() {
    use base64::Engine;
    for trust_failure in [true, false] {
        let mut h = Harness::new(Reply::default()).await;
        h.enable_diagnostics().await;
        let mut credential = h.credential(true);
        if trust_failure {
            credential["learnedHostKey"]["fingerprint"] = json!(format!(
                "SHA256:{}",
                base64::engine::general_purpose::STANDARD_NO_PAD.encode([0_u8; 32])
            ));
        } else {
            credential["outcome"] = "resolved_password".into();
            credential["password"] = "wrong-password-canary".into();
            credential.as_object_mut().unwrap().remove("privateKey");
            credential.as_object_mut().unwrap().remove("passphrase");
        }
        let _resolve = h.resolve(credential).await;
        let result = rpc(&h, "ssh.exec", params()).await;
        let text = diagnostic_text(&result);
        assert_eq!(
            result["failure_reason"],
            if trust_failure {
                "host_key_mismatch"
            } else {
                "authentication_failed"
            }
        );
        assert_stage(text, "ssh_proof", "passed");
        assert_stage(
            text,
            "ssh_trust",
            if trust_failure { "failed" } else { "passed" },
        );
        assert_stage(
            text,
            "authentication",
            if trust_failure {
                "not_reached"
            } else {
                "failed"
            },
        );
        assert!(text.contains("generation 7."));
        assert!(
            result["diagnostic_text"]
                .as_str()
                .unwrap()
                .contains(if trust_failure {
                    "Verify the server host key"
                } else {
                    "Check the configured SSH credential"
                })
        );
        assert!(!result.to_string().contains("canary"));
        assert!(h.observed.commands.lock().unwrap().is_empty());
        h.shutdown().await;
    }
}

#[tokio::test]
async fn retained_process_status_uses_its_receipt_after_another_host_failure() {
    let mut h = Harness::new(Reply::Reject).await;
    h.enable_diagnostics().await;
    let _resolve = h.resolve(h.credential(true)).await;
    let started = rpc(
        &h,
        "ssh.session.start",
        json!({"sshConnectionId":CONNECTION,"program":{"type":"exec","command":"hold"}}),
    )
    .await;
    let session = started["session_id"].as_str().unwrap();
    super::sessions::state(&h, &started["session_id"], "failed").await;
    let first = rpc(&h, "ssh.session.status", json!({"sessionId":session})).await;
    assert!(diagnostic_text(&first).contains(&format!("Session: {session}\n")));
    let unrelated = rpc(&h, "ssh.exec", params()).await;
    assert_ne!(diagnostic_attempt(&first), diagnostic_attempt(&unrelated));
    let again = rpc(&h, "ssh.session.status", json!({"sessionId":session})).await;
    assert_eq!(first["diagnostic_text"], again["diagnostic_text"]);
    let read = rpc(
        &h,
        "ssh.session.read",
        json!({"sessionId":session,"cursor":0,"waitMs":30000,"maxBytes":8192,"maxChunks":32}),
    )
    .await;
    assert_eq!(read["session"], first["session"]);
    assert_eq!(read["diagnostic_text"], first["diagnostic_text"]);
    assert_eq!(read["wait_expired"], false);
    h.shutdown().await;
}

#[tokio::test]
async fn binary_file_failure_keeps_file_cause_and_matching_history_text() {
    use runner_rpc_proto::{
        Response,
        stream::{Frame, Reader, Writer},
    };
    use tokio::io::AsyncWriteExt;
    let mut h = Harness::new(Reply::Sftp("normal")).await;
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
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("absent");
    let mut guest = h.open().await;
    let request=json!({"version":1,"method":"ssh.file.download","remaining_ms":900000,"params":{"sshConnectionId":CONNECTION,"remotePath":path}}).to_string();
    guest.write_u32(request.len() as u32).await.unwrap();
    guest.write_all(request.as_bytes()).await.unwrap();
    let (read, write) = tokio::io::split(guest);
    Writer::input(write).send(&Frame::End).await.unwrap();
    let mut reader = Reader::responses(read);
    let mut result = Value::Null;
    while let Some(frame) = reader.next().await.unwrap() {
        if let Frame::Control(Response::Result { data }) = frame {
            result = serde_json::from_str(data.get()).unwrap();
        }
    }
    assert_eq!(result["failure_reason"], "path_not_found");
    assert_eq!(result["effects"], "not_started");
    assert!(diagnostic_text(&result).starts_with("Failure: file path not found during file."));
    let text = diagnostic_text(&result);
    let history = rpc(
        &h,
        "ssh.diagnose",
        json!({"attemptId":diagnostic_attempt(&result)}),
    )
    .await;
    assert_eq!(history["status"], "found");
    assert_eq!(diagnostic_text(&history), text);
    assert_eq!(history["message"], result["diagnostic_text"]);
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    h.shutdown().await;
}

#[tokio::test]
async fn forwarding_failure_retains_actual_channel_stage_and_current_source_identity() {
    let mut h = Harness::new(Reply::default()).await;
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
    h.observed.reject_forwards.store(true, Ordering::SeqCst);
    let result = h
        .ssh()
        .open_direct_tcpip(
            CONNECTION.parse().unwrap(),
            7,
            "desktop.internal",
            5900,
            tokio_util::sync::CancellationToken::new(),
            tokio::time::Instant::now() + std::time::Duration::from_secs(10),
        )
        .await;
    assert!(result.is_err());
    let query = rpc(&h, "ssh.diagnose", json!({})).await;
    let text = diagnostic_text(&query);
    assert!(text.contains("during forwarding."));
    assert!(text.contains(&format!("Configuration: created at {CREATED_AT};")));
    assert!(text.contains("generation 7."));
    assert_stage(text, "authentication", "passed");
    assert_stage(text, "forwarding", "failed");
    h.shutdown().await;
}
