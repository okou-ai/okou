use super::super::{ExecutionHooks, NewSandboxDispatch, execute_job_with_prepared_notifier};
use super::support::{
    api_storage, default_params, minimal_context, sandbox_write_file_error,
    test_executor_config_with_startup_api,
};
use crate::test_fixtures::raw_http::{RawHttpAction, RawHttpTestServer, http_response};
use runner_provider::RunCancellationHandle;
use runner_types::storage_manifest::StorageManifest;
use runner_types::types::SandboxReuseResult;
use sandbox::{ExecResult, SandboxId};
use sandbox_mock::{MockLifecycleGate, MockSandboxFactory, MockSandboxOverrides};
use std::sync::Arc;
use std::time::Duration;

fn archive() -> Vec<u8> {
    let gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::none());
    let mut tar = tar::Builder::new(gzip);
    let mut header = tar::Header::new_ustar();
    header.set_mode(0o644);
    header.set_size(7);
    header.set_cksum();
    tar.append_data(&mut header, "value", &b"content"[..])
        .unwrap();
    tar.into_inner().unwrap().finish().unwrap()
}

#[tokio::test]
async fn early_storage_application_joins_both_owners_before_spawn_or_terminal_failure() {
    for failure in ["none", "guest", "ready", "abort", "cooperative", "hard"] {
        let temp = tempfile::tempdir().unwrap();
        let (config, _startup_api) = test_executor_config_with_startup_api(temp.path()).await;
        let body = archive();
        let warm = config.home.storage_cache_dir("ready", "v1");
        tokio::fs::create_dir_all(&warm).await.unwrap();
        tokio::fs::write(warm.join("archive.tar.gz"), &body)
            .await
            .unwrap();
        let (release, waiting) = tokio::sync::oneshot::channel();
        let disconnected = matches!(failure, "guest" | "cooperative" | "hard");
        let action = if disconnected {
            RawHttpAction::WaitForDisconnect
        } else {
            RawHttpAction::WaitThenRespond {
                release: waiting,
                response: http_response("200 OK", &body),
            }
        };
        let server = RawHttpTestServer::spawn(vec![action]).await;
        let mut cold = api_storage(
            "pending",
            "/mnt/pending",
            "v1",
            &format!("{}/archive", server.url()),
        );
        cold.archive_size = Some(body.len() as u64);
        let mut context = minimal_context();
        context.storage_manifest = Some(StorageManifest {
            storages: vec![
                cold,
                api_storage("ready", "/mnt/ready", "v1", "https://example.test/ready"),
            ],
            artifacts: Vec::new(),
        });
        let overrides = Arc::new(MockSandboxOverrides::new());
        let application = MockLifecycleGate::new();
        overrides.set_storage_manifest_lifecycle_gate(application.clone());
        overrides.push_storage_manifest_result(Ok(ExecResult::new(
            0,
            b"true\n".to_vec(),
            Vec::new(),
        )));
        if failure == "guest" {
            overrides.push_storage_manifest_result(Ok(ExecResult::new(
                1,
                Vec::new(),
                b"consumer failed".to_vec(),
            )));
        }
        if matches!(failure, "ready" | "abort") {
            overrides.push_storage_manifest_result(Ok(ExecResult::new(
                1,
                Vec::new(),
                b"secondary consumer abort".to_vec(),
            )));
            overrides.push_private_write_files_result(Err(sandbox_write_file_error(
                "ready publication failed",
            )));
        }
        if failure == "abort" {
            overrides.push_private_write_file_result(Err(sandbox_write_file_error(
                "abort publication failed",
            )));
        }
        let cancel = RunCancellationHandle::new();
        let signals = cancel.signals();
        let task = tokio::spawn({
            let overrides = overrides.clone();
            async move {
                let factory = MockSandboxFactory::with_overrides(overrides);
                let (mut outcome, telemetry) = execute_job_with_prepared_notifier(
                    &factory,
                    context,
                    NewSandboxDispatch {
                        id: SandboxId::new_v4(),
                        reuse_result: SandboxReuseResult::PoolMiss,
                    },
                    &config,
                    &default_params(),
                    signals,
                    ExecutionHooks::none(),
                )
                .await;
                if let Some(report) = outcome.startup_report.take() {
                    report.finish().await;
                }
                config.background_fill.shutdown().await;
                config.decoded_cache.shutdown().await;
                (outcome, telemetry)
            }
        });
        application
            .wait_entered(1, Duration::from_secs(5))
            .await
            .unwrap();
        application.release_one();
        application
            .wait_entered(2, Duration::from_secs(5))
            .await
            .unwrap();
        assert!(overrides.start_agent_process_calls().is_empty());
        assert!(!task.is_finished());
        if failure == "cooperative" {
            assert!(cancel.request_cooperative_user_cancellation().await);
        }
        if failure == "hard" {
            assert!(cancel.request_hard_cancellation().await);
        }
        if disconnected {
            drop(release);
        } else {
            release.send(()).unwrap();
        }
        if matches!(failure, "ready" | "abort" | "cooperative") {
            tokio::time::timeout(Duration::from_secs(5), async {
                while overrides.private_write_file_calls().is_empty() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("the failed producer must attempt its bound abort");
            assert!(
                !task.is_finished(),
                "even a failed abort cannot abandon accepted application"
            );
        }
        if failure != "hard" {
            application.release_one();
        }
        let (outcome, telemetry) = tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap();
        if failure == "none" {
            assert_eq!(outcome.exit_code(), 0, "{:?}", outcome.error());
            assert_eq!(overrides.start_agent_process_calls().len(), 1);
            assert!(outcome.storage_fingerprints.storages["/mnt/pending"].matches("pending", "v1"));
        } else {
            assert!(overrides.start_agent_process_calls().is_empty());
            assert!(
                !outcome.storage_fingerprints.storages["/mnt/pending"].matches("pending", "v1")
            );
            assert!(!outcome.storage_fingerprints.storages["/mnt/ready"].matches("ready", "v1"));
            if matches!(failure, "ready" | "abort") {
                assert!(
                    outcome
                        .error()
                        .unwrap()
                        .contains("ready publication failed"),
                    "{:?}",
                    outcome.error()
                );
            }
            if failure == "guest" {
                assert!(
                    outcome.error().unwrap().contains("consumer failed"),
                    "{:?}",
                    outcome.error()
                );
            }
        }
        server.assert_finished_with_requests().await;
        if failure == "hard" {
            assert!(
                telemetry
                    .pending_ops_snapshot()
                    .iter()
                    .any(|(action, _, _)| action == "runner_storage_manifest_batch_prepare"),
                "hard cancellation must retain observations already recorded by the application"
            );
        }
    }
}

#[tokio::test]
async fn warm_storage_application_cannot_spawn_before_both_accepted_operations_settle() {
    for failure in ["none", "guest", "stage", "cooperative", "hard"] {
        let temp = tempfile::tempdir().unwrap();
        let (config, _startup_api) = test_executor_config_with_startup_api(temp.path()).await;
        let body = archive();
        for name in ["ready", "warm"] {
            let directory = config.home.storage_cache_dir(name, "v1");
            std::fs::create_dir_all(&directory).unwrap();
            std::fs::write(directory.join("archive.tar.gz"), &body).unwrap();
            drop(runner_host::lock::open_lock_file(&config.home.storage_lock(name, "v1")).unwrap());
        }
        config
            .decoded_cache
            .warm_from_archive("ready", "v1")
            .await
            .unwrap();
        let mut context = minimal_context();
        context.storage_manifest = Some(StorageManifest {
            storages: vec![
                api_storage("ready", "/mnt/ready", "v1", "https://unused/ready"),
                api_storage("warm", "/mnt/warm", "v1", "https://unused/warm"),
            ],
            artifacts: Vec::new(),
        });
        let overrides = Arc::new(MockSandboxOverrides::new());
        let application = MockLifecycleGate::new();
        let staging = MockLifecycleGate::new();
        overrides.set_storage_manifest_lifecycle_gate(application.clone());
        overrides.set_write_file_lifecycle_gate(staging.clone());
        overrides.push_storage_manifest_result(Ok(ExecResult::new(
            0,
            b"true\n".to_vec(),
            Vec::new(),
        )));
        if failure == "guest" {
            overrides.push_storage_manifest_result(Ok(ExecResult::new(
                1,
                Vec::new(),
                b"warm consumer failed".to_vec(),
            )));
        }
        if failure == "stage" {
            overrides.push_write_file_result(Err(sandbox_write_file_error("warm stage failed")));
        }
        let cancel = RunCancellationHandle::new();
        let signals = cancel.signals();
        let task = tokio::spawn({
            let overrides = overrides.clone();
            async move {
                let factory = MockSandboxFactory::with_overrides(overrides);
                let (mut outcome, _) = execute_job_with_prepared_notifier(
                    &factory,
                    context,
                    NewSandboxDispatch {
                        id: SandboxId::new_v4(),
                        reuse_result: SandboxReuseResult::PoolMiss,
                    },
                    &config,
                    &default_params(),
                    signals,
                    ExecutionHooks::none(),
                )
                .await;
                if let Some(report) = outcome.startup_report.take() {
                    report.finish().await;
                }
                config.background_fill.shutdown().await;
                config.decoded_cache.shutdown().await;
                outcome
            }
        });
        application
            .wait_entered(1, Duration::from_secs(5))
            .await
            .unwrap();
        application.release_one();
        application
            .wait_entered(2, Duration::from_secs(5))
            .await
            .unwrap();
        staging
            .wait_entered(1, Duration::from_secs(5))
            .await
            .unwrap();
        assert!(overrides.start_agent_process_calls().is_empty());
        assert!(!task.is_finished());
        // The actual application receives one binary complete input, including
        // the decoded bytes and the bound pending archive, before staging ends.
        let calls = overrides.storage_manifest_calls();
        let (manifest, files) =
            guest_contracts::storage_files::split_input(&calls[1].manifest_json).unwrap();
        let manifest: guest_contracts::storage_manifest::Manifest =
            serde_json::from_slice(manifest).unwrap();
        let files = guest_contracts::storage_files::decode(files).unwrap();
        assert!(manifest.archive_readiness.is_some());
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].files[0].content, b"content");
        if failure == "guest" {
            application.release_one();
        }
        if failure == "cooperative" {
            assert!(cancel.request_cooperative_user_cancellation().await);
        }
        if failure == "hard" {
            assert!(cancel.request_hard_cancellation().await);
        }
        staging.release_one();
        if failure != "guest" {
            application.release_one();
        }
        let outcome = tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap();
        if failure == "none" {
            assert_eq!(outcome.exit_code(), 0, "{:?}", outcome.error());
            assert_eq!(overrides.start_agent_process_calls().len(), 1);
            assert!(outcome.storage_fingerprints.storages["/mnt/warm"].matches("warm", "v1"));
        } else {
            assert!(overrides.start_agent_process_calls().is_empty());
            assert!(!outcome.storage_fingerprints.storages["/mnt/warm"].matches("warm", "v1"));
            if failure == "guest" {
                assert!(
                    outcome.error().unwrap().contains("warm consumer failed"),
                    "{:?}",
                    outcome.error()
                );
            }
            if failure == "stage" {
                assert!(
                    outcome.error().unwrap().contains("warm stage failed"),
                    "{:?}",
                    outcome.error()
                );
            }
        }
    }
}
