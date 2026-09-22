use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

use super::super::{SubmitArgs, SubmitPlan};
use super::support::{mode, submit_queue_entry};
use crate::local_queue;
use runner_host::paths::HomePaths;
use runner_types::ids::RunId;

#[test]
fn write_job_file_creates_private_job_file() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let job_id = RunId::new_v4();
    let queue = submit_queue_entry(group_dir, job_id);
    std::fs::create_dir_all(queue.job.parent().unwrap()).unwrap();
    let plan = SubmitPlan {
        group: "test/group".into(),
        profile: crate::profile::DEFAULT_PROFILE.to_owned(),
        queue,
        timeout: Duration::ZERO,
        request_json: br#"{"secretEnvironment":{"ANTHROPIC_API_KEY":"sk-local-secret"}}"#.to_vec(),
        active_inputs: vec![],
    };

    plan.write_job_file().unwrap();

    let mode = std::fs::metadata(&plan.queue.job)
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(mode, runner_host::host_file::PRIVATE_FILE_MODE);
}

#[test]
fn write_job_file_removes_tmp_when_publish_fails() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let job_id = RunId::new_v4();
    let queue = submit_queue_entry(group_dir, job_id);
    std::fs::create_dir_all(queue.job.parent().unwrap()).unwrap();
    std::fs::create_dir_all(&queue.job).unwrap();
    let plan = SubmitPlan {
        group: "test/group".into(),
        profile: crate::profile::DEFAULT_PROFILE.to_owned(),
        queue,
        timeout: Duration::ZERO,
        request_json: b"{}".to_vec(),
        active_inputs: vec![],
    };

    let err = plan.write_job_file().unwrap_err();

    assert!(err.to_string().contains("rename job file"), "got: {err}");
    assert!(plan.queue.job.is_dir());
    let tmp_files: Vec<_> = std::fs::read_dir(&plan.queue.job_dir)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().and_then(|ext| ext.to_str()) == Some("tmp"))
        .collect();
    assert!(tmp_files.is_empty(), "tmp files left behind: {tmp_files:?}");
}

#[test]
fn submit_plan_creates_private_queue_dirs_and_job_file() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let home = HomePaths::with_root(root.clone());
    let group = "test/group";
    let group_dir = root.join("groups").join(group);
    let plan = SubmitPlan::from_args(
        SubmitArgs {
            group: group.into(),
            prompt: "secret prompt".into(),
            cli_agent_type: "claude-code".into(),
            profile: None,
            chat_thread_id: None,
            session_id: Some("session-123".into()),
            feature_flags: vec![],
            env: vec![],
            secret_env: vec![],
            timeout: 5,
            active_inputs: vec![],
        },
        home,
    )
    .unwrap();

    plan.write_job_file().unwrap();

    assert_eq!(mode(&plan.queue.job_dir), 0o700);
    assert_eq!(mode(&local_queue::results_dir(&group_dir)), 0o700);
    assert_eq!(mode(&local_queue::cancels_dir(&group_dir)), 0o700);
    assert_eq!(mode(&plan.queue.job), 0o600);
}

#[test]
fn submit_plan_tightens_existing_permissive_queue_dirs() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let home = HomePaths::with_root(root.clone());
    let group = "test/group";
    let group_dir = root.join("groups").join(group);
    let job_dir =
        local_queue::profile_jobs_dir(&group_dir, crate::profile::DEFAULT_PROFILE).unwrap();
    let results_dir = local_queue::results_dir(&group_dir);
    let cancels_dir = local_queue::cancels_dir(&group_dir);
    for path in [&job_dir, &results_dir, &cancels_dir] {
        std::fs::create_dir_all(path).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    let plan = SubmitPlan::from_args(
        SubmitArgs {
            group: group.into(),
            prompt: "secret prompt".into(),
            cli_agent_type: "claude-code".into(),
            profile: None,
            chat_thread_id: None,
            session_id: None,
            feature_flags: vec![],
            env: vec![],
            secret_env: vec![],
            timeout: 5,
            active_inputs: vec![],
        },
        home,
    )
    .unwrap();

    assert_eq!(mode(&plan.queue.job_dir), 0o700);
    assert_eq!(mode(&results_dir), 0o700);
    assert_eq!(mode(&cancels_dir), 0o700);
}
