use std::process::ExitCode;
use std::time::Duration;

use super::super::{ActiveInputProducer, DelayedActiveInput, SubmitPlan, run_submit_with_home};
use super::support::{submit_args_for_test, submit_queue_entry, write_queue_job_file};
use runner_host::paths::HomePaths;
use runner_provider::local_queue::{self, JobRequest, JobResponse};
use runner_provider::{
    ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES, identified_active_input_payload_len,
};
use runner_types::ids::RunId;

const TEST_QUEUE_WATCH_TIMEOUT: Duration = Duration::from_secs(5);
const TEST_QUEUE_WATCH_INTERVAL: Duration = Duration::from_millis(1);

async fn wait_for_active_inputs_and_write_success(
    group_dir: std::path::PathBuf,
    profile: String,
    expected_inputs: usize,
) -> (JobRequest, Vec<local_queue::ActiveInputEntry>) {
    let job_dir = local_queue::profile_jobs_dir(&group_dir, &profile).unwrap();
    let queue = local_queue::LocalQueue::new(group_dir.clone());
    let deadline = tokio::time::Instant::now() + TEST_QUEUE_WATCH_TIMEOUT;
    let mut last_seen_inputs = 0;
    loop {
        if let Ok(entries) = std::fs::read_dir(&job_dir) {
            for entry in entries.filter_map(Result::ok) {
                let path = entry.path();
                if path.extension().and_then(|ext| ext.to_str()) != Some("job") {
                    continue;
                }
                let request: JobRequest =
                    serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
                let inputs = queue.read_active_input_entries_from_sequence_sync(request.job_id, 0);
                last_seen_inputs = last_seen_inputs.max(inputs.len());
                if inputs.len() < expected_inputs {
                    continue;
                }
                let response = JobResponse {
                    run_id: request.job_id,
                    exit_code: 0,
                    error: None,
                };
                let result_path = local_queue::result_path(&group_dir, request.job_id);
                std::fs::create_dir_all(result_path.parent().unwrap()).unwrap();
                std::fs::write(&result_path, serde_json::to_vec(&response).unwrap()).unwrap();
                return (request, inputs);
            }
        }

        if tokio::time::Instant::now() >= deadline {
            panic!(
                "timed out waiting for {expected_inputs} local active inputs in {} (last seen: {last_seen_inputs})",
                job_dir.display()
            );
        }
        tokio::time::sleep(TEST_QUEUE_WATCH_INTERVAL).await;
    }
}

#[test]
fn parses_active_input_specs() {
    let parsed = SubmitPlan::parse_active_inputs(
        &[
            "after=250ms,text=first".to_string(),
            "after=1s,text=second,with,commas".to_string(),
        ],
        Duration::from_secs(5),
    )
    .unwrap();

    assert_eq!(
        parsed,
        vec![
            DelayedActiveInput {
                sequence: 1,
                after: Duration::from_millis(250),
                text: "first".to_string(),
            },
            DelayedActiveInput {
                sequence: 2,
                after: Duration::from_secs(1),
                text: "second,with,commas".to_string(),
            },
        ]
    );
}

#[test]
fn parses_more_than_eight_active_input_specs() {
    let values = (1..=9)
        .map(|sequence| format!("after={sequence}ms,text=input-{sequence}"))
        .collect::<Vec<_>>();
    let parsed = SubmitPlan::parse_active_inputs(&values, Duration::from_secs(5)).unwrap();

    assert_eq!(parsed.len(), 9);
    assert_eq!(parsed[8].sequence, 9);
    assert_eq!(parsed[8].text, "input-9");
}

#[test]
fn rejects_invalid_active_input_specs() {
    for value in [
        "text=missing-after",
        "after=1m,text=bad-unit",
        "after=0s,text=zero",
        "after=1s,text=",
        "after=5s,text=timeout",
        "after=1s,text=bad\0nul",
    ] {
        let err = SubmitPlan::parse_active_inputs(&[value.to_string()], Duration::from_secs(5))
            .unwrap_err();

        assert!(
            err.to_string().contains("active-input"),
            "value={value}, got: {err}"
        );
    }

    let err = SubmitPlan::parse_active_inputs(
        &[
            "after=2s,text=first".to_string(),
            "after=1s,text=second".to_string(),
        ],
        Duration::from_secs(5),
    )
    .unwrap_err();
    assert!(err.to_string().contains("non-decreasing"));

    let oversized_text = "x".repeat(ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES);
    let err = SubmitPlan::parse_active_inputs(
        &[format!("after=1s,text={oversized_text}")],
        Duration::from_secs(5),
    )
    .unwrap_err();
    assert!(err.to_string().contains("serialized payload"));
}

