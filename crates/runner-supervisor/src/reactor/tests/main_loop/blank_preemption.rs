use std::collections::BTreeMap;

use crate::blank_pool::{BlankPoolReplenisher, BlankPrepareResult, BlankProfile};
use sandbox_mock::{
    MockBackingProcess, MockLifecycleGate, MockSandboxFactory, MockSandboxOverrides,
};

use super::super::super::*;
use super::super::support::{
    context_with_session, mock_run_config, push_job, shutdown, test_profiles, wait_discover_entered,
};

#[tokio::test]
async fn fitting_job_in_real_reactor_preempts_blank_cpu_while_guest_io_remains_owned() {
    let (config, env) = mock_run_config(test_profiles(), 16, 32768, 8);
    let tracker = IdleDestroyTracker::new(config.shared.reuse_state_notify.clone());
    let overrides = Arc::new(MockSandboxOverrides::new());
    let start = MockLifecycleGate::new();
    overrides.set_start_lifecycle_gate(start.clone());
    let (exit, backing) = MockBackingProcess::channel();
    let factory = MockSandboxFactory::with_overrides(overrides.clone());
    factory.push_create_backing(backing);
    let factory: crate::SharedFactory = Arc::new(Box::new(factory));
    let profiles = BTreeMap::from([(
        "vm0/default".into(),
        BlankProfile {
            vcpu: 2,
            memory_mb: 4096,
            rootfs_hash: "test-rootfs".into(),
            home_disk_mb: 32,
        },
    )]);
    let factories = BTreeMap::from([("vm0/default".into(), (factory, true))]);
    let budget = config.capacity.budget.clone();
    let pool = config.shared.idle_pool.clone();
    let status = config.shared.status.clone();
    let admission = config.exec_config.pre_spawn_admission.clone();
    let mut blank = BlankPoolReplenisher::new(&profiles, &factories, &budget, 1, None);
    blank
        .maybe_start(
            RunnerMode::Running,
            &pool,
            &budget,
            &admission,
            &status,
            &tracker,
        )
        .await;
    start.wait_entered(1, Duration::from_secs(5)).await.unwrap();
    let runner = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    let id = RunId::new_v4();
    push_job(
        &env,
        id,
        "vm0/default",
        Some(context_with_session(id, "blank-foreground")),
    );
    assert_eq!(
        env.handle
            .wait_completion(id, Duration::from_secs(5))
            .await
            .unwrap()
            .exit_code,
        0
    );
    assert!(budget.allocated().0 >= 2);
    assert_eq!(overrides.destroy_call_count(), 0);
    {
        let waited = blank.wait_for_preparation();
        tokio::pin!(waited);
        assert!(futures_util::poll!(waited.as_mut()).is_pending());
        exit.confirm_exit();
        start.release_one();
        let result = tokio::time::timeout(Duration::from_secs(5), waited)
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(result, BlankPrepareResult::Failed(_)));
    }
    assert_eq!(overrides.destroy_call_count(), 1);
    blank.shutdown(&tracker).await;
    tracker.close_and_wait().await;
    shutdown(&env, runner).await;
    assert_eq!(budget.allocated(), (0, 0, 0));
}
