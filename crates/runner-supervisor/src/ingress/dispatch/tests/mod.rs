//! Dispatch intake preserves admission capacity and retry ownership.

use super::*;
use crate::home_image_cache::HomeImageCache;
use runner_host::paths::RunnerPaths;
use runner_lifecycle::{
    active_runs::ActiveRuns, home_image_cache::snapshot::HomeCacheStateSnapshot,
    idle_pool::IdlePool, lifecycle::RunnerMode,
};
use serde_json::json;
use tokio::sync::{Mutex as AsyncMutex, Notify, oneshot};
use tokio::task::JoinHandle;

fn body(identity: RunnerProcessIdentity, run_id: RunId, not_after: u64) -> String {
    json!({
        "runnerId": identity.runner_id(), "heartbeatGeneration": identity.heartbeat_generation(),
        "profile": "vm0/default", "notAfter": not_after,
        "executionContext": {"runId":run_id,"prompt":"hello","sandboxToken":"run-token","firewallToken":"firewall-token","cliAgentType":"","platformEnvironment":{},"connectorRuntimeTargets":[],"contentBundles":{"format":"tar-gzip-v1","skills":[]}}
    }).to_string()
}

fn submit(
    intake: &Arc<DispatchIntake>,
    identity: RunnerProcessIdentity,
    run_id: RunId,
    bytes: String,
    now: u64,
) -> JoinHandle<Disposition> {
    let intake = intake.clone();
    tokio::spawn(async move {
        let permit = intake.try_reserve().unwrap();
        intake
            .submit(identity, run_id, bytes.as_bytes(), permit, now)
            .await
    })
}

fn preferred_probe(cache: HomeImageCache, mode: watch::Receiver<RunnerMode>) -> PreferredHomeProbe {
    PreferredHomeProbe::new(
        cache,
        HomeCacheStateSnapshot::new(),
        [("vm0/default".to_owned(), 1)].into(),
        ActiveRuns::new(Arc::new(Notify::new())),
        Arc::new(AsyncMutex::new(IdlePool::new(Default::default()))),
        None,
        mode,
    )
}

fn preferred_body(identity: RunnerProcessIdentity, run_id: RunId, source: RunId) -> String {
    let mut preferred: serde_json::Value =
        serde_json::from_str(&body(identity, run_id, 2_000)).unwrap();
    preferred["executionContext"]["reuseKey"] = json!("thread:preferred-admission");
    preferred["preferredHomeCheckout"] = json!({
        "predecessorRunId": source,
        "waitUntil": 1_500,
    });
    preferred.to_string()
}

#[test]
fn ordinary_dispatch_can_take_the_only_admission_slot_during_a_home_probe() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .start_paused(true)
        .max_blocking_threads(1)
        .build()
        .unwrap();
    runtime.block_on(async {
        let root = tempfile::tempdir().unwrap();
        let cache = HomeImageCache::new(RunnerPaths::new(root.path().to_path_buf()));
        let (_mode, mode) = watch::channel(RunnerMode::Running);
        let probe = preferred_probe(cache, mode);
        let (intake, mut receiver) = DispatchIntake::new(Arc::new(Semaphore::new(1)), Some(probe));

        // Occupy the single blocking worker so the real probe stays pending.
        let (started, waiting) = oneshot::channel();
        let (release, released) = oneshot::channel();
        let worker = tokio::task::spawn_blocking(move || {
            started.send(()).unwrap();
            let _ = released.blocking_recv();
        });
        waiting.await.unwrap();

        let identity = RunnerProcessIdentity::new(uuid::Uuid::new_v4(), 1).unwrap();
        let preferred_id = RunId::new_v4();
        let preferred = preferred_body(identity, preferred_id, RunId::new_v4());
        let mut pending = Box::pin(intake.submit(
            identity,
            preferred_id,
            preferred.as_bytes(),
            intake.try_reserve().unwrap(),
            1_000,
        ));
        assert!(futures_util::poll!(pending.as_mut()).is_pending());
        assert!(receiver.try_recv().is_err(), "probing must precede custody");

        let ordinary_id = RunId::new_v4();
        let ordinary = body(identity, ordinary_id, 2_000);
        let ordinary_permit = intake.try_reserve().expect("probe released the slot");
        let ordinary = intake.submit(
            identity,
            ordinary_id,
            ordinary.as_bytes(),
            ordinary_permit,
            1_000,
        );
        tokio::pin!(ordinary);
        assert!(futures_util::poll!(ordinary.as_mut()).is_pending());
        let work = receiver
            .try_recv()
            .expect("ordinary work entered admission");
        assert_eq!(work.context.as_ref().unwrap().run_id, ordinary_id);
        work.settle(Disposition::Accepted);
        drop(work);
        assert_eq!(ordinary.await, Disposition::Accepted);

        release.send(()).unwrap();
        worker.await.unwrap();
        let work = tokio::select! {
            work = receiver.recv() => work.expect("preferred work entered admission"),
            result = &mut pending => panic!("preferred dispatch finished before admission: {result:?}"),
        };
        assert_eq!(work.context.as_ref().unwrap().run_id, preferred_id);
        work.settle(Disposition::Accepted);
        assert_eq!(pending.await, Disposition::Accepted);
    });
}

