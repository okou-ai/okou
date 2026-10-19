use super::{
    harness::{CONNECTION, CREATED_AT, Harness, Reply, params},
    terminal, wait_for,
};
use crate::test_fixtures::{diagnostic_attempt, diagnostic_text, remote_inventory};
use russh::keys::{Algorithm, HashAlg};
use serde_json::{Value, json};
use std::sync::atomic::Ordering;

async fn rpc(h: &Harness, method: &str, params: Value) -> Value {
    terminal(
        &h.raw(
            json!({"version":1,"method":method,"remaining_ms":10000,"params":params}).to_string(),
        )
        .await,
    )
    .clone()
}

#[tokio::test]
async fn active_check_is_fresh_has_no_channels_and_preserves_operational_history() {
    const OTHER: &str = "a90d4e85-16c1-4d29-81ea-3745807481a6";
    let mut h = Harness::new(Reply::default()).await;
    h.enable_checks(&["ssh:read", "ssh:write"]).await;
    let _inventory = h
        .api
        .mock_async(|when, then| {
            when.method("GET").path("/api/ssh/hosts");
            then.status(200)
                .json_body(remote_inventory(&[(CONNECTION, 7), (OTHER, 7)], CREATED_AT));
        })
        .await;
    let bad = h.resolve(json!({"outcome":"unavailable"})).await;
    assert_eq!(
        terminal(&h.request(params()).await)["failure_reason"],
        "unavailable"
    );
    let before = rpc(&h, "ssh.diagnose", json!({})).await;
    bad.delete_async().await;
    let good = h.resolve(h.credential(true)).await;
    // An ordinary command leaves a healthy reusable connection in the pool.
    assert_eq!(terminal(&h.request(params()).await)["type"], "finished");
    let auth_before = h.observed.auth.load(Ordering::SeqCst);
    let result = rpc(&h, "ssh.check", json!({"connectionId":CONNECTION})).await;
    assert_eq!(result["status"], "passed", "{result}");
    assert!(diagnostic_text(&result).contains("Check-owned cleanup: passed."));
    assert_eq!(h.observed.auth.load(Ordering::SeqCst), auth_before + 1);
    assert_eq!(h.observed.commands.lock().unwrap().len(), 1);
    assert!(h.observed.forwards.lock().unwrap().is_empty());
    wait_for(|| h.observed.closed.load(Ordering::SeqCst) > 0).await;
    assert_eq!(rpc(&h, "ssh.diagnose", json!({})).await, before);
    let mut wrong_pin = h.credential(true);
    wrong_pin["learnedHostKey"]["fingerprint"] = super::harness::key(Algorithm::Ed25519)
        .fingerprint(HashAlg::Sha256)
        .to_string()
        .into();
    let _other = h.resolve_connection(OTHER, wrong_pin).await;
    let (passed, failed) = tokio::join!(
        rpc(&h, "ssh.check", json!({"connectionId":CONNECTION})),
        rpc(&h, "ssh.check", json!({"connectionId":OTHER}))
    );
    assert_eq!(passed["status"], "passed", "{passed}");
    assert_eq!(failed["status"], "failed", "{failed}");
    assert!(diagnostic_text(&passed).contains(&format!("Connection: {CONNECTION}\n")));
    assert!(diagnostic_text(&failed).contains(&format!("Connection: {OTHER}\n")));
    assert_ne!(diagnostic_attempt(&passed), diagnostic_attempt(&failed));
    assert!(diagnostic_text(&passed).len() <= 8192 && diagnostic_text(&failed).len() <= 8192);
    assert_eq!(rpc(&h, "ssh.diagnose", json!({})).await, before);
    assert_eq!(h.observed.commands.lock().unwrap().len(), 1);
    let attempts = h.observed.attempts.lock().unwrap().len();
    for receipt in [&passed, &failed] {
        let selected = rpc(
            &h,
            "ssh.diagnose",
            json!({"checks":true,"attemptId":diagnostic_attempt(receipt)}),
        )
        .await;
        assert_eq!(selected["status"], "found");
        assert_eq!(diagnostic_text(&selected), diagnostic_text(receipt));
        assert_eq!(
            rpc(
                &h,
                "ssh.diagnose",
                json!({"attemptId":diagnostic_attempt(receipt)})
            )
            .await["status"],
            "not_retained"
        );
    }
    assert_eq!(
        rpc(
            &h,
            "ssh.diagnose",
            json!({"checks":true,"connectionId":CONNECTION,"attemptId":diagnostic_attempt(&failed)})
        )
        .await["status"],
        "not_retained"
    );
    assert_eq!(
        rpc(
            &h,
            "ssh.diagnose",
            json!({"checks":true,"connectionId":OTHER})
        )
        .await["message"],
        failed["message"]
    );
    assert_eq!(h.observed.attempts.lock().unwrap().len(), attempts);
    good.delete_async().await;
    // Cached authority is invalidated explicitly by the normal path, not by a check.
    h.expire_idle().await;
    h.shutdown().await;
}

