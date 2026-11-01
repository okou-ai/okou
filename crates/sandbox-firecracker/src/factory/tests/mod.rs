mod owned_home;

use super::*;
use crate::factory::leak_cleaner::LeakCleaner;
use crate::leaked_resources::LeakedResources;
use crate::network::{NetnsLease, NetnsPool};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[tokio::test]
async fn shutdown_cleans_owned_netns_pool_with_extra_arc_refs() {
    let pool = NetnsPoolHandle::new_for_test(NetnsPool::active_for_test());
    let _destroy_task_clone = pool.clone();
    let mut factory =
        test_factory_with_resources(pool.clone(), NetnsPoolOwnership::Owned, test_leak_cleaner());

    assert!(pool.is_active_for_test().await);
    factory.shutdown().await;

    assert!(factory.resources.is_none());
    assert!(!pool.is_active_for_test().await);
}

#[tokio::test]
async fn shutdown_keeps_shared_netns_pool_for_runtime_shutdown() {
    let pool = NetnsPoolHandle::new_for_test(NetnsPool::active_for_test());
    let mut factory = test_factory_with_resources(
        pool.clone(),
        NetnsPoolOwnership::Shared,
        test_leak_cleaner(),
    );

    assert!(pool.is_active_for_test().await);
    factory.shutdown().await;

    assert!(factory.resources.is_none());
    assert!(factory.shutdown_netns_pool.is_some());
    assert!(pool.is_active_for_test().await);

    pool.cleanup().await.unwrap();
    assert!(!pool.is_active_for_test().await);
}

fn test_config(base_dir: PathBuf) -> FirecrackerConfig {
    FirecrackerConfig {
        binary_path: PathBuf::from("/tmp/firecracker"),
        kernel_path: PathBuf::from("/tmp/vmlinux"),
        rootfs_path: PathBuf::from("/tmp/rootfs.ext4"),
        base_dir,
        profile: "vm0/default".into(),
        proxy_port: None,
        dns_port: None,
        snapshot: None,
    }
}

fn test_factory_without_resources() -> FirecrackerFactory {
    FirecrackerFactory {
        home_drive_pressure: None,
        config: test_config(PathBuf::from("/tmp/factory-test-base")),
        factory_paths: FactoryPaths::new(PathBuf::from("/tmp/factory-test")),
        runtime_paths: RuntimePaths::new(),
        cleanup_group: FactoryCleanupGroup::new(),
        resources: None,
        shutdown_netns_pool: None,
        host_cpu_cgroup: None,
    }
}

fn test_pool_with_lease(name: &str) -> (NetnsPoolHandle, Option<NetnsLease>) {
    let mut raw_pool = NetnsPool::inactive_for_test();
    let lease = Some(raw_pool.lease_for_test(name));
    raw_pool.track_lease_for_test(lease.as_ref().unwrap());
    (NetnsPoolHandle::new_for_test(raw_pool), lease)
}

fn test_factory_with_resources(
    netns_pool: NetnsPoolHandle,
    netns_ownership: NetnsPoolOwnership,
    leak_cleaner: LeakCleaner,
) -> FirecrackerFactory {
    let factory_paths = FactoryPaths::new(PathBuf::from("/tmp/factory-test"));
    let device_pool =
        nbd_cow::pool::DevicePoolHandle::new(nbd_cow::pool::DevicePoolConfig::default());
    let cow_pool = crate::cow_pool::CowPoolHandle::new(crate::cow_pool::CowPoolConfig {
        workspaces_dir: factory_paths.workspaces(),
        base_image: PathBuf::from("/tmp/rootfs.ext4"),
        base_size: 0,
        golden_cow: None,
        device_pool,
    });
    let cleanup_group = FactoryCleanupGroup::new();
    cleanup_group.start_accepting();
    FirecrackerFactory {
        home_drive_pressure: None,
        config: test_config(PathBuf::from("/tmp/factory-test-base")),
        factory_paths,
        runtime_paths: RuntimePaths::new(),
        cleanup_group,
        resources: Some(StartedFactoryResources {
            netns_pool,
            netns_ownership,
            cow_pool,
            leak_cleaner,
        }),
        shutdown_netns_pool: None,
        host_cpu_cgroup: None,
    }
}

fn test_leak_cleaner() -> LeakCleaner {
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel::<LeakedResources>();
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
    let (completed_cleanup_count_tx, completed_cleanup_count_rx) = tokio::sync::watch::channel(0);
    let handle = tokio::spawn(async move {
        let _completed_cleanup_count_tx = completed_cleanup_count_tx;
        let _ = shutdown_rx.await;
    });
    LeakCleaner::from_parts_for_test(tx, shutdown_tx, completed_cleanup_count_rx, handle)
}

fn assert_factory_invalid_state(err: SandboxError, expected_state: &str) {
    match err {
        SandboxError::InvalidState {
            context,
            state,
            message: _,
        } => {
            assert_eq!(context, SandboxInvalidStateContext::Factory);
            assert_eq!(state, expected_state);
        }
        other => panic!("expected factory invalid-state error, got {other:?}"),
    }
}

#[tokio::test]
async fn clean_stale_workspace_dir_allows_absent_target() {
    let tmp = tempfile::tempdir().unwrap();
    let target = tmp.path().join("sandbox-workspace");

    clean_stale_workspace_dir("sandbox", &target).unwrap();

    assert!(!target.exists());
}

