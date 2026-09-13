mod admission;
mod cache;
mod credentials;
mod framing;
mod harness;
mod key_wait;
mod lifecycle;
mod observations;
mod passwords;
mod pooling;
mod proof;
mod sessions;
mod telemetry;

use base64::Engine;
use harness::{Harness, Reply, params};
use serde_json::{Value, json};
use std::{
    sync::{Arc, atomic::Ordering},
    time::Duration,
};

fn terminal(frames: &[Value]) -> &Value {
    let frame = frames.last().unwrap();
    assert_eq!(frame["type"], "result", "{frames:?}");
    &frame["data"]
}

fn output(frames: &[Value], stream: &str) -> Vec<u8> {
    frames
        .iter()
        .filter(|frame| {
            frame["type"] == "event"
                && frame["data"]["type"] == "output"
                && frame["data"]["stream"] == stream
        })
        .flat_map(|frame| {
            base64::engine::general_purpose::STANDARD
                .decode(frame["data"]["data"].as_str().unwrap())
                .unwrap()
        })
        .collect()
}

#[tokio::test]
async fn pinned_exec_uses_current_identity_and_preserves_binary_output_and_exit() {
    let mut h = Harness::new(Reply::default()).await;
    let resolve = h.resolve(h.credential(true)).await;
    let frames = h.request(params()).await;
    assert_eq!(
        frames[0],
        json!({"type":"event","data":{"type":"accepted"}})
    );
    assert_eq!(output(&frames, "stdout"), b"hello\0\xff");
    assert_eq!(output(&frames, "stderr"), b"warning\n");
    assert_eq!(terminal(&frames)["type"], "finished");
    assert_eq!(terminal(&frames)["exit"], json!({"type":"status","code":7}));
    assert_eq!(terminal(&frames)["effects"], "completed");
    resolve.assert_calls_async(1).await;
    assert_eq!(
        *h.observed.commands.lock().unwrap(),
        vec![b"printf test-command".to_vec()]
    );
    assert_eq!(
        *h.observed.queries.lock().unwrap(),
        vec![("ssh.example.com.".into(), 22)]
    );
    assert_eq!(
        *h.observed.attempts.lock().unwrap(),
        vec!["93.184.216.34:22".parse::<std::net::SocketAddr>().unwrap()]
    );
    h.shutdown().await;
}

