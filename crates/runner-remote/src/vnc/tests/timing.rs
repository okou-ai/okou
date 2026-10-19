use super::{
    closed,
    harness::{CONNECTION, CREATED_AT, Harness, bounded},
    mode,
    peer::{Event, StageGate},
};
use crate::test_fixtures::{diagnostic_attempt, diagnostic_text, remote_inventory};
use serde_json::json;
use std::{sync::Arc, time::Duration};
use tokio::sync::Semaphore;

pub(super) fn elapsed(text: &str, stage: &str) -> u64 {
    let rest = text
        .split_once(&format!("- VNC {stage}: "))
        .unwrap_or_else(|| panic!("missing {stage}: {text}"))
        .1;
    rest.lines()
        .nth(1)
        .and_then(|line| line.trim().strip_prefix("Elapsed: "))
        .and_then(|line| line.split_once(" ms").map(|(ms, _)| ms))
        .and_then(|ms| ms.parse().ok())
        .unwrap_or_else(|| panic!("missing {stage} timing: {text}"))
}

async fn advance(ms: u64) {
    tokio::time::pause();
    tokio::time::advance(Duration::from_millis(ms)).await;
    tokio::time::resume();
}

async fn release_after(gate: &StageGate, ms: u64) {
    bounded(gate.reached.cancelled()).await;
    advance(ms).await;
    gate.release.add_permits(1);
}

async fn inventory(h: &Harness) -> httpmock::Mock<'_> {
    h.api
        .mock_async(|when, then| {
            when.method("GET").path("/api/vnc/hosts");
            then.status(200)
                .json_body(remote_inventory(&[(CONNECTION, 7)], CREATED_AT));
        })
        .await
}

#[tokio::test]
async fn setup_and_capture_times_are_attributed_and_history_remains_frozen() {
    let mut h = Harness::new().await;
    h.run.enable_diagnostics(&h.runtime).await;
    let _resolve = h.resolve().await;
    let _authority = h.check("valid", 200).await;
    let _inventory = inventory(&h).await;
    let auth = StageGate::new();
    let init = StageGate::new();
    *h.peer.setup.authentication.lock().await = Some(Arc::clone(&auth));
    *h.peer.setup.initialization.lock().await = Some(Arc::clone(&init));
    let (started, ()) = tokio::join!(h.start("shared"), async {
        release_after(&auth, 210).await;
        release_after(&init, 340).await;
    });
    let session = started.session();
    mode(&h, 1).await;
    // Session idle time must never become capture time or enlarge reused setup.
    advance(5000).await;
    *h.peer.capture_gate.lock().await = Some(Arc::new(Semaphore::new(0)));
    let request = h.run.raw(
        json!({"version":1,"method":"vnc.capture","remaining_ms":2000,"params":{"sessionId":session}})
            .to_string(),
    );
    let (failed, ()) = tokio::join!(request, async {
        assert!(matches!(h.peer.event().await, Event::Capture));
        advance(1100).await;
    });
    let text = diagnostic_text(failed.result());
    assert_eq!(failed.result()["reason"], "timed_out");
    assert!(text.contains("VNC authentication: reused."), "{text}");
    assert!(
        text.contains(
            "Reused timing describes original setup; those stages were not checked again."
        )
    );
    assert!(
        (210..5000).contains(&elapsed(text, "authentication")),
        "{text}"
    );
    assert!(
        (340..5000).contains(&elapsed(text, "initialization")),
        "{text}"
    );
    assert!((1000..5000).contains(&elapsed(text, "capture")), "{text}");
    assert!(text.contains("VNC capture: unknown."), "{text}");
    assert!(text.len() <= 8192);
    let before = h.run.passive("vnc.diagnose", json!({})).await;
    assert_eq!(diagnostic_text(&before), text);
    advance(20_000).await;
    let after = h
        .run
        .passive(
            "vnc.diagnose",
            json!({"attemptId":diagnostic_attempt(&before)}),
        )
        .await;
    assert_eq!(before, after);
    closed(&h).await;
    h.run.shutdown().await;
}

#[tokio::test]
async fn authentication_timeout_times_only_observed_work_and_does_not_recheck_history() {
    let mut h = Harness::new().await;
    h.run.enable_diagnostics(&h.runtime).await;
    let _resolve = h.resolve().await;
    let _inventory = inventory(&h).await;
    let gate = StageGate::new();
    *h.peer.setup.authentication.lock().await = Some(Arc::clone(&gate));
    let request = h.run.raw(
        json!({"version":1,"method":"vnc.session.start","remaining_ms":2000,"params":{"connectionId":CONNECTION,"mode":"shared"}})
            .to_string(),
    );
    let (failed, ()) = tokio::join!(request, async {
        bounded(gate.reached.cancelled()).await;
        advance(1100).await;
    });
    let text = diagnostic_text(failed.result());
    assert!(text.contains("VNC authentication: unknown."), "{text}");
    assert!(
        (1000..2000).contains(&elapsed(text, "authentication")),
        "{text}"
    );
    assert!(text.contains("VNC initialization: not reached.\n- VNC authority recheck:"));
    let attempts = h.network.attempts.lock().unwrap().len();
    advance(5000).await;
    assert_eq!(
        diagnostic_text(&h.run.passive("vnc.diagnose", json!({})).await),
        text
    );
    assert_eq!(h.network.attempts.lock().unwrap().len(), attempts);
    gate.release.add_permits(1);
    h.run.shutdown().await;
}

