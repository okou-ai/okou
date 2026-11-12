//! Retry history lasts only through the original delivery window.

use super::*;
use serde_json::json;
use tokio::task::JoinHandle;

fn body(identity: RunnerProcessIdentity, run_id: RunId, not_after: u64) -> String {
    json!({
        "runnerId": identity.runner_id(), "heartbeatGeneration": identity.heartbeat_generation(),
        "profile": "vm0/default", "notAfter": not_after,
        "executionContext": {"runId":run_id,"prompt":"hello","sandboxToken":"run-token","cliAgentType":"","platformEnvironment":{},"connectorRuntimeTargets":[],"contentBundles":{"format":"tar-gzip-v1","skills":[]}}
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

#[tokio::test]
async fn original_window_replays_then_reclaims_settled_history_without_closing_new_intake() {
    let identity = RunnerProcessIdentity::new(uuid::Uuid::new_v4(), 1).unwrap();
    let (intake, mut receiver) = DispatchIntake::new(Arc::new(Semaphore::new(4)));
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
    let (intake, mut receiver) = DispatchIntake::new(Arc::new(Semaphore::new(4)));
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
    let (intake, mut receiver) = DispatchIntake::new(Arc::new(Semaphore::new(4)));
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
