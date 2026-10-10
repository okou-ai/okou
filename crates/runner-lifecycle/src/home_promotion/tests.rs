use super::test_support::{HomePromotionFixture, add_healthy_cache_preparation_matcher};
use super::*;
use guest_contracts::home_cache_history::{
    HomeCacheHistoryProof, HomeCacheHistoryProofBinding, TerminalHomeCachePreparationRequest,
};
use guest_contracts::session_history_identity::{
    SessionHistoryFramework, SessionHistoryIdentity, SessionHistoryRefKind, SessionHistorySourceRef,
};
use sandbox::{ExecResult, Sandbox};
use sandbox_mock::{ExecMatcher, MockSandbox, MockSandboxOverrides};
use std::sync::Arc;

fn terminal_report() -> TerminalHomeCachePreparationReport {
    TerminalHomeCachePreparationReport {
        cleanup: crate::idle_reuse_preparation::healthy_reuse_preparation_report(),
        history_proof: None,
    }
}

#[tokio::test]
async fn changed_terminal_home_mount_rejects_before_cleanup_freeze_or_publication() {
    let fixture = HomePromotionFixture::new("thread:terminal-mount-rejected").await;
    let cache = fixture.cache.clone();
    let overrides = Arc::new(MockSandboxOverrides::new());
    add_healthy_cache_preparation_matcher(&overrides);
    overrides.push_home_drive_mount_result(Ok(ExecResult::new(
        64,
        Vec::new(),
        b"same-device subtree is not the whole home".to_vec(),
    )));
    let sandbox = MockSandbox::with_overrides(fixture.sandbox_id.to_string(), overrides.clone());
    assert!(
        prepare_home_image_from_active_sandbox(&sandbox, Some(fixture.promotion), "test")
            .await
            .is_none()
    );
    assert_eq!(overrides.home_drive_mount_calls(), 1);
    assert!(
        overrides.exec_calls().is_empty(),
        "cleanup and freeze must not run"
    );
    assert!(cache.held_home_states().await.is_empty());
}

#[tokio::test]
async fn parked_home_is_cleaned_then_frozen_but_not_published_before_termination() {
    let fixture = HomePromotionFixture::new("thread:parked-home").await;
    let overrides = Arc::new(MockSandboxOverrides::new());
    add_healthy_cache_preparation_matcher(&overrides);
    let mut sandbox =
        MockSandbox::with_overrides(fixture.sandbox_id.to_string(), overrides.clone());
    let prepared =
        prepare_home_image_from_parked_sandbox(&mut sandbox, Some(fixture.promotion), "test")
            .await
            .unwrap();
    assert_eq!(overrides.terminal_unpark_call_count(), 1);
    assert_eq!(overrides.home_drive_mount_calls(), 1);
    let calls = overrides.exec_calls();
    assert_eq!(calls.len(), 2);
    assert!(calls[0].cmd.ends_with("prepare-for-cache"));
    assert!(calls[0].sudo && calls[0].env_keys.is_empty());
    let request: TerminalHomeCachePreparationRequest =
        serde_json::from_slice(calls[0].stdin_bytes.as_ref().unwrap()).unwrap();
    request.validate().unwrap();
    assert!(
        request
            .current_runtime_dir
            .starts_with("/home/user/.vm0/guest-agent/runs/")
    );
    assert!(calls[1].cmd.contains("/home/user"));
    assert!(calls[1].cmd.contains("--freeze"));
    assert!(!calls[1].cmd.contains("--unfreeze"));
    assert!(fixture.cache.held_home_states().await.is_empty());
    sandbox.stop().await.unwrap();
    assert!(prepared.publish().await);
    assert_eq!(fixture.cache.held_home_states().await.len(), 1);
}

#[tokio::test]
async fn unsupported_malformed_truncated_or_cancelled_cleanup_never_freezes_or_publishes() {
    for result in [
        ExecResult::new(2, Vec::new(), Vec::new()),
        ExecResult::new(0, b"invalid".to_vec(), Vec::new()),
        {
            let mut r = ExecResult::new(
                0,
                serde_json::to_vec(&terminal_report()).unwrap(),
                Vec::new(),
            );
            r.stdout_truncated = true;
            r
        },
        {
            let mut r = ExecResult::new(
                0,
                serde_json::to_vec(&terminal_report()).unwrap(),
                Vec::new(),
            );
            r.termination = sandbox::ExecTermination::Cancelled;
            r
        },
    ] {
        let fixture = HomePromotionFixture::new("thread:invalid-terminal").await;
        let cache = fixture.cache.clone();
        let overrides = Arc::new(MockSandboxOverrides::new());
        overrides.add_exec_result_matcher("prepare-for-cache", result);
        let sandbox =
            MockSandbox::with_overrides(fixture.sandbox_id.to_string(), overrides.clone());
        assert!(
            prepare_home_image_from_active_sandbox(&sandbox, Some(fixture.promotion), "test")
                .await
                .is_none()
        );
        assert_eq!(overrides.exec_calls().len(), 1);
        assert!(cache.held_home_states().await.is_empty());
    }
}

