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
    SessionHistoryFramework, SessionHistoryIdentityExpectation, SessionHistorySourceRef,
};
use sandbox::{EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, ExecTermination, Sandbox};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use super::cli_framework::{EffectiveCliFramework, effective_cli_framework};
use super::{RunnerError, RunnerResult};
use runner_types::types::ExecutionContext;

/// Mirror the finalized child launch, including managed overrides. User HOME,
/// CLAUDE_CONFIG_DIR and CODEX_HOME do not override the managed framework homes.
/// Pi resumes by id in its fixed directory; the guest proves unique selection.
pub(super) fn current_source(
    context: &ExecutionContext,
    retained: &SessionHistorySourceRef,
) -> Option<SessionHistorySourceRef> {
    let session_id = context.native_continuation.as_ref()?.session_id.as_ref()?;
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
    let expected = if let Some(native) = &context.native_continuation {
        let Some(session_id) = native.session_id.as_deref() else {
            return Ok(false);
        };
        if native.generation_run_id.as_deref() != Some(binding.proof.generation.as_str()) {
            return Ok(false);
        }
        let expected_session_id = if effective_cli_framework(&context.cli_agent_type)
            == EffectiveCliFramework::Codex
        {
            let Some(id) = guest_contracts::codex_thread_id::canonical_codex_thread_id(session_id)
            else {
                return Ok(false);
            };
            id
        } else {
            session_id.to_owned()
        };
        let identity = &binding.proof.identity;
        if identity.framework
            != SessionHistoryFramework::from(guest_contracts::env::CliFramework::from(
                effective_cli_framework(&context.cli_agent_type),
            ))
            || identity.session_id_hash
                != hex::encode(Sha256::digest(expected_session_id.as_bytes()))
        {
            return Ok(false);
        }
        SessionHistoryIdentityExpectation::new(
            identity.framework,
            identity.session_id_hash.clone(),
            identity.history_ref_kind,
            identity.history_hash.clone(),
            identity.history_size_bytes,
        )
        .ok()
    } else {
        return Ok(false);
    };
    let Some(expected) = expected else {
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
mod tests;
