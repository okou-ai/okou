use runner_types::ids::RunId;
pub(crate) use runner_types::test_fixtures::execution_context_for_test;
use runner_types::types::ExecutionContext;
use std::collections::HashMap;

pub(crate) fn diagnostic_context_for_test(run_id: RunId, token: &str) -> ExecutionContext {
    let mut context = execution_context_for_test(run_id);
    context.sandbox_token = "internal-sandbox-token".into();
    context.environment = Some(HashMap::from([(
        "OKOU_TOKEN".into(),
        "untrusted-user-token".into(),
    )]));
    context
        .platform_environment
        .insert("OKOU_TOKEN".into(), token.into());
    context
}
