#![cfg(test)]
#![cfg(unix)]

use std::ffi::OsString;
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use runner_provider::local_queue::{self, ActiveInputEntry, JobRequest, LocalQueue};
use runner_types::ids::RunId;

fn entries(path: &Path) -> Vec<OsString> {
    let mut names: Vec<_> = std::fs::read_dir(path)
        .expect("list queue publication directory")
        .map(|entry| {
            entry
                .expect("read queue publication directory entry")
                .file_name()
        })
        .collect();
    names.sort();
    names
}

fn submit_job(group: &Path, run_id: RunId) {
    let profile = "vm0/default";
    local_queue::ensure_profile_jobs_dir(group, profile).expect("prepare private job directory");
    let path = local_queue::job_path(group, profile, run_id).expect("derive valid job path");
    let request = JobRequest {
        job_id: run_id,
        prompt: "initial prompt".into(),
        cli_agent_type: "claude-code".into(),
        vars: None,
        environment: None,
        secret_environment: None,
        user_timezone: None,
        profile: Some(profile.into()),
        reuse_key: None,
        session_id: None,
        feature_flags: None,
        active_input: Some(true),
    };
    local_queue::write_private_file(
        &path,
        &serde_json::to_vec(&request).expect("serialize local job request"),
        "local job file",
    )
    .expect("publish private job request");
}

#[test]
fn active_input_publication_retires_staging_without_overwriting_a_sequence() {
    let dir = tempfile::tempdir().unwrap();
    let group = dir.path().join("group");
    let queue = LocalQueue::new(group.clone());
    let run_id = RunId::new_v4();
    submit_job(&group, run_id);
    let entry = ActiveInputEntry {
        run_id,
        sequence: 7,
        text: "keep\nλ".into(),
    };
    let path = local_queue::active_input_path(&group, run_id, entry.sequence);
    let run_dir = local_queue::run_inputs_dir(&group, run_id);
    let expected = format!(r#"{{"runId":"{run_id}","sequence":7,"text":"keep\nλ"}}"#);

    queue.write_active_input_sync(&entry).unwrap();

    assert_eq!(std::fs::read(&path).unwrap(), expected.as_bytes());
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o7777,
        0o600
    );
    assert_eq!(
        entries(&run_dir),
        vec![path.file_name().unwrap().to_os_string()]
    );
    assert_eq!(queue.read_active_input_entry_sync(run_id, 7), Some(entry));

    let error = queue
        .write_active_input_sync(&ActiveInputEntry {
            run_id,
            sequence: 7,
            text: "replacement must not publish".into(),
        })
        .unwrap_err();

    assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
    assert!(error.to_string().starts_with(&format!(
        "publish local active-input file {}: ",
        path.display()
    )));
    assert_eq!(std::fs::read(&path).unwrap(), expected.as_bytes());
    assert_eq!(
        entries(&run_dir),
        vec![path.file_name().unwrap().to_os_string()]
    );
}

#[test]
fn result_publication_retires_staging_on_replacement_and_rename_failure() {
    let dir = tempfile::tempdir().unwrap();
    let group = dir.path().join("group");
    let queue = LocalQueue::new(group.clone());
    let run_id = RunId::new_v4();
    let marker = queue
        .write_abandoned_result_marker_sync(run_id, "abandoned")
        .unwrap();
    let path = local_queue::result_path(&group, run_id);
    let result_dir = local_queue::results_dir(&group);
    let expected = format!(r#"{{"run_id":"{run_id}","exit_code":7,"error":"line\nλ"}}"#);

    assert!(queue.write_result_sync(run_id, 7, Some("line\nλ")));
    marker.remove_if_unchanged();

    assert_eq!(std::fs::read(&path).unwrap(), expected.as_bytes());
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o7777,
        0o600
    );
    assert_eq!(
        entries(&result_dir),
        vec![path.file_name().unwrap().to_os_string()]
    );

    let blocked_id = RunId::new_v4();
    let blocked = local_queue::result_path(&group, blocked_id);
    std::fs::create_dir(&blocked).unwrap();
    let sentinel = blocked.join("keep");
    std::fs::write(&sentinel, b"independent contents").unwrap();

    assert!(!queue.write_result_sync(blocked_id, 0, None));

    let mut expected_names = vec![
        path.file_name().unwrap().to_os_string(),
        blocked.file_name().unwrap().to_os_string(),
    ];
    expected_names.sort();
    assert_eq!(entries(&result_dir), expected_names);
    assert_eq!(entries(&blocked), vec![OsString::from("keep")]);
    assert_eq!(std::fs::read(sentinel).unwrap(), b"independent contents");
    assert_eq!(std::fs::read(path).unwrap(), expected.as_bytes());
}
