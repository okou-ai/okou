use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::time::Duration;

use super::*;

struct CustodyCompletion(Option<tokio::sync::oneshot::Sender<()>>);

impl Drop for CustodyCompletion {
    fn drop(&mut self) {
        if let Some(completed) = self.0.take() {
            let _ = completed.send(());
        }
    }
}

#[tokio::test]
async fn actual_formatted_home_checkpoint_retains_transaction_until_cleanup() {
    use std::io::{Seek, SeekFrom};
    let dir = tempfile::tempdir().unwrap();
    let factory_paths = FactoryPaths::new(dir.path().join("factory"));
    let netns_pool = NetnsPoolHandle::new_for_test(crate::network::NetnsPool::inactive_for_test());
    let device_pool =
        nbd_cow::pool::DevicePoolHandle::new(nbd_cow::pool::DevicePoolConfig::default());
    let cow_pool = crate::cow_pool::CowPoolHandle::new(crate::cow_pool::CowPoolConfig {
        workspaces_dir: factory_paths.workspaces(),
        base_image: dir.path().join("rootfs.ext4"),
        base_size: 16 * 1024 * 1024,
        golden_cow: None,
        device_pool: device_pool.clone(),
    });
    let mut factory = FirecrackerFactory {
        home_drive_pressure: None,
        config: test_config(dir.path().join("factory")),
        factory_paths,
        runtime_paths: RuntimePaths::with_dir_for_test(dir.path().join("runtime")),
        cleanup_group: FactoryCleanupGroup::new(),
        resources: Some(StartedFactoryResources {
            leak_cleaner: LeakCleaner::spawn(netns_pool.clone()),
            netns_pool,
            netns_ownership: NetnsPoolOwnership::Shared,
            cow_pool,
        }),
        shutdown_netns_pool: None,
        host_cpu_cgroup: None,
    };
    // Cancellation and explicit checkpoint refusal must both clean the actual
    // formatted file. Closing the writer on panic also unblocks physical cleanup.
    for cancel in [true, false] {
        let (reader, mut writer) = UnixStream::pair().unwrap();
        let reader = std::sync::Mutex::new(Some(reader));
        let (entered, accepted) = tokio::sync::watch::channel(false);
        let checkpoint: HomeCreateCheckpoint = Arc::new(move |path| {
            let mut file = std::fs::File::open(path)?;
            assert_eq!(file.metadata()?.len(), 16 * 1024 * 1024);
            file.seek(SeekFrom::Start(1080))?;
            let mut magic = [0; 2];
            file.read_exact(&mut magic)?;
            assert_eq!(magic, [0x53, 0xef]);
            entered.send_replace(true);
            let mut byte = [0];
            reader
                .lock()
                .unwrap()
                .take()
                .unwrap()
                .read_exact(&mut byte)?;
            Err(std::io::Error::other("owned test checkpoint refused"))
        });
        let config = SandboxConfig {
            id: sandbox::SandboxId::new_v4(),
            resources: sandbox::ResourceLimits {
                cpu_count: 2,
                memory_mb: 2048,
            },
            device_rate_limits: None,
            home_drive: Some(sandbox::HomeDriveConfig {
                size_mb: 16,
                seed_image: None,
                space_reserve: sandbox::HomeDriveSpaceReserve::default(),
            }),
        };
        let workspace = factory.factory_paths.workspace(&config.id.to_string());
        let (completed, finished) = tokio::sync::oneshot::channel();
        let create = factory.create_inner(
            config,
            None,
            Some(sandbox::SandboxCreateCustody::new(Arc::new(
                CustodyCompletion(Some(completed)),
            ))),
            Some(FactoryCheckpoint::Home(checkpoint)),
        );
        tokio::pin!(finished);
        let mut create = Box::pin(create);
        let mut accepted = accepted;
        tokio::select! {
            result = &mut create => panic!("actual home was not held: {}", result.is_ok()),
            result = tokio::time::timeout(Duration::from_secs(10), async { while !*accepted.borrow_and_update() { accepted.changed().await.unwrap(); } }) => result.unwrap(),
        }
        assert!(workspace.join("home.ext4").is_file());
        assert!(futures_util::poll!(finished.as_mut()).is_pending());
        if cancel {
            drop(create);
            assert!(futures_util::poll!(finished.as_mut()).is_pending());
            writer.write_all(b"x").unwrap();
        } else {
            writer.write_all(b"x").unwrap();
            let error = create.await.err().unwrap().to_string();
            assert!(error.contains("owned test checkpoint refused"), "{error}");
        }
        tokio::time::timeout(Duration::from_secs(10), finished)
            .await
            .unwrap()
            .unwrap();
        assert!(
            !workspace.exists(),
            "custody completion follows actual workspace cleanup"
        );
    }
    factory.shutdown().await;
    device_pool.cleanup().await;
}

