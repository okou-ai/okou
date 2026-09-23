//! Codex setup boundary.
//!
//! This module owns the guest-side setup wrapper that runs before Codex starts.
//! Auth-state file construction lives in `codex_auth`; app-server process and
//! protocol orchestration stay in the sibling Codex app-server modules.

use std::time::Instant;

use guest_telemetry::log_info;
use guest_telemetry::telemetry::record_sandbox_op;

use crate::codex_auth::{DesiredCodexAuth, reconcile_codex_auth_state};
use crate::env;
use crate::error::AgentError;
use crate::masker::SecretMasker;

use super::codex_runtime_config;

const LOG_TAG: &str = "sandbox:guest-agent";

/// Reconcile Codex runtime files using the config captured during bootstrap.
///
/// Auth reconciliation runs first, and both private writers independently
/// validate `CODEX_HOME` during publication. API-owned runtime provider
/// metadata writes the model catalog before `codex app-server` can observe
/// startup config.
///
/// Three mutually-exclusive states are supported:
///
/// - **ChatGPT-OAuth mode** (`CHATGPT_ACCOUNT_ID` set): write a fabricated
///   canonical `auth.json` containing placeholder JWTs that put Codex into
///   ChatGPT mode without ever holding real OAuth credentials inside the
///   sandbox. The firewall replaces placeholder bytes on egress. See the
///   `codex_auth` module and issue #11877.
/// - **API-key mode** (`OPENAI_API_KEY` set): write Codex's API-key auth.json
///   shape directly. This avoids spawning `codex login --with-api-key` and
///   keeps setup deterministic before the CLI process starts.
/// - **No auth**: remove any stale auth.json left by a previous reused
///   sandbox run so Codex cannot inherit credentials from another run.
pub async fn setup_codex_for_config(
    _masker: &SecretMasker,
    config: &env::GuestConfig,
) -> Result<(), AgentError> {
    let codex_oauth_mode = config
        .user_env
        .get("CHATGPT_ACCOUNT_ID")
        .is_some_and(|value| !value.is_empty());
    let codex_oauth_account_id = config
        .user_env
        .get("CODEX_OAUTH_ACCOUNT_ID")
        .map(String::as_str);
    let api_key = config
        .user_env
        .get("OPENAI_API_KEY")
        .map(String::as_str)
        .unwrap_or("");
    setup_codex_with_values(
        codex_oauth_mode,
        codex_oauth_account_id,
        &config.codex_home_dir,
        api_key,
    )?;
    codex_runtime_config::write_model_catalog_from_raw(
        &config.codex_home_dir,
        &config.codex_runtime_config,
    )
}

fn setup_codex_with_values(
    codex_oauth_mode: bool,
    codex_oauth_account_id: Option<&str>,
    codex_home_dir: &str,
    api_key: &str,
) -> Result<(), AgentError> {
    let setup_start = Instant::now();
    let codex_home = std::path::PathBuf::from(codex_home_dir);
    let (desired, mode_label) = if codex_oauth_mode {
        let account_id = codex_oauth_account_id
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                AgentError::Execution(
                    "Codex OAuth run is missing CODEX_OAUTH_ACCOUNT_ID".to_string(),
                )
            })?;
        (
            DesiredCodexAuth::ChatGpt {
                now: chrono::Utc::now(),
                account_id,
            },
            "chatgpt",
        )
    } else if api_key.is_empty() {
        (DesiredCodexAuth::None, "none")
    } else {
        (DesiredCodexAuth::ApiKey { api_key }, "apikey")
    };

    let result = reconcile_codex_auth_state(&codex_home, desired);
    let success = result.is_ok();
    let err_msg = result.as_ref().err().map(ToString::to_string);
    record_sandbox_op(
        "codex_auth_reconcile",
        setup_start.elapsed(),
        success,
        err_msg.as_deref(),
    );

    if success {
        log_info!(
            LOG_TAG,
            "Codex auth state reconciled with mode {mode_label}"
        );
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_oauth_requires_selected_workspace_id_before_writing_auth() {
        let tmp = tempfile::tempdir().unwrap();
        let codex_home = tmp.path().join(".codex");
        let codex_home_dir = codex_home.to_str().unwrap();

        for account_id in [None, Some(""), Some(" ")] {
            let error = setup_codex_with_values(true, account_id, codex_home_dir, "")
                .expect_err("Codex OAuth must not use a placeholder workspace ID");
            assert!(error.to_string().contains("missing CODEX_OAUTH_ACCOUNT_ID"));
            assert!(!codex_home.join("auth.json").exists());
        }
    }
}
