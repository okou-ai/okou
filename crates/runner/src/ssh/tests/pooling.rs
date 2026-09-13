use std::{
    sync::atomic::Ordering,
    time::{Duration, Instant},
};

use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;

use super::{
    harness::{CONNECTION, Harness, Reply, params},
    output,
    sessions::{bytes, rpc, start, state, write},
    terminal, wait_for,
};

fn command(text: &str) -> Value {
    json!({"sshConnectionId": CONNECTION, "command": text})
}

#[tokio::test]
async fn sequential_exec_reuses_authentication_with_independent_cwd_environment_and_stdin() {
    let mut h = Harness::new(Reply::Process).await;
    h.runtime.ably_connected(true);
    let resolve = h.resolve(h.credential(true)).await;
    let first = h
        .request(command("cd /; export POOL_TEST_STATE=first; printf first"))
        .await;
    assert_eq!(output(&first, "stdout"), b"first");
    assert_eq!(terminal(&first)["exit"]["code"], 0);
    let second = h
        .request(command(
            "printf '%s|' \"${POOL_TEST_STATE-unset}\"; pwd; cat",
        ))
        .await;
    assert_eq!(
        output(&second, "stdout"),
        format!("unset|{}\n", std::env::current_dir().unwrap().display()).as_bytes()
    );
    assert_eq!(terminal(&second)["exit"]["code"], 0);
    assert_eq!(h.observed.attempts.lock().unwrap().len(), 1);
    assert_eq!(h.observed.auth.load(Ordering::SeqCst), 1);
    resolve.assert_calls_async(1).await;
    h.shutdown().await;
    wait_for(|| h.observed.closed.load(Ordering::SeqCst) == 1).await;
}

#[tokio::test]
async fn completed_shell_and_pty_reuse_transport_without_inheriting_channel_state() {
    let mut h = Harness::new(Reply::Process).await;
    h.runtime.ably_connected(true);
    let _resolve = h.resolve(h.credential(true)).await;
    let id = start(&h, json!({"type":"shell"}), false).await;
    state(&h, &id, "running").await;
    write(&h, &id, "cd /; export POOL_TEST_STATE=old; exit 0\n", false).await;
    state(&h, &id, "finished").await;
    let plain = h
        .request(command("printf '%s|' \"${POOL_TEST_STATE-unset}\"; pwd"))
        .await;
    assert_eq!(
        output(&plain, "stdout"),
        format!("unset|{}\n", std::env::current_dir().unwrap().display()).as_bytes()
    );
    let pty = start(&h, json!({"type":"exec", "command":"test -t 0"}), true).await;
    assert_eq!(
        state(&h, &pty, "finished").await["state"]["exit"]["code"],
        0
    );
    let plain = h.request(command("test -t 0")).await;
    assert_eq!(terminal(&plain)["exit"]["code"], 1);
    assert_eq!(h.observed.attempts.lock().unwrap().len(), 1);
    assert_eq!(h.observed.auth.load(Ordering::SeqCst), 1);
    h.shutdown().await;
}

#[tokio::test]
async fn idle_transport_occupies_neither_guest_park_nor_short_request_capacity() {
    let mut h = Harness::new(Reply::default()).await;
    h.runtime.ably_connected(true);
    let _resolve = h.resolve(h.credential(true)).await;
    for _ in 0..12 {
        assert_eq!(terminal(&h.request(params()).await)["type"], "finished");
    }
    assert_eq!(h.observed.auth.load(Ordering::SeqCst), 1);
    drop(h.control.try_fence_normal_operations().unwrap());
    let mut pending = Vec::new();
    for _ in 0..8 {
        pending.push(h.open().await);
    }
    assert_eq!(
        super::harness::frames(h.open().await).await[0]["code"],
        "resource_exhausted"
    );
    h.shutdown().await;
    for guest in pending {
        assert!(super::harness::frames(guest).await.is_empty());
    }
    drop(h.control.try_fence_normal_operations().unwrap());
    wait_for(|| h.observed.closed.load(Ordering::SeqCst) == 1).await;
}

