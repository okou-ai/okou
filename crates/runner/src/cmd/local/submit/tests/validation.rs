use std::process::ExitCode;

use super::super::{MAX_LOCAL_SUBMIT_TIMEOUT_SECS, SubmitArgs, SubmitPlan, run_submit_with_home};
use super::support::{run_submit_and_write_success, submit_args_for_test};
use crate::error::RunnerError;
use crate::local_queue;
use runner_host::paths::HomePaths;

fn prompt_len_for_serialized_job_size(root: &std::path::Path, target_bytes: usize) -> usize {
    let mut args = submit_args_for_test();
    args.prompt.clear();
    let plan = SubmitPlan::from_args(args, HomePaths::with_root(root.to_path_buf())).unwrap();
    target_bytes.checked_sub(plan.request_json.len()).unwrap()
}

#[tokio::test]
async fn rejects_invalid_profile_name() {
    let args = SubmitArgs {
        group: "test/group".into(),
        prompt: "hello".into(),
        cli_agent_type: "claude-code".into(),
        profile: Some("bad-name".into()),
        chat_thread_id: None,
        session_id: None,
        feature_flags: vec![],
        env: vec![],
        secret_env: vec![],
        timeout: 1,
        active_inputs: vec![],
    };
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let err = run_submit_with_home(args, home).await.unwrap_err();
    assert!(
        err.to_string().contains("invalid profile name"),
        "got: {err}"
    );
}

#[tokio::test]
async fn accepts_valid_profile_name() {
    let args = SubmitArgs {
        group: "test/group".into(),
        prompt: "hello".into(),
        cli_agent_type: "claude-code".into(),
        profile: Some("vm0/default".into()),
        chat_thread_id: None,
        session_id: None,
        feature_flags: vec![],
        env: vec![],
        secret_env: vec![],
        timeout: 0,
        active_inputs: vec![],
    };
    // Should pass validation and fail later (HomePaths or timeout), not on profile.
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let result = run_submit_with_home(args, home).await;
    if let Err(e) = &result {
        assert!(!e.to_string().contains("invalid profile name"), "got: {e}");
    }
}

#[tokio::test]
async fn rejects_feature_flag_missing_equals() {
    let args = SubmitArgs {
        group: "test/group".into(),
        prompt: "hello".into(),
        cli_agent_type: "claude-code".into(),
        profile: None,
        chat_thread_id: None,
        session_id: None,
        feature_flags: vec!["myFlag".into()],
        env: vec![],
        secret_env: vec![],
        timeout: 1,
        active_inputs: vec![],
    };
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let err = run_submit_with_home(args, home).await.unwrap_err();
    assert!(err.to_string().contains("expected key=value"), "got: {err}");
}

#[tokio::test]
async fn rejects_feature_flag_non_boolean() {
    let args = SubmitArgs {
        group: "test/group".into(),
        prompt: "hello".into(),
        cli_agent_type: "claude-code".into(),
        profile: None,
        chat_thread_id: None,
        session_id: None,
        feature_flags: vec!["myFlag=yes".into()],
        env: vec![],
        secret_env: vec![],
        timeout: 1,
        active_inputs: vec![],
    };
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let err = run_submit_with_home(args, home).await.unwrap_err();
    assert!(
        err.to_string().contains("expected true/false"),
        "got: {err}"
    );
}

#[tokio::test]
async fn timeout_message_includes_group_and_profile() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let args = SubmitArgs {
        group: "test/group".into(),
        prompt: "hello".into(),
        cli_agent_type: "claude-code".into(),
        profile: Some("vm0/large".into()),
        chat_thread_id: None,
        session_id: None,
        feature_flags: vec![],
        env: vec![],
        secret_env: vec![],
        timeout: 0,
        active_inputs: vec![],
    };

    let err = run_submit_with_home(args, home).await.unwrap_err();
    let msg = err.to_string();
    assert!(msg.contains("group: test/group"), "got: {msg}");
    assert!(msg.contains("profile: vm0/large"), "got: {msg}");
    assert!(msg.contains("no local runner"), "got: {msg}");
    assert!(msg.contains("support this profile"), "got: {msg}");
}