#[tokio::test]
async fn invalid_parameters_and_unknown_method_never_resolve_or_connect() {
    let h = Harness::new(Reply::default()).await;
    let resolve = h.resolve(h.credential(true)).await;
    for params in [
        json!({}),
        json!({"sshConnectionId":"bad","command":"true"}),
        json!({"sshConnectionId":harness::CONNECTION,"command":"true","host":"evil"}),
        json!({"sshConnectionId":harness::CONNECTION,"command":"x".repeat(65537)}),
    ] {
        assert_eq!(
            h.request(params).await,
            vec![json!({"type":"error","code":"invalid_request","delivery":"not_dispatched"})]
        );
    }
    let duplicated = format!(
        r#"{{"version":1,"method":"ssh.exec","remaining_ms":60000,"params":{{"sshConnectionId":"{}","command":"first","command":"second"}}}}"#,
        harness::CONNECTION
    );
    assert_eq!(h.raw(duplicated).await[0]["code"], "invalid_request");
    assert_eq!(
        h.raw(r#"{"version":1,"method":"unknown","params":{}}"#.into())
            .await[0]["code"],
        "unknown_method"
    );
    resolve.assert_calls_async(0).await;
    assert!(h.observed.attempts.lock().unwrap().is_empty());
}

#[tokio::test]
async fn unavailable_old_api_and_malformed_credentials_fail_before_network() {
    let h = Harness::new(Reply::default()).await;
    assert_eq!(
        terminal(&h.request(params()).await)["failure_reason"],
        "authority_failure"
    );
    let unavailable = h.resolve(json!({"outcome":"unavailable"})).await;
    assert_eq!(
        terminal(&h.request(params()).await)["failure_reason"],
        "unavailable"
    );
    unavailable.delete_async().await;
    let mut body = h.credential(true);
    body["privateKey"] = json!("bad-key");
    let _resolve = h.resolve(body).await;
    assert_eq!(
        terminal(&h.request(params()).await)["failure_reason"],
        "unsupported_credential"
    );
    assert!(h.observed.attempts.lock().unwrap().is_empty());
    assert_eq!(h.observed.auth.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn host_key_mismatch_never_authenticates() {
    let h = Harness::new(Reply::default()).await;
    let mut body = h.credential(true);
    body["learnedHostKey"]["fingerprint"] = json!(format!(
        "SHA256:{}",
        base64::engine::general_purpose::STANDARD_NO_PAD.encode([0_u8; 32])
    ));
    let _resolve = h.resolve(body).await;
    let frames = h.request(params()).await;
    assert_eq!(terminal(&frames)["failure_reason"], "host_key_mismatch");
    assert_eq!(terminal(&frames)["effects"], "not_started");
    assert_eq!(h.observed.auth.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn exec_refusal_disconnect_and_missing_status_have_honest_effects() {
    for (reply, reason, effects) in [
        (Reply::Reject, "exec_rejected", "not_started"),
        (Reply::Disconnect, "disconnected", "unknown"),
        (
            Reply::Exit {
                stdout: vec![],
                stderr: vec![],
                fragment: 1,
                code: None,
                signal: None,
            },
            "disconnected",
            "unknown",
        ),
    ] {
        let h = Harness::new(reply).await;
        let _resolve = h.resolve(h.credential(true)).await;
        let frames = h.request(params()).await;
        assert_eq!(terminal(&frames)["failure_reason"], reason);
        assert_eq!(terminal(&frames)["effects"], effects);
        assert_eq!(h.observed.commands.lock().unwrap().len(), 1);
        assert_eq!(h.observed.attempts.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn first_use_requires_current_authority_pin_before_authentication() {
    for (response, expected) in [
        (json!({"outcome":"pinned","generation":8}), "finished"),
        (json!({"outcome":"matched","generation":8}), "finished"),
        (
            json!({"outcome":"pinned","generation":7}),
            "authority_failure",
        ),
        (json!({"outcome":"unavailable"}), "unavailable"),
        (
            json!({"outcome":"configuration_changed"}),
            "configuration_changed",
        ),
        (json!({"outcome":"host_key_mismatch"}), "host_key_mismatch"),
    ] {
        let h = Harness::new(Reply::default()).await;
        let credential = h.credential(false);
        let pin = h.api.mock_async(|when, then| {
            when.method("POST").path(format!("/api/runners/runs/{}/ssh/pin", h.run))
                .header("authorization", format!("Bearer {}", harness::TOKEN))
                .json_body(json!({"connectionId":harness::CONNECTION,"runnerIdentity":{"runnerId":h.identity.runner_id(),"heartbeatGeneration":h.identity.heartbeat_generation()},"expectedGeneration":7,"observedHostKey":{"algorithm":"ssh-ed25519","fingerprint":h.host_key.fingerprint(russh::keys::HashAlg::Sha256).to_string()}}));
            then.status(200).json_body(response);
        }).await;
        let _resolve = h.resolve(credential).await;
        let frames = h.request(params()).await;
        pin.assert_calls_async(1).await;
        if expected == "finished" {
            assert_eq!(terminal(&frames)["type"], "finished");
            assert_eq!(h.observed.auth.load(Ordering::SeqCst), 1);
        } else {
            assert_eq!(terminal(&frames)["failure_reason"], expected);
            assert_eq!(h.observed.auth.load(Ordering::SeqCst), 0);
            assert!(h.observed.commands.lock().unwrap().is_empty());
        }
    }
}

#[tokio::test]
async fn complete_dns_answer_set_is_checked_before_any_connection() {
    let h = Harness::new(Reply::default()).await;
    let _resolve = h.resolve(h.credential(true)).await;
    for answers in [
        vec![],
        vec!["93.184.216.34:22", "127.0.0.1:22"],
        vec!["[::ffff:93.184.216.34]:22"],
        vec!["93.184.216.34:23"],
        vec!["[2606:4700:4700::1111%3]:22"],
        vec!["93.184.216.34:22"; 65],
    ] {
        *h.network.answers.lock().unwrap() = answers
            .into_iter()
            .map(|address| address.parse().unwrap())
            .collect();
        assert_eq!(
            terminal(&h.request(params()).await)["failure_reason"],
            "unsafe_destination"
        );
        assert!(h.observed.attempts.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn canonical_shared_address_policy_is_enforced_at_dispatch() {
    let h = Harness::new(Reply::default()).await;
    let cases: Value = serde_json::from_str(include_str!("../../../../../turbo/packages/connectors/src/__tests__/public-destination-policy-contract.json")).unwrap();
    for case in cases["addressPolicyCases"].as_array().unwrap() {
        let mut credential = h.credential(true);
        credential["host"] = case["address"].clone();
        let resolve = h.resolve(credential).await;
        let frames = h.request(params()).await;
        if case["expectedPublic"] == true {
            assert_eq!(terminal(&frames)["type"], "finished", "{case}: {frames:?}");
        } else {
            assert_eq!(
                terminal(&frames)["failure_reason"],
                "unsafe_destination",
                "{case}: {frames:?}"
            );
        }
        resolve.delete_async().await;
    }
    assert!(h.observed.queries.lock().unwrap().is_empty());
}

#[tokio::test]
async fn cancelled_dns_does_not_block_guest_park_or_the_next_runs_quota() {
    let mut h = Harness::new(Reply::default()).await;
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    *h.network.resolve_gate.lock().unwrap() = Some(Arc::clone(&gate));
    let _resolve = h.resolve(h.credential(true)).await;
    let dispatcher = h.take_dispatcher();
    let (frames, ()) = tokio::join!(h.request(params()), async {
        wait_for(|| !h.observed.queries.lock().unwrap().is_empty()).await;
        assert_eq!(
            h.control.try_fence_normal_operations().err(),
            Some(guest_control_client::NormalOperationFenceRejection::Busy)
        );
        // Shutdown delivers terminal+EOF while its DNS task is still held.
        dispatcher.shutdown().await;
    });
    assert_eq!(terminal(&frames)["failure_reason"], "cancelled");
    assert_eq!(terminal(&frames)["effects"], "not_started");
    drop(h.control.try_fence_normal_operations().unwrap());
    h.restart(crate::ids::RunId::new_v4()).await;
    let mut pending = Vec::new();
    for _ in 0..8 {
        pending.push(h.open().await);
    }
    assert_eq!(
        harness::frames(h.open().await).await[0]["code"],
        "resource_exhausted"
    );
    // Every new-Run slot is usable while old-Run DNS remains held.
    for guest in pending {
        assert_eq!(
            harness::request_frames(
                guest,
                r#"{"version":1,"method":"unknown","params":{}}"#.into()
            )
            .await[0]["code"],
            "unknown_method"
        );
    }
    let fence = h.control.try_fence_normal_operations().unwrap();
    gate.add_permits(1);
    wait_for(|| h.observed.resolved.load(Ordering::SeqCst) == 1).await;
    assert_eq!(h.observed.auth.load(Ordering::SeqCst), 0);
    assert!(h.observed.attempts.lock().unwrap().is_empty());
    assert!(h.observed.commands.lock().unwrap().is_empty());
    drop(fence);
    h.shutdown().await;
}

#[tokio::test]
async fn timeout_after_exec_ack_is_unknown_without_replay() {
    let h = Harness::new(Reply::Hold).await;
    let _resolve = h.resolve(h.credential(true)).await;
    let frames = h
        .raw(
            json!({"version":1,"method":"ssh.exec","remaining_ms":2000,"params":params()})
                .to_string(),
        )
        .await;
    assert_eq!(frames[0]["data"]["type"], "accepted");
    assert_eq!(terminal(&frames)["failure_reason"], "timed_out");
    assert_eq!(terminal(&frames)["effects"], "unknown");
    assert_eq!(h.observed.commands.lock().unwrap().len(), 1);
    assert_eq!(h.observed.attempts.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn full_binary_streams_fit_the_generic_budget_with_independent_truncation() {
    for (fragment, length) in [
        (1, 1024 * 1024 + 1),
        (16384, 1024 * 1024),
        (17001, 1024 * 1024 + 1),
    ] {
        let stdout: Vec<u8> = (0..length).map(|index| index as u8).collect();
        let stderr = vec![0xff; length];
        let h = Harness::new(Reply::Exit {
            stdout: stdout.clone(),
            stderr: stderr.clone(),
            fragment,
            code: Some(0),
            signal: None,
        })
        .await;
        let _resolve = h.resolve(h.credential(true)).await;
        let frames = h.request(params()).await;
        let kept = length.min(1024 * 1024);
        assert_eq!(
            terminal(&frames)["type"],
            "finished",
            "fragment={fragment}: {}",
            terminal(&frames)
        );
        let actual_stdout = output(&frames, "stdout");
        let actual_stderr = output(&frames, "stderr");
        assert_eq!(actual_stdout.len(), kept);
        assert_eq!(actual_stderr.len(), kept);
        assert!(actual_stdout == stdout[..kept]);
        assert!(actual_stderr == stderr[..kept]);
        assert_eq!(terminal(&frames)["stdout_bytes"], kept);
        assert_eq!(terminal(&frames)["stderr_bytes"], kept);
        assert_eq!(terminal(&frames)["stdout_truncated"], length > kept);
        assert_eq!(terminal(&frames)["stderr_truncated"], length > kept);
    }
}

#[tokio::test]
async fn remote_signal_retains_only_allowlisted_name_and_not_peer_diagnostics() {
    for (signal, name) in [
        (russh::Sig::TERM, "TERM"),
        (russh::Sig::Custom("USR2".into()), "USR2"),
        (russh::Sig::Custom("secret-peer-signal".into()), "UNKNOWN"),
    ] {
        let h = Harness::new(Reply::Exit {
            stdout: vec![],
            stderr: vec![],
            fragment: 1,
            code: None,
            signal: Some(signal),
        })
        .await;
        let _resolve = h.resolve(h.credential(true)).await;
        let frames = h.request(params()).await;
        assert_eq!(
            terminal(&frames)["exit"],
            json!({"type":"signal","signal":name,"core_dumped":false})
        );
        let text = serde_json::to_string(&frames).unwrap();
        assert!(!text.contains("secret-peer-signal"));
        assert!(!text.contains("peer diagnostic"));
    }
}

async fn wait_for(predicate: impl Fn() -> bool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !predicate() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}