#[tokio::test]
async fn same_bytes_are_admitted_at_preference_expiry_while_home_is_still_locked() {
    use crate::home_image_cache::{HomeImageLeaseIdentity, HomeImageLeaseRequest};
    use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;

    let root = tempfile::tempdir().unwrap();
    let cache = HomeImageCache::new(RunnerPaths::new(root.path().to_path_buf()));
    let source = RunId::new_v4();
    let lease = cache
        .lease_active(HomeImageLeaseRequest {
            identity: HomeImageLeaseIdentity {
                run_id: source,
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: "vm0/default",
                rootfs_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                reuse_key: Some("thread:preferred-admission"),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: 1024 * 1024,
            },
            home_drive_available: true,
        })
        .await;
    let (_mode, mode) = watch::channel(RunnerMode::Running);
    let (intake, mut receiver) = DispatchIntake::new(
        Arc::new(Semaphore::new(1)),
        Some(preferred_probe(cache, mode)),
    );
    let intake = Arc::new(intake);
    let identity = RunnerProcessIdentity::new(uuid::Uuid::new_v4(), 1).unwrap();
    let run_id = RunId::new_v4();
    let body = preferred_body(identity, run_id, source);

    let mut first = submit(&intake, identity, run_id, body.clone(), 1_000);
    tokio::select! {
        result = &mut first => assert_eq!(result.unwrap(), Disposition::Busy),
        _ = receiver.recv() => panic!("contended offer took custody before expiry"),
    }

    // Advance only the request clock. The original Home lock stays held.
    let mut retry = submit(&intake, identity, run_id, body, 1_500);
    let work = tokio::select! {
        work = receiver.recv() => work.expect("same-byte retry entered admission"),
        result = &mut retry => panic!("same-byte retry finished before admission: {result:?}"),
    };
    assert_eq!(work.context.as_ref().unwrap().run_id, run_id);
    assert_eq!(work.preferred_home_source, Some(source));
    work.settle(Disposition::Accepted);
    assert_eq!(retry.await.unwrap(), Disposition::Accepted);
    drop(lease);
}

#[tokio::test]
async fn idle_listener_releases_expired_history_on_its_own_tick() {
    use crate::ingress::IngressRuntime;
    use crate::ingress::test_support::{HOST, TOKEN};
    use crate::ingress::tests::{dispatch_request, namespace, request};
    use std::time::Duration;

    let (_root, directory) = namespace();
    let identity = RunnerProcessIdentity::new(uuid::Uuid::new_v4(), 1).unwrap();
    let runtime = IngressRuntime::start(directory.clone(), identity, HOST.into(), TOKEN)
        .await
        .unwrap();
    let (intake, mut receiver) = DispatchIntake::new(Arc::new(Semaphore::new(4)), None);
    runtime.enable_dispatch(intake);
    let socket = directory.join(format!("{}.sock", identity.runner_id()));
    let run_id = RunId::new_v4();
    let deadline = now_ms() + 60_000;
    let bytes = body(identity, run_id, deadline);
    let wire = dispatch_request(identity, run_id, &bytes);
    let sending = tokio::spawn(async move { request(&socket, &wire).await });
    let work = tokio::time::timeout(Duration::from_secs(5), receiver.recv())
        .await
        .unwrap()
        .unwrap();
    work.settle(Disposition::Accepted);
    drop(work);
    let response = sending.await.unwrap();
    assert_eq!(response.0, 200);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&response.1).unwrap()["disposition"],
        "accepted"
    );

    let intake = runtime.handler.dispatch.get().unwrap();
    let mut retained = intake
        .records
        .lock()
        .unwrap()
        .get(&run_id)
        .unwrap()
        .verdict
        .subscribe();
    // Advance only the receiver's observed wall time, without invoking cleanup.
    // The completed HTTP round trip proves the listener and its timer are armed.
    intake.observe_time(deadline);
    assert!(retained.has_changed().is_ok());
    raw_http_test_support::clock::advance_timer_phase(Duration::from_secs(1)).await;
    tokio::time::timeout(Duration::from_secs(5), retained.changed())
        .await
        .expect("idle listener must reclaim expired history on its periodic tick")
        .expect_err("the expired record's final verdict sender must be released");
    runtime.shutdown().await;
}

