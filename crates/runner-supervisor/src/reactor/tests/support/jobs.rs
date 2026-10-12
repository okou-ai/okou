use super::super::super::*;
use super::env::MockRunEnv;
use super::wait::assert_run_exits_within;
use crate::test_fixtures::execution_context::execution_context_for_test;
use runner_provider::JobCandidate;

pub(in super::super) fn minimal_context(run_id: RunId) -> runner_types::types::ExecutionContext {
    execution_context_for_test(run_id)
}

/// Push a job to the mock provider and pre-configure its claim result.
pub(in super::super) fn push_job(
    env: &MockRunEnv,
    run_id: RunId,
    profile: &str,
    ctx: Option<runner_types::types::ExecutionContext>,
) {
    let reuse_key = ctx.as_ref().and_then(|context| context.reuse_key.clone());
    env.provider.set_claim_result(run_id, ctx);
    env.handle
        .discover_tx
        .send(JobCandidate::new(run_id, profile.into()).with_reuse_key(reuse_key))
        .unwrap();
}

/// Trigger graceful shutdown and wait for run() to exit.
pub(in super::super) async fn shutdown(
    env: &MockRunEnv,
    run_handle: tokio::task::JoinHandle<RunnerResult<()>>,
) {
    env.drain();
    env.cancel.cancel();
    assert_run_exits_within(
        run_handle,
        Duration::from_secs(10),
        "run should finish within 10s",
    )
    .await;
}

/// ExecutionContext with a resume_session for idle pool testing.
pub(in super::super) fn context_with_session(
    run_id: RunId,
    session_id: &str,
) -> runner_types::types::ExecutionContext {
    let mut ctx = minimal_context(run_id);
    ctx.reuse_key = Some(session_id.into());
    ctx.resume_session = Some(runner_types::types::ResumeSession::inline(
        session_id.into(),
        String::new(),
    ));
    ctx
}
