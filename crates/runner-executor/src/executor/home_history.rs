//! Advisory image evidence consumed only after current managed preparation.

use std::time::Duration;

use api_contracts::generated::constants::runners::paths::{
    CANONICAL_CLAUDE_CONFIG_DIR, CANONICAL_CODEX_HOME_DIR, CANONICAL_PI_SESSION_DIR,
    CANONICAL_WORKING_DIR,
};
use guest_contracts::home_cache_history::{
    HOME_CACHE_HISTORY_HELPER_MAX_BYTES, HOME_CACHE_HISTORY_VERIFY_COMMAND,
    HomeCacheHistoryProofBinding, HomeCacheHistoryVerifyReport, HomeCacheHistoryVerifyRequest,
};
use guest_contracts::session_history_identity::{
    SessionHistoryFramework, SessionHistoryIdentityExpectation, SessionHistoryRefKind,
    SessionHistorySourceRef,
};
use sandbox::{EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, ExecTermination, Sandbox};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use super::cli_framework::{EffectiveCliFramework, effective_cli_framework};
use super::{RunnerError, RunnerResult};
use runner_types::types::ExecutionContext;

pub(super) fn expected_history(
    context: &ExecutionContext,
) -> Option<SessionHistoryIdentityExpectation> {
    super::env::validate_resume_session_id(context).ok()?;
    let resume = context.resume_session.as_ref()?;
    let history = resume.history_ref()?;
    let framework = effective_cli_framework(&context.cli_agent_type);
    let session_id = match framework {
        EffectiveCliFramework::Codex => {
            guest_contracts::codex_thread_id::canonical_codex_thread_id(
                &resume.cli_agent_session_id,
            )?
        }
        EffectiveCliFramework::ClaudeCode | EffectiveCliFramework::Pi => {
            resume.cli_agent_session_id.clone()
        }
    };
    SessionHistoryIdentityExpectation::new(
        SessionHistoryFramework::from(guest_contracts::env::CliFramework::from(framework)),
        hex::encode(Sha256::digest(session_id.as_bytes())),
        SessionHistoryRefKind::Blob,
        history.hash.clone(),
        history.raw_size,
    )
    .ok()
}

/// Mirror the finalized child launch, including managed overrides. User HOME,
/// CLAUDE_CONFIG_DIR and CODEX_HOME do not override the managed framework homes.
/// Pi resumes by id in its fixed directory; the guest proves unique selection.
pub(super) fn current_source(
    context: &ExecutionContext,
    retained: &SessionHistorySourceRef,
) -> Option<SessionHistorySourceRef> {
    let session_id = &context.resume_session.as_ref()?.cli_agent_session_id;
    match effective_cli_framework(&context.cli_agent_type) {
        EffectiveCliFramework::ClaudeCode => Some(SessionHistorySourceRef::ClaudeCode {
            config_dir: CANONICAL_CLAUDE_CONFIG_DIR.into(),
            working_dir: CANONICAL_WORKING_DIR.into(),
            session_id: session_id.clone(),
        }),
        EffectiveCliFramework::Codex => Some(SessionHistorySourceRef::Codex {
            sessions_dir: format!("{CANONICAL_CODEX_HOME_DIR}/sessions"),
            thread_id: guest_contracts::codex_thread_id::canonical_codex_thread_id(session_id)?,
        }),
        EffectiveCliFramework::Pi => {
            let SessionHistorySourceRef::Pi {
                session_path,
                session_id: retained_id,
            } = retained
            else {
                return None;
            };
            if retained_id != session_id
                || std::path::Path::new(session_path).parent()
                    != Some(std::path::Path::new(CANONICAL_PI_SESSION_DIR))
            {
                return None;
            }
            Some(SessionHistorySourceRef::Pi {
                session_path: session_path.clone(),
                session_id: session_id.clone(),
            })
        }
    }
}

pub(super) async fn verify_home_candidate(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    binding: HomeCacheHistoryProofBinding,
    cancel: &CancellationToken,
) -> RunnerResult<bool> {
    if cancel.is_cancelled() {
        return Err(RunnerError::Cancelled);
    }
    let Some(expected) = expected_history(context) else {
        return Ok(false);
    };
    let Some(source) = current_source(context, &binding.proof.identity.history_source) else {
        return Ok(false);
    };
    let request = HomeCacheHistoryVerifyRequest {
        binding,
        expected,
        source,
    };
    if request.validate().is_err() {
        return Ok(false);
    }
    let bytes = serde_json::to_vec(&request).map_err(|error| {
        RunnerError::Internal(format!("serialize history verification: {error}"))
    })?;
    if bytes.len() > HOME_CACHE_HISTORY_HELPER_MAX_BYTES {
        return Ok(false);
    }
    let command = format!(
        "{} {HOME_CACHE_HISTORY_VERIFY_COMMAND}",
        guest_contracts::guest_binary::AGENT_PATH
    );
    let result = sandbox
        .exec_with_diagnostic_label(
            &ExecRequest {
                cmd: &command,
                timeout: Duration::from_secs(5),
                env: &[],
                sudo: true,
                expected_exit_codes: &[],
                stdin_bytes: Some(&bytes),
                output_limits: EXEC_OUTPUT_LIMIT_64_KIB,
            },
            "home-cache-history-verify",
        )
        .await;
    if cancel.is_cancelled() {
        return Err(RunnerError::Cancelled);
    }
    let Ok(result) = result else {
        return Ok(false);
    };
    if result.termination == ExecTermination::Cancelled {
        return Err(RunnerError::Cancelled);
    }
    if !crate::helper_exec::helper_exec_succeeded(&result)
        || result.stdout_truncated
        || result.stdout.len() > HOME_CACHE_HISTORY_HELPER_MAX_BYTES
    {
        return Ok(false);
    }
    Ok(
        serde_json::from_slice::<HomeCacheHistoryVerifyReport>(&result.stdout)
            .is_ok_and(|report| report.verified),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_fixtures::execution_context::execution_context_for_test;
    use runner_types::ids::RunId;
    use runner_types::types::{
        ResumeSession, ResumeSessionHistory, ResumeSessionHistoryEncoding, ResumeSessionHistoryRef,
        ResumeSessionHistoryRefKind,
    };

    fn context() -> ExecutionContext {
        let mut context = execution_context_for_test(RunId::new_v4());
        context.resume_session = Some(ResumeSession {
            cli_agent_session_id: "session-1".into(),
            history: ResumeSessionHistory::Ref {
                history_ref: ResumeSessionHistoryRef {
                    kind: ResumeSessionHistoryRefKind::Blob,
                    hash: hex::encode(Sha256::digest(b"history")),
                    raw_size: 7,
                    encoded_size: 7,
                    url: "http://localhost/history".into(),
                    download_source: None,
                    encoding: ResumeSessionHistoryEncoding::Identity,
                },
            },
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
        let expected = expected_history(&context).unwrap();
        assert_eq!(expected.history_size_bytes, 7);
        assert_eq!(
            expected.session_id_hash,
            hex::encode(Sha256::digest(b"session-1"))
        );
    }

    #[tokio::test]
    async fn cancellation_is_not_a_successful_history_miss() {
        let context = context();
        let expected = expected_history(&context).unwrap();
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
            expected.framework,
            expected.session_id_hash,
            expected.history_ref_kind,
            expected.history_hash,
            7,
            source,
        )
        .unwrap();
        let binding = HomeCacheHistoryProofBinding {
            proof: guest_contracts::home_cache_history::HomeCacheHistoryProof {
                format_version: 1,
                generation: uuid::Uuid::new_v4().to_string(),
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
}
