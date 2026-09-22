use std::ffi::OsStr;
use std::process::ExitCode;
use std::time::Duration;

use super::super::run_submit_with_home;
use super::support::submit_args_for_test;
use crate::local_queue::{self, JobRequest, JobResponse};
use crate::test_fixtures::ignored_child::{
    ignored_child_test_env_guard_enabled, run_ignored_child_test,
};
use runner_host::paths::HomePaths;
use runner_types::ids::RunId;

const INTERRUPT_CHILD_ENV: &str = "OKOU_RUNNER_LOCAL_SUBMIT_INTERRUPT_TEST";
const INTERRUPT_CHILD_VALUE: &str = "after-job-publication";
const INTERRUPT_CHILD_TEST: &str =
    "cmd::local::submit::tests::interrupt::sigint_after_job_publication_uses_cancel_cleanup_child";
const SECOND_INTERRUPT_CHILD_VALUE: &str = "second-interrupt-after-claim";
const SECOND_INTERRUPT_CHILD_TEST: &str = "cmd::local::submit::tests::interrupt::second_sigint_preserves_claimed_cancel_without_result_child";

pub(super) fn post_publish_test_checkpoint() {
    let value = std::env::var_os(INTERRUPT_CHILD_ENV);
    if value.as_deref() != Some(OsStr::new(INTERRUPT_CHILD_VALUE))
        && value.as_deref() != Some(OsStr::new(SECOND_INTERRUPT_CHILD_VALUE))
    {
        return;
    }

    send_sigint();
}

fn send_sigint() {
    nix::sys::signal::kill(nix::unistd::Pid::this(), nix::sys::signal::Signal::SIGINT)
        .expect("send SIGINT to local submit test process");
}

#[tokio::test]
async fn sigint_after_job_publication_uses_cancel_cleanup() {
    run_ignored_child_test(
        INTERRUPT_CHILD_TEST,
        (INTERRUPT_CHILD_ENV, INTERRUPT_CHILD_VALUE),
        &[],
        Duration::from_secs(5),
    )
    .await;
}

#[tokio::test]
#[ignore = "spawned by sigint_after_job_publication_uses_cancel_cleanup"]
async fn sigint_after_job_publication_uses_cancel_cleanup_child() {
    if !ignored_child_test_env_guard_enabled((INTERRUPT_CHILD_ENV, INTERRUPT_CHILD_VALUE)) {
        return;
    }

    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let group_dir = home.groups_dir().join("test/group");
    let profile = crate::profile::DEFAULT_PROFILE.to_owned();
    let runner = tokio::spawn(wait_for_cancel_and_write_failure(
        group_dir.clone(),
        profile.clone(),
    ));

    let exit = run_submit_with_home(submit_args_for_test(), home)
        .await
        .unwrap();
    let job_id = runner.await.unwrap();

    assert_eq!(exit, ExitCode::FAILURE);
    assert!(
        !local_queue::job_path(&group_dir, &profile, job_id)
            .unwrap()
            .exists(),
        "interrupted submit must not leave an executable job"
    );
    assert!(!local_queue::cancel_path(&group_dir, job_id).exists());
    assert!(!local_queue::claim_path(&group_dir, job_id).exists());
    assert!(!local_queue::result_path(&group_dir, job_id).exists());
}

#[tokio::test]
async fn second_sigint_preserves_claimed_cancel_without_result() {
    run_ignored_child_test(
        SECOND_INTERRUPT_CHILD_TEST,
        (INTERRUPT_CHILD_ENV, SECOND_INTERRUPT_CHILD_VALUE),
        &[],
        Duration::from_secs(5),
    )
    .await;
}

#[tokio::test]
#[ignore = "spawned by second_sigint_preserves_claimed_cancel_without_result"]
async fn second_sigint_preserves_claimed_cancel_without_result_child() {
    if !ignored_child_test_env_guard_enabled((INTERRUPT_CHILD_ENV, SECOND_INTERRUPT_CHILD_VALUE)) {
        return;
    }

    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let group_dir = home.groups_dir().join("test/group");
    let profile = crate::profile::DEFAULT_PROFILE.to_owned();
    let claimer = tokio::spawn(claim_and_send_second_interrupt(
        group_dir.clone(),
        profile.clone(),
    ));

    let exit = run_submit_with_home(submit_args_for_test(), home)
        .await
        .unwrap();
    let job_id = claimer.await.unwrap();

    assert_eq!(exit, ExitCode::FAILURE);
    assert!(
        !local_queue::job_path(&group_dir, &profile, job_id)
            .unwrap()
            .exists(),
        "interrupted submit must not leave an executable job"
    );
    assert!(!local_queue::result_path(&group_dir, job_id).exists());
    assert!(local_queue::cancel_path(&group_dir, job_id).exists());
    assert!(local_queue::claim_path(&group_dir, job_id).exists());
}

async fn claim_and_send_second_interrupt(group_dir: std::path::PathBuf, profile: String) -> RunId {
    let request = wait_for_job(&group_dir, &profile).await;
    local_queue::ensure_claims_dir(&group_dir).unwrap();
    local_queue::create_private_marker(
        &local_queue::claim_path(&group_dir, request.job_id),
        "local claim marker",
    )
    .unwrap();

    let cancel_path = local_queue::cancel_path(&group_dir, request.job_id);
    while !local_queue::marker_file_exists(&cancel_path, "local cancel marker").unwrap() {
        tokio::task::yield_now().await;
    }

    send_sigint();
    request.job_id
}

async fn wait_for_cancel_and_write_failure(
    group_dir: std::path::PathBuf,
    profile: String,
) -> RunId {
    let request = wait_for_job(&group_dir, &profile).await;

    let cancel_path = local_queue::cancel_path(&group_dir, request.job_id);
    while !local_queue::marker_file_exists(&cancel_path, "local cancel marker").unwrap() {
        tokio::task::yield_now().await;
    }

    let result = JobResponse {
        run_id: request.job_id,
        exit_code: 1,
        error: Some("cancelled by test runner".to_owned()),
    };
    let result_path = local_queue::result_path(&group_dir, request.job_id);
    std::fs::write(result_path, serde_json::to_vec(&result).unwrap()).unwrap();
    request.job_id
}

async fn wait_for_job(group_dir: &std::path::Path, profile: &str) -> JobRequest {
    let job_dir = local_queue::profile_jobs_dir(group_dir, profile).unwrap();
    loop {
        if let Ok(entries) = std::fs::read_dir(&job_dir) {
            let request = entries.filter_map(Result::ok).find_map(|entry| {
                let path = entry.path();
                (path.extension().and_then(|ext| ext.to_str()) == Some("job")).then(|| {
                    serde_json::from_slice::<JobRequest>(&std::fs::read(path).unwrap()).unwrap()
                })
            });
            if let Some(request) = request {
                return request;
            }
        }
        tokio::task::yield_now().await;
    }
}
