use std::{
    sync::{Arc, atomic::Ordering},
    time::Duration,
};

use base64::Engine;
use serde_json::{Value, json};
use tokio::time::{Instant, timeout};

use super::{
    harness::{self, AdditionalRun, CONNECTION, Harness, Reply},
    wait_for,
};

#[tokio::test]
async fn lost_start_and_read_replies_do_not_kill_the_session_or_hold_guest_park() {
    use tokio::io::AsyncWriteExt;
    let mut h = Harness::new(Reply::Hold).await;
    h.runtime.ably_connected(true);
    let _resolve = h.resolve(h.credential(true)).await;
    let mut guest = h.open().await;
    let request = envelope(
        "start",
        json!({"sshConnectionId":CONNECTION,"program":{"type":"exec","command":"hold"}}),
    );
    guest.write_u32(request.len() as u32).await.unwrap();
    guest.write_all(request.as_bytes()).await.unwrap();
    drop(guest);
    wait_for(|| h.observed.commands.lock().unwrap().len() == 1).await;
    let listed = rpc(&h, "list", json!({})).await;
    let id = listed["sessions"][0]["session_id"].clone();
    state(&h, &id, "running").await;
    let mut guest = h.open().await;
    let request = envelope("read", json!({"sessionId":id,"cursor":0}));
    guest.write_u32(request.len() as u32).await.unwrap();
    guest.write_all(request.as_bytes()).await.unwrap();
    drop(guest);
    wait_for(|| h.observed.reservations.load(Ordering::SeqCst) == 0).await;
    drop(h.control.try_fence_normal_operations().unwrap());
    state(&h, &id, "running").await;
    assert_eq!(h.observed.commands.lock().unwrap().len(), 1);
    h.shutdown().await;
}