#[tokio::test]
async fn mismatched_proof_generation_or_digest_rejects_publication_before_freeze() {
    for wrong_generation in [true, false] {
        let fixture = HomePromotionFixture::new("thread:proof-binding").await;
        let mut report = terminal_report();
        let generation = if wrong_generation {
            uuid::Uuid::new_v4().to_string()
        } else {
            fixture.promotion.publication_generation()
        };
        let identity = SessionHistoryIdentity::new(
            SessionHistoryFramework::ClaudeCode,
            hex::encode(Sha256::digest(b"session-1")),
            SessionHistoryRefKind::Blob,
            hex::encode(Sha256::digest(b"history")),
            7,
            SessionHistorySourceRef::ClaudeCode {
                config_dir: "/home/user/.claude".into(),
                working_dir: "/home/user/workspace".into(),
                session_id: "session-1".into(),
            },
        )
        .unwrap();
        let proof = HomeCacheHistoryProof {
            format_version: 1,
            generation,
            identity,
        };
        let digest = if wrong_generation {
            hex::encode(Sha256::digest(proof.to_json_vec().unwrap()))
        } else {
            "f".repeat(64)
        };
        report.history_proof = Some(HomeCacheHistoryProofBinding {
            proof,
            sha256: digest,
        });
        let overrides = Arc::new(MockSandboxOverrides::new());
        overrides.add_exec_result_matcher(
            "prepare-for-cache",
            ExecResult::new(0, serde_json::to_vec(&report).unwrap(), Vec::new()),
        );
        let sandbox =
            MockSandbox::with_overrides(fixture.sandbox_id.to_string(), overrides.clone());
        let cache = fixture.cache.clone();
        assert!(
            prepare_home_image_from_active_sandbox(&sandbox, Some(fixture.promotion), "test")
                .await
                .is_none()
        );
        assert_eq!(overrides.exec_calls().len(), 1);
        assert!(cache.held_home_states().await.is_empty());
    }
}

#[tokio::test]
async fn empty_history_proof_is_a_publication_candidate_not_an_idle_capacity_gate() {
    let fixture = HomePromotionFixture::new("thread:home-no-history").await;
    let mut report = terminal_report();
    report.cleanup.after.available_bytes = 0;
    report.cleanup.after.available_inodes = 0;
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.add_exec_result_matcher(
        "prepare-for-cache",
        ExecResult::new(0, serde_json::to_vec(&report).unwrap(), Vec::new()),
    );
    let mut sandbox = MockSandbox::with_overrides(fixture.sandbox_id.to_string(), overrides);
    let prepared =
        prepare_home_image_from_active_sandbox(&sandbox, Some(fixture.promotion), "test")
            .await
            .unwrap();
    sandbox.stop().await.unwrap();
    assert!(prepared.publish().await);
}

#[tokio::test]
async fn failed_unpark_or_freeze_never_returns_a_publishable_image() {
    for unpark_failure in [true, false] {
        let fixture = HomePromotionFixture::new("thread:terminal-failure").await;
        let overrides = Arc::new(MockSandboxOverrides::new());
        add_healthy_cache_preparation_matcher(&overrides);
        if unpark_failure {
            overrides.push_unpark_result(Err(sandbox::SandboxError::IdleTransition {
                transition: sandbox::SandboxIdleTransition::Unpark,
                message: "failed unpark".into(),
            }));
        } else {
            overrides.add_exec_matcher(ExecMatcher {
                pattern: "--freeze".into(),
                exit_code: 64,
                stdout: Vec::new(),
                stderr: b"freeze failed".to_vec(),
            });
        }
        let mut sandbox =
            MockSandbox::with_overrides(fixture.sandbox_id.to_string(), overrides.clone());
        let cache = fixture.cache.clone();
        assert!(
            prepare_home_image_from_parked_sandbox(&mut sandbox, Some(fixture.promotion), "test")
                .await
                .is_none()
        );
        assert_eq!(
            overrides.exec_calls().len(),
            if unpark_failure { 0 } else { 2 }
        );
        assert!(cache.held_home_states().await.is_empty());
    }
}

#[tokio::test]
async fn preparation_panic_and_abandoned_frozen_home_do_not_publish() {
    let fixture = HomePromotionFixture::new("thread:terminal-panic").await;
    let cache = fixture.cache.clone();
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.add_exec_panic_matcher("prepare-for-cache", "synthetic helper panic");
    let sandbox = MockSandbox::with_overrides(fixture.sandbox_id.to_string(), overrides);
    assert!(
        prepare_home_image_from_active_sandbox(&sandbox, Some(fixture.promotion), "test")
            .await
            .is_none()
    );
    assert!(cache.held_home_states().await.is_empty());
    let fixture = HomePromotionFixture::new("thread:abandoned-frozen").await;
    let cache = fixture.cache.clone();
    let sandbox = super::test_support::mock_sandbox_ready_for_cache_preparation(
        fixture.sandbox_id.to_string(),
    );
    let prepared =
        prepare_home_image_from_active_sandbox(&sandbox, Some(fixture.promotion), "test")
            .await
            .unwrap();
    prepared.abandon("termination-unconfirmed").await;
    assert!(cache.held_home_states().await.is_empty());
}
