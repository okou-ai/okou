use std::sync::Arc;
use std::task::Poll;

use guest_contracts::session_history_identity::{
    SessionHistorySidecarExportMetadata, SessionHistorySidecarRepresentation,
};
use sandbox::{ExecResult, SandboxError, SandboxId};
use sandbox_mock::{MockLifecycleGate, MockSandbox, MockSandboxOverrides};

use super::destroy_tests::{make_idle_destroy_job_for, make_idle_destroy_payload_for};
use super::entry::WorkspacePromotionPolicy;
use super::*;
use crate::resource_budget::ResourceBudget;
use crate::workspace_image_cache::WorkspaceCacheCheckoutResult;
use crate::workspace_promotion::prepare_workspace_image_from_active_sandbox;
use crate::workspace_promotion::test_support::{
    WorkspacePromotionFixture, test_restored_session_identity,
};

const WAIT: Duration = Duration::from_secs(5);

async fn sibling_fixture(
    first: &WorkspacePromotionFixture,
    key: &str,
) -> WorkspacePromotionFixture {
    WorkspacePromotionFixture::new_with_cache(
        Arc::clone(&first._dir),
        first.cache.clone(),
        key,
        None,
    )
    .await
}

#[tokio::test]
async fn idle_reclamation_holds_from_terminal_unpark_through_kill_but_not_host_destroy() {
    let history = br#"{"type":"message","content":"bounded reclamation"}"#;
    let identity = test_restored_session_identity("sess-reclamation", history);
    let first = WorkspacePromotionFixture::new_with_restored_session_identity_and_export_capacity(
        "thread:reclamation-first",
        Some(&identity),
        1,
    )
    .await;
    let second = sibling_fixture(&first, "thread:reclamation-second").await;
    let overrides = Arc::new(MockSandboxOverrides::new());
    let unpark = MockLifecycleGate::new();
    let exec = MockLifecycleGate::new();
    let copy = MockLifecycleGate::new();
    let kill = MockLifecycleGate::new();
    let destroy = MockLifecycleGate::new();
    overrides.set_unpark_lifecycle_gate(unpark.clone());
    overrides.set_exec_lifecycle_gate(exec.clone());
    overrides.set_copy_file_lifecycle_gate(copy.clone());
    overrides.set_kill_lifecycle_gate(kill.clone());
    overrides.set_destroy_lifecycle_gate(destroy.clone());
    overrides.add_exec_result_matcher(
        "export-session-history-sidecar",
        ExecResult::new(
            0,
            serde_json::to_vec(&SessionHistorySidecarExportMetadata {
                timings: Default::default(),
                representation: SessionHistorySidecarRepresentation::Raw,
                encoded_size: history.len() as u64,
            })
            .unwrap(),
            Vec::new(),
        ),
    );
    overrides.push_copy_file_result(Ok(history.to_vec()));
    let budget = Arc::new(ResourceBudget::new(2, 4096, 1.0, 0));
    let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
    let job = make_idle_destroy_job_for(
        first.sandbox_id,
        overrides.clone(),
        lease,
        Some(first.promotion),
    )
    .await;
    let task = tokio::spawn(job.run_with_context("soft_drain"));
    unpark.wait_entered(1, WAIT).await.unwrap();

    let second_overrides = Arc::new(MockSandboxOverrides::new());
    let second_payload = make_idle_destroy_payload_for(
        second.sandbox_id,
        second_overrides.clone(),
        Some(second.promotion),
    )
    .await;
    let queued = second_payload.finalize_workspace_and_destroy("candidate_admission_oldest");
    tokio::pin!(queued);
    assert!(matches!(futures_util::poll!(&mut queued), Poll::Pending));
    assert_eq!(second_overrides.unpark_call_count(), 0);

    unpark.release_one();
    exec.wait_entered(1, WAIT).await.unwrap();
    assert!(matches!(futures_util::poll!(&mut queued), Poll::Pending));
    assert_eq!(second_overrides.unpark_call_count(), 0);
    exec.release_one();
    copy.wait_entered(1, WAIT).await.unwrap();
    assert!(matches!(futures_util::poll!(&mut queued), Poll::Pending));
    assert_eq!(second_overrides.unpark_call_count(), 0);
    copy.release_one();
    // Workspace freeze remains admitted work; guest sidecar cleanup is left
    // to sandbox destruction.
    exec.wait_entered(2, WAIT).await.unwrap();
    assert!(matches!(futures_util::poll!(&mut queued), Poll::Pending));
    assert_eq!(second_overrides.unpark_call_count(), 0);
    exec.release_one();
    kill.wait_entered(1, WAIT).await.unwrap();
    assert!(matches!(futures_util::poll!(&mut queued), Poll::Pending));
    assert_eq!(second_overrides.unpark_call_count(), 0);
    assert!(
        first.cache.held_workspace_states().await.is_empty(),
        "frozen workspace must remain unpublished until kill succeeds"
    );
    assert_eq!(overrides.terminal_unpark_call_count(), 1);
    assert_eq!(overrides.stop_call_count(), 0);
    assert_eq!(overrides.kill_call_count(), 1);
    kill.release_one();
    destroy.wait_entered(1, WAIT).await.unwrap();

    let second_result = tokio::time::timeout(WAIT, queued).await.unwrap();
    assert!(second_result.workspace_cache_promoted);
    assert_eq!(second_overrides.destroy_call_count(), 1);
    assert!(
        !task.is_finished(),
        "post-kill host cleanup is still blocked"
    );
    assert_eq!(budget.allocated(), (2, 4096, 1));
    destroy.release_one();
    assert!(tokio::time::timeout(WAIT, task).await.unwrap().unwrap());
    assert_eq!(budget.allocated(), (0, 0, 0));
    assert_eq!(
        WorkspacePromotionFixture::checkout_result(&first.cache, &first.reuse_key).await,
        WorkspaceCacheCheckoutResult::Hit
    );
}