#[tokio::test]
async fn backpressured_input_does_not_block_output_and_timeout_never_replays_partial_input() {
    let mut h = Harness::new(Reply::BlockedInput).await;
    h.runtime.ably_connected(true);
    let _resolve = h.resolve(h.credential(true)).await;
    let id = start(&h, json!({"type":"exec","command":"hold"}), false).await;
    state(&h, &id, "running").await;
    let request = json!({"version":1,"method":"ssh.session.write","remaining_ms":3000,
        "params":{"sessionId":id,"dataBase64":base64::engine::general_purpose::STANDARD.encode(vec![b'x';16384])}}).to_string();
    let (frames, ()) = tokio::join!(h.raw(request), async {
        wait_for(|| !h.observed.input.lock().unwrap().is_empty()).await;
        timeout(Duration::from_secs(5), async {
            loop {
                let read = rpc(&h, "read", json!({"sessionId":id,"cursor":0})).await;
                if !bytes(&read).is_empty() {
                    assert_eq!(bytes(&read), b"output during blocked input");
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    });
    assert_eq!(frames[0]["data"]["failure_reason"], "timed_out");
    assert_eq!(frames[0]["data"]["effects"], "unknown");
    assert_eq!(*h.observed.input.lock().unwrap(), b"x");
    let status = state(&h, &id, "failed").await;
    // RPC deadline reporting can retire its scope before the stdin actor polls
    // the same deadline. Either terminal cause closes the partial write.
    assert!(
        ["timed_out", "cancelled"].contains(&status["state"]["failure_reason"].as_str().unwrap())
    );
    assert_eq!(status["effects"], "unknown");
    drop(h.control.try_fence_normal_operations().unwrap());
    h.shutdown().await;
}

#[tokio::test]
async fn malformed_session_requests_are_rejected_before_authority_or_network() {
    let h = Harness::new(Reply::Hold).await;
    h.runtime.ably_connected(true);
    let resolve = h.resolve(h.credential(true)).await;
    for (method, params) in [
        (
            "start",
            json!({"sshConnectionId":CONNECTION,"program":{"type":"exec","command":""}}),
        ),
        (
            "start",
            json!({"sshConnectionId":CONNECTION.replace('-', ""),"program":{"type":"shell"}}),
        ),
        (
            "start",
            json!({"sshConnectionId":CONNECTION,"program":{"type":"shell","command":"extra"}}),
        ),
        (
            "start",
            json!({"sshConnectionId":CONNECTION,"program":{"type":"shell"},"host":"attacker"}),
        ),
        ("read", json!({"sessionId":CONNECTION,"cursor":-1})),
        ("write", json!({"sessionId":CONNECTION,"dataBase64":"YQ"})),
        (
            "write",
            json!({"sessionId":CONNECTION,"dataBase64":base64::engine::general_purpose::STANDARD.encode(vec![0;16385])}),
        ),
        ("write", json!({"sessionId":CONNECTION})),
        ("signal", json!({"sessionId":CONNECTION,"signal":"CUSTOM"})),
        ("list", json!({"runId":"other"})),
    ] {
        let frames = h.raw(envelope(method, params)).await;
        assert_eq!(frames[0]["code"], "invalid_request", "{frames:?}");
        assert_eq!(frames[0]["delivery"], "not_dispatched");
    }
    resolve.assert_calls_async(0).await;
    assert!(h.observed.attempts.lock().unwrap().is_empty());
}
#[tokio::test]
async fn signal_submission_and_observed_signal_exit_are_separate_outcomes() {
    for signal in ["TERM", "KILL", "HUP", "INT", "USR1", "USR2"] {
        let mut h = Harness::new(Reply::Process).await;
        h.runtime.ably_connected(true);
        let _resolve = h.resolve(h.credential(true)).await;
        let id = start(
            &h,
            json!({"type":"exec","command":"exec /bin/sleep 600"}),
            false,
        )
        .await;
        state(&h, &id, "running").await;
        assert_eq!(
            rpc(&h, "signal", json!({"sessionId":id,"signal":signal})).await["effects"],
            "unknown"
        );
        let status = state(&h, &id, "finished").await;
        assert_eq!(status["effects"], "completed");
        assert_eq!(
            status["state"]["exit"],
            json!({"type":"signal","signal":signal,"core_dumped":false})
        );
        h.shutdown().await;
    }
}

fn envelope(method: &str, params: Value) -> String {
    json!({"version":1,"method":format!("ssh.session.{method}"),"remaining_ms":60000,"params":params}).to_string()
}

pub(super) async fn rpc(h: &Harness, method: &str, params: Value) -> Value {
    let frames = h.raw(envelope(method, params)).await;
    assert_eq!(frames.len(), 1, "{frames:?}");
    assert_eq!(frames[0]["type"], "result", "{frames:?}");
    frames[0]["data"].clone()
}

pub(super) async fn start(h: &Harness, program: Value, pty: bool) -> Value {
    let result = rpc(
        h,
        "start",
        json!({"sshConnectionId":CONNECTION,"program":program,"pty":pty}),
    )
    .await;
    assert_eq!(result["type"], "started", "{result}");
    result["session_id"].clone()
}

pub(super) async fn state(h: &Harness, id: &Value, expected: &str) -> Value {
    timeout(Duration::from_secs(10), async {
        loop {
            let result = rpc(h, "status", json!({"sessionId":id})).await;
            assert_eq!(result["type"], "status", "{result}");
            if result["session"]["state"]["type"] == expected {
                return result["session"].clone();
            }
            assert_ne!(result["session"]["state"]["type"], "failed", "{result}");
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap()
}

pub(super) async fn write(h: &Harness, id: &Value, text: &str, eof: bool) {
    let result = rpc(h, "write", json!({"sessionId":id,"dataBase64":base64::engine::general_purpose::STANDARD.encode(text),"eof":eof})).await;
    assert_eq!(result["type"], "submitted", "{result}");
    assert_eq!(result["effects"], "unknown");
}

pub(super) fn bytes(read: &Value) -> Vec<u8> {
    read["chunks"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|chunk| {
            base64::engine::general_purpose::STANDARD
                .decode(chunk["data"].as_str().unwrap())
                .unwrap()
        })
        .collect()
}

#[tokio::test]
async fn shell_keeps_cwd_environment_and_stdin_across_short_requests() {
    let mut h = Harness::new(Reply::Process).await;
    h.runtime.ably_connected(true);
    let _resolve = h.resolve(h.credential(true)).await;
    let id = start(&h, json!({"type":"shell"}), false).await;
    state(&h, &id, "running").await;
    write(&h, &id, "cd /; export SESSION_VALUE=retained\n", false).await;
    write(
        &h,
        &id,
        "printf '%s:%s' \"$PWD\" \"$SESSION_VALUE\"; printf warning >&2; exit 7\n",
        true,
    )
    .await;
    let status = state(&h, &id, "finished").await;
    assert_eq!(status["state"]["exit"], json!({"type":"status","code":7}));
    assert_eq!(status["stdin_closed"], true);
    let read = rpc(&h, "read", json!({"sessionId":id,"cursor":0})).await;
    let text = String::from_utf8(bytes(&read)).unwrap();
    assert!(text.contains("/:retained"), "{text}");
    assert!(text.contains("warning"), "{text}");
    assert_eq!(
        read,
        rpc(&h, "read", json!({"sessionId":id,"cursor":0})).await
    );
    assert_eq!(
        rpc(&h, "list", json!({})).await["sessions"][0]["session_id"],
        id
    );
    drop(h.control.try_fence_normal_operations().unwrap());
    h.shutdown().await;
}

#[tokio::test]
async fn a_real_pty_is_explicit_and_refusal_never_sends_the_program() {
    let h = Harness::new(Reply::Process).await;
    h.runtime.ably_connected(true);
    let _resolve = h.resolve(h.credential(true)).await;
    let id = start(
        &h,
        json!({"type":"exec","command":"test -t 0 && printf terminal"}),
        true,
    )
    .await;
    assert_eq!(state(&h, &id, "finished").await["state"]["exit"]["code"], 0);
    assert!(
        String::from_utf8(bytes(
            &rpc(&h, "read", json!({"sessionId":id,"cursor":0})).await
        ))
        .unwrap()
        .contains("terminal")
    );
    assert_eq!(h.observed.ptys.load(Ordering::SeqCst), 1);
    let h = Harness::new(Reply::Hold).await;
    h.runtime.ably_connected(true);
    let _resolve = h.resolve(h.credential(true)).await;
    let id = start(&h, json!({"type":"shell"}), true).await;
    let status = state(&h, &id, "failed").await;
    assert_eq!(status["state"]["failure_reason"], "exec_rejected");
    assert_eq!(status["effects"], "not_started");
    assert!(h.observed.commands.lock().unwrap().is_empty());
}

#[tokio::test]
async fn quiet_command_survives_the_one_shot_deadline_and_peer_rekey() {
    let mut h = Harness::new(Reply::Process).await;
    h.runtime.ably_connected(true);
    let _resolve = h.resolve(h.credential(true)).await;
    let first = h
        .request(json!({"sshConnectionId":CONNECTION,"command":"true"}))
        .await;
    assert_eq!(super::terminal(&first)["type"], "finished");
    let began = Instant::now();
    let id = start(
        &h,
        json!({"type":"exec","command":"sleep 61; printf done"}),
        false,
    )
    .await;
    state(&h, &id, "running").await;
    // This real duration is the contract under test, not a synchronization delay.
    tokio::time::sleep(Duration::from_secs(61)).await;
    assert_eq!(state(&h, &id, "finished").await["state"]["exit"]["code"], 0);
    assert!(began.elapsed() > Duration::from_secs(60));
    assert_eq!(h.observed.auth.load(Ordering::SeqCst), 1);
    assert_eq!(
        bytes(&rpc(&h, "read", json!({"sessionId":id,"cursor":0})).await),
        b"done"
    );
    h.shutdown().await;
}

#[tokio::test]
async fn eight_retained_sessions_do_not_occupy_short_request_slots_or_park_leases() {
    let mut h = Harness::new(Reply::default()).await;
    h.runtime.ably_connected(true);
    let _resolve = h.resolve(h.credential(true)).await;
    let mut ids = Vec::new();
    for _ in 0..8 {
        let id = start(&h, json!({"type":"exec","command":"true"}), false).await;
        state(&h, &id, "finished").await;
        ids.push(id);
    }
    assert_eq!(
        rpc(
            &h,
            "start",
            json!({"sshConnectionId":CONNECTION,"program":{"type":"shell"}})
        )
        .await["failure_reason"],
        "resource_exhausted"
    );
    assert_eq!(
        rpc(&h, "list", json!({})).await["sessions"]
            .as_array()
            .unwrap()
            .len(),
        8
    );
    drop(h.control.try_fence_normal_operations().unwrap());
    assert_eq!(
        rpc(&h, "close", json!({"sessionId":ids[0]})).await["effects"],
        "completed"
    );
    let _ = start(&h, json!({"type":"exec","command":"true"}), false).await;
    let other = AdditionalRun::new(&h.runtime, "other").await;
    let frames = harness::request_frames(
        other.open().await,
        envelope("status", json!({"sessionId":ids[1]})),
    )
    .await;
    assert_eq!(frames[0]["data"]["failure_reason"], "unavailable");
    other.shutdown().await;
    h.shutdown().await;
}

#[tokio::test]
async fn output_loss_is_explicit_bounded_and_cursor_reads_make_progress() {
    let total = 1024 * 1024 + 8192;
    let h = Harness::new(Reply::Exit {
        stdout: vec![0xff; total],
        stderr: vec![],
        fragment: 16384,
        code: Some(0),
        signal: None,
    })
    .await;
    h.runtime.ably_connected(true);
    let _resolve = h.resolve(h.credential(true)).await;
    let id = start(&h, json!({"type":"exec","command":"true"}), false).await;
    let status = state(&h, &id, "finished").await;
    assert_eq!(status["end_cursor"], total);
    assert!(status["oldest_cursor"].as_u64().unwrap() >= 8192);
    let first = rpc(&h, "read", json!({"sessionId":id,"cursor":0})).await;
    assert_eq!(first["lost"]["from"], 0);
    assert_eq!(first["lost"]["to"], status["oldest_cursor"]);
    assert_eq!(bytes(&first), vec![0xff; 8192]);
    let next = rpc(
        &h,
        "read",
        json!({"sessionId":id,"cursor":first["next_cursor"]}),
    )
    .await;
    assert!(next.get("lost").is_none());
    assert_eq!(bytes(&next), vec![0xff; 8192]);
    let invalid = h
        .raw(envelope("read", json!({"sessionId":id,"cursor":total+1})))
        .await;
    assert_eq!(invalid[0]["code"], "invalid_request");
}

#[tokio::test]
async fn invalidation_disconnect_and_replacement_retire_existing_ids() {
    let mut h = Harness::new(Reply::Hold).await;
    h.runtime.ably_connected(true);
    let _resolve = h.resolve(h.credential(true)).await;
    let id = start(&h, json!({"type":"exec","command":"hold"}), false).await;
    state(&h, &id, "running").await;
    h.runtime.ably_message(&ably_subscriber::Message {
        name: Some("ssh-authority-invalidated".into()),
        data: json!({"runId":h.run,"connectionId":CONNECTION}),
        id: None,
        client_id: None,
        timestamp: None,
    });
    assert_eq!(
        rpc(&h, "status", json!({"sessionId":id})).await["failure_reason"],
        "unavailable"
    );
    let id = start(&h, json!({"type":"exec","command":"hold"}), false).await;
    state(&h, &id, "running").await;
    h.runtime.ably_connected(false);
    assert_eq!(rpc(&h, "list", json!({})).await["sessions"], json!([]));
    assert_eq!(
        rpc(
            &h,
            "start",
            json!({"sshConnectionId":CONNECTION,"program":{"type":"shell"}})
        )
        .await["failure_reason"],
        "unavailable"
    );
    h.runtime.ably_connected(true);
    let id = start(&h, json!({"type":"exec","command":"hold"}), false).await;
    state(&h, &id, "running").await;
    h.restart(crate::ids::RunId::new_v4()).await;
    assert_eq!(
        rpc(&h, "status", json!({"sessionId":id})).await["failure_reason"],
        "unavailable"
    );
    h.shutdown().await;
}

#[tokio::test]
async fn failed_async_preparation_remains_inspectable_and_cpu_wait_does_not_keep_guest_busy() {
    let mut h = Harness::new(Reply::Hold).await;
    h.runtime.ably_connected(true);
    let mut credential = h.credential(true);
    credential["privateKey"] = json!("not a key");
    let _resolve = h.resolve(credential).await;
    let cpu = Arc::clone(&h.runtime.cpu)
        .acquire_many_owned(2)
        .await
        .unwrap();
    let id = start(&h, json!({"type":"exec","command":"never"}), false).await;
    wait_for(|| h.observed.reservations.load(Ordering::SeqCst) == 0).await;
    drop(h.control.try_fence_normal_operations().unwrap());
    drop(cpu);
    let status = state(&h, &id, "failed").await;
    assert_eq!(status["effects"], "not_started");
    assert_eq!(status["state"]["failure_reason"], "unsupported_credential");
    assert!(h.observed.attempts.lock().unwrap().is_empty());
    h.shutdown().await;
}

#[tokio::test]
async fn eof_signal_and_close_report_submission_without_claiming_remote_termination() {
    let mut h = Harness::new(Reply::Hold).await;
    h.runtime.ably_connected(true);
    let _resolve = h.resolve(h.credential(true)).await;
    let id = start(&h, json!({"type":"exec","command":"hold"}), false).await;
    state(&h, &id, "running").await;
    write(&h, &id, "", true).await;
    assert_eq!(
        rpc(&h, "write", json!({"sessionId":id,"dataBase64":"YQ=="})).await["reason"],
        "stdin_closed"
    );
    assert_eq!(
        rpc(&h, "signal", json!({"sessionId":id,"signal":"TERM"})).await["effects"],
        "unknown"
    );
    wait_for(|| h.observed.signals.load(Ordering::SeqCst) == 1).await;
    assert_eq!(
        rpc(&h, "close", json!({"sessionId":id})).await["effects"],
        "unknown"
    );
    assert_eq!(
        rpc(&h, "status", json!({"sessionId":id})).await["failure_reason"],
        "unavailable"
    );
    h.shutdown().await;
}

#[tokio::test]
async fn credential_cache_saturation_does_not_create_a_global_session_cap() {
    let mut h = Harness::new(Reply::Hold).await;
    h.runtime.ably_connected(true);
    let mut registrations = Vec::new();
    for _ in 0..256 {
        let registration = h.runtime.cache.register(crate::ids::RunId::new_v4());
        let _access = registration.lookup(uuid::Uuid::new_v4()).unwrap();
        registrations.push(registration);
    }
    let _resolve = h.resolve(h.credential(true)).await;
    let id = start(&h, json!({"type":"exec","command":"hold"}), false).await;
    state(&h, &id, "running").await;
    h.runtime.ably_message(&ably_subscriber::Message {
        name: Some("ssh-authority-invalidated".into()),
        data: json!({"runId":h.run,"connectionId":CONNECTION}),
        id: None,
        client_id: None,
        timestamp: None,
    });
    assert_eq!(
        rpc(&h, "status", json!({"sessionId":id})).await["failure_reason"],
        "unavailable"
    );
    h.shutdown().await;
    drop(registrations);
}

#[tokio::test]
async fn completed_records_expire_and_cannot_be_reattached() {
    let mut h = Harness::new(Reply::default()).await;
    h.runtime.ably_connected(true);
    let _resolve = h.resolve(h.credential(true)).await;
    let id = start(&h, json!({"type":"exec","command":"true"}), false).await;
    state(&h, &id, "finished").await;
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(301)).await;
    tokio::time::resume();
    assert_eq!(rpc(&h, "list", json!({})).await["sessions"], json!([]));
    assert_eq!(
        rpc(&h, "status", json!({"sessionId":id})).await["failure_reason"],
        "unavailable"
    );
    h.shutdown().await;
}