#[test]
fn accepts_active_input_payload_at_serialized_limit() {
    let payload_overhead = identified_active_input_payload_len("").unwrap();
    let exact_limit_text = "x".repeat(ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES - payload_overhead);

    let parsed = SubmitPlan::parse_active_inputs(
        &[format!("after=1s,text={exact_limit_text}")],
        Duration::from_secs(5),
    )
    .unwrap();

    assert_eq!(parsed.len(), 1);
    assert_eq!(
        identified_active_input_payload_len(&parsed[0].text).unwrap(),
        ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES
    );
}

#[test]
fn accepts_active_input_for_codex_agent() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let mut args = submit_args_for_test();
    args.cli_agent_type = "codex".to_string();
    args.active_inputs = vec!["after=1ms,text=hello".to_string()];

    let plan = SubmitPlan::from_args(args, home).unwrap();
    let request: JobRequest = serde_json::from_slice(&plan.request_json).unwrap();
    assert_eq!(request.cli_agent_type, "codex");
    assert_eq!(request.active_input, Some(true));
    assert_eq!(plan.active_inputs.len(), 1);
}

#[test]
fn accepts_active_input_for_custom_agent_that_defaults_to_claude() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let mut args = submit_args_for_test();
    args.cli_agent_type = "custom-agent".to_string();
    args.active_inputs = vec!["after=1ms,text=hello".to_string()];

    SubmitPlan::from_args(args, home).unwrap();
}

#[tokio::test]
async fn active_inputs_are_written_after_job_publication_and_cleaned_on_completion() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let group = "test/group";
    let group_dir = home.groups_dir().join(group);
    let watcher = tokio::spawn(wait_for_active_inputs_and_write_success(
        group_dir.clone(),
        crate::profile::DEFAULT_PROFILE.to_owned(),
        9,
    ));
    let mut args = submit_args_for_test();
    args.group = group.into();
    args.timeout = 5;
    args.active_inputs = (1..=9)
        .map(|sequence| {
            let text = if sequence == 2 {
                "second,with,comma".to_string()
            } else {
                format!("input-{sequence}")
            };
            format!("after={sequence}ms,text={text}")
        })
        .collect();
    let expected_inputs = (1..=9)
        .map(|sequence| {
            let text = if sequence == 2 {
                "second,with,comma".to_string()
            } else {
                format!("input-{sequence}")
            };
            (sequence, text)
        })
        .collect::<Vec<_>>();

    let code = run_submit_with_home(args, home).await.unwrap();
    let (request, inputs) = watcher.await.unwrap();

    assert_eq!(code, ExitCode::SUCCESS);
    assert_eq!(request.prompt, "hello");
    assert_eq!(request.active_input, Some(true));
    assert_eq!(
        inputs
            .iter()
            .map(|entry| (entry.sequence, entry.text.clone()))
            .collect::<Vec<_>>(),
        expected_inputs
    );
    assert!(
        !local_queue::run_inputs_dir(&group_dir, request.job_id).exists(),
        "completed submit cleanup should remove local active-input files"
    );
}

#[tokio::test]
async fn active_input_producer_stops_after_write_failure_to_preserve_sequence_order() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let job_id = RunId::new_v4();
    let queue = submit_queue_entry(group_dir, job_id);
    write_queue_job_file(group_dir, crate::profile::DEFAULT_PROFILE, job_id);
    local_queue::ensure_run_inputs_dir(group_dir, job_id).unwrap();
    std::fs::write(
        local_queue::active_input_path(group_dir, job_id, 1),
        b"not-json",
    )
    .unwrap();

    let producer = ActiveInputProducer::start(
        queue,
        vec![
            DelayedActiveInput {
                sequence: 1,
                after: Duration::ZERO,
                text: "first".to_string(),
            },
            DelayedActiveInput {
                sequence: 2,
                after: Duration::ZERO,
                text: "second".to_string(),
            },
        ],
    )
    .unwrap();

    tokio::time::timeout(TEST_QUEUE_WATCH_TIMEOUT, producer.task)
        .await
        .unwrap()
        .unwrap();

    assert!(
        !local_queue::active_input_path(group_dir, job_id, 2).exists(),
        "producer should not create a sequence gap after an active-input write failure"
    );
}