#[tokio::test]
async fn cancelling_one_active_session_preserves_the_other_and_its_reusable_connection() {
    let mut h = Harness::new(Reply::Process).await;
    h.runtime.ably_connected(true);
    let _resolve = h.resolve(h.credential(true)).await;
    let first = start(&h, json!({"type":"shell"}), false).await;
    state(&h, &first, "running").await;
    let second = start(&h, json!({"type":"shell"}), false).await;
    state(&h, &second, "running").await;
    assert_eq!(h.observed.attempts.lock().unwrap().len(), 2);
    assert_eq!(
        rpc(&h, "close", json!({"sessionId":first})).await["type"],
        "closed"
    );
    wait_for(|| h.observed.closed.load(Ordering::SeqCst) == 1).await;
    write(&h, &second, "printf live; exit 0\n", false).await;
    state(&h, &second, "finished").await;
    assert_eq!(
        bytes(&rpc(&h, "read", json!({"sessionId":second,"cursor":0})).await),
        b"live"
    );
    assert_eq!(
        output(&h.request(command("printf next")).await, "stdout"),
        b"next"
    );
    assert_eq!(h.observed.auth.load(Ordering::SeqCst), 2);
    h.shutdown().await;
}

#[tokio::test]
async fn a_stalled_guest_output_consumer_does_not_block_another_process() {
    let mut h = Harness::new(Reply::Process).await;
    h.runtime.ably_connected(true);
    let _resolve = h.resolve(h.credential(true)).await;
    let mut stalled = h.open().await;
    let request = json!({"version":1,"method":"ssh.exec","remaining_ms":60000,
        "params":command("head -c 2097152 /dev/zero")})
    .to_string();
    stalled.write_u32(request.len() as u32).await.unwrap();
    stalled.write_all(request.as_bytes()).await.unwrap();
    stalled.shutdown().await.unwrap();
    wait_for(|| h.observed.commands.lock().unwrap().len() == 1).await;
    let other = tokio::time::timeout(
        Duration::from_secs(10),
        h.request(command("printf independent")),
    )
    .await
    .unwrap();
    assert_eq!(output(&other, "stdout"), b"independent");
    assert_eq!(terminal(&other)["exit"]["code"], 0);
    assert_eq!(h.observed.attempts.lock().unwrap().len(), 2);
    drop(stalled);
    h.shutdown().await;
    drop(h.control.try_fence_normal_operations().unwrap());
}

#[tokio::test]
async fn invalidation_retires_active_and_idle_connections_before_fresh_work() {
    let mut h = Harness::new(Reply::Process).await;
    h.runtime.ably_connected(true);
    let old = h.resolve(h.credential(true)).await;
    let active = start(&h, json!({"type":"shell"}), false).await;
    state(&h, &active, "running").await;
    assert_eq!(
        terminal(&h.request(command("true")).await)["type"],
        "finished"
    );
    assert!(h.runtime.ably_message(&ably_subscriber::Message {
        name: Some("ssh-authority-invalidated".into()),
        data: json!({"runId":h.run,"connectionId":CONNECTION}),
        id: None,
        client_id: None,
        timestamp: None,
    }));
    wait_for(|| h.observed.closed.load(Ordering::SeqCst) == 2).await;
    assert_eq!(
        rpc(&h, "status", json!({"sessionId":active})).await["failure_reason"],
        "unavailable"
    );
    old.delete_async().await;
    let mut credential = h.credential(true);
    credential["generation"] = json!(8);
    let fresh = h.resolve(credential).await;
    assert_eq!(
        output(&h.request(command("printf fresh")).await, "stdout"),
        b"fresh"
    );
    fresh.assert_calls_async(1).await;
    assert_eq!(h.observed.auth.load(Ordering::SeqCst), 3);
    h.shutdown().await;
}

#[tokio::test]
async fn idle_expiry_closes_the_socket_without_waiting_for_another_request() {
    let mut h = Harness::new(Reply::default()).await;
    h.runtime.ably_connected(true);
    let _resolve = h.resolve(h.credential(true)).await;
    rpc(&h, "list", json!({})).await;
    // Offset idle expiry from the dispatcher's periodic cleanup ticks.
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(10)).await;
    tokio::time::resume();
    assert_eq!(terminal(&h.request(params()).await)["type"], "finished");
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(51)).await;
    tokio::time::resume();
    // Drain the already-due periodic cleanup while this connection is still healthy.
    rpc(&h, "list", json!({})).await;
    assert_eq!(h.observed.closed.load(Ordering::SeqCst), 0);
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(10)).await;
    tokio::time::resume();
    // No guest request or periodic tick follows expiry; the transport timer must close it.
    wait_for(|| h.observed.closed.load(Ordering::SeqCst) == 1).await;
    assert_eq!(terminal(&h.request(params()).await)["type"], "finished");
    assert_eq!(h.observed.auth.load(Ordering::SeqCst), 2);
    h.shutdown().await;
}