#[tokio::test]
async fn idle_reclamation_uses_host_cpu_capacity_across_cache_clones() {
    for (host_cpus, capacity) in [(0, 1), (2, 1), (6, 3), (64, 4)] {
        let seed = WorkspacePromotionFixture::new("thread:capacity-seed").await;
        let cache = seed.cache.clone().with_promotion_host_cpus(host_cpus);
        let unpark = MockLifecycleGate::new();
        let overrides = Arc::new(MockSandboxOverrides::new());
        overrides.set_unpark_lifecycle_gate(unpark.clone());
        let mut jobs = Vec::new();
        for index in 0..=capacity {
            let fixture = WorkspacePromotionFixture::new_with_cache(
                Arc::clone(&seed._dir),
                cache.clone(),
                &format!("thread:capacity-{index}"),
                None,
            )
            .await;
            let payload = make_idle_destroy_payload_for(
                fixture.sandbox_id,
                overrides.clone(),
                Some(fixture.promotion),
            )
            .await;
            jobs.push(Box::pin(
                payload.finalize_workspace_and_destroy("soft_drain"),
            ));
        }
        for job in &mut jobs {
            assert!(matches!(futures_util::poll!(job.as_mut()), Poll::Pending));
        }
        assert_eq!(unpark.entered_count(), capacity as u64);
        unpark.release_many(capacity + 1);
        let results = tokio::time::timeout(WAIT, futures_util::future::join_all(jobs))
            .await
            .unwrap();
        assert!(
            results
                .iter()
                .all(|result| result.outcome == DestroyOutcome::Completed)
        );
        // Publication is best effort: concurrent post-kill publishers may skip
        // the nonblocking cache-capacity lock, but every sandbox must be cleaned up.
        let promoted = results
            .iter()
            .filter(|result| result.workspace_cache_promoted)
            .count();
        assert!(promoted > 0);
        assert_eq!(seed.cache.held_workspace_states().await.len(), promoted);
        assert_eq!(overrides.destroy_call_count(), (capacity + 1) as u32);
        seed.promotion.abandon_unpublished("test").await.unwrap();
    }
}

