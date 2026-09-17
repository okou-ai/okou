use std::path::Path;
use std::sync::Arc;

use sandbox::Sandbox;

use super::super::super::{ExecutorConfig, JobParams};
use crate::http::HttpClientConfig;
use crate::idle_pool::ReusableIdleSandbox;
use crate::network_log_drain::NetworkLogDrainCoordinator;
use crate::network_log_manager::NetworkLogManager;
use crate::paths::{HomePaths, LogPaths};
use crate::proxy;
use crate::telemetry::JobTelemetry;
use crate::types::ExecutionContext;

/// Build a real `ExecutorConfig` backed by tempdir files.
pub(in crate::executor::tests) async fn test_executor_config(dir: &Path) -> ExecutorConfig {
    let registry_path = dir.join("proxy-registry.json");
    let lock_path = dir.join("proxy-registry.json.lock");
    tokio::fs::write(&registry_path, r#"{"sandboxes":{},"updatedAt":0}"#)
        .await
        .unwrap();
    let log_dir = dir.join("logs");
    tokio::fs::create_dir_all(&log_dir).await.unwrap();

    ExecutorConfig {
        api_url: "http://localhost:9999".into(),
        runner_hostname: None,
        registry: proxy::ProxyRegistryHandle::new(registry_path, lock_path),
        http: crate::http::HttpClient::new(HttpClientConfig {
            api_url: "http://localhost:9999".into(),
            vercel_bypass: None,
            client_session_id: "runner-session-test".to_string(),
        })
        .unwrap(),
        log_paths: LogPaths::new(log_dir),
        network_log_manager: NetworkLogManager::new(),
        network_log_drain: NetworkLogDrainCoordinator::noop(),
        mitm_jsonl_flush: None,
        connector_runtime_sync: None,
        guest_rpc: None,
        session_history_cpu: super::super::super::SessionHistoryCpuPool::with_capacity(1),
        session_history_probe: super::super::super::SessionHistoryProbe::default(),
        fresh_archive_delivery: crate::storage_cache::FreshArchiveDeliveryAdmission::new(),
        decoded_cache: crate::storage_cache::decoded::DecodedCache::new(HomePaths::with_root(
            dir.to_owned(),
        )),
        background_fill: crate::storage_cache::StorageCacheBackgroundFillCoordinator::new()
            .unwrap(),
        pre_spawn_admission: crate::pre_spawn_admission::PreSpawnAdmission::new(2).unwrap(),
        storage_baseline_observer: Default::default(),
        home: HomePaths::with_root(dir.to_path_buf()),
        workspace_cache: None,
    }
}

pub(in crate::executor::tests) fn default_params() -> JobParams {
    JobParams {
        profile_name: "vm0/default".into(),
        vcpu: 2,
        memory_mb: 2048,
        workspace_disk_mb: 16_384,
        restore_guest_state: false,
        device_rate_limits: None,
        workspace_image_prepare_lock_policy: Default::default(),
    }
}

pub(in crate::executor::tests) fn test_device_rate_limits() -> sandbox::DeviceRateLimits {
    sandbox::DeviceRateLimits {
        block: sandbox::BlockRateLimits {
            bandwidth_bytes_per_sec: 100 * 1024 * 1024,
            ops_per_sec: 10_000,
        },
        network: sandbox::NetworkRateLimits {
            rx_bytes_per_sec: 50 * 1024 * 1024,
            tx_bytes_per_sec: 25 * 1024 * 1024,
        },
    }
}

pub(in crate::executor::tests) fn test_budget_lease() -> crate::resource_budget::BudgetLease {
    let budget = Arc::new(crate::resource_budget::ResourceBudget::new(1, 1, 1.0, 0));
    crate::resource_budget::ResourceBudget::try_reserve_lease(&budget, 2, 2048).unwrap()
}

pub(in crate::executor::tests) async fn make_reusable_idle_sandbox(
    mut sandbox: Box<dyn Sandbox>,
    source_ip: String,
    session_id: &str,
) -> (ReusableIdleSandbox, crate::resource_budget::BudgetLease) {
    use crate::idle_pool::{
        IdlePool, IdlePoolConfig, IdleUnparkResult, ParkResult,
        test_support::ParkedIdleCandidateBuilder,
    };

    assert_eq!(
        sandbox.park().await.unwrap(),
        sandbox::SandboxParkOutcome::Reusable
    );
    let mut pool = IdlePool::new(IdlePoolConfig { max_idle: 0 });
    let candidate = ParkedIdleCandidateBuilder::new(session_id, test_budget_lease())
        .with_sandbox(sandbox)
        .with_source_ip(source_ip)
        .build();
    assert!(matches!(pool.park(candidate), ParkResult::Parked));
    let entry = pool.take(session_id).expect("idle entry should exist");
    match entry.try_unpark_for_run(crate::ids::RunId::new_v4()).await {
        IdleUnparkResult::Reused {
            sandbox,
            budget_lease,
        } => (*sandbox, budget_lease),
        IdleUnparkResult::Failed { error, .. } => {
            panic!("test idle entry should unpark: {error}");
        }
    }
}

pub(in crate::executor::tests) fn test_telemetry(
    config: &ExecutorConfig,
    ctx: &ExecutionContext,
) -> JobTelemetry {
    crate::telemetry::JobTelemetry::new(
        config.http.clone(),
        ctx.run_id,
        ctx.sandbox_token.clone(),
        config.runner_hostname.clone(),
    )
}

pub(in crate::executor::tests) async fn assert_proxy_registry_empty(dir: &Path) {
    let raw = tokio::fs::read_to_string(dir.join("proxy-registry.json"))
        .await
        .unwrap();
    let registry: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(
        registry["sandboxes"]
            .as_object()
            .map(|sandboxes| sandboxes.len()),
        Some(0),
        "proxy registry should not retain a sandbox after executor cleanup: {registry}",
    );
    assert!(
        registry["updatedAt"]
            .as_i64()
            .is_some_and(|updated_at| updated_at > 0),
        "proxy registry should record a cleanup mutation: {registry}",
    );
}
