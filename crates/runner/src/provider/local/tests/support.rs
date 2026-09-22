use std::sync::atomic::Ordering;

pub(super) use std::collections::HashMap;
pub(super) use std::sync::Arc;
pub(super) use std::time::Duration;

pub(super) use super::super::LocalProvider;
use super::super::job_candidate_from_discovered;
pub(super) use super::super::watch::RECONCILE_INTERVAL;
pub(super) use crate::local_queue;
use crate::local_queue::JobRequest;
pub(super) use crate::local_queue::JobResponse;
pub(super) use crate::provider::{CompletionAuth, JobCandidate, JobProvider};
use crate::run_cancellation::{RunCancellationRegistration, RunCancellationRegistry};
pub(super) use runner_types::ids::RunId;
use runner_types::types::CompleteRequest;
pub(super) use tokio_util::sync::CancellationToken;

pub(super) trait LocalProviderTestExt {
    fn find_unclaimed_job(&self) -> Option<JobCandidate>;
    fn write_result(&self, run_id: RunId, exit_code: i32, error: Option<&str>) -> bool;
}

impl LocalProviderTestExt for LocalProvider {
    fn find_unclaimed_job(&self) -> Option<JobCandidate> {
        let start = self.profile_cursor.fetch_add(1, Ordering::Relaxed);
        self.queue
            .discover_candidate_sync(&self.supported_profiles, start)
            .map(job_candidate_from_discovered)
    }

    fn write_result(&self, run_id: RunId, exit_code: i32, error: Option<&str>) -> bool {
        self.queue.write_result_sync(run_id, exit_code, error)
    }
}

pub(super) fn empty_cancel_tokens() -> RunCancellationRegistry {
    RunCancellationRegistry::new()
}

pub(super) fn complete_request(
    run_id: RunId,
    exit_code: i32,
    error: Option<&str>,
) -> CompleteRequest {
    CompleteRequest {
        run_id,
        exit_code,
        failure_reason: None,
        error: error.map(str::to_owned),
        sandbox_id: None,
        sandbox_reuse_result: None,
        workspace_reuse_result: None,
        active_input_delivery_ids: Vec::new(),
    }
}

pub(super) async fn insert_cancel_registration(
    tokens: &RunCancellationRegistry,
    run_id: RunId,
) -> RunCancellationRegistration {
    tokens.register(run_id).await.unwrap()
}

pub(super) fn profiles(names: &[&str]) -> Vec<String> {
    names.iter().map(|name| (*name).to_string()).collect()
}

pub(super) fn default_profiles() -> Vec<String> {
    profiles(&[crate::profile::DEFAULT_PROFILE])
}

pub(super) fn default_provider(
    dir: &std::path::Path,
    cancel: CancellationToken,
    tokens: RunCancellationRegistry,
) -> Arc<LocalProvider> {
    LocalProvider::new_inner(dir.to_path_buf(), default_profiles(), cancel, tokens, false)
}

pub(super) fn provider_with_profiles(
    dir: &std::path::Path,
    supported_profiles: &[&str],
    cancel: CancellationToken,
    tokens: RunCancellationRegistry,
) -> Arc<LocalProvider> {
    LocalProvider::new_inner(
        dir.to_path_buf(),
        profiles(supported_profiles),
        cancel,
        tokens,
        false,
    )
}

pub(super) fn write_job(dir: &std::path::Path, job_id: RunId, prompt: &str) {
    write_job_in_partition(
        dir,
        crate::profile::DEFAULT_PROFILE,
        job_id,
        prompt,
        Some(crate::profile::DEFAULT_PROFILE),
    );
}

pub(super) fn write_job_atomically(dir: &std::path::Path, job_id: RunId, prompt: &str) {
    let partition_profile = crate::profile::DEFAULT_PROFILE;
    let json = job_request_json(
        job_id,
        prompt,
        JobOptions {
            profile: Some(partition_profile),
            ..JobOptions::default()
        },
    );
    let job_dir = local_queue::profile_jobs_dir(dir, partition_profile).unwrap();
    std::fs::create_dir_all(&job_dir).unwrap();
    let job_path = local_queue::job_path(dir, partition_profile, job_id).unwrap();
    let temporary_path = job_dir.join(format!("{job_id}.job.tmp"));
    std::fs::write(&temporary_path, json).unwrap();
    std::fs::rename(temporary_path, job_path).unwrap();
}

