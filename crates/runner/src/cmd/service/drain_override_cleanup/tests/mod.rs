use std::collections::VecDeque;
use std::time::Duration;

use super::*;

#[derive(Debug, Eq, PartialEq)]
enum Event {
    Remove,
    Restore,
    Reload(SystemdReloadPolicy, SystemdReloadRequirement),
}

struct FakeDrainOverrideCleanupOps {
    remove_result: Option<RunnerResult<DrainRestartOverrideRemoval>>,
    restore_result: Option<RunnerResult<()>>,
    reload_results: VecDeque<RunnerResult<()>>,
    events: Vec<Event>,
}

impl DrainOverrideCleanupOps for FakeDrainOverrideCleanupOps {
    fn remove_override(
        &mut self,
        _unit: &RunnerServiceUnit,
    ) -> RunnerResult<DrainRestartOverrideRemoval> {
        self.events.push(Event::Remove);
        self.remove_result.take().unwrap()
    }

    fn restore_override(&mut self, _unit: &RunnerServiceUnit) -> RunnerResult<()> {
        self.events.push(Event::Restore);
        self.restore_result.take().unwrap_or(Ok(()))
    }

    fn reload<'a>(
        &'a mut self,
        _unit: &'a RunnerServiceUnit,
        requirement: SystemdReloadRequirement,
        policy: SystemdReloadPolicy,
    ) -> ServiceFuture<'a, ()> {
        self.events.push(Event::Reload(policy, requirement));
        Box::pin(std::future::ready(
            self.reload_results.pop_front().unwrap_or(Ok(())),
        ))
    }
}

fn service_unit() -> RunnerServiceUnit {
    RunnerServiceUnit::from_suffix("test").unwrap()
}

fn fake_error(message: &str) -> RunnerError {
    RunnerError::Internal(message.to_string())
}

fn fake_ops(
    remove_result: RunnerResult<DrainRestartOverrideRemoval>,
    reload_results: impl IntoIterator<Item = RunnerResult<()>>,
) -> FakeDrainOverrideCleanupOps {
    FakeDrainOverrideCleanupOps {
        remove_result: Some(remove_result),
        restore_result: None,
        reload_results: reload_results.into_iter().collect(),
        events: Vec::new(),
    }
}

fn bounded_policy() -> SystemdReloadPolicy {
    SystemdReloadPolicy::Bounded {
        lock_timeout: Duration::from_secs(20),
        command_timeout: Duration::from_secs(10),
    }
}

#[tokio::test]
async fn absent_override_is_reconciled_through_both_reload_policies() {
    for policy in [SystemdReloadPolicy::Unbounded, bounded_policy()] {
        let mut ops = fake_ops(Ok(DrainRestartOverrideRemoval::AlreadyAbsent), []);

        reconcile_drain_restart_override_removal_with_ops(&service_unit(), policy, &mut ops)
            .await
            .unwrap();

        assert_eq!(
            ops.events,
            [
                Event::Remove,
                Event::Reload(
                    policy,
                    SystemdReloadRequirement::dirty().with_drain_override(false),
                ),
            ]
        );
    }
}

#[tokio::test]
async fn failed_retry_does_not_restore_override_absent_before_this_attempt() {
    let mut ops = fake_ops(
        Ok(DrainRestartOverrideRemoval::AlreadyAbsent),
        [Err(fake_error("reload failed"))],
    );

    let error = reconcile_drain_restart_override_removal_with_ops(
        &service_unit(),
        SystemdReloadPolicy::Unbounded,
        &mut ops,
    )
    .await
    .unwrap_err();

    assert_eq!(error.to_string(), "internal error: reload failed");
    assert_eq!(
        ops.events,
        [
            Event::Remove,
            Event::Reload(
                SystemdReloadPolicy::Unbounded,
                SystemdReloadRequirement::dirty().with_drain_override(false),
            ),
        ]
    );
}