#[tokio::test]
async fn active_check_denied_before_target_io_without_feature_or_execution_authority() {
    let mut h = Harness::new(Reply::default()).await;
    let request = || {
        json!({"version":1,"method":"ssh.check","remaining_ms":10000,"params":{"connectionId":CONNECTION}}).to_string()
    };
    assert_eq!(h.raw(request()).await[0]["type"], "error");
    h.enable_checks(&["ssh:read"]).await;
    let resolve = h.resolve(h.credential(true)).await;
    assert_eq!(h.raw(request()).await[0]["type"], "error");
    resolve.assert_calls_async(0).await;
    assert!(h.observed.attempts.lock().unwrap().is_empty());
    h.shutdown().await;
}

#[tokio::test]
async fn active_check_host_key_refusal_is_failed_without_poisoning_history() {
    let mut h = Harness::new(Reply::default()).await;
    h.enable_checks(&["ssh:write"]).await;
    let _inventory = h
        .api
        .mock_async(|when, then| {
            when.method("GET").path("/api/ssh/hosts");
            then.status(200)
                .json_body(remote_inventory(&[(CONNECTION, 7)], CREATED_AT));
        })
        .await;
    let mut credential = h.credential(true);
    credential["learnedHostKey"]["fingerprint"] = super::harness::key(Algorithm::Ed25519)
        .fingerprint(HashAlg::Sha256)
        .to_string()
        .into();
    let _resolve = h.resolve(credential).await;
    let result = rpc(&h, "ssh.check", json!({"connectionId":CONNECTION})).await;
    assert_eq!(result["status"], "failed", "{result}");
    assert!(diagnostic_text(&result).contains("host key"));
    assert_eq!(h.observed.auth.load(Ordering::SeqCst), 0);
    assert!(h.observed.commands.lock().unwrap().is_empty());
    assert_eq!(
        rpc(&h, "ssh.diagnose", json!({})).await["status"],
        "no_failure"
    );
    h.shutdown().await;
}

