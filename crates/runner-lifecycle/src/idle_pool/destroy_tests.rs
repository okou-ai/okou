use super::*;

use std::sync::Arc;

use crate::resource_budget::{BudgetLease, ResourceBudget};
use crate::workspace_image_cache::{WorkspaceCacheCheckoutResult, WorkspaceImagePromotionContext};
use crate::workspace_promotion::test_support::WorkspacePromotionFixture;
use runner_host::paths::RunnerPaths;
use sandbox::{ResourceLimits, SandboxConfig, SandboxFactory, SandboxId};
use sandbox_mock::{MockSandboxFactory, MockSandboxOverrides};

use super::entry::{IdleSandboxResources, WorkspacePromotionPolicy};

fn reserved_budget_lease() -> (Arc<ResourceBudget>, BudgetLease) {
    let budget = Arc::new(ResourceBudget::new(2, 4096, 1.0, 0));
    let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
    (budget, lease)
}

async fn make_idle_destroy_payload(overrides: Arc<MockSandboxOverrides>) -> IdleDestroyPayload {
    make_idle_destroy_payload_for(SandboxId::new_v4(), overrides, None).await
}

pub(super) async fn make_idle_destroy_payload_for(
    sandbox_id: SandboxId,
    overrides: Arc<MockSandboxOverrides>,
    workspace_promotion: Option<WorkspaceImagePromotionContext>,
) -> IdleDestroyPayload {
    let factory: Arc<Box<dyn SandboxFactory>> = Arc::new(Box::new(
        MockSandboxFactory::with_overrides(Arc::clone(&overrides)),
    ));
    let sandbox = factory
        .create(SandboxConfig {
            id: sandbox_id,
            resources: ResourceLimits {
                cpu_count: 2,
                memory_mb: 4096,
            },
            device_rate_limits: None,
            workspace_drive: None,
        })
        .await
        .expect("create sandbox");

    IdleDestroyPayload {
        resources: IdleSandboxResources {
            sandbox,
            factory,
            workspace_promotion,
        },
        workspace_promotion_policy: WorkspacePromotionPolicy::Promote,
    }
}

async fn make_idle_destroy_job(
    overrides: Arc<MockSandboxOverrides>,
    budget_lease: BudgetLease,
) -> IdleDestroyJob {
    make_idle_destroy_job_for(SandboxId::new_v4(), overrides, budget_lease, None).await
}

pub(super) async fn make_idle_destroy_job_for(
    sandbox_id: SandboxId,
    overrides: Arc<MockSandboxOverrides>,
    budget_lease: BudgetLease,
    workspace_promotion: Option<WorkspaceImagePromotionContext>,
) -> IdleDestroyJob {
    IdleDestroyJob {
        payload: make_idle_destroy_payload_for(sandbox_id, overrides, workspace_promotion).await,
        budget_lease,
        reuse_key: Some("session:sess-destroy".into()),
        profile_name: "vm0/default".into(),
    }
}

#[tokio::test]
async fn idle_destroy_payload_kill_error_completes_after_destroy() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_kill_result(Err(sandbox::SandboxError::Start {
        message: "simulated idle kill failure".into(),
    }));
    let payload = make_idle_destroy_payload(Arc::clone(&overrides)).await;

    let outcome = payload.stop_and_destroy().await;

    assert_eq!(outcome, DestroyOutcome::Completed);
    assert_eq!(overrides.stop_call_count(), 0);
    assert_eq!(overrides.kill_call_count(), 1);
    assert_eq!(overrides.destroy_call_count(), 1);
}

#[tokio::test]
async fn idle_destroy_payload_kill_panic_is_uncertain_after_destroy() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_kill_panic("simulated idle kill panic");
    let payload = make_idle_destroy_payload(Arc::clone(&overrides)).await;

    let outcome = payload.stop_and_destroy().await;

    assert_eq!(outcome, DestroyOutcome::Uncertain);
    assert_eq!(overrides.stop_call_count(), 0);
    assert_eq!(overrides.kill_call_count(), 1);
    assert_eq!(overrides.destroy_call_count(), 1);
}

