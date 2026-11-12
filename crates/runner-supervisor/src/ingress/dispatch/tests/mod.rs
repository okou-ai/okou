//! Compact process-lifetime custody, independent of execution duration.

use super::*;
use serde_json::json;

fn body(identity: RunnerProcessIdentity, run_id: RunId) -> String {
    json!({
        "runnerId": identity.runner_id(), "heartbeatGeneration": identity.heartbeat_generation(),
        "profile": "vm0/default", "notAfter": now_ms()+60_000,
        "executionContext": {"runId":run_id,"prompt":"hello","sandboxToken":"run-token","cliAgentType":"","platformEnvironment":{},"connectorRuntimeTargets":[],"contentBundles":{"format":"tar-gzip-v1","skills":[]}}
    }).to_string()
}

#[tokio::test]
async fn compact_custody_never_evicts_accepted_work_or_reopens_an_unknown_attempt() {
    let identity = RunnerProcessIdentity::new(uuid::Uuid::new_v4(), 1).unwrap();
    let (mut intake, mut receiver) = DispatchIntake::new(Arc::new(Semaphore::new(4)));
    intake.max_records = 2;
    let intake = Arc::new(intake);
    let first = RunId::new_v4();
    let bytes = body(identity, first);
    let submit = {
        let intake = intake.clone();
        let bytes = bytes.clone();
        tokio::spawn(async move {
            let permit = intake.reserve().await.unwrap();
            intake
                .submit(identity, first, bytes.as_bytes(), permit)
                .await
        })
    };
    let work = receiver.recv().await.unwrap();
    work.settle(Disposition::Accepted);
    drop(work);
    assert_eq!(submit.await.unwrap(), Disposition::Accepted);
    let second = RunId::new_v4();
    let second_body = body(identity, second);
    let submit = {
        let intake = intake.clone();
        let bytes = second_body.clone();
        tokio::spawn(async move {
            let permit = intake.reserve().await.unwrap();
            intake
                .submit(identity, second, bytes.as_bytes(), permit)
                .await
        })
    };
    // Owner disappearance is uncertain, and must never permit a retry to execute.
    drop(receiver.recv().await.unwrap());
    assert_eq!(submit.await.unwrap(), Disposition::Unknown);
    for (run_id, bytes, expected) in [
        (first, bytes, Disposition::Accepted),
        (second, second_body, Disposition::Unknown),
        (RunId::new_v4(), String::new(), Disposition::Unknown),
    ] {
        let permit = intake.reserve().await.unwrap();
        assert_eq!(
            intake
                .submit(identity, run_id, bytes.as_bytes(), permit)
                .await,
            expected
        );
    }
    let third = RunId::new_v4();
    let permit = intake.reserve().await.unwrap();
    assert_eq!(
        intake
            .submit(identity, third, body(identity, third).as_bytes(), permit)
            .await,
        Disposition::Rejected
    );
    assert!(receiver.try_recv().is_err());
}
