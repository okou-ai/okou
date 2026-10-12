use std::io;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::time::Duration;

use futures_util::FutureExt;
use runner_executor::test_fixtures::guest_control::GuestControlFixture;
use runner_provider::local_queue::{self, ActiveInputEntry, LocalQueue};
use runner_provider::{ActiveInputSource, JobCandidate, local_active_input_event_id};
use runner_types::ids::RunId;
use sandbox_mock::{MockLifecycleGate, MockSandboxOverrides};

use super::super::super::run;
use super::super::support::{
    minimal_context, mock_run_config_with_overrides, shutdown, test_profiles, wait_budget_count,
    wait_cancel_handle, wait_cancel_token_removed,
};

const TEST_TIMEOUT: Duration = Duration::from_secs(5);

enum CompletionPath {
    HardCancellation,
    TerminalWaitTimeout,
    Delivered,
}

async fn assert_active_input_completion(path: CompletionPath) {
    let wait_limit =
        matches!(path, CompletionPath::TerminalWaitTimeout).then_some(Duration::from_millis(25));
    let mut socket = GuestControlFixture::start(wait_limit).await;
    let wait_gate = MockLifecycleGate::new();
    let destroy_gate = MockLifecycleGate::new();
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_start_agent_process_handle(socket.take_process());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    overrides.set_destroy_lifecycle_gate(destroy_gate.clone());
    let (config, env) =
        mock_run_config_with_overrides(test_profiles(), 2, 4096, 1, Arc::clone(&overrides));
    let budget = Arc::clone(&config.capacity.budget);
    let run_id = RunId::new_v4();
    let group_dir = env._temp_dir.path().join("active-input");
    let profile = runner_types::profile_name::DEFAULT_PROFILE;
    local_queue::ensure_profile_jobs_dir(&group_dir, profile).unwrap();
    local_queue::write_private_file(
        &local_queue::job_path(&group_dir, profile, run_id).unwrap(),
        b"{}",
        "active-input regression job",
    )
    .unwrap();
    let queue = LocalQueue::new(group_dir);
    let text = if matches!(path, CompletionPath::Delivered) {
        "normal follow-up".to_owned()
    } else {
        "x".repeat(512 * 1024)
    };
    queue
        .write_active_input_sync(&ActiveInputEntry {
            run_id,
            sequence: 1,
            text: text.clone(),
        })
        .unwrap();
    if !matches!(path, CompletionPath::Delivered) {
        queue
            .write_active_input_sync(&ActiveInputEntry {
                run_id,
                sequence: 2,
                text: "must not be sent after shutdown".to_owned(),
            })
            .unwrap();
    }
    env.provider.set_claim_with_active_input(
        run_id,
        minimal_context(run_id),
        ActiveInputSource::local_queue(queue, run_id),
    );
    env.handle
        .discover_tx
        .send(JobCandidate::new(run_id, profile.into()))
        .unwrap();
    let run_task = tokio::spawn(run(config));

    // Always close real I/O and reap the reactor, even when a regression causes
    // an assertion/deadline to fail. Closing the fixture also unblocks old code.
    let assertions = AssertUnwindSafe(async {
        wait_gate.wait_entered(1, TEST_TIMEOUT).await.unwrap();
        let remaining = if matches!(path, CompletionPath::Delivered) {
            let message = socket.read_control().await;
            let control = runner_executor::test_fixtures::guest_control::decode_control(&message);
            assert_eq!(control, (local_active_input_event_id(run_id, 1), text));
            socket.acknowledge(&message).await;
            socket.finish().await;
            None
        } else {
            Some(socket.observe_partial_control().await)
        };

        match path {
            CompletionPath::HardCancellation => {
                let cancellation =
                    wait_cancel_handle(&env.cancel_tokens, run_id, TEST_TIMEOUT).await;
                assert!(cancellation.request_hard_cancellation().await);
                let result = tokio::time::timeout(TEST_TIMEOUT, &mut socket.cancel_result)
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(result, Err(io::ErrorKind::TimedOut));
                // Cancel expired in the writer queue. Completion must still
                // follow without draining the original blocked control frame.
            }
            CompletionPath::TerminalWaitTimeout | CompletionPath::Delivered => {
                wait_gate.release_one();
                let result = tokio::time::timeout(TEST_TIMEOUT, &mut socket.wait_result)
                    .await
                    .unwrap()
                    .unwrap();
                if matches!(path, CompletionPath::TerminalWaitTimeout) {
                    assert_eq!(result, Err(io::ErrorKind::TimedOut));
                    assert!(socket.client.reserve_external_operation().is_err());
                } else {
                    assert_eq!(result, Ok(()));
                }
            }
        }

        let completion = env
            .handle
            .wait_completion(run_id, TEST_TIMEOUT)
            .await
            .expect("active-input shutdown must not block claimed-run completion");
        if matches!(path, CompletionPath::Delivered) {
            assert_eq!(completion.exit_code, 0);
            assert!(completion.error.is_none());
        } else {
            assert_ne!(completion.exit_code, 0);
            assert!(completion.error.is_some());
        }
        destroy_gate
            .wait_entered(1, TEST_TIMEOUT)
            .await
            .expect("sandbox finalization must follow bounded forwarding shutdown");
        if let Some(remaining) = remaining {
            socket.assert_partial_write_closed(remaining).await;
        } else {
            assert!(socket.client.reserve_external_operation().is_ok());
        }
        destroy_gate.release_one();
        wait_cancel_token_removed(&env.cancel_tokens, run_id, TEST_TIMEOUT).await;
        wait_budget_count(&budget, 0, TEST_TIMEOUT).await;
        assert_eq!(overrides.destroy_call_count(), 1);
        assert_eq!(overrides.park_call_count(), 0);
        assert_eq!(env.handle.completions.lock().unwrap().len(), 1);
    })
    .catch_unwind()
    .await;

    destroy_gate.release_one();
    wait_gate.release_one();
    drop(socket);
    shutdown(&env, run_task).await;
    if let Err(panic) = assertions {
        std::panic::resume_unwind(panic);
    }
}

#[tokio::test]
async fn active_input_partial_write_hard_cancel_completes_and_finalizes() {
    assert_active_input_completion(CompletionPath::HardCancellation).await;
}

#[tokio::test]
async fn active_input_partial_write_terminal_wait_timeout_completes_and_finalizes() {
    assert_active_input_completion(CompletionPath::TerminalWaitTimeout).await;
}

#[tokio::test]
async fn active_input_socket_delivery_preserves_successful_completion_and_finalization() {
    assert_active_input_completion(CompletionPath::Delivered).await;
}