#[tokio::test]
async fn reuse_renews_idle_expiry_and_active_work_survives_earlier_idle_deadlines() {
    let mut h = Harness::new(Reply::Process).await;
    h.runtime.ably_connected(true);
    let _resolve = h.resolve(h.credential(true)).await;
    assert_eq!(
        terminal(&h.request(command("true")).await)["type"],
        "finished"
    );

    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(50)).await;
    tokio::time::resume();
    assert_eq!(
        output(&h.request(command("printf renewed")).await, "stdout"),
        b"renewed"
    );
    assert_eq!(h.observed.auth.load(Ordering::SeqCst), 1);

    // Cross the first idle period's deadline while the renewed period is current.
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(15)).await;
    tokio::time::resume();
    let active = start(&h, json!({"type":"shell"}), false).await;
    state(&h, &active, "running").await;
    assert_eq!(h.observed.auth.load(Ordering::SeqCst), 1);

    // Cross the renewed idle deadline after checkout. Only Run/session limits apply now.
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(61)).await;
    tokio::time::resume();
    write(&h, &active, "printf live; exit 0\n", false).await;
    assert_eq!(
        state(&h, &active, "finished").await["state"]["exit"]["code"],
        0
    );
    assert_eq!(
        bytes(&rpc(&h, "read", json!({"sessionId":active,"cursor":0})).await),
        b"live"
    );
    assert_eq!(h.observed.auth.load(Ordering::SeqCst), 1);
    assert_eq!(h.observed.closed.load(Ordering::SeqCst), 0);
    h.shutdown().await;
    wait_for(|| h.observed.closed.load(Ordering::SeqCst) == 1).await;
}

#[tokio::test]
async fn idle_cache_evicts_the_oldest_connection_and_never_matches_only_an_endpoint() {
    let mut h = Harness::new(Reply::default()).await;
    h.runtime.ably_connected(true);
    let _resolve = h
        .api
        .mock_async(|when, then| {
            when.method("POST")
                .path(format!("/api/runners/runs/{}/ssh/resolve", h.run));
            then.status(200).json_body(h.credential(true));
        })
        .await;
    let ids: Vec<_> = (0..9).map(|_| uuid::Uuid::new_v4()).collect();
    for id in &ids {
        assert_eq!(
            terminal(
                &h.request(json!({"sshConnectionId":id,"command":"true"}))
                    .await
            )["type"],
            "finished"
        );
    }
    assert_eq!(h.observed.auth.load(Ordering::SeqCst), 9);
    wait_for(|| h.observed.closed.load(Ordering::SeqCst) >= 1).await;
    assert_eq!(
        terminal(
            &h.request(json!({"sshConnectionId":ids[8],"command":"true"}))
                .await
        )["type"],
        "finished"
    );
    assert_eq!(h.observed.auth.load(Ordering::SeqCst), 9);
    assert_eq!(
        terminal(
            &h.request(json!({"sshConnectionId":ids[0],"command":"true"}))
                .await
        )["type"],
        "finished"
    );
    assert_eq!(h.observed.auth.load(Ordering::SeqCst), 10);
    h.shutdown().await;
}

#[tokio::test]
async fn run_replacement_cannot_reuse_an_earlier_registration_transport() {
    let mut h = Harness::new(Reply::default()).await;
    h.runtime.ably_connected(true);
    let old = h.resolve(h.credential(true)).await;
    assert_eq!(terminal(&h.request(params()).await)["type"], "finished");
    old.delete_async().await;
    h.restart(h.run).await;
    wait_for(|| h.observed.closed.load(Ordering::SeqCst) == 1).await;
    let fresh = h.resolve(h.credential(true)).await;
    assert_eq!(terminal(&h.request(params()).await)["type"], "finished");
    fresh.assert_calls_async(1).await;
    assert_eq!(h.observed.auth.load(Ordering::SeqCst), 2);
    h.shutdown().await;
}

#[tokio::test]
async fn refused_reused_channel_fails_without_replay_and_a_later_request_connects_fresh() {
    let mut h = Harness::new(Reply::default()).await;
    h.runtime.ably_connected(true);
    h.observed
        .reject_reused_channels
        .store(true, Ordering::SeqCst);
    let _resolve = h.resolve(h.credential(true)).await;
    assert_eq!(terminal(&h.request(params()).await)["type"], "finished");

    let refused = h.request(params()).await;
    assert_eq!(terminal(&refused)["failure_reason"], "protocol");
    assert_eq!(terminal(&refused)["effects"], "not_started");
    assert_eq!(h.observed.auth.load(Ordering::SeqCst), 1);
    assert_eq!(h.observed.commands.lock().unwrap().len(), 1);

    assert_eq!(terminal(&h.request(params()).await)["type"], "finished");
    assert_eq!(h.observed.auth.load(Ordering::SeqCst), 2);
    assert_eq!(h.observed.commands.lock().unwrap().len(), 2);
    h.shutdown().await;
}