#[tokio::test]
async fn idle_destroy_job_destroy_panic_preserves_workspace_cache_and_releases_budget_lease() {
    let fixture = WorkspacePromotionFixture::new("sess-idle-destroy-panic-promote").await;
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_destroy_panic("simulated destroy panic");
    let (budget, lease) = reserved_budget_lease();
    let job = make_idle_destroy_job_for(
        fixture.sandbox_id,
        Arc::clone(&overrides),
        lease,
        Some(fixture.promotion),
    )
    .await;

    let result = job.run_retaining_lease("test_destroy_panic").await;

    assert_eq!(result.outcome, DestroyOutcome::Uncertain);
    assert!(result.workspace_cache_promoted);
    let exec_calls = overrides.exec_calls();
    assert_eq!(exec_calls.len(), 1);
    assert!(
        exec_calls[0]
            .cmd
            .contains("\"$workspace_fsfreeze_path\" --freeze")
    );
    assert_eq!(overrides.destroy_call_count(), 1);
    assert_eq!(budget.allocated(), (2, 4096, 1));
    drop(result.budget_lease);
    assert_eq!(budget.allocated(), (0, 0, 0));
    let states = fixture.cache.held_workspace_states().await;
    assert_eq!(states.len(), 1);
    assert_eq!(states[0].reuse_key, fixture.reuse_key);
    let paths = RunnerPaths::new(fixture._dir.path().join("runner"));
    assert!(
        !tokio::fs::try_exists(paths.active_workspace_image(&fixture.sandbox_id))
            .await
            .unwrap(),
        "successful promotion must move the image out before sandbox destruction"
    );
    tokio::fs::remove_dir_all(paths.workspace_dir(&fixture.sandbox_id))
        .await
        .unwrap();
    assert_eq!(
        WorkspacePromotionFixture::checkout_result(&fixture.cache, &fixture.reuse_key).await,
        WorkspaceCacheCheckoutResult::Hit,
        "removing the destroyed sandbox workspace must not remove the promoted cache entry"
    );
}

#[tokio::test]
async fn idle_destroy_job_kill_panic_still_attempts_destroy_and_releases_budget_lease() {
    let fixture = WorkspacePromotionFixture::new("sess-idle-destroy-kill-panic").await;
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_kill_panic("simulated idle kill panic");
    let (budget, lease) = reserved_budget_lease();
    let job = make_idle_destroy_job_for(
        fixture.sandbox_id,
        Arc::clone(&overrides),
        lease,
        Some(fixture.promotion),
    )
    .await;

    let promoted = job.run_with_context("test_kill_panic").await;

    assert!(!promoted);
    let exec_calls = overrides.exec_calls();
    assert_eq!(exec_calls.len(), 1);
    assert!(
        exec_calls[0]
            .cmd
            .contains("\"$workspace_fsfreeze_path\" --freeze")
    );
    assert_eq!(overrides.destroy_call_count(), 1);
    assert_eq!(budget.allocated(), (0, 0, 0));
    assert!(fixture.cache.held_workspace_states().await.is_empty());
}

#[tokio::test]
async fn idle_destroy_job_kill_error_still_attempts_destroy_and_releases_budget_lease() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_kill_result(Err(sandbox::SandboxError::Start {
        message: "simulated idle kill failure".into(),
    }));
    let (budget, lease) = reserved_budget_lease();
    assert_eq!(budget.allocated(), (2, 4096, 1));
    let job = make_idle_destroy_job(Arc::clone(&overrides), lease).await;

    let promoted = job.run_with_context("test_kill_error").await;

    assert!(!promoted);
    assert_eq!(overrides.destroy_call_count(), 1);
    assert_eq!(budget.allocated(), (0, 0, 0));
}

#[tokio::test]
async fn idle_destroy_job_publishes_frozen_workspace_only_after_successful_kill() {
    let fixture = WorkspacePromotionFixture::new("sess-idle-destroy-promote").await;
    let overrides = Arc::new(MockSandboxOverrides::new());
    let (budget, lease) = reserved_budget_lease();
    let job = make_idle_destroy_job_for(
        fixture.sandbox_id,
        Arc::clone(&overrides),
        lease,
        Some(fixture.promotion),
    )
    .await;

    let promoted = job.run_with_context("test_idle_destroy_promote").await;

    assert!(promoted);
    assert_eq!(overrides.terminal_unpark_call_count(), 1);
    assert_eq!(overrides.stop_call_count(), 0);
    assert_eq!(overrides.kill_call_count(), 1);
    let exec_calls = overrides.exec_calls();
    assert_eq!(exec_calls.len(), 1);
    assert!(
        exec_calls[0]
            .cmd
            .contains("\"$workspace_fsfreeze_path\" --freeze")
    );
    assert_eq!(overrides.destroy_call_count(), 1);
    assert_eq!(budget.allocated(), (0, 0, 0));
    let states = fixture.cache.held_workspace_states().await;
    assert_eq!(states.len(), 1);
    assert_eq!(states[0].reuse_key, fixture.reuse_key);
    let paths = RunnerPaths::new(fixture._dir.path().join("runner"));
    assert!(
        !tokio::fs::try_exists(paths.active_workspace_image(&fixture.sandbox_id))
            .await
            .unwrap(),
        "successful promotion must move the image out before sandbox destruction"
    );
    tokio::fs::remove_dir_all(paths.workspace_dir(&fixture.sandbox_id))
        .await
        .unwrap();
    assert_eq!(
        WorkspacePromotionFixture::checkout_result(&fixture.cache, &fixture.reuse_key).await,
        WorkspaceCacheCheckoutResult::Hit,
        "removing the destroyed sandbox workspace must not remove the promoted cache entry"
    );
}