#[tokio::test]
async fn clean_stale_workspace_dir_removes_existing_target_dir() {
    let tmp = tempfile::tempdir().unwrap();
    let target = tmp.path().join("sandbox-workspace");
    tokio::fs::create_dir_all(target.join("nested"))
        .await
        .unwrap();
    tokio::fs::write(target.join("nested").join("stale.txt"), b"stale")
        .await
        .unwrap();

    clean_stale_workspace_dir("sandbox", &target).unwrap();

    assert!(!target.exists());
}

#[tokio::test]
async fn clean_stale_workspace_dir_errors_for_unclaimed_target() {
    let tmp = tempfile::tempdir().unwrap();
    let target = tmp.path().join("sandbox-workspace");
    tokio::fs::write(&target, b"not a directory").await.unwrap();

    let err = clean_stale_workspace_dir("sandbox", &target).unwrap_err();

    match err {
        SandboxError::Initialization { phase, message } => {
            assert_eq!(phase, SandboxInitializationPhase::SandboxAllocation);
            assert!(message.contains("clean stale target workspace"));
        }
        other => panic!("expected initialization error, got {other:?}"),
    }
    assert!(target.exists());
}

#[tokio::test]
async fn clean_stale_sock_dir_removes_existing_target_dir() {
    let tmp = tempfile::tempdir().unwrap();
    let target = tmp.path().join("sandbox-sock");
    tokio::fs::create_dir_all(target.join("vsock"))
        .await
        .unwrap();
    tokio::fs::write(target.join("vsock").join("stale.sock"), b"stale")
        .await
        .unwrap();

    clean_stale_sock_dir("sandbox", &target).unwrap();

    assert!(!target.exists());
}

#[tokio::test]
async fn create_rejects_shutdown_factory() {
    let factory = test_factory_without_resources();
    let config = sandbox::SandboxConfig {
        id: sandbox::SandboxId::new_v4(),
        resources: sandbox::ResourceLimits {
            cpu_count: 1,
            memory_mb: 512,
        },
        device_rate_limits: None,
        home_drive: None,
    };

    let err = match factory.create(config).await {
        Ok(_) => panic!("create should fail without factory resources"),
        Err(err) => err,
    };

    assert_factory_invalid_state(err, "shutdown");
}

#[tokio::test]
async fn destroy_without_resources_or_retained_pool_has_no_release_authority() {
    let factory = test_factory_without_resources();

    assert!(factory.netns_pool_for_destroy("sandbox").is_none());
}

#[tokio::test]
async fn create_rejects_factory_after_shutdown_even_with_retained_destroy_pool() {
    let mut factory = test_factory_with_resources(
        NetnsPoolHandle::new_for_test(NetnsPool::inactive_for_test()),
        NetnsPoolOwnership::Shared,
        test_leak_cleaner(),
    );
    factory.shutdown().await;

    let config = sandbox::SandboxConfig {
        id: sandbox::SandboxId::new_v4(),
        resources: sandbox::ResourceLimits {
            cpu_count: 1,
            memory_mb: 512,
        },
        device_rate_limits: None,
        home_drive: None,
    };
    let err = match factory.create(config).await {
        Ok(_) => panic!("create should fail after shutdown"),
        Err(err) => err,
    };

    assert_factory_invalid_state(err, "shutdown");
}

#[tokio::test]
async fn shutdown_is_idempotent_after_resources_are_taken() {
    let mut factory = test_factory_with_resources(
        NetnsPoolHandle::new_for_test(NetnsPool::inactive_for_test()),
        NetnsPoolOwnership::Shared,
        test_leak_cleaner(),
    );

    factory.shutdown().await;
    factory.shutdown().await;

    assert!(factory.resources.is_none());
    assert!(factory.shutdown_netns_pool.is_some());
}

#[tokio::test]
async fn destroy_uses_retained_netns_pool_after_shutdown() {
    let (pool, mut lease) = test_pool_with_lease("test-ns");
    let mut factory = test_factory_with_resources(
        pool.clone(),
        NetnsPoolOwnership::Shared,
        test_leak_cleaner(),
    );
    factory.shutdown().await;

    let selected = factory
        .netns_pool_for_destroy("sandbox")
        .expect("shutdown factory should retain destroy netns pool");

    let _ = selected.release(&mut lease).await;

    assert!(lease.is_none());
}

#[tokio::test]
async fn factory_shutdown_drains_cleanup_group_before_leak_cleaner() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let cleanup_events = Arc::clone(&events);
    let leak_events = Arc::clone(&events);
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel::<LeakedResources>();
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
    let (completed_cleanup_count_tx, completed_cleanup_count_rx) = tokio::sync::watch::channel(0);
    let handle = tokio::spawn(async move {
        let _completed_cleanup_count_tx = completed_cleanup_count_tx;
        let _ = shutdown_rx.await;
        leak_events.lock().unwrap().push("leak_cleaner");
    });
    let mut factory = test_factory_with_resources(
        NetnsPoolHandle::new_for_test(NetnsPool::inactive_for_test()),
        NetnsPoolOwnership::Owned,
        LeakCleaner::from_parts_for_test(tx, shutdown_tx, completed_cleanup_count_rx, handle),
    );

    let waiter =
        factory
            .cleanup_group
            .spawn(FactoryCleanupTaskKind::Destroy, "sandbox", async move {
                cleanup_events.lock().unwrap().push("cleanup_group");
            });
    drop(waiter);

    factory.shutdown().await;

    assert_eq!(
        *events.lock().unwrap(),
        vec!["cleanup_group", "leak_cleaner"]
    );
}
