use std::collections::HashMap;

use crate::test_fixtures::execution_context::execution_context_for_test;
use runner_types::ids::RunId;
use runner_types::types::ExecutionContext;

pub(in crate::executor::tests) fn minimal_context() -> ExecutionContext {
    let mut ctx = execution_context_for_test(RunId::from(uuid::Uuid::nil()));
    ctx.prompt = "test prompt".into();
    ctx.sandbox_token = "tok".into();
    ctx
}

pub(in crate::executor::tests) fn context_with_env(
    environment: HashMap<String, String>,
) -> ExecutionContext {
    let mut ctx = minimal_context();
    ctx.environment = Some(environment);
    ctx
}