#[tokio::test]
async fn rejected_disconnected_and_missing_exit_channels_are_never_reused_or_replayed() {
    for reply in [
        Reply::Reject,
        Reply::Disconnect,
        Reply::Exit {
            stdout: Vec::new(),
            stderr: Vec::new(),
            fragment: 1,
            code: None,
            signal: None,
        },
    ] {
        let mut h = Harness::new(reply).await;
        h.runtime.ably_connected(true);
        let _resolve = h.resolve(h.credential(true)).await;
        for _ in 0..2 {
            assert_eq!(terminal(&h.request(params()).await)["type"], "failed");
        }
        assert_eq!(h.observed.auth.load(Ordering::SeqCst), 2);
        assert_eq!(h.observed.commands.lock().unwrap().len(), 2);
        h.shutdown().await;
    }
}

#[tokio::test]
async fn eight_idle_transports_do_not_reduce_active_session_or_exec_admission() {
    let mut h = Harness::new(Reply::Process).await;
    h.runtime.ably_connected(true);
    let _resolve = h
        .api
        .mock_async(|when, then| {
            when.method("POST")
                .path(format!("/api/runners/runs/{}/ssh/resolve", h.run));
            then.status(200).json_body(h.credential(true));
        })
        .await;
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
        let id = start(&h, json!({"type":"shell"}), false).await;
        state(&h, &id, "running").await;
    }
    let request = json!({"version":1,"method":"ssh.exec","remaining_ms":60000,
        "params":command("exec sleep 3600")})
    .to_string();
    let mut active = Vec::new();
    for _ in 0..8 {
        let mut guest = h.open().await;
        guest.write_u32(request.len() as u32).await.unwrap();
        guest.write_all(request.as_bytes()).await.unwrap();
        guest.shutdown().await.unwrap();
        active.push(guest);
    }
    wait_for(|| h.observed.commands.lock().unwrap().len() == 16).await;
    assert_eq!(h.observed.auth.load(Ordering::SeqCst), 24);
    assert_eq!(
        super::harness::frames(h.open().await).await[0]["code"],
        "resource_exhausted"
    );
    h.shutdown().await;
    for guest in active {
        assert_eq!(
            super::terminal(&super::harness::frames(guest).await)["failure_reason"],
            "cancelled"
        );
    }
    drop(h.control.try_fence_normal_operations().unwrap());
}

#[tokio::test]
#[ignore = "manual real-peer cold/warm measurement; no timing threshold"]
async fn measure_cold_and_warm_repeated_exec() {
    let mut h = Harness::new(Reply::Process).await;
    h.runtime.ably_connected(true);
    let _resolve = h.resolve(h.credential(true)).await;
    assert_eq!(
        terminal(&h.request(command("true")).await)["exit"]["code"],
        0
    );
    h.expire_idle().await;
    let mut measurements = Vec::new();
    for cold in [true, false] {
        if !cold {
            assert_eq!(
                terminal(&h.request(command("true")).await)["exit"]["code"],
                0
            );
        }
        let before = h.observed.auth.load(Ordering::SeqCst);
        let connections_before = h.observed.attempts.lock().unwrap().len();
        let mut samples = Vec::new();
        for _ in 0..10 {
            let begin = Instant::now();
            assert_eq!(
                terminal(&h.request(command("true")).await)["exit"]["code"],
                0
            );
            samples.push(begin.elapsed().as_secs_f64() * 1000.0);
            if cold {
                h.expire_idle().await;
            }
        }
        let authentications = h.observed.auth.load(Ordering::SeqCst) - before;
        let connections = h.observed.attempts.lock().unwrap().len() - connections_before;
        assert_eq!(authentications, if cold { 10 } else { 0 });
        assert_eq!(connections, authentications);
        samples.sort_by(f64::total_cmp);
        measurements.push(
            json!({"mode":if cold {"cold"} else {"warm"}, "samples":samples.len(),
            "median_ms":(samples[4]+samples[5])/2.0,"min_ms":samples[0],"max_ms":samples[9],
            "connections":connections,"authentications":authentications}),
        );
    }
    println!("SSH_REUSE_MEASUREMENT {}", json!(measurements));
    h.shutdown().await;
}