#[tokio::test]
async fn maximum_timeout_is_accepted() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let group = "test/group";
    let mut args = submit_args_for_test();
    args.group = group.into();
    args.timeout = MAX_LOCAL_SUBMIT_TIMEOUT_SECS;

    let (code, request) = run_submit_and_write_success(args, home).await.unwrap();

    assert_eq!(code, ExitCode::SUCCESS);
    assert_eq!(request.prompt, "hello");
}

#[tokio::test]
async fn oversized_timeouts_are_rejected_before_publishing_job() {
    for timeout in [MAX_LOCAL_SUBMIT_TIMEOUT_SECS + 1, u64::MAX] {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());
        let group = "test/group";
        let group_dir = home.groups_dir().join(group);
        let mut args = submit_args_for_test();
        args.group = group.into();
        args.timeout = timeout;

        let err = run_submit_with_home(args, home).await.unwrap_err();

        assert!(matches!(&err, RunnerError::Config(_)), "got: {err:?}");
        let msg = err.to_string();
        assert!(msg.contains("--timeout"), "got: {msg}");
        assert!(msg.contains("must be <="), "got: {msg}");
        assert!(msg.contains(&timeout.to_string()), "got: {msg}");
        assert!(
            !group_dir.exists(),
            "invalid timeout must not create a local queue group directory"
        );
    }
}

#[tokio::test]
async fn serialized_job_at_size_limit_is_accepted() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let prompt_len = prompt_len_for_serialized_job_size(root, local_queue::LOCAL_JOB_MAX_BYTES);
    let mut args = submit_args_for_test();
    args.prompt = "x".repeat(prompt_len);

    let (exit_code, request) =
        run_submit_and_write_success(args, HomePaths::with_root(root.to_path_buf()))
            .await
            .unwrap();

    assert_eq!(exit_code, ExitCode::SUCCESS);
    assert_eq!(
        serde_json::to_vec(&request).unwrap().len(),
        local_queue::LOCAL_JOB_MAX_BYTES
    );
}

#[tokio::test]
async fn serialized_job_over_size_limit_is_rejected_before_publication() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let prompt_len = prompt_len_for_serialized_job_size(root, local_queue::LOCAL_JOB_MAX_BYTES) + 1;
    let mut args = submit_args_for_test();
    args.prompt = "x".repeat(prompt_len);

    let error = run_submit_with_home(args, HomePaths::with_root(root.to_path_buf()))
        .await
        .unwrap_err();

    assert!(matches!(error, RunnerError::Config(_)), "got: {error:?}");
    assert!(
        error
            .to_string()
            .contains(&local_queue::LOCAL_JOB_MAX_BYTES.to_string()),
        "got: {error}"
    );
    let job_dir = local_queue::profile_jobs_dir(
        &root.join("groups/test/group"),
        crate::profile::DEFAULT_PROFILE,
    )
    .unwrap();
    assert!(
        std::fs::read_dir(job_dir).unwrap().next().is_none(),
        "oversized request must not publish a local job"
    );
}

#[tokio::test]
async fn timeout_removes_unclaimed_job_from_queue() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let group = "test/group";
    let group_dir = home.groups_dir().join(group);
    let args = SubmitArgs {
        group: group.into(),
        prompt: "hello".into(),
        cli_agent_type: "claude-code".into(),
        profile: None,
        chat_thread_id: None,
        session_id: None,
        feature_flags: vec![],
        env: vec![],
        secret_env: vec![],
        timeout: 0,
        active_inputs: vec![],
    };

    let err = run_submit_with_home(args, home).await.unwrap_err();

    let job_dir =
        local_queue::profile_jobs_dir(&group_dir, crate::profile::DEFAULT_PROFILE).unwrap();
    let job_files: Vec<_> = std::fs::read_dir(&job_dir)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().and_then(|ext| ext.to_str()) == Some("job"))
        .collect();
    let result_files: Vec<_> = std::fs::read_dir(local_queue::results_dir(&group_dir))
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().and_then(|ext| ext.to_str()) == Some("result"))
        .collect();

    assert!(err.to_string().contains("timeout waiting for local result"));
    assert!(job_files.is_empty(), "job files left behind: {job_files:?}");
    assert!(
        result_files.is_empty(),
        "result files left behind: {result_files:?}"
    );
}
