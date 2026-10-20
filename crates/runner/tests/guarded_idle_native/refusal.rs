//! Ordinary provider-boundary regressions for native fixture failure custody.

use std::collections::BTreeMap;

use runner_lifecycle::home_image_cache::HomeCacheCheckoutResult;
use runner_lifecycle::home_promotion::test_support::test_home_image;
use runner_lifecycle::idle_reuse_preparation::add_healthy_reuse_preparation_matcher;
use sandbox_mock::{MockBackingProcess, MockSandbox, MockSandboxFactory, MockSandboxOverrides};
use tokio::io::AsyncReadExt;

use super::*;

#[tokio::test]
async fn unexpected_finalizing_provider_states_keep_original_data_and_full_lease() -> TestResult<()>
{
    // These are synthetic ordinary inputs, never native artifact/measurement proof.
    let inputs: fixture::Inputs = serde_json::from_value(serde_json::json!({
        "host_total_bytes": 67108864, "operating_floor_bytes": 2097152,
        "cleanup_reserve_bytes": 4194304, "critical_available_bytes": 2097152,
        "recovery_available_bytes": 8388608, "live_growth_bytes": 8388608,
        "tail_growth_bytes": 1048576, "replacement_preparation_bytes": 1048576,
        "max_sample_age_millis": 10000, "max_operations": 16, "max_cleanup_inflight": 4,
        "pressure_sample_period_millis": 50, "pressure_recovery_sustain_millis": 50,
        "pressure_wave_cooldown_millis": 50, "pressure_optional_start_interval_millis": 50,
        "pressure_max_wave_entries": 4,
    }))?;
    for (label, running, handoff_point, park_refused, expected) in [
        (
            "parked",
            true,
            None,
            false,
            "native provider did not reach requested finalizing state",
        ),
        (
            "handoff",
            true,
            Some(sandbox::SandboxFinalExecParkHandoffPoint::DuringBalloonSettle),
            false,
            "native finalizing handoff reached an unexpected physical boundary",
        ),
        (
            "refused",
            false,
            None,
            true,
            "native finalizing park/preparation failed",
        ),
    ] {
        let directory = tempfile::tempdir()?;
        let paths = RunnerPaths::new(directory.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await?;
        let cache = HomeImageCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let key = format!("thread:ordinary-refusal-{run_id}");
        let home = fixture::checkout(&cache, run_id, sandbox_id, &key, "test-rootfs").await;
        assert_eq!(home.result(), HomeCacheCheckoutResult::Miss);
        tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id)).await?;
        let image = paths.active_home_image(&sandbox_id);
        let original = test_home_image();
        tokio::fs::write(&image, &original).await?;
        tokio::fs::OpenOptions::new()
            .write(true)
            .open(&image)
            .await?
            .set_len(fixture::IMAGE_BYTES)
            .await?;
        let overrides = Arc::new(MockSandboxOverrides::new());
        add_healthy_reuse_preparation_matcher(&overrides);
        if let Some(point) = handoff_point {
            overrides.push_final_exec_park_handoff_point(point);
        }
        if park_refused {
            overrides.push_park_result(Err(sandbox::SandboxError::Start {
                message: "ordinary provider refuses park".into(),
            }));
        }
        let (_, backing) = MockBackingProcess::channel();
        let sandbox = Box::new(
            MockSandbox::with_overrides(sandbox_id.to_string(), overrides.clone())
                .with_backing_process(backing),
        );
        let factory: Arc<Box<dyn SandboxFactory>> = Arc::new(Box::new(
            MockSandboxFactory::with_overrides(overrides.clone()),
        ));
        let budget = Arc::new(ResourceBudget::new(2, 4096, 1.0, 0));
        let receipts = evidence::Case::new(
            format!("ordinary-refusal-{label}"),
            evidence::Artifacts {
                source_sha: "0".repeat(40),
                test_binary_sha256: "0".repeat(64),
                firecracker_sha256: "0".repeat(64),
                kernel_sha256: "0".repeat(64),
                rootfs_sha256: "0".repeat(64),
                policy_sha256: "0".repeat(64),
                snapshot_id: "ordinary-fixture".into(),
                snapshot_files: BTreeMap::new(),
                snapshot_preparation_sha256: "0".repeat(64),
            },
        )?;
        let result = finalizing::exercise(
            finalizing::Context {
                factory,
                cache: cache.clone(),
                sandbox,
                home,
                budget: budget.clone(),
                operations: inputs.operations()?,
                rootfs_hash: "test-rootfs".into(),
                run_id,
                sandbox_id,
                reuse_key: key.clone(),
            },
            &inputs,
            running,
            Some(&receipts),
        )
        .await;
        assert_eq!(
            result.err().map(|error| error.to_string()),
            Some(expected.into())
        );
        assert_eq!(budget.allocated(), (2, 4096, 1));
        assert_eq!(
            fixture::checkout(
                &cache,
                RunId::new_v4(),
                SandboxId::new_v4(),
                &key,
                "test-rootfs"
            )
            .await
            .result(),
            HomeCacheCheckoutResult::LockBusy
        );
        let mut retained = vec![0; original.len()];
        tokio::fs::File::open(&image)
            .await?
            .read_exact(&mut retained)
            .await?;
        assert_eq!(retained, original);
        assert_eq!(overrides.kill_call_count(), 0);
        assert_eq!(overrides.destroy_call_count(), 0);
        // Explicit ordinary mock-fixture disposal, never native completion proof.
        drop(receipts);
        assert_eq!(budget.allocated(), (0, 0, 0));
    }
    Ok(())
}
