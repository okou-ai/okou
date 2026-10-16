use super::{
    harness::{CONNECTION, CREATED_AT, Harness, Reply, params},
    terminal,
};
use crate::test_fixtures::{diagnostic_report, remote_inventory};
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
fn stage(report: &Value, name: &str) -> Value {
    report["ssh"]["stages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["stage"] == name)
        .unwrap()["status"]
        .clone()
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
        let report = &diagnostic_report(reply);
        assert_eq!(report["connection_id"], id);
        assert!(reply["diagnostic_text"].as_str().unwrap().len() <= 8192);
        assert_eq!(report["configuration_created_at"], CREATED_AT);
        assert_eq!(stage(report, "ssh_proof"), "passed");
        assert_eq!(stage(report, "ssh_trust"), "passed");
        assert_eq!(stage(report, "authentication"), "passed");
        assert_eq!(stage(report, "operation"), "failed");
        let query = rpc(
            &h,
            "ssh.diagnose",
            json!({"attemptId":report["attempt_id"]}),
        )
        .await;
        assert_eq!(&diagnostic_report(&query), report);
    }
    assert_ne!(
        diagnostic_report(&a)["attempt_id"],
        diagnostic_report(&b)["attempt_id"]
    );
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
    assert_eq!(diagnostic_report(&enabled)["connection_id"], CONNECTION);
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
        let report = &diagnostic_report(&result);
        assert_eq!(result["effects"], "not_started");
        assert_eq!(stage(report, "authentication"), "not_reached");
        match case {
            "dns" => {
                assert_eq!(stage(report, "dns"), "failed");
                assert_eq!(stage(report, "tcp"), "not_reached");
                assert!(
                    result["diagnostic_text"]
                        .as_str()
                        .unwrap()
                        .contains("Check destination DNS")
                );
            }
            "policy" => {
                assert_eq!(stage(report, "destination_policy"), "failed");
                assert_eq!(stage(report, "tcp"), "not_reached");
            }
            _ => {
                assert_eq!(stage(report, "dns"), "passed");
                assert_eq!(stage(report, "destination_policy"), "passed");
                assert_eq!(stage(report, "tcp"), "failed");
                assert_eq!(
                    report["ssh"]["address_family"],
                    if case == "tcp6" { "ipv6" } else { "ipv4" }
                );
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
    let report = &diagnostic_report(&result);
    assert_eq!(report["ssh"]["transport"], "reused");
    assert_eq!(report["ssh"]["selected_address"], "93.184.216.34");
    assert_eq!(stage(report, "authentication"), "reused");
    assert_eq!(stage(report, "dns"), "reused");
    assert_eq!(h.observed.auth.load(Ordering::SeqCst), 1);
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
        let report = &diagnostic_report(&result);
        assert_eq!(
            result["failure_reason"],
            if trust_failure {
                "host_key_mismatch"
            } else {
                "authentication_failed"
            }
        );
        assert_eq!(stage(report, "ssh_proof"), "passed");
        assert_eq!(
            stage(report, "ssh_trust"),
            if trust_failure { "failed" } else { "passed" }
        );
        assert_eq!(
            stage(report, "authentication"),
            if trust_failure {
                "not_reached"
            } else {
                "failed"
            }
        );
        assert_eq!(report["configuration_generation"], 7);
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
    assert_eq!(diagnostic_report(&first)["session_id"], session);
    let unrelated = rpc(&h, "ssh.exec", params()).await;
    assert_ne!(
        diagnostic_report(&first)["attempt_id"],
        diagnostic_report(&unrelated)["attempt_id"]
    );
    let again = rpc(&h, "ssh.session.status", json!({"sessionId":session})).await;
    assert_eq!(first["diagnostic_text"], again["diagnostic_text"]);
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
    assert_eq!(
        diagnostic_report(&result)["cause"],
        json!({"source":"file","code":"path_not_found"})
    );
    let report = &diagnostic_report(&result);
    let history = rpc(
        &h,
        "ssh.diagnose",
        json!({"attemptId":report["attempt_id"]}),
    )
    .await;
    assert_eq!(history["status"], "found");
    assert_eq!(diagnostic_report(&history), *report);
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
    let report = &diagnostic_report(&query);
    assert_eq!(report["operation"], "forwarding");
    assert_eq!(report["configuration_created_at"], CREATED_AT);
    assert_eq!(report["configuration_generation"], 7);
    assert_eq!(stage(report, "authentication"), "passed");
    assert_eq!(stage(report, "forwarding"), "failed");
    h.shutdown().await;
}