#[tokio::test]
async fn active_vnc_check_nested_ssh_failure_keeps_an_existing_shell_alive() {
    use super::sessions;
    use crate::{
        test_fixtures::http::{HttpClientConfig, http_client},
        vnc::VncRuntime,
    };
    const VNC: &str = "ec71882f-380f-49d5-bcbd-5d08a76fa412";
    let mut h = Harness::new(Reply::Process).await;
    let mut changed_peer = Harness::new(Reply::default()).await;
    let vnc = VncRuntime::official(
        http_client(HttpClientConfig {
            api_url: h.api.base_url(),
            vercel_bypass: None,
            client_session_id: "check-foreground".into(),
        }),
        super::harness::TOKEN,
        h.identity,
    )
    .unwrap()
    .unwrap();
    h.restart_with_vnc(vnc).await;
    h.enable_checks(&["ssh:read", "ssh:write", "vnc:read", "vnc:write"])
        .await;
    let dispatcher = h.take_dispatcher();
    let _resolve = h.resolve(h.credential(true)).await;
    let observation = h
        .api
        .mock_async(|when, then| {
            when.method("POST")
                .path(format!("/api/runners/runs/{}/ssh/observations", h.run));
            then.status(200).json_body(json!({"outcome":"recorded"}));
        })
        .await;
    let _vnc_resolve = h.api.mock_async(|when,then| {
        when.method("POST").path(format!("/api/runners/runs/{}/vnc/resolve",h.run));
        then.status(200).header("X-VNC-Connection-Created-At",CREATED_AT).json_body(json!({
            "outcome":"resolved_apple_dh","host":"127.0.0.1","port":5900,"generation":11,
            "transport":{"type":"ssh","connectionId":CONNECTION,"generation":7},
            "authentication":{"method":"apple_dh_username_password","username":"user-canary","password":"password-canary"},
            "security":{"type":"apple_dh"}
        }));
    }).await;
    let shell = sessions::start(&h, json!({"type":"shell"}), false).await;
    sessions::state(&h, &shell, "running").await;
    // The old physical session remains connected to the original peer. A new
    // dial sees a changed server key and must fail without revoking that session.
    *h.network.target.lock().unwrap() = *changed_peer.network.target.lock().unwrap();
    let (result, ssh_result) = tokio::join!(
        rpc(&h, "vnc.check", json!({"connectionId":VNC,"mode":"shared"})),
        rpc(&h, "ssh.check", json!({"connectionId":CONNECTION}))
    );
    assert_eq!(result["status"], "failed", "{result}");
    assert!(diagnostic_text(&result).contains("SSH host key mismatch"));
    assert_eq!(
        sessions::rpc(&h, "status", json!({"sessionId":shell})).await["session"]["state"]["type"],
        "running"
    );
    assert_eq!(h.observed.closed.load(Ordering::SeqCst), 0);
    let vnc_inventory = h
        .api
        .mock_async(|when, then| {
            when.method("GET").path("/api/vnc/hosts");
            then.status(200)
                .json_body(remote_inventory(&[(VNC, 11)], CREATED_AT));
        })
        .await;
    let ssh_denied = h
        .api
        .mock_async(|when, then| {
            when.method("GET").path("/api/ssh/hosts");
            then.status(403).body("private-authority-canary");
        })
        .await;
    let selection = json!({"checks":true,"attemptId":diagnostic_attempt(&result)});
    let hidden = rpc(&h, "vnc.diagnose", selection.clone()).await;
    assert_eq!(hidden["status"], "authority_unavailable");
    assert!(!diagnostic_text(&hidden).contains(CONNECTION));
    assert!(!hidden.to_string().contains("private-authority-canary"));
    ssh_denied.delete_async().await;
    let _ssh_inventory = h
        .api
        .mock_async(|when, then| {
            when.method("GET").path("/api/ssh/hosts");
            then.status(200)
                .json_body(remote_inventory(&[(CONNECTION, 7)], CREATED_AT));
        })
        .await;
    let retained = rpc(&h, "vnc.diagnose", selection).await;
    assert_eq!(retained["status"], "found");
    assert_eq!(retained["message"], result["message"]);
    let ssh_retained = rpc(
        &h,
        "ssh.diagnose",
        json!({"checks":true,"attemptId":diagnostic_attempt(&ssh_result)}),
    )
    .await;
    assert_eq!(ssh_retained["status"], "found");
    assert_eq!(ssh_retained["message"], ssh_result["message"]);
    assert_eq!(
        rpc(
            &h,
            "ssh.diagnose",
            json!({"checks":true,"attemptId":diagnostic_attempt(&result)})
        )
        .await["status"],
        "not_retained"
    );
    assert_eq!(
        rpc(
            &h,
            "vnc.diagnose",
            json!({"checks":true,"attemptId":diagnostic_attempt(&ssh_result)})
        )
        .await["status"],
        "not_retained"
    );
    vnc_inventory.assert_calls_async(3).await;
    assert_eq!(h.observed.closed.load(Ordering::SeqCst), 0);
    sessions::rpc(&h, "close", json!({"sessionId":shell})).await;
    dispatcher.shutdown().await.unwrap();
    changed_peer.shutdown().await;
    observation.assert_calls_async(1).await;
}

