use super::*;
use crate::test_fixtures::execution_context::execution_context_for_test;
use guest_contracts::session_history_identity::SessionHistoryRefKind;
use runner_types::ids::RunId;

fn context() -> ExecutionContext {
    let mut context = execution_context_for_test(RunId::new_v4());
    context.native_continuation = Some(guest_contracts::env::NativeContinuation {
        session_id: Some("session-1".into()),
        generation_run_id: Some(uuid::Uuid::new_v4().to_string()),
        recovery_prompt: None,
    });
    context
}

#[test]
fn current_managed_source_does_not_inherit_cached_or_user_config() {
    let mut context = context();
    context.environment = Some(std::collections::HashMap::from([(
        "CLAUDE_CONFIG_DIR".into(),
        "/tmp/old".into(),
    )]));
    let stale = SessionHistorySourceRef::ClaudeCode {
        config_dir: "/tmp/old".into(),
        working_dir: "/old/cwd".into(),
        session_id: "session-1".into(),
    };
    assert_eq!(
        current_source(&context, &stale),
        Some(SessionHistorySourceRef::ClaudeCode {
            config_dir: CANONICAL_CLAUDE_CONFIG_DIR.into(),
            working_dir: CANONICAL_WORKING_DIR.into(),
            session_id: "session-1".into()
        })
    );
}

#[tokio::test]
async fn cancellation_is_not_a_successful_history_miss() {
    let context = context();
    let source = current_source(
        &context,
        &SessionHistorySourceRef::ClaudeCode {
            config_dir: CANONICAL_CLAUDE_CONFIG_DIR.into(),
            working_dir: CANONICAL_WORKING_DIR.into(),
            session_id: "session-1".into(),
        },
    )
    .unwrap();
    let identity = guest_contracts::session_history_identity::SessionHistoryIdentity::new(
        SessionHistoryFramework::ClaudeCode,
        hex::encode(Sha256::digest(b"session-1")),
        SessionHistoryRefKind::LocalHome,
        hex::encode(Sha256::digest(b"history")),
        7,
        source,
    )
    .unwrap();
    let binding = HomeCacheHistoryProofBinding {
        proof: guest_contracts::home_cache_history::HomeCacheHistoryProof {
            format_version: 1,
            generation: context
                .native_continuation
                .as_ref()
                .unwrap()
                .generation_run_id
                .clone()
                .unwrap(),
            identity,
        },
        sha256: "a".repeat(64),
    };
    let cancel = CancellationToken::new();
    cancel.cancel();
    let sandbox = sandbox_mock::MockSandbox::new("cancelled-proof");
    assert!(matches!(
        verify_home_candidate(&sandbox, &context, binding, &cancel).await,
        Err(RunnerError::Cancelled)
    ));
}