pub(super) fn write_job_with_profile(
    dir: &std::path::Path,
    job_id: RunId,
    prompt: &str,
    profile: Option<&str>,
) {
    let partition = profile.unwrap_or(crate::profile::DEFAULT_PROFILE);
    write_job_in_partition(dir, partition, job_id, prompt, profile);
}

pub(super) fn write_job_with_active_input(dir: &std::path::Path, job_id: RunId, prompt: &str) {
    write_job_in_partition_with_options(
        dir,
        crate::profile::DEFAULT_PROFILE,
        job_id,
        prompt,
        JobOptions {
            profile: Some(crate::profile::DEFAULT_PROFILE),
            active_input: Some(true),
            ..JobOptions::default()
        },
    );
}

pub(super) fn write_job_with_session(
    dir: &std::path::Path,
    job_id: RunId,
    prompt: &str,
    session_id: &str,
) {
    write_job_in_partition_with_options(
        dir,
        crate::profile::DEFAULT_PROFILE,
        job_id,
        prompt,
        JobOptions {
            profile: Some(crate::profile::DEFAULT_PROFILE),
            session_id: Some(session_id),
            ..JobOptions::default()
        },
    );
}

pub(super) fn write_job_with_reuse_metadata(
    dir: &std::path::Path,
    job_id: RunId,
    prompt: &str,
    reuse_key: Option<&str>,
    session_id: Option<&str>,
) {
    write_job_in_partition_with_options(
        dir,
        crate::profile::DEFAULT_PROFILE,
        job_id,
        prompt,
        JobOptions {
            profile: Some(crate::profile::DEFAULT_PROFILE),
            reuse_key,
            session_id,
            ..JobOptions::default()
        },
    );
}

pub(super) fn write_job_in_partition(
    dir: &std::path::Path,
    partition_profile: &str,
    job_id: RunId,
    prompt: &str,
    json_profile: Option<&str>,
) {
    write_job_in_partition_with_options(
        dir,
        partition_profile,
        job_id,
        prompt,
        JobOptions {
            profile: json_profile,
            ..JobOptions::default()
        },
    );
}

#[derive(Default)]
struct JobOptions<'a> {
    profile: Option<&'a str>,
    reuse_key: Option<&'a str>,
    session_id: Option<&'a str>,
    active_input: Option<bool>,
}

fn write_job_in_partition_with_options(
    dir: &std::path::Path,
    partition_profile: &str,
    job_id: RunId,
    prompt: &str,
    options: JobOptions<'_>,
) {
    let json = job_request_json(job_id, prompt, options);
    let job_dir = local_queue::profile_jobs_dir(dir, partition_profile).unwrap();
    std::fs::create_dir_all(&job_dir).unwrap();
    std::fs::write(
        local_queue::job_path(dir, partition_profile, job_id).unwrap(),
        &json,
    )
    .unwrap();
}

fn job_request_json(job_id: RunId, prompt: &str, options: JobOptions<'_>) -> Vec<u8> {
    let req = JobRequest {
        job_id,
        prompt: prompt.into(),
        cli_agent_type: "claude-code".into(),
        vars: None,
        environment: None,
        secret_environment: None,
        user_timezone: None,
        profile: options.profile.map(String::from),
        reuse_key: options.reuse_key.map(String::from),
        session_id: options.session_id.map(String::from),
        feature_flags: None,
        active_input: options.active_input,
    };
    serde_json::to_vec(&req).unwrap()
}

pub(super) fn write_job_with_environments(
    dir: &std::path::Path,
    job_id: RunId,
    environment: Option<HashMap<String, String>>,
    secret_environment: Option<HashMap<String, String>>,
) {
    let req = JobRequest {
        job_id,
        prompt: "hello with env".into(),
        cli_agent_type: "claude-code".into(),
        vars: None,
        environment,
        secret_environment,
        user_timezone: None,
        profile: Some(crate::profile::DEFAULT_PROFILE.into()),
        reuse_key: None,
        session_id: None,
        feature_flags: None,
        active_input: None,
    };
    let json = serde_json::to_vec(&req).unwrap();
    let job_dir = local_queue::profile_jobs_dir(dir, crate::profile::DEFAULT_PROFILE).unwrap();
    std::fs::create_dir_all(&job_dir).unwrap();
    std::fs::write(
        local_queue::job_path(dir, crate::profile::DEFAULT_PROFILE, job_id).unwrap(),
        &json,
    )
    .unwrap();
}

pub(super) fn read_result(dir: &std::path::Path, job_id: RunId) -> JobResponse {
    let path = local_queue::result_path(dir, job_id);
    let buf = std::fs::read(path).unwrap();
    serde_json::from_slice(&buf).unwrap()
}