#[tokio::test]
async fn failed_directory_cleanup_reload_does_not_restore_override() {
    let mut ops = fake_ops(
        Ok(DrainRestartOverrideRemoval::DirectoryRemoved),
        [Err(fake_error("reload failed"))],
    );

    let error = reconcile_drain_restart_override_removal_with_ops(
        &service_unit(),
        SystemdReloadPolicy::Unbounded,
        &mut ops,
    )
    .await
    .unwrap_err();

    assert_eq!(error.to_string(), "internal error: reload failed");
    assert_eq!(
        ops.events,
        [
            Event::Remove,
            Event::Reload(
                SystemdReloadPolicy::Unbounded,
                SystemdReloadRequirement::dirty().with_drain_override(false),
            ),
        ]
    );
}

#[tokio::test]
async fn failed_removal_reload_restores_with_same_policy() {
    let policy = bounded_policy();
    let mut ops = fake_ops(
        Ok(DrainRestartOverrideRemoval::OverrideRemoved),
        [Err(fake_error("reload failed")), Ok(())],
    );

    let error =
        reconcile_drain_restart_override_removal_with_ops(&service_unit(), policy, &mut ops)
            .await
            .unwrap_err();

    assert_eq!(error.to_string(), "internal error: reload failed");
    assert_eq!(
        ops.events,
        [
            Event::Remove,
            Event::Reload(
                policy,
                SystemdReloadRequirement::dirty().with_drain_override(false),
            ),
            Event::Restore,
            Event::Reload(
                policy,
                SystemdReloadRequirement::dirty().with_drain_override(true),
            ),
        ]
    );
}

#[tokio::test]
async fn cleanup_and_compensation_reload_failures_keep_both_errors_and_order() {
    let policy = bounded_policy();
    let mut ops = fake_ops(
        Ok(DrainRestartOverrideRemoval::OverrideRemoved),
        [
            Err(fake_error("cleanup reload failed")),
            Err(fake_error("compensation reload failed")),
        ],
    );

    let error =
        reconcile_drain_restart_override_removal_with_ops(&service_unit(), policy, &mut ops)
            .await
            .unwrap_err();

    assert_eq!(
        error.to_string(),
        concat!(
            "internal error: failed to reload systemd after removing drain restart override ",
            "for vm0-runner-test: internal error: cleanup reload failed; additionally failed ",
            "to restore drain restart override: internal error: failed to reload systemd after ",
            "restoring drain restart override for vm0-runner-test: internal error: ",
            "compensation reload failed",
        )
    );
    assert_eq!(
        ops.events,
        [
            Event::Remove,
            Event::Reload(
                policy,
                SystemdReloadRequirement::dirty().with_drain_override(false),
            ),
            Event::Restore,
            Event::Reload(
                policy,
                SystemdReloadRequirement::dirty().with_drain_override(true),
            ),
        ]
    );
}

#[tokio::test]
async fn removal_and_reload_failures_keep_both_errors_without_restoration() {
    let mut ops = fake_ops(
        Err(fake_error("remove failed")),
        [Err(fake_error("reload failed"))],
    );

    let error = reconcile_drain_restart_override_removal_with_ops(
        &service_unit(),
        SystemdReloadPolicy::Unbounded,
        &mut ops,
    )
    .await
    .unwrap_err();

    assert!(error.to_string().contains("remove failed"));
    assert!(error.to_string().contains("reload failed"));
    assert!(!ops.events.contains(&Event::Restore));
}

#[tokio::test]
async fn reload_and_restoration_failures_keep_both_errors() {
    let mut ops = fake_ops(
        Ok(DrainRestartOverrideRemoval::OverrideRemoved),
        [Err(fake_error("reload failed"))],
    );
    ops.restore_result = Some(Err(fake_error("restore failed")));

    let error = reconcile_drain_restart_override_removal_with_ops(
        &service_unit(),
        SystemdReloadPolicy::Unbounded,
        &mut ops,
    )
    .await
    .unwrap_err();

    assert!(error.to_string().contains("reload failed"));
    assert!(error.to_string().contains("restore failed"));
}