#[tokio::test]
async fn active_check_full_physical_capacity_is_blocked_and_preserves_foreground_work() {
    use super::{harness::frames, sessions};
    use crate::{
        test_fixtures::http::{HttpClientConfig, http_client},
        vnc::VncRuntime,
    };
    use std::time::Duration;
    use tokio::{io::AsyncWriteExt, time::Instant};
    use tokio_util::sync::CancellationToken;
    let mut h = Harness::new(Reply::Process).await;
    let vnc = VncRuntime::official(
        http_client(HttpClientConfig {
            api_url: h.api.base_url(),
            vercel_bypass: None,
            client_session_id: "check-capacity".into(),
        }),
        super::harness::TOKEN,
        h.identity,
    )
    .unwrap()
    .unwrap();
    h.restart_with_vnc(vnc).await;
    h.enable_checks(&["ssh:write", "vnc:write"]).await;
    let _resolve = h
        .api
        .mock_async(|when, then| {
            when.method("POST")
                .path(format!("/api/runners/runs/{}/ssh/resolve", h.run));
            then.status(200)
                .header("X-SSH-Connection-Created-At", CREATED_AT)
                .json_body(h.credential(true));
        })
        .await;
    // Different subjects leave eight ordinary idle transports without reusing them.
    for _ in 0..8 {
        assert_eq!(
            terminal(
                &h.request(json!({"sshConnectionId":uuid::Uuid::new_v4(),"command":"true"}))
                    .await
            )["type"],
            "finished"
        );
    }
    for _ in 0..8 {
        let session = sessions::start(&h, json!({"type":"shell"}), false).await;
        sessions::state(&h, &session, "running").await;
    }
    let mut forwards = Vec::new();
    for _ in 0..2 {
        let stream = h
            .ssh()
            .open_direct_tcpip(
                CONNECTION.parse().unwrap(),
                7,
                "desktop.internal",
                5900,
                CancellationToken::new(),
                Instant::now() + Duration::from_secs(10),
            )
            .await
            .unwrap();
        forwards.push((stream, h.accept_forwarded().await));
    }
    // Six actual remote processes occupy the remaining physical slots while
    // two RPC admission slots remain available. Shutdown cancels these processes.
    let request = json!({"version":1,"method":"ssh.exec","remaining_ms":60000,
        "params":{"sshConnectionId":CONNECTION,"command":"exec sleep 3600"}})
    .to_string();
    let mut active = Vec::new();
    for _ in 0..6 {
        let mut guest = h.open().await;
        guest.write_u32(request.len() as u32).await.unwrap();
        guest.write_all(request.as_bytes()).await.unwrap();
        guest.shutdown().await.unwrap();
        active.push(guest);
    }
    wait_for(|| h.observed.commands.lock().unwrap().len() == 14).await;
    assert_eq!(h.observed.auth.load(Ordering::SeqCst), 24);
    let result = h
        .raw(
            json!({"version":1,"method":"ssh.check","remaining_ms":2000,
        "params":{"connectionId":CONNECTION}})
            .to_string(),
        )
        .await;
    let result = terminal(&result);
    assert_eq!(result["status"], "blocked", "{result}");
    assert!(diagnostic_text(result).contains("resource exhausted"));
    assert_eq!(h.observed.auth.load(Ordering::SeqCst), 24);
    assert_eq!(h.observed.closed.load(Ordering::SeqCst), 0);
    // Leave one forwarding slot available while filling its freed physical
    // slot with another ordinary RPC. Nested VNC checks must report the same
    // physical boundary even when healthy SSH setup is allowed to be reused.
    drop(forwards.pop());
    wait_for(|| h.observed.closed.load(Ordering::SeqCst) == 1).await;
    let mut guest = h.open().await;
    guest.write_u32(request.len() as u32).await.unwrap();
    guest.write_all(request.as_bytes()).await.unwrap();
    guest.shutdown().await.unwrap();
    active.push(guest);
    wait_for(|| h.observed.commands.lock().unwrap().len() == 15).await;
    let _vnc_resolve=h.api.mock_async(|when,then| {
        when.method("POST").path(format!("/api/runners/runs/{}/vnc/resolve",h.run));
        then.status(200).header("X-VNC-Connection-Created-At",CREATED_AT).json_body(json!({
            "outcome":"resolved_apple_dh","host":"127.0.0.1","port":5900,"generation":11,
            "transport":{"type":"ssh","connectionId":CONNECTION,"generation":7},
            "authentication":{"method":"apple_dh_username_password","username":"user-canary","password":"password-canary"},
            "security":{"type":"apple_dh"}
        }));
    }).await;
    let vnc = rpc(
        &h,
        "vnc.check",
        json!({"connectionId":"ec71882f-380f-49d5-bcbd-5d08a76fa412","mode":"shared"}),
    )
    .await;
    assert_eq!(vnc["status"], "blocked", "{vnc}");
    assert!(diagnostic_text(&vnc).contains("SSH resource exhausted"));
    assert_eq!(h.observed.auth.load(Ordering::SeqCst), 25);
    assert_eq!(h.observed.closed.load(Ordering::SeqCst), 1);
    let listed = sessions::rpc(&h, "list", json!({})).await;
    assert_eq!(listed["sessions"].as_array().unwrap().len(), 8);
    for session in listed["sessions"].as_array().unwrap() {
        assert_eq!(session["state"]["type"], "running");
    }
    drop(forwards);
    h.shutdown().await;
    for guest in active {
        assert_eq!(
            terminal(&frames(guest).await)["failure_reason"],
            "cancelled"
        );
    }
}