#[tokio::test]
async fn idle_reclamation_retains_admission_through_destroy_when_kill_fails() {
    for panics in [false, true] {
        let first =
            WorkspacePromotionFixture::new_with_restored_session_identity_and_export_capacity(
                "thread:kill-failure",
                None,
                1,
            )
            .await;
        let second = sibling_fixture(&first, "thread:after-kill-failure").await;
        let overrides = Arc::new(MockSandboxOverrides::new());
        if panics {
            overrides.push_kill_panic("test kill panic");
        } else {
            overrides.push_kill_result(Err(SandboxError::Start {
                message: "test kill failure".into(),
            }));
        }
        let destroy = MockLifecycleGate::new();
        overrides.set_destroy_lifecycle_gate(destroy.clone());
        let payload = make_idle_destroy_payload_for(
            first.sandbox_id,
            overrides.clone(),
            Some(first.promotion),
        )
        .await;
        let task = tokio::spawn(payload.finalize_workspace_and_destroy("soft_drain"));
        destroy.wait_entered(1, WAIT).await.unwrap();
        let second_overrides = Arc::new(MockSandboxOverrides::new());
        let second_payload = make_idle_destroy_payload_for(
            second.sandbox_id,
            second_overrides.clone(),
            Some(second.promotion),
        )
        .await;
        let queued = second_payload.finalize_workspace_and_destroy("idle_destroy");
        tokio::pin!(queued);
        assert!(matches!(futures_util::poll!(&mut queued), Poll::Pending));
        assert_eq!(second_overrides.unpark_call_count(), 0);
        destroy.release_one();
        let first_result = tokio::time::timeout(WAIT, task).await.unwrap().unwrap();
        assert!(!first_result.workspace_cache_promoted);
        assert_eq!(
            first_result.outcome,
            if panics {
                DestroyOutcome::Uncertain
            } else {
                DestroyOutcome::Completed
            }
        );
        assert!(
            tokio::time::timeout(WAIT, queued)
                .await
                .unwrap()
                .workspace_cache_promoted
        );
        assert!(
            first
                .cache
                .held_workspace_states()
                .await
                .iter()
                .all(|state| state.reuse_key != first.reuse_key)
        );
    }
}

#[tokio::test]
async fn idle_reclamation_failure_releases_admission_after_cleanup() {
    enum Failure {
        UnparkError,
        UnparkPanic,
        FreezeError,
        FreezePanic,
        DestroyPanic,
    }
    for failure in [
        Failure::UnparkError,
        Failure::UnparkPanic,
        Failure::FreezeError,
        Failure::FreezePanic,
        Failure::DestroyPanic,
    ] {
        let first =
            WorkspacePromotionFixture::new_with_restored_session_identity_and_export_capacity(
                "thread:preparation-failure",
                None,
                1,
            )
            .await;
        let second = sibling_fixture(&first, "thread:after-preparation-failure").await;
        let overrides = Arc::new(MockSandboxOverrides::new());
        match failure {
            Failure::UnparkError => overrides.push_unpark_result(Err(SandboxError::Start {
                message: "test unpark error".into(),
            })),
            Failure::UnparkPanic => overrides.push_unpark_panic("test unpark panic"),
            Failure::FreezeError => overrides
                .add_exec_result_matcher("--freeze", ExecResult::new(1, Vec::new(), Vec::new())),
            Failure::FreezePanic => {
                overrides.add_exec_panic_matcher("--freeze", "test freeze panic")
            }
            Failure::DestroyPanic => {
                overrides.push_kill_panic("test kill panic");
                overrides.push_destroy_panic("test destroy panic");
            }
        }
        let payload = make_idle_destroy_payload_for(
            first.sandbox_id,
            overrides.clone(),
            Some(first.promotion),
        )
        .await;
        let result =
            tokio::time::timeout(WAIT, payload.finalize_workspace_and_destroy("test_failure"))
                .await
                .unwrap();
        assert!(!result.workspace_cache_promoted);
        assert_eq!(overrides.destroy_call_count(), 1);
        let next = make_idle_destroy_payload_for(
            second.sandbox_id,
            Arc::new(MockSandboxOverrides::new()),
            Some(second.promotion),
        )
        .await;
        assert!(
            tokio::time::timeout(WAIT, next.finalize_workspace_and_destroy("test_followup"))
                .await
                .unwrap()
                .workspace_cache_promoted
        );
    }
}