#[tokio::test]
async fn active_check_retains_fresh_setup_and_its_own_retirement_time() {
    let mut h = Harness::new().await;
    h.run.enable_checks(&h.runtime, &["vnc:write"]).await;
    let _resolve = h.resolve().await;
    let _authority = h.check("valid", 200).await;
    let gate = StageGate::new();
    *h.peer.setup.initialization.lock().await = Some(Arc::clone(&gate));
    let (checked, ()) = tokio::join!(
        h.run
            .active_check(json!({"connectionId":CONNECTION,"mode":"shared"})),
        release_after(&gate, 260),
    );
    assert_eq!(checked["status"], "passed", "{checked}");
    let text = diagnostic_text(&checked);
    assert!(elapsed(text, "initialization") >= 260, "{text}");
    assert!(text.contains("VNC authentication: passed."));
    assert!(text.contains("VNC retirement: passed.\n  Elapsed:"));
    assert!(!text.contains("Reused timing"));
    assert!(text.len() <= 8192);
    mode(&h, 1).await;
    closed(&h).await;
    h.run.shutdown().await;
}

#[tokio::test]
async fn disabled_diagnostics_do_not_add_timing_or_prevent_ordinary_failure() {
    let mut h = Harness::new().await;
    let _resolve = h.resolve().await;
    h.peer
        .refuse
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let gate = StageGate::new();
    *h.peer.setup.authentication.lock().await = Some(Arc::clone(&gate));
    let (failed, ()) = tokio::join!(h.start("shared"), release_after(&gate, 240));
    assert_eq!(
        failed.result(),
        &json!({"outcome":"failed","reason":"authentication_failed"})
    );
    assert_eq!(
        h.run.passive("vnc.diagnose", json!({})).await["status"],
        "unavailable"
    );
    h.run.shutdown().await;
}

// A live pending report and native-watch handoff are pipeline owner boundaries;
// ordinary RPC terminals instead finish pending stages as failed/unknown.
#[tokio::test(start_paused = true)]
async fn pending_report_and_native_watch_freeze_at_their_own_capture_boundaries() {
    use crate::diagnostics::{
        Handle, Identity, NativeEvidence, NativeSource, Operation, Protocol, Record,
    };
    use crate::vnc::evidence::{Snapshot, Stage};
    use runner_types::ids::RunId;
    use std::sync::atomic::AtomicBool;
    use tracing_subscriber::prelude::*;
    use tracing_test_support::CapturedEvents;
    use uuid::Uuid;

    let events = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(events.clone());
    let _subscriber = tracing::subscriber::set_default(subscriber);
    let handle = Handle::new(RunId::new_v4(), true);
    let connection = Uuid::new_v4();
    let mut vnc = Snapshot::default();
    vnc.begin(Stage::Authentication);
    tokio::time::advance(Duration::from_millis(170)).await;
    let captured = handle
        .record(Record {
            effects: None,
            protocol: Protocol::Vnc,
            connection,
            operation: Operation::Start,
            identity: Identity::default(),
            cause: Some(crate::diagnostics::Cause::Vnc(
                super::super::Failure::TimedOut,
            )),
            dependency: None,
            native: None,
            ssh: None,
            vnc: Some(vnc.clone()),
        })
        .unwrap();
    let original = captured.message().unwrap();
    assert!(original.contains("VNC authentication: pending.\n  Elapsed: 170 ms."));
    assert!(original.contains("VNC initialization: not reached.\n- VNC authority recheck:"));

    let evidence = Arc::new(NativeEvidence::new());
    let source = NativeSource {
        configuration_id: Uuid::new_v4(),
        generation: 7,
        resource_id: evidence.resource_id,
        evidence: Arc::clone(&evidence),
        connection: None,
    };
    let active = Arc::new(AtomicBool::new(true));
    evidence.observe(
        handle
            .watch_vnc(connection, Identity::default(), &source, None, &active)
            .unwrap()
            .with_vnc(Some(vnc.clone()), None),
    );
    tokio::time::advance(Duration::from_secs(20)).await;
    evidence.terminate(crate::tailscale::Failure::DomainFailed);
    // Retained JSON is the diagnostic logger's public evidence contract. The
    // native event publishes its captured context after the long source wait.
    let native = events
        .entries()
        .into_iter()
        .filter(|event| {
            event.fields.get("message").map(String::as_str)
                == Some("Remote operation failure retained")
        })
        .map(|event| {
            serde_json::from_str::<serde_json::Value>(&event.fields["diagnostic"]).unwrap()
        })
        .find(|report| report["operation"] == "native")
        .unwrap();
    let stages = native["vnc"]["steps"].as_array().unwrap();
    let auth = stages
        .iter()
        .find(|step| step["stage"] == "authentication")
        .unwrap();
    assert_eq!(auth["status"], "unknown");
    assert_eq!(auth["elapsed_ms"], 170);
    let init = stages
        .iter()
        .find(|step| step["stage"] == "initialization")
        .unwrap();
    assert_eq!(init["status"], "unknown");
    assert!(init.get("elapsed_ms").is_none());
    vnc.begin(Stage::Initialization);
    tokio::time::advance(Duration::from_secs(30)).await;
    assert_eq!(captured.message().unwrap(), original);
}
