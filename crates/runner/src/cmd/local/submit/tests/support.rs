use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use super::super::{SubmitArgs, SubmitQueueEntry, run_submit_with_home};
use runner_host::paths::HomePaths;
use runner_provider::local_queue::{self, JobRequest, JobResponse};
use runner_types::ids::RunId;

pub(super) const TEST_SUBMIT_RENDEZVOUS_TIMEOUT: Duration = Duration::from_secs(5);
const TEST_SUBMIT_QUEUE_POLL_INTERVAL: Duration = Duration::from_millis(1);

pub(super) fn submit_queue_entry(group_dir: &Path, job_id: RunId) -> SubmitQueueEntry {
    SubmitQueueEntry::for_job(group_dir, crate::profile::DEFAULT_PROFILE, job_id).unwrap()
}

pub(super) fn write_queue_job_file(group_dir: &Path, profile: &str, job_id: RunId) -> PathBuf {
    let path = local_queue::job_path(group_dir, profile, job_id).unwrap();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, b"{}").unwrap();
    path
}

pub(super) fn mode(path: &Path) -> u32 {
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

pub(super) async fn wait_for_job_and_write_result(
    group_dir: std::path::PathBuf,
    profile: String,
    exit_code: i32,
    error: Option<String>,
    response_run_id: Option<RunId>,
) -> JobRequest {
    let job_dir = local_queue::profile_jobs_dir(&group_dir, &profile).unwrap();
    loop {
        if let Ok(entries) = std::fs::read_dir(&job_dir) {
            for entry in entries.filter_map(Result::ok) {
                let path = entry.path();
                if path.extension().and_then(|ext| ext.to_str()) != Some("job") {
                    continue;
                }
                let request: JobRequest =
                    serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
                let response = JobResponse {
                    run_id: response_run_id.unwrap_or(request.job_id),
                    exit_code,
                    error: error.clone(),
                };
                let result_path = local_queue::result_path(&group_dir, request.job_id);
                std::fs::create_dir_all(result_path.parent().unwrap()).unwrap();
                std::fs::write(&result_path, serde_json::to_vec(&response).unwrap()).unwrap();
                return request;
            }
        }

        tokio::time::sleep(TEST_SUBMIT_QUEUE_POLL_INTERVAL).await;
    }
}

fn observed_queue_entries(group_dir: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut directories = vec![group_dir.to_owned()];
    let mut entries = Vec::new();
    while let Some(directory) = directories.pop() {
        for entry in std::fs::read_dir(directory)? {
            let entry = entry?;
            let path = entry.path();
            if entry.file_type()?.is_dir() {
                directories.push(path.clone());
            }
            entries.push(path.strip_prefix(group_dir).unwrap().to_owned());
        }
    }
    entries.sort();
    Ok(entries)
}

async fn run_submit_and_write_result_with_timeout(
    args: SubmitArgs,
    home: HomePaths,
    profile: &str,
    exit_code: i32,
    error: Option<String>,
    timeout: Duration,
) -> Result<(ExitCode, JobRequest), String> {
    let group = args.group.clone();
    let group_dir = home.groups_dir().join(&group);
    let watched_group_dir = group_dir.clone();
    let profile = profile.to_owned();
    let watched_profile = profile.clone();
    let rendezvous = async move {
        tokio::try_join!(run_submit_with_home(args, home), async move {
            Ok::<JobRequest, crate::error::RunnerError>(
                wait_for_job_and_write_result(
                    watched_group_dir,
                    watched_profile,
                    exit_code,
                    error,
                    None,
                )
                .await,
            )
        })
    };

    match tokio::time::timeout(timeout, rendezvous).await {
        Ok(Ok(result)) => Ok(result),
        Ok(Err(error)) => Err(format!(
            "local submit failed during test rendezvous (group: {group}, profile: {profile}): {error}"
        )),
        Err(_) => Err(format!(
            "local submit test rendezvous timed out after {timeout:?} (group: {group}, profile: {profile}, observed queue entries: {:?})",
            observed_queue_entries(&group_dir)
        )),
    }
}

pub(super) async fn run_submit_and_write_result(
    args: SubmitArgs,
    home: HomePaths,
    exit_code: i32,
    error: Option<String>,
) -> Result<(ExitCode, JobRequest), String> {
    let profile = args
        .profile
        .as_deref()
        .unwrap_or(crate::profile::DEFAULT_PROFILE)
        .to_owned();
    run_submit_and_write_result_with_timeout(
        args,
        home,
        &profile,
        exit_code,
        error,
        TEST_SUBMIT_RENDEZVOUS_TIMEOUT,
    )
    .await
}

pub(super) async fn run_submit_and_write_success(
    args: SubmitArgs,
    home: HomePaths,
) -> Result<(ExitCode, JobRequest), String> {
    run_submit_and_write_result(args, home, 0, None).await
}

pub(super) fn submit_args_for_test() -> SubmitArgs {
    SubmitArgs {
        group: "test/group".into(),
        prompt: "hello".into(),
        cli_agent_type: "claude-code".into(),
        profile: None,
        chat_thread_id: None,
        session_id: None,
        feature_flags: vec![],
        env: vec![],
        secret_env: vec![],
        timeout: 1,
        active_inputs: vec![],
    }
}

#[tokio::test]
async fn submit_rendezvous_timeout_reports_queue_context() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let mut args = submit_args_for_test();
    args.timeout = super::super::MAX_LOCAL_SUBMIT_TIMEOUT_SECS;

    let result =
        run_submit_and_write_result_with_timeout(args, home, "vm0/large", 0, None, Duration::ZERO)
            .await;
    let error = match result {
        Ok(_) => panic!("expected local submit test rendezvous to time out"),
        Err(error) => error,
    };

    assert!(error.contains("group: test/group"), "got: {error}");
    assert!(error.contains("profile: vm0/large"), "got: {error}");
    assert!(error.contains("jobs/vm0/default"), "got: {error}");
    assert!(error.contains(".job"), "got: {error}");
}

#[tokio::test]
async fn submit_rendezvous_surfaces_submit_error_before_deadline() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let mut args = submit_args_for_test();
    args.feature_flags = vec!["missing-equals".to_owned()];
    args.timeout = super::super::MAX_LOCAL_SUBMIT_TIMEOUT_SECS;

    let result = run_submit_and_write_result_with_timeout(
        args,
        home,
        crate::profile::DEFAULT_PROFILE,
        0,
        None,
        Duration::ZERO,
    )
    .await;
    let error = match result {
        Ok(_) => panic!("expected local submit validation to fail"),
        Err(error) => error,
    };

    assert!(
        error.contains("local submit failed during test rendezvous"),
        "got: {error}"
    );
    assert!(error.contains("expected key=value"), "got: {error}");
    assert!(!error.contains("timed out"), "got: {error}");
}
