use guest_contracts::cli_agent_session_id::is_valid_cli_agent_session_id;
use guest_contracts::diagnostics::FailureDiagnostic;
use sandbox::Sandbox;
use tracing::warn;

use super::super::session_id::invalid_session_id_diagnostic_preview;
use super::super::{SMALL_GUEST_FILE_MAX_BYTES, guest_runtime_path};
use runner_types::ids::RunId;

pub(in crate::executor) async fn read_guest_error_file(
    sandbox: &dyn Sandbox,
    run_id: RunId,
) -> Option<String> {
    let error_path = match guest_runtime_path(
        run_id,
        guest_contracts::runtime_paths::checkpoint_error_file,
    ) {
        Ok(path) => path,
        Err(e) => {
            warn!(run_id = %run_id, error = %e, "failed to resolve guest error file path");
            return None;
        }
    };
    match sandbox
        .read_file(&error_path, SMALL_GUEST_FILE_MAX_BYTES)
        .await
    {
        Ok(Some(bytes)) if !bytes.is_empty() => {
            let msg = String::from_utf8_lossy(&bytes).trim().to_string();
            Some(msg).filter(|s| !s.is_empty())
        }
        _ => None,
    }
}

/// Read structured guest failure diagnostics from the guest filesystem.
///
/// Diagnostics are optional and best-effort. They must never change the
/// user-visible completion error or mask the original exit status.
pub(in crate::executor) async fn read_guest_failure_diagnostic_file(
    sandbox: &dyn Sandbox,
    run_id: RunId,
) -> Option<FailureDiagnostic> {
    let path = match guest_runtime_path(
        run_id,
        guest_contracts::runtime_paths::failure_diagnostic_file,
    ) {
        Ok(path) => path,
        Err(e) => {
            warn!(run_id = %run_id, error = %e, "failed to resolve guest failure diagnostic path");
            return None;
        }
    };
    match sandbox.read_file(&path, SMALL_GUEST_FILE_MAX_BYTES).await {
        Ok(Some(bytes)) if !bytes.iter().all(|byte| byte.is_ascii_whitespace()) => {
            match serde_json::from_slice::<FailureDiagnostic>(&bytes) {
                Ok(diagnostic) => Some(diagnostic),
                Err(e) => {
                    warn!(run_id = %run_id, error = %e, "failed to parse guest failure diagnostic");
                    None
                }
            }
        }
        Ok(_) => None,
        Err(e) => {
            warn!(run_id = %run_id, error = %e, "failed to read guest failure diagnostic");
            None
        }
    }
}

/// Read the CLI-generated session ID from the guest filesystem.
///
/// The guest-agent writes the session ID to the guest runtime directory
/// when the CLI reports it. When the execution context supplies no session ID,
/// the runner uses this as the late-discovered identity for session tracking
/// and finalization. Preassigned Pi session IDs skip this discovery path.
pub(in crate::executor) async fn read_guest_cli_agent_session_id(
    sandbox: &dyn Sandbox,
    run_id: RunId,
) -> Option<String> {
    let path = match guest_runtime_path(run_id, guest_contracts::runtime_paths::session_id_file) {
        Ok(path) => path,
        Err(e) => {
            warn!(run_id = %run_id, error = %e, "failed to resolve guest session id path");
            return None;
        }
    };
    match sandbox.read_file(&path, SMALL_GUEST_FILE_MAX_BYTES).await {
        Ok(Some(bytes)) if !bytes.is_empty() => {
            let id = String::from_utf8_lossy(&bytes).trim().to_string();
            if id.is_empty() {
                return None;
            }
            if !is_valid_cli_agent_session_id(&id) {
                warn!(
                    run_id = %run_id,
                    session_id = %invalid_session_id_diagnostic_preview(&id),
                    "ignoring invalid guest session ID"
                );
                return None;
            }
            Some(id)
        }
        _ => None,
    }
}
