use super::*;
use crate::test_fixtures::execution_context::execution_context_for_test;

fn minimal_context(run_id: RunId) -> ExecutionContext {
    execution_context_for_test(run_id)
}

fn complete_request(run_id: RunId) -> CompleteRequest {
    CompleteRequest {
        run_id,
        exit_code: 0,
        failure_reason: None,
        error: None,
        sandbox_id: None,
    }
}

#[tokio::test]
async fn claim_rejects_mismatched_context() {
    let candidate_run_id = RunId::from(uuid::Uuid::nil());
    let context_run_id = RunId::new_v4();
    let (provider, _handle) = MockJobProvider::new(CancellationToken::new());
    provider.set_claim_result(candidate_run_id, Some(minimal_context(context_run_id)));

    let claimed = provider
        .claim(JobCandidate::new(
            candidate_run_id,
            runner_types::profile_name::DEFAULT_PROFILE.to_owned(),
        ))
        .await;

    assert!(claimed.is_none());
}

#[tokio::test]
async fn claim_accepts_matching_context() {
    let run_id = RunId::from(uuid::Uuid::nil());
    let (provider, _handle) = MockJobProvider::new(CancellationToken::new());
    provider.set_claim_result(run_id, Some(minimal_context(run_id)));

    let claimed = provider
        .claim(JobCandidate::new(
            run_id,
            runner_types::profile_name::DEFAULT_PROFILE.to_owned(),
        ))
        .await
        .expect("matching context should be claimed");

    assert_eq!(claimed.context().run_id, run_id);
}

#[tokio::test]
async fn completion_gate_tracks_release_and_cancellation() {
    let (provider, handle) = MockJobProvider::new(CancellationToken::new());
    handle.block_completions();

    let released_run_id = RunId::new_v4();
    let released_provider = Arc::clone(&provider);
    let released = tokio::spawn(async move {
        released_provider
            .complete(complete_request(released_run_id), CompletionAuth::local())
            .await;
    });
    handle
        .wait_completion(released_run_id, Duration::from_secs(2))
        .await
        .expect("blocked completion should record its request");
    assert_eq!(handle.completion_in_flight(), 1);

    handle.unblock_completions();
    released.await.unwrap();
    assert_eq!(handle.completion_in_flight(), 0);

    handle.block_completions();
    let cancelled_run_id = RunId::new_v4();
    let cancelled_provider = Arc::clone(&provider);
    let cancelled = tokio::spawn(async move {
        cancelled_provider
            .complete(complete_request(cancelled_run_id), CompletionAuth::local())
            .await;
    });
    handle
        .wait_completion(cancelled_run_id, Duration::from_secs(2))
        .await
        .expect("cancelled completion should record its request");
    assert_eq!(handle.completion_in_flight(), 1);

    cancelled.abort();
    assert!(cancelled.await.unwrap_err().is_cancelled());
    assert_eq!(handle.completion_in_flight(), 0);
}