#[tokio::test]
async fn idle_destroy_job_kill_error_abandons_frozen_workspace_and_still_destroys() {
    let fixture = WorkspacePromotionFixture::new("sess-idle-destroy-kill-error").await;
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_kill_result(Err(sandbox::SandboxError::Start {
        message: "simulated idle kill failure".into(),
    }));
    let (budget, lease) = reserved_budget_lease();
    let job = make_idle_destroy_job_for(
        fixture.sandbox_id,
        Arc::clone(&overrides),
        lease,
        Some(fixture.promotion),
    )
    .await;

    let promoted = job.run_with_context("test_idle_destroy_kill_error").await;

    assert!(!promoted);
    assert_eq!(overrides.terminal_unpark_call_count(), 1);
    assert_eq!(overrides.stop_call_count(), 0);
    assert_eq!(overrides.kill_call_count(), 1);
    let exec_calls = overrides.exec_calls();
    assert_eq!(exec_calls.len(), 1);
    assert!(
        exec_calls[0]
            .cmd
            .contains("\"$workspace_fsfreeze_path\" --freeze")
    );
    assert_eq!(overrides.destroy_call_count(), 1);
    assert_eq!(budget.allocated(), (0, 0, 0));
    assert!(fixture.cache.held_workspace_states().await.is_empty());
}

#[tokio::test]
async fn idle_destroy_job_publication_failure_after_kill_still_destroys() {
    let fixture = WorkspacePromotionFixture::new("sess-idle-destroy-publish-error").await;
    let paths = RunnerPaths::new(fixture._dir.path().join("runner"));
    tokio::fs::remove_file(paths.active_workspace_image(&fixture.sandbox_id))
        .await
        .unwrap();
    let overrides = Arc::new(MockSandboxOverrides::new());
    let (budget, lease) = reserved_budget_lease();
    let job = make_idle_destroy_job_for(
        fixture.sandbox_id,
        Arc::clone(&overrides),
        lease,
        Some(fixture.promotion),
    )
    .await;

    let promoted = job
        .run_with_context("test_idle_destroy_publish_error")
        .await;

    assert!(!promoted);
    assert_eq!(overrides.unpark_call_count(), 1);
    let exec_calls = overrides.exec_calls();
    assert_eq!(exec_calls.len(), 1);
    assert!(
        exec_calls[0]
            .cmd
            .contains("\"$workspace_fsfreeze_path\" --freeze")
    );
    assert_eq!(overrides.destroy_call_count(), 1);
    assert_eq!(budget.allocated(), (0, 0, 0));
    assert!(fixture.cache.held_workspace_states().await.is_empty());
}

#[tokio::test]
async fn idle_destroy_job_unpark_error_skips_workspace_cache_and_still_destroys() {
    assert_idle_destroy_job_unpark_failure_skips_workspace_cache_and_still_destroys(
        "sess-idle-destroy-unpark-error",
        |overrides| {
            overrides.push_unpark_result(Err(sandbox::SandboxError::IdleTransition {
                transition: sandbox::SandboxIdleTransition::Unpark,
                message: "simulated unpark failure".into(),
            }));
        },
    )
    .await;
}

#[tokio::test]
async fn idle_destroy_job_unpark_panic_skips_workspace_cache_and_still_destroys() {
    assert_idle_destroy_job_unpark_failure_skips_workspace_cache_and_still_destroys(
        "sess-idle-destroy-unpark-panic",
        |overrides| overrides.push_unpark_panic("simulated unpark panic"),
    )
    .await;
}

async fn assert_idle_destroy_job_unpark_failure_skips_workspace_cache_and_still_destroys(
    session_id: &str,
    configure_overrides: impl FnOnce(&MockSandboxOverrides),
) {
    let fixture = WorkspacePromotionFixture::new(session_id).await;
    let overrides = Arc::new(MockSandboxOverrides::new());
    configure_overrides(&overrides);
    let (budget, lease) = reserved_budget_lease();
    let job = make_idle_destroy_job_for(
        fixture.sandbox_id,
        Arc::clone(&overrides),
        lease,
        Some(fixture.promotion),
    )
    .await;

    let promoted = job.run_with_context("test_idle_destroy_unpark_error").await;

    assert!(!promoted);
    assert_eq!(overrides.unpark_call_count(), 1);
    assert_eq!(overrides.terminal_unpark_call_count(), 1);
    assert!(overrides.exec_calls().is_empty());
    assert_eq!(overrides.stop_call_count(), 0);
    assert_eq!(overrides.kill_call_count(), 1);
    assert_eq!(overrides.destroy_call_count(), 1);
    assert_eq!(budget.allocated(), (0, 0, 0));
    assert!(fixture.cache.held_workspace_states().await.is_empty());
}