#[tokio::test]
async fn original_window_replays_then_reclaims_settled_history_without_closing_new_intake() {
    let identity = RunnerProcessIdentity::new(uuid::Uuid::new_v4(), 1).unwrap();
    let (intake, mut receiver) = DispatchIntake::new(Arc::new(Semaphore::new(4)), None);
    let intake = Arc::new(intake);
    let mut originals = Vec::new();
    for verdict in [Disposition::Accepted, Disposition::Rejected] {
        let run_id = RunId::new_v4();
        let bytes = body(identity, run_id, 2_000);
        let submitted = submit(&intake, identity, run_id, bytes.clone(), 1_000);
        let work = receiver.recv().await.unwrap();
        work.settle(verdict);
        drop(work);
        assert_eq!(submitted.await.unwrap(), verdict);
        intake.expire(u64::MAX);
        assert_eq!(
            submit(&intake, identity, run_id, bytes.clone(), u64::MAX)
                .await
                .unwrap(),
            Disposition::Unknown
        );
        assert_eq!(
            submit(&intake, identity, run_id, bytes.clone(), 1_001)
                .await
                .unwrap(),
            verdict
        );
        assert_eq!(
            submit(
                &intake,
                identity,
                run_id,
                body(identity, run_id, 3_000),
                1_001
            )
            .await
            .unwrap(),
            Disposition::Conflict,
            "a renewed deadline cannot replace the original delivery"
        );
        originals.push((run_id, bytes));
    }
    intake.expire(1_999);
    assert_eq!(intake.records.lock().unwrap().len(), 2);
    intake.expire(2_000);
    assert!(
        intake.records.lock().unwrap().is_empty(),
        "expired metadata must be released"
    );
    for (run_id, bytes) in originals {
        for now in [2_000, 1_000] {
            assert_eq!(
                submit(&intake, identity, run_id, bytes.clone(), now)
                    .await
                    .unwrap(),
                Disposition::Unknown,
                "expiry stays irreversible even if an older clock observation arrives"
            );
        }
    }
    assert!(receiver.try_recv().is_err());
    let fresh = RunId::new_v4();
    let submitted = submit(
        &intake,
        identity,
        fresh,
        body(identity, fresh, 3_000),
        2_000,
    );
    let work = receiver.recv().await.unwrap();
    work.settle(Disposition::Accepted);
    drop(work);
    assert_eq!(submitted.await.unwrap(), Disposition::Accepted);
}

#[tokio::test]
async fn owner_loss_is_unknown_and_never_reopens_original_input_after_expiry() {
    let identity = RunnerProcessIdentity::new(uuid::Uuid::new_v4(), 1).unwrap();
    let (intake, mut receiver) = DispatchIntake::new(Arc::new(Semaphore::new(4)), None);
    let intake = Arc::new(intake);
    let run_id = RunId::new_v4();
    let bytes = body(identity, run_id, 2_000);
    let submitted = submit(&intake, identity, run_id, bytes.clone(), 1_000);
    drop(receiver.recv().await.unwrap());
    assert_eq!(submitted.await.unwrap(), Disposition::Unknown);
    assert_eq!(
        submit(&intake, identity, run_id, bytes.clone(), 1_001)
            .await
            .unwrap(),
        Disposition::Unknown
    );
    intake.expire(2_000);
    assert!(intake.records.lock().unwrap().is_empty());
    assert_eq!(
        submit(&intake, identity, run_id, bytes, 2_000)
            .await
            .unwrap(),
        Disposition::Unknown
    );
    assert!(receiver.try_recv().is_err());
}

#[tokio::test]
async fn history_expiry_does_not_drop_owned_admission_or_its_existing_observers() {
    let identity = RunnerProcessIdentity::new(uuid::Uuid::new_v4(), 1).unwrap();
    let (intake, mut receiver) = DispatchIntake::new(Arc::new(Semaphore::new(4)), None);
    let intake = Arc::new(intake);
    let run_id = RunId::new_v4();
    let bytes = body(identity, run_id, 2_000);
    let original = submit(&intake, identity, run_id, bytes.clone(), 1_000);
    let work = receiver.recv().await.unwrap();
    let permit = intake.try_reserve().unwrap();
    let observer = intake.submit(identity, run_id, bytes.as_bytes(), permit, 1_001);
    tokio::pin!(observer);
    assert!(futures_util::poll!(observer.as_mut()).is_pending());
    intake.expire(2_000);
    assert!(intake.records.lock().unwrap().is_empty());
    assert_eq!(
        submit(&intake, identity, run_id, bytes.clone(), 2_000)
            .await
            .unwrap(),
        Disposition::Unknown
    );
    assert!(receiver.try_recv().is_err());
    // The retained admission owner can still finish rollback and settle callers
    // that subscribed while the original window was open.
    work.settle(Disposition::Rejected);
    drop(work);
    assert_eq!(original.await.unwrap(), Disposition::Rejected);
    assert_eq!(observer.await, Disposition::Rejected);
}
