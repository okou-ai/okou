use super::super::super::*;
use super::super::support::{
    context_with_session, mock_run_config_with_overrides, push_job, seed_home_cache_state,
    shutdown, test_profiles,
};
use guest_contracts::disk_cleanup::{DiskCleanupFilesystem, DiskCleanupReport};
use runner_host::paths::RunnerPaths;
use sandbox::{SandboxConfig, SandboxId};
use sandbox_mock::{MockLifecycleGate, MockSandboxFactory, MockSandboxOverrides};

const WAIT: Duration = Duration::from_secs(5);

#[tokio::test]
async fn exhausted_home_cleanup_prefers_existing_blank_then_bounds_cold_fallback() {
    for (blank_fails, uncertain_retirement) in [(false, false), (true, false), (false, true)] {
        let mut profiles = test_profiles();
        profiles.get_mut("vm0/default").unwrap().home_disk_mb = 16;
        // A capacity of two disables automatic blank replenishment. Seed one
        // actual parked boundary resource, so the budget assertions have no
        // unrelated background preparation reservation.
        let overrides = Arc::new(MockSandboxOverrides::new());
        let (mut config, env) =
            mock_run_config_with_overrides(profiles, 16, 32_768, 2, overrides.clone());
        let budget = config.capacity.budget.clone();
        let factory: crate::SharedFactory = Arc::new(Box::new(MockSandboxFactory::with_overrides(
            overrides.clone(),
        )));
        let blank_id = SandboxId::new_v4();
        let mut blank = factory
            .create(SandboxConfig {
                id: blank_id,
                resources: sandbox::ResourceLimits {
                    cpu_count: 2,
                    memory_mb: 4096,
                },
                device_rate_limits: None,
                home_drive: Some(sandbox::HomeDriveConfig {
                    space_reserve: runner_lifecycle::home_image_cache::HOME_IMAGE_SPACE_RESERVE,
                    size_mb: 16,
                    seed_image: None,
                }),
            })
            .await
            .unwrap();
        blank.park_for_blank_pool().await.unwrap();
        let candidate = crate::idle_pool::ParkedIdleCandidate::blank(
            blank,
            factory,
            ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap(),
            blank_id,
            "vm0/default".into(),
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
            None,
        );
        assert!(matches!(
            env.idle_pool.lock().await.park(candidate),
            crate::idle_pool::ParkResult::Parked
        ));
        let paths = RunnerPaths::new(config.paths.base_dir.clone());
        let cache = HomeImageCache::shared(paths.clone(), &config.paths.home, &config.runner.group);
        let reuse_key = "thread:disk-blank-recovery";
        seed_home_cache_state(&cache, &paths, reuse_key, "vm0/default", 16 * 1024 * 1024).await;
        Arc::get_mut(&mut config.exec_config).unwrap().home_cache = Some(cache);
        for _ in 0..if blank_fails { 2 } else { 1 } {
            overrides.push_private_write_files_result(Err(sandbox::SandboxError::Operation {
                operation: sandbox::SandboxOperation::WriteFile,
                reason: sandbox::SandboxOperationReason::Guest,
                message: "No space left on device (os error 28)".into(),
            }));
            overrides.add_exec_matcher(sandbox_mock::ExecMatcher {
                pattern: "recover-disk-space home".into(),
                exit_code: 0,
                stdout: serde_json::to_vec(&DiskCleanupReport {
                    filesystem: DiskCleanupFilesystem::Home,
                    available_bytes_before: 0,
                    available_bytes_after: 1024,
                    available_inodes_before: 1024,
                    available_inodes_after: 1024,
                    removed_entries: 0,
                })
                .unwrap(),
                stderr: Vec::new(),
            });
        }
        overrides.add_persistent_exec_matcher(sandbox_mock::ExecMatcher {
            pattern:"guest-agent-binary".into(), exit_code:0,
            stdout:b"VM0_DF_BLOCKS_V1\n/dev/root 12000000 6000000 6000000 50% /\n/dev/vdb 24000000 24000000 0 100% /home/user\nVM0_DF_INODES_V1\n/dev/root 800000 100000 700000 13% /\n/dev/vdb 1500000 300000 1200000 20% /home/user\n".to_vec(), stderr:Vec::new(),
        });
        if uncertain_retirement {
            overrides.push_destroy_panic("disk-full resource retirement uncertain");
        }
        let wait = MockLifecycleGate::new();
        overrides.set_wait_process_lifecycle_gate(wait.clone());
        let run_id = RunId::new_v4();
        let mut context = context_with_session(run_id, "disk-blank-recovery");
        context.reuse_key = Some(reuse_key.into());
        context.prompt = "Current input survives every resource replacement".into();
        let task = tokio::spawn(run(config));
        push_job(&env, run_id, "vm0/default", Some(context));
        if uncertain_retirement {
            let completion = env.handle.wait_completion(run_id, WAIT).await.unwrap();
            assert_ne!(completion.exit_code, 0);
            assert_eq!(overrides.create_configs().len(), 2);
            assert!(overrides.start_agent_process_calls().is_empty());
            // Both the untouched blank and uncertain original VM retain their
            // own capacity after provider completion; no cold VM is created.
            assert_eq!(budget.allocated(), (4, 8192, 2));
            let status: serde_json::Value = serde_json::from_slice(
                &tokio::fs::read(env._temp_dir.path().join("status.json"))
                    .await
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(
                status["active_runs"][0]["sandbox_id"],
                overrides.create_configs()[1].id.to_string()
            );
            shutdown(&env, task).await;
            assert_eq!(budget.allocated(), (0, 0, 0));
            env.assert_startup_report_calls(0);
            continue;
        }
        wait.wait_entered(1, WAIT).await.unwrap();
        assert_eq!(overrides.start_agent_process_calls().len(), 1);
        assert_eq!(budget.allocated(), (2, 4096, 1));
        let status: serde_json::Value = serde_json::from_slice(
            &tokio::fs::read(env._temp_dir.path().join("status.json"))
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(status["active_runs"][0]["sandbox_id"], blank_id.to_string());
        assert_eq!(status["active_runs"][0]["phase"], "running");
        let expected = if blank_fails { "cold" } else { "blank" };
        let launches = overrides.start_agent_process_calls();
        assert!(launches[0].env.iter().any(|(key, value)| key
            == guest_contracts::env::CANONICAL_SANDBOX_STARTUP_PATH_ENV
            && value == expected));
        let creates = overrides.create_configs();
        assert_eq!(creates.len(), if blank_fails { 3 } else { 2 });
        assert!(creates[1].home_drive.as_ref().unwrap().seed_image.is_some());
        if blank_fails {
            assert_eq!(creates[2].id, blank_id);
            assert!(creates[2].home_drive.as_ref().unwrap().seed_image.is_none());
        }
        env.drain();
        wait.release_one();
        let completion = env.handle.wait_completion(run_id, WAIT).await.unwrap();
        assert_eq!(completion.exit_code, 0);
        assert_eq!(completion.sandbox_id, Some(blank_id));
        shutdown(&env, task).await;
        assert_eq!(budget.allocated(), (0, 0, 0));
        assert_eq!(env.handle.completions.lock().unwrap().len(), 1);
        env.assert_startup_report_calls(1);
    }
}
