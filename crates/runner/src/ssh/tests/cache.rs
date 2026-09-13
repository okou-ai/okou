use std::{
    sync::{Arc, atomic::Ordering},
    time::Duration,
};

use russh::keys::Algorithm;
use serde_json::{Value, json};

use super::{
    harness::{self, Harness, Reply, params, read_http_request, respond},
    terminal,
};
use crate::ids::RunId;

fn notify(h: &Harness, data: Value) {
    assert!(h.runtime.ably_message(&ably_subscriber::Message {
        name: Some("ssh-authority-invalidated".into()),
        data,
        id: None,
        client_id: None,
        timestamp: None,
    }));
}

#[tokio::test]
async fn run_cache_reuses_transport_but_validates_each_cold_destination() {
    let h = Harness::new(Reply::default()).await;
    h.runtime.ably_connected(true);
    let resolve = h.resolve(h.credential(true)).await;
    assert_eq!(terminal(&h.request(params()).await)["type"], "finished");
    let _cpu = Arc::clone(&h.runtime.cpu)
        .acquire_many_owned(2)
        .await
        .unwrap();
    assert_eq!(terminal(&h.request(params()).await)["type"], "finished");
    *h.network.answers.lock().unwrap() = vec!["127.0.0.1:22".parse().unwrap()];
    h.expire_idle().await;
    assert_eq!(
        terminal(&h.request(params()).await)["failure_reason"],
        "unsafe_destination"
    );
    resolve.assert_calls_async(1).await;
    assert_eq!(h.observed.queries.lock().unwrap().len(), 2);
    assert_eq!(h.observed.commands.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn concurrent_commands_share_one_authority_fill() {
    let h = Harness::new(Reply::default()).await;
    h.runtime.ably_connected(true);
    let resolve = h.resolve(h.credential(true)).await;
    let (first, second) = tokio::join!(h.request(params()), h.request(params()));
    assert_eq!(terminal(&first)["type"], "finished");
    assert_eq!(terminal(&second)["type"], "finished");
    resolve.assert_calls_async(1).await;
    assert_eq!(h.observed.commands.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn cached_pin_still_rejects_a_different_peer_before_authentication() {
    let h = Harness::new(Reply::default()).await;
    let other = Harness::with_keys(
        Reply::default(),
        h.key.clone(),
        harness::key(Algorithm::Ed25519),
    )
    .await;
    h.runtime.ably_connected(true);
    let resolve = h.resolve(h.credential(true)).await;
    assert_eq!(terminal(&h.request(params()).await)["type"], "finished");
    let original = *h.network.target.lock().unwrap();
    *h.network.target.lock().unwrap() = *other.network.target.lock().unwrap();
    h.expire_idle().await;
    assert_eq!(
        terminal(&h.request(params()).await)["failure_reason"],
        "host_key_mismatch"
    );
    assert_eq!(other.observed.auth.load(Ordering::SeqCst), 0);
    assert!(other.observed.commands.lock().unwrap().is_empty());
    resolve.assert_calls_async(1).await;
    *h.network.target.lock().unwrap() = original;
    assert_eq!(terminal(&h.request(params()).await)["type"], "finished");
    resolve.assert_calls_async(2).await;
}

#[tokio::test]
async fn malformed_notifications_cannot_become_run_wide_evictions() {
    let h = Harness::new(Reply::default()).await;
    h.runtime.ably_connected(true);
    let resolve = h.resolve(h.credential(true)).await;
    assert_eq!(terminal(&h.request(params()).await)["type"], "finished");
    for data in [
        json!({"runId": h.run}),
        json!({"runId": h.run, "connectionId": 42}),
        json!({"runId": h.run, "connectionId": "invalid"}),
        json!({"runId": "invalid", "connectionId": null}),
        Value::Null,
    ] {
        notify(&h, data);
        assert_eq!(terminal(&h.request(params()).await)["type"], "finished");
    }
    resolve.assert_calls_async(1).await;
}

#[tokio::test]
async fn confirmed_first_use_pin_is_reused_without_repinning() {
    let h = Harness::new(Reply::default()).await;
    h.runtime.ably_connected(true);
    let resolve = h.resolve(h.credential(false)).await;
    let pin = h
        .api
        .mock_async(|when, then| {
            when.method("POST")
                .path(format!("/api/runners/runs/{}/ssh/pin", h.run))
                .json_body_includes(json!({"expectedGeneration": 7}).to_string());
            then.status(200)
                .json_body(json!({"outcome":"pinned", "generation":8}));
        })
        .await;
    assert_eq!(terminal(&h.request(params()).await)["type"], "finished");
    assert_eq!(terminal(&h.request(params()).await)["type"], "finished");
    resolve.assert_calls_async(1).await;
    pin.assert_calls_async(1).await;
}

#[tokio::test]
async fn targeted_and_run_wide_notifications_evict_without_stale_fallback() {
    for connection in [json!(harness::CONNECTION), Value::Null] {
        let h = Harness::new(Reply::default()).await;
        h.runtime.ably_connected(true);
        let old = h.resolve(h.credential(true)).await;
        assert_eq!(terminal(&h.request(params()).await)["type"], "finished");
        old.delete_async().await;
        let unavailable = h.resolve(json!({"outcome":"unavailable"})).await;
        notify(&h, json!({"runId": RunId::new_v4(), "connectionId": null}));
        notify(
            &h,
            json!({"runId": h.run, "connectionId": uuid::Uuid::new_v4()}),
        );
        // No notification for this entry: its Run-lifetime snapshot is deliberately reusable.
        assert_eq!(terminal(&h.request(params()).await)["type"], "finished");
        unavailable.assert_calls_async(0).await;
        notify(&h, json!({"runId": h.run, "connectionId": connection}));
        assert_eq!(
            terminal(&h.request(params()).await)["failure_reason"],
            "unavailable"
        );
        unavailable.assert_calls_async(1).await;
        assert_eq!(h.observed.commands.lock().unwrap().len(), 2);
        unavailable.delete_async().await;
        assert_eq!(
            terminal(&h.request(params()).await)["failure_reason"],
            "authority_failure"
        );
    }
}

#[tokio::test]
async fn disconnected_requests_bypass_cache_and_recovery_refills_lazily() {
    let h = Harness::new(Reply::default()).await;
    let resolve = h.resolve(h.credential(true)).await;
    for _ in 0..2 {
        assert_eq!(terminal(&h.request(params()).await)["type"], "finished");
    }
    resolve.assert_calls_async(2).await;
    h.runtime.ably_connected(true);
    for _ in 0..2 {
        assert_eq!(terminal(&h.request(params()).await)["type"], "finished");
    }
    resolve.assert_calls_async(3).await;
    h.runtime.ably_connected(false);
    for _ in 0..2 {
        assert_eq!(terminal(&h.request(params()).await)["type"], "finished");
    }
    resolve.assert_calls_async(5).await;
    h.runtime.ably_connected(true);
    for _ in 0..2 {
        assert_eq!(terminal(&h.request(params()).await)["type"], "finished");
    }
    resolve.assert_calls_async(6).await;
}

#[tokio::test]
async fn replacement_registrations_and_later_runs_never_reuse_authority() {
    let mut h = Harness::new(Reply::default()).await;
    h.runtime.ably_connected(true);
    for run in [h.run, h.run, RunId::new_v4()] {
        h.restart(run).await;
        let resolve = h.resolve(h.credential(true)).await;
        assert_eq!(terminal(&h.request(params()).await)["type"], "finished");
        resolve.assert_calls_async(1).await;
        resolve.delete_async().await;
    }
    h.shutdown().await;
}

#[tokio::test]
async fn authentication_failure_evicts_only_the_failed_snapshot_without_replay() {
    let h = Harness::new(Reply::default()).await;
    h.runtime.ably_connected(true);
    let mut wrong = h.credential(true);
    wrong["privateKey"] = json!(
        harness::key(Algorithm::Ed25519)
            .to_openssh(russh::keys::ssh_key::LineEnding::LF)
            .unwrap()
            .as_str()
    );
    let invalid = h.resolve(wrong).await;
    assert_eq!(
        terminal(&h.request(params()).await)["failure_reason"],
        "authentication_failed"
    );
    invalid.assert_calls_async(1).await;
    assert!(h.observed.commands.lock().unwrap().is_empty());
    invalid.delete_async().await;
    let valid = h.resolve(h.credential(true)).await;
    assert_eq!(terminal(&h.request(params()).await)["type"], "finished");
    assert_eq!(terminal(&h.request(params()).await)["type"], "finished");
    valid.assert_calls_async(1).await;
    assert_eq!(h.observed.commands.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn full_retained_cache_bypasses_caching_without_rejecting_commands() {
    let h = Harness::new(Reply::default()).await;
    h.runtime.ably_connected(true);
    let resolve = h
        .api
        .mock_async(|when, then| {
            when.method("POST")
                .path(format!("/api/runners/runs/{}/ssh/resolve", h.run));
            then.status(200).json_body(h.credential(true));
        })
        .await;
    // Populate the documented 256-entry budget through real request dispatch.
    // Destination validation happens after credential preparation on each command.
    *h.network.answers.lock().unwrap() = vec!["127.0.0.1:22".parse().unwrap()];
    for _ in 0..256 {
        let request = json!({"sshConnectionId": uuid::Uuid::new_v4(), "command": "true"});
        assert_eq!(
            terminal(&h.request(request).await)["failure_reason"],
            "unsafe_destination"
        );
    }
    *h.network.answers.lock().unwrap() = vec!["93.184.216.34:22".parse().unwrap()];
    for _ in 0..2 {
        assert_eq!(terminal(&h.request(params()).await)["type"], "finished");
    }
    resolve.assert_calls_async(258).await;
    assert_eq!(h.observed.auth.load(Ordering::SeqCst), 1);
    resolve.delete_async().await;
    let mut credential = h.credential(true);
    credential["generation"] = json!(8);
    let fresh = h.resolve(credential).await;
    // Even without a delivered notice, newly resolved authority cannot reuse an older generation.
    assert_eq!(terminal(&h.request(params()).await)["type"], "finished");
    assert_eq!(h.observed.auth.load(Ordering::SeqCst), 2);
    notify(&h, json!({"runId":h.run, "connectionId":null}));
    for _ in 0..2 {
        assert_eq!(terminal(&h.request(params()).await)["type"], "finished");
    }
    fresh.assert_calls_async(2).await;
    assert_eq!(h.observed.auth.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn invalidation_during_resolve_fences_the_late_result_before_authentication() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let h = Harness::with_api(
        Reply::default(),
        harness::key(Algorithm::Ed25519),
        harness::key(Algorithm::Ed25519),
        Some(format!("http://{}", listener.local_addr().unwrap())),
    )
    .await;
    h.runtime.ably_connected(true);
    let server = async {
        let (mut socket, _) = listener.accept().await.unwrap();
        read_http_request(&mut socket).await;
        notify(
            &h,
            json!({"runId":h.run, "connectionId":harness::CONNECTION}),
        );
        respond(&mut socket, h.credential(true)).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        read_http_request(&mut socket).await;
        respond(&mut socket, json!({"outcome":"unavailable"}))
            .await
            .unwrap();
    };
    let client = async {
        assert_eq!(
            terminal(&h.request(params()).await)["failure_reason"],
            "configuration_changed"
        );
        assert_eq!(
            terminal(&h.request(params()).await)["failure_reason"],
            "unavailable"
        );
    };
    tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(server, client);
    })
    .await
    .unwrap();
    assert_eq!(h.observed.auth.load(Ordering::SeqCst), 0);
    assert!(h.observed.commands.lock().unwrap().is_empty());
}

#[tokio::test]
async fn late_pin_results_cannot_repopulate_or_evict_a_replacement_snapshot() {
    for pin_result in [
        json!({"outcome": "pinned", "generation": 8}),
        json!({"outcome": "configuration_changed"}),
    ] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let h = Harness::with_api(
            Reply::default(),
            harness::key(Algorithm::Ed25519),
            harness::key(Algorithm::Ed25519),
            Some(format!("http://{}", listener.local_addr().unwrap())),
        )
        .await;
        h.runtime.ably_connected(true);
        let server = async {
            let (mut resolve, _) = listener.accept().await.unwrap();
            read_http_request(&mut resolve).await;
            respond(&mut resolve, h.credential(false)).await.unwrap();
            let (mut pin, _) = listener.accept().await.unwrap();
            read_http_request(&mut pin).await;
            notify(
                &h,
                json!({"runId": h.run, "connectionId": harness::CONNECTION}),
            );
            let replacement = async {
                let (mut resolve, _) = listener.accept().await.unwrap();
                read_http_request(&mut resolve).await;
                let mut credential = h.credential(true);
                credential["generation"] = json!(9);
                respond(&mut resolve, credential).await.unwrap();
            };
            let (second, ()) = tokio::join!(h.request(params()), replacement);
            assert_eq!(terminal(&second)["type"], "finished");
            let late = respond(&mut pin, pin_result.clone()).await;
            assert!(
                late.is_ok()
                    || late.is_err_and(|error| matches!(
                        error.kind(),
                        std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset
                    ))
            );
        };
        let ((), first) = tokio::time::timeout(Duration::from_secs(10), async {
            tokio::join!(server, h.request(params()))
        })
        .await
        .unwrap();
        // The invalidated attempt must never authenticate, even if its pin arrives late.
        assert_eq!(terminal(&first)["failure_reason"], "configuration_changed");
        assert_eq!(h.observed.auth.load(Ordering::SeqCst), 1);
        // No further HTTP response is provided: the replacement must still be cached.
        let third = tokio::time::timeout(Duration::from_secs(10), h.request(params()))
            .await
            .unwrap();
        assert_eq!(terminal(&third)["type"], "finished");
        assert_eq!(h.observed.auth.load(Ordering::SeqCst), 1);
    }
}
