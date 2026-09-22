use super::super::super::*;
use super::super::support::{
    minimal_context, mock_run_config_with_overrides, push_job, shutdown, test_profiles,
    wait_budget_count, wait_cancel_handle,
};
use crate::workspace_image_cache::WorkspaceImageCache;
use runner_host::paths::RunnerPaths;
use sandbox::{ExecResult, SandboxError, SandboxOperation, SandboxOperationReason};
use sandbox_mock::{MockLifecycleGate, MockSandboxOverrides};
use tracing::Level;
use tracing_subscriber::prelude::*;
use tracing_test_support::CapturedEvents;

#[tokio::test]
async fn startup_finalization_classifies_cache_failures_and_preserves_healthy_cancelled_cache() {
    for (cancelled, failure, expected_level) in [
        (true, None, None),
        (
            true,
            Some(SandboxOperationReason::GuestConnectionUnavailable),
            Some(Level::INFO),
        ),
        (true, Some(SandboxOperationReason::Guest), Some(Level::WARN)),
        (
            true,
            Some(SandboxOperationReason::BackendCrashed),
            Some(Level::WARN),
        ),
        (
            false,
            Some(SandboxOperationReason::GuestConnectionUnavailable),
            Some(Level::WARN),
        ),
    ] {
        let captured = CapturedEvents::default();
        let _subscriber =
            tracing::subscriber::set_default(tracing_subscriber::registry().with(captured.clone()));
        let overrides = Arc::new(MockSandboxOverrides::new());
        let private_write_gate = MockLifecycleGate::new();
        overrides.set_private_write_file_lifecycle_gate(private_write_gate.clone());
        if let Some(reason) = failure {
            if reason == SandboxOperationReason::Guest {
                overrides.add_exec_result_matcher(
                    "\"$workspace_fsfreeze_path\" --freeze",
                    ExecResult::new(1, Vec::new(), b"filesystem freeze failed".to_vec()),
                );
            } else {
                overrides.add_exec_error_matcher(
                    "\"$workspace_fsfreeze_path\" --freeze",
                    SandboxError::Operation {
                        operation: SandboxOperation::Exec,
                        reason,
                        message: "guest operation unavailable".into(),
                    },
                );
            }
        }
        let mut profiles = test_profiles();
        profiles.get_mut("vm0/default").unwrap().workspace_disk_mb = 16;
        let (mut config, env) =
            mock_run_config_with_overrides(profiles, 8, 32768, 4, Arc::clone(&overrides));
        let paths = RunnerPaths::new(config.paths.base_dir.clone());
        let cache =
            WorkspaceImageCache::shared(paths.clone(), &config.paths.home, &config.runner.group);
        Arc::get_mut(&mut config.exec_config)
            .unwrap()
            .workspace_cache = Some(cache.clone());
        let budget = Arc::clone(&config.capacity.budget);
        let run_handle = tokio::spawn(run(config));
        let run_id = RunId::new_v4();
        let mut context = minimal_context(run_id);
        context.reuse_key = Some("thread:cancelled-promotion".into());
        push_job(&env, run_id, "vm0/default", Some(context));
        private_write_gate
            .wait_entered(1, Duration::from_secs(5))
            .await
            .unwrap();

        let sandbox_id = overrides.create_configs()[0].id;
        let active_image = paths.active_workspace_image(&sandbox_id);
        tokio::fs::create_dir_all(active_image.parent().unwrap())
            .await
            .unwrap();
        let file = tokio::fs::File::create(&active_image).await.unwrap();
        file.set_len(16 * 1024 * 1024).await.unwrap();
        drop(file);
        if cancelled {
            let cancel =
                wait_cancel_handle(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
            cancel.request_cooperative_user_cancellation().await;
        } else {
            overrides.push_private_write_files_result(Err(SandboxError::Io(
                std::io::Error::other("private preparation failed"),
            )));
            overrides.clear_private_write_file_lifecycle_gate();
            private_write_gate.release_one();
        }

        let completion = env
            .handle
            .wait_completion(run_id, Duration::from_secs(5))
            .await
            .unwrap();
        if cancelled {
            assert_eq!(completion.exit_code, 137);
            assert_eq!(completion.error.as_deref(), Some("cancelled by user"));
        } else {
            assert_eq!(completion.exit_code, 1);
            assert!(
                completion
                    .error
                    .as_deref()
                    .unwrap()
                    .contains("private preparation failed")
            );
        }
        wait_budget_count(&budget, 0, Duration::from_secs(5)).await;
        assert_eq!(overrides.stop_call_count(), 1);
        assert_eq!(overrides.destroy_call_count(), 1);
        assert_eq!(env.idle_pool.lock().await.len(), 0);

        // Budget release does not drain heartbeat cache scans. Stop the runner
        // before inspecting the cache so its nonblocking scan cannot skip a
        // healthy entry whose lock is held by a concurrent heartbeat refresh.
        shutdown(&env, run_handle).await;
        let states = cache.held_workspace_states().await;
        assert_eq!(states.len(), usize::from(failure.is_none()));

        let events = captured.entries();
        let promotion_failure = events.iter().find(|event| {
            event.fields.get("message").map(String::as_str)
                == Some("workspace image cache promotion skipped because guest freeze failed")
        });
        assert_eq!(promotion_failure.map(|event| event.level), expected_level);
        if let Some(event) = promotion_failure {
            assert_eq!(event.fields.get("run_id"), Some(&run_id.to_string()));
            assert_eq!(
                event
                    .fields
                    .get("skipped_after_cancellation")
                    .map(String::as_str),
                Some(if expected_level == Some(Level::INFO) {
                    "true"
                } else {
                    "false"
                })
            );
        }
    }
}
