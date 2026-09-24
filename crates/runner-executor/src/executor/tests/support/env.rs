use std::collections::HashMap;

use sandbox::SandboxId;

use super::super::super::env::{HostEnv, build_env_json_with_host_env_for_run};
use crate::error::RunnerResult;
use runner_types::types::{ExecutionContext, SandboxReuseResult, WorkspaceReuseResult};

pub(in crate::executor::tests) fn build_env_for_test(
    ctx: &ExecutionContext,
    api_url: &str,
) -> HashMap<String, String> {
    build_env_for_test_result(ctx, api_url).expect("test env should build")
}

pub(in crate::executor::tests) fn build_env_for_test_result(
    ctx: &ExecutionContext,
    api_url: &str,
) -> RunnerResult<HashMap<String, String>> {
    build_env_for_test_with_host_env_result(ctx, api_url, &HostEnv::default())
}

pub(in crate::executor::tests) fn build_env_for_test_with_host_env(
    ctx: &ExecutionContext,
    api_url: &str,
    host_env: &HostEnv,
) -> HashMap<String, String> {
    build_env_for_test_with_host_env_result(ctx, api_url, host_env).expect("test env should build")
}

pub(in crate::executor::tests) fn build_env_for_test_with_host_env_result(
    ctx: &ExecutionContext,
    api_url: &str,
    host_env: &HostEnv,
) -> RunnerResult<HashMap<String, String>> {
    let sid = SandboxId::new_v4().to_string();
    build_env_json_with_host_env_for_run(
        ctx,
        api_url,
        &sid,
        SandboxReuseResult::Reused,
        WorkspaceReuseResult::SandboxReused,
        host_env,
    )
}
