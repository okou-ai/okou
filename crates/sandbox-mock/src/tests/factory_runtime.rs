use super::*;
use std::sync::Arc;

#[tokio::test]
async fn overrides_share_create_results_across_runtime_factories() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_create_result(Err(SandboxError::Initialization {
        phase: SandboxInitializationPhase::SandboxAllocation,
        message: "out of resources".into(),
    }));
    let runtime = MockSandboxRuntime::with_overrides(Arc::clone(&overrides));

    let first_factory = runtime.create_factory(test_factory_config()).await.unwrap();
    let result = first_factory.create(test_sandbox_config()).await;
    assert!(matches!(
        result,
        Err(SandboxError::Initialization {
            phase: SandboxInitializationPhase::SandboxAllocation,
            ..
        })
    ));

    let second_factory = runtime.create_factory(test_factory_config()).await.unwrap();
    second_factory.create(test_sandbox_config()).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shared_create_result_is_consumed_once_across_concurrent_factories() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_create_result(Err(SandboxError::Initialization {
        phase: SandboxInitializationPhase::SandboxAllocation,
        message: "out of resources".into(),
    }));
    let first_factory = Arc::new(MockSandboxFactory::with_overrides(Arc::clone(&overrides)));
    let second_factory = Arc::new(MockSandboxFactory::with_overrides(Arc::clone(&overrides)));
    let barrier = Arc::new(tokio::sync::Barrier::new(2));

    let first = tokio::spawn({
        let barrier = Arc::clone(&barrier);
        async move {
            barrier.wait().await;
            first_factory.create(test_sandbox_config()).await.is_err()
        }
    });
    let second = tokio::spawn({
        let barrier = Arc::clone(&barrier);
        async move {
            barrier.wait().await;
            second_factory.create(test_sandbox_config()).await.is_err()
        }
    });

    let failure_count = [first.await.unwrap(), second.await.unwrap()]
        .into_iter()
        .filter(|failed| *failed)
        .count();
    assert_eq!(
        failure_count, 1,
        "shared create result should be consumed by exactly one concurrent factory"
    );
}

#[tokio::test]
async fn factory_local_create_result_takes_precedence_over_shared_overrides() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_create_result(Err(SandboxError::Initialization {
        phase: SandboxInitializationPhase::SandboxAllocation,
        message: "shared failure".into(),
    }));
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    factory.push_create_result(Ok(()));

    factory.create(test_sandbox_config()).await.unwrap();
    let result = factory.create(test_sandbox_config()).await;

    assert!(matches!(
        result,
        Err(SandboxError::Initialization {
            phase: SandboxInitializationPhase::SandboxAllocation,
            ..
        })
    ));
}

#[tokio::test]
async fn factory_creates_sandbox() {
    let mut factory = MockSandboxFactory::new();
    let sandbox = factory.create(test_sandbox_config()).await.unwrap();
    assert!(!sandbox.id().is_empty());
    factory.destroy(sandbox).await;
    factory.shutdown().await;
}

#[tokio::test]
async fn runtime_creates_factory() {
    let mut runtime = MockSandboxRuntime::new();
    let factory_config = FactoryConfig {
        home_drive_pressure: None,
        profile: "test".into(),
        binary_path: "/bin/test".into(),
        kernel_path: "/boot/test".into(),
        rootfs_path: "/rootfs/test".into(),
        runtime_path: "/runtime/test".into(),
        base_dir: "/tmp/test".into(),
        snapshot: None,
    };
    let mut factory = runtime.create_factory(factory_config).await.unwrap();
    assert_eq!(factory.name(), "mock");
    factory.shutdown().await;
    runtime.shutdown().await;
}

#[tokio::test]
async fn runtime_provider_creates_runtime() {
    let provider = MockRuntimeProvider;
    let mut runtime = provider
        .create_runtime(RuntimeConfig {
            proxy_port: None,
            dns_port: None,
            host_cpu_placement: None,
        })
        .await
        .unwrap();
    runtime.shutdown().await;
}

#[tokio::test]
async fn factory_create_queued_error() {
    let factory = MockSandboxFactory::new();
    factory.push_create_result(Err(SandboxError::Initialization {
        phase: SandboxInitializationPhase::SandboxAllocation,
        message: "out of resources".into(),
    }));

    let result = factory.create(test_sandbox_config()).await;
    assert!(result.is_err());

    // Next create falls back to default success.
    factory.create(test_sandbox_config()).await.unwrap();
}
