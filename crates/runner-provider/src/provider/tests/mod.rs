use super::*;
use crate::test_fixtures::execution_context::execution_context_for_test;

fn minimal_context(run_id: RunId) -> ExecutionContext {
    let mut ctx = execution_context_for_test(run_id);
    ctx.sandbox_token = "sandbox-token".into();
    ctx
}

#[test]
fn local_completion_keeps_local_authority() {
    let run_id = RunId::from(uuid::Uuid::nil());

    let claimed = ClaimedJob::local(run_id, minimal_context(run_id))
        .expect("matching local context is valid");
    let (context, auth, _) = claimed.into_parts();
    assert_eq!(context.run_id, run_id);
    assert!(matches!(
        auth.into_sandbox_token(run_id),
        Err(CompletionAuthError::NotSandbox)
    ));
}