#[tokio::test]
async fn idle_reclamation_admission_does_not_block_bypass_or_active_promotion() {
    let first = WorkspacePromotionFixture::new_with_restored_session_identity_and_export_capacity(
        "thread:blocked-reclamation",
        None,
        1,
    )
    .await;
    let abandoned = sibling_fixture(&first, "thread:abandoned-reclamation").await;
    let history = br#"{"type":"message","content":"active export"}"#;
    let identity = test_restored_session_identity("sess-active-export", history);
    let active = WorkspacePromotionFixture::new_with_cache(
        Arc::clone(&first._dir),
        first.cache.clone(),
        "thread:active-promotion",
        Some(&identity),
    )
    .await;
    let overrides = Arc::new(MockSandboxOverrides::new());
    let unpark = MockLifecycleGate::new();
    overrides.set_unpark_lifecycle_gate(unpark.clone());
    let payload =
        make_idle_destroy_payload_for(first.sandbox_id, overrides, Some(first.promotion)).await;
    let task = tokio::spawn(payload.finalize_workspace_and_destroy("soft_drain"));
    unpark.wait_entered(1, WAIT).await.unwrap();

    let bypass_overrides = Arc::new(MockSandboxOverrides::new());
    let missing =
        make_idle_destroy_payload_for(SandboxId::new_v4(), bypass_overrides.clone(), None).await;
    let result = tokio::time::timeout(WAIT, missing.finalize_workspace_and_destroy("idle_destroy"))
        .await
        .unwrap();
    assert!(!result.workspace_cache_promoted);
    let mut abandoned_payload = make_idle_destroy_payload_for(
        abandoned.sandbox_id,
        bypass_overrides.clone(),
        Some(abandoned.promotion),
    )
    .await;
    abandoned_payload.workspace_promotion_policy =
        WorkspacePromotionPolicy::AbandonUnpublished("test_abandon");
    let result = tokio::time::timeout(
        WAIT,
        abandoned_payload.finalize_workspace_and_destroy("idle_destroy"),
    )
    .await
    .unwrap();
    assert!(!result.workspace_cache_promoted);
    assert_eq!(bypass_overrides.unpark_call_count(), 0);
    assert_eq!(bypass_overrides.destroy_call_count(), 2);

    let sandbox = MockSandbox::new(active.sandbox_id.to_string());
    sandbox.push_exec_result(Ok(ExecResult::new(
        0,
        serde_json::to_vec(&SessionHistorySidecarExportMetadata {
            timings: Default::default(),
            representation: SessionHistorySidecarRepresentation::Raw,
            encoded_size: history.len() as u64,
        })
        .unwrap(),
        Vec::new(),
    )));
    sandbox.push_copy_file_result(Ok(history.to_vec()));
    let prepared = tokio::time::timeout(
        WAIT,
        prepare_workspace_image_from_active_sandbox(
            &sandbox,
            Some(active.promotion),
            "active_finalization",
        ),
    )
    .await
    .unwrap()
    .unwrap();
    prepared.abandon("test").await;
    assert!(!task.is_finished());
    unpark.release_one();
    assert!(
        tokio::time::timeout(WAIT, task)
            .await
            .unwrap()
            .unwrap()
            .workspace_cache_promoted
    );
}