#[test]
fn cancelled_owned_home_create_cleans_workspace_after_physical_io_finishes() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()
        .unwrap();
    runtime.block_on(async {
        let dir = tempfile::tempdir().unwrap();
        let factory_paths = FactoryPaths::new(dir.path().join("factory"));
        let netns_pool =
            NetnsPoolHandle::new_for_test(crate::network::NetnsPool::inactive_for_test());
        let device_pool =
            nbd_cow::pool::DevicePoolHandle::new(nbd_cow::pool::DevicePoolConfig::default());
        let cow_pool = crate::cow_pool::CowPoolHandle::new(crate::cow_pool::CowPoolConfig {
            workspaces_dir: factory_paths.workspaces(),
            base_image: dir.path().join("rootfs.ext4"),
            base_size: 16 * 1024 * 1024,
            golden_cow: None,
            device_pool: device_pool.clone(),
        });
        let mut factory = FirecrackerFactory {
            home_drive_pressure: None,
            config: test_config(dir.path().join("factory")),
            factory_paths,
            runtime_paths: RuntimePaths::with_dir_for_test(dir.path().join("runtime")),
            cleanup_group: FactoryCleanupGroup::new(),
            resources: Some(StartedFactoryResources {
                leak_cleaner: LeakCleaner::spawn(netns_pool.clone()),
                netns_pool,
                netns_ownership: NetnsPoolOwnership::Shared,
                cow_pool,
            }),
            shutdown_netns_pool: None,
            host_cpu_cgroup: None,
        };
        let (mut reader, mut writer) = UnixStream::pair().unwrap();
        let (entered, accepted) = tokio::sync::oneshot::channel();
        let blocked = tokio::task::spawn_blocking(move || {
            let _ = entered.send(());
            let mut byte = [0];
            reader.read_exact(&mut byte).unwrap();
        });
        accepted.await.unwrap();
        let (completed, finished) = tokio::sync::oneshot::channel();
        let config = SandboxConfig {
            id: sandbox::SandboxId::new_v4(),
            resources: sandbox::ResourceLimits {
                cpu_count: 2,
                memory_mb: 2048,
            },
            device_rate_limits: None,
            home_drive: Some(sandbox::HomeDriveConfig {
                size_mb: 16,
                seed_image: None,
                space_reserve: sandbox::HomeDriveSpaceReserve::default(),
            }),
        };
        let workspace = factory.factory_paths.workspace(&config.id.to_string());
        {
            let create = factory.create_with_custody(
                config,
                sandbox::SandboxCreateCustody::new(Arc::new(CustodyCompletion(Some(completed)))),
            );
            tokio::pin!(create);
            assert!(futures_util::poll!(create.as_mut()).is_pending());
            assert!(workspace.is_dir());
        }
        let held_during_io = workspace.is_dir();
        tokio::pin!(finished);
        assert!(futures_util::poll!(finished.as_mut()).is_pending());
        writer.write_all(b"x").unwrap();
        blocked.await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), finished)
            .await
            .unwrap()
            .unwrap();
        let leftover = workspace.exists();
        factory.shutdown().await;
        device_pool.cleanup().await;
        assert!(
            held_during_io,
            "accepted home IO retains its original workspace"
        );
        assert!(
            !leftover,
            "completed cancelled home IO must not recreate an orphan workspace"
        );
    });
}
