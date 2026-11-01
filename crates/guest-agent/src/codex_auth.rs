//! Reconcile Codex `auth.json` in Okou's canonical Codex home before launching the CLI.
//!
//! The guest-agent owns the complete local Codex auth state because sandboxes
//! can be reused across runs. Each run must therefore write the desired auth
//! mode or remove stale auth from a previous run before Codex starts.
//!
//! Codex (`openai/codex`) decides between API-key mode and ChatGPT mode at
//! load time from `auth.json` contents. By writing an `auth.json` with
//! `auth_mode: "chatgpt"`, `OPENAI_API_KEY: null`, and a `tokens` object
//! whose JWTs carry far-future `exp` claims, we put the codex CLI into
//! ChatGPT mode without ever holding real OAuth credentials inside the
//! sandbox. Newer Codex versions compare the local account ID with workspace
//! discovery, so the selected workspace ID is copied into auth.json. The
//! bearer and refresh tokens remain placeholders. The mitm firewall injects
//! the real access token on ChatGPT API egress. Real OAuth refresh belongs to
//! the API lifecycle (`refreshAccessTokenForSource$` in
//! `turbo/apps/api/src/signals/services/agent-webhook-firewall-auth.service.ts`).
//! Guest refresh is blocked by `REFRESH_TOKEN_NOOP_URL` and the firewall's
//! deny policy for `auth.openai.com`.
//!
//! Codex `decode_jwt_payload` (`codex-rs/login/src/token_data.rs:117-128`)
//! base64url-decodes only the payload segment; the header and signature
//! segments must be non-empty but are not validated. So a syntactically
//! valid 3-segment JWT with a `https://api.openai.com/auth` claim
//! namespace and a far-future `exp` is sufficient for codex's local
//! parser.
//!
//! See issue #11877 and parent Epic #11872 for full context.

use std::path::Path;

#[cfg(test)]
use api_contracts::generated::constants::codex_oauth_token::placeholders::CHATGPT_ACCOUNT_ID as PLACEHOLDER_CHATGPT_ACCOUNT_ID;
use api_contracts::generated::constants::codex_oauth_token::placeholders::CHATGPT_REFRESH_TOKEN as PLACEHOLDER_CHATGPT_REFRESH_TOKEN;
use base64::Engine;
use chrono::{DateTime, Utc};
use guest_contracts::runtime_paths::{self, PrivateFileReplacementTarget};
use serde_json::{Value, json};

use crate::error::AgentError;

// ---------------------------------------------------------------------------
// Placeholder constants
//
// The ChatGPT OAuth placeholder byte strings are generated from the
// TypeScript model-provider contract. That keeps guest-agent's fabricated
// auth.json aligned with the firewall's egress replacement map.
// ---------------------------------------------------------------------------

/// Placeholder ChatGPT plan type. Must be a non-`free` plan name; codex
/// rejects `free`. The real plan type is enforced server-side at provider
/// creation; this string only needs to satisfy codex's local parser.
pub(crate) const PLACEHOLDER_PLAN_TYPE: &str = "plus";

/// Far-future JWT `exp` offset, in seconds. For a parseable access token,
/// Codex's `AuthManager::should_refresh_proactively` returns true when
/// its `exp` is no later than five minutes from now:
/// <https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/login/src/auth/manager.rs#L2955-L2974>.
/// An `exp` ~100 years from now therefore keeps the predicate false during
/// runs.
const FAR_FUTURE_EXP_SECS: i64 = 100 * 365 * 24 * 3600;

/// Localhost no-op URL for `CODEX_REFRESH_TOKEN_URL_OVERRIDE`. Defense
/// in depth: if codex tries to refresh despite the far-future `exp`,
/// the request hits a closed port and fails fast instead of escaping
/// to `auth.openai.com`. The firewall additionally denies that
/// hostname from inside the sandbox (Epic #11872 risk-mitigation row).
pub(crate) const REFRESH_TOKEN_NOOP_URL: &str = "http://127.0.0.1:1/blocked";
const CODEX_HOME_MODE: u32 = 0o700;
#[cfg(test)]
const AUTH_JSON_MODE: u32 = 0o600;

pub(crate) enum DesiredCodexAuth<'a> {
    ChatGpt {
        now: DateTime<Utc>,
        account_id: &'a str,
    },
    ApiKey {
        api_key: &'a str,
    },
    None,
}

// ---------------------------------------------------------------------------
// JWT builder
//
// Header is `{"alg":"HS256","typ":"JWT"}` (NOT `alg:none` — the latter
// is a known antipattern that strict JWT libraries reject by default).
// Signature segment is a fixed non-empty literal; codex doesn't validate
// signatures locally, so no real HMAC computation is needed.
// ---------------------------------------------------------------------------

fn make_placeholder_jwt(payload: &Value) -> Result<String, AgentError> {
    let header = json!({"alg": "HS256", "typ": "JWT"});
    let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let header_b64 = engine.encode(serde_json::to_string(&header)?.as_bytes());
    let payload_b64 = engine.encode(serde_json::to_string(payload)?.as_bytes());
    // Fixed placeholder signature segment — codex doesn't validate it,
    // and we don't have OpenAI's signing key. Non-empty satisfies the
    // segment-presence check in `decode_jwt_payload`.
    let sig = "PLACEHOLDER_SIG_DO_NOT_TRUST";
    Ok(format!("{header_b64}.{payload_b64}.{sig}"))
}

// ---------------------------------------------------------------------------
// Claim builders
// ---------------------------------------------------------------------------

/// Build the JWT payload for the access_token. Codex parses this for
/// `chatgpt_account_id` (under the `https://api.openai.com/auth`
/// namespace) and `exp` (top-level). Far-future `exp` prevents
/// proactive refresh.
fn build_access_token_claims(now: DateTime<Utc>, account_id: &str) -> Value {
    let exp = now.timestamp() + FAR_FUTURE_EXP_SECS;
    json!({
        "https://api.openai.com/auth": {
            "chatgpt_account_id": account_id,
            "chatgpt_plan_type": PLACEHOLDER_PLAN_TYPE,
        },
        "iat": now.timestamp(),
        "exp": exp,
    })
}

/// id_token claims include `chatgpt_account_id`, `chatgpt_plan_type`,
/// `chatgpt_user_id`, and `chatgpt_account_is_fedramp` — parsed by
/// codex's `IdTokenInfo` struct (`codex-rs/login/src/token_data.rs:28-42`).
fn build_id_token_claims(now: DateTime<Utc>, account_id: &str) -> Value {
    let exp = now.timestamp() + FAR_FUTURE_EXP_SECS;
    json!({
        "https://api.openai.com/auth": {
            "chatgpt_account_id": account_id,
            "chatgpt_plan_type": PLACEHOLDER_PLAN_TYPE,
            "chatgpt_user_id": "placeholder",
            "chatgpt_account_is_fedramp": false,
        },
        "iat": now.timestamp(),
        "exp": exp,
    })
}

// ---------------------------------------------------------------------------
// auth.json builder
//
// Three independent ChatGPT-mode signals (defense in depth against
// future codex refactors):
//   1. `auth_mode: "chatgpt"` (explicit; wins first in `resolved_mode()`)
//   2. `OPENAI_API_KEY: null` (defends against the unconditional fallback
//      being gated on `tokens.is_some()` in some future codex version)
//   3. `tokens` populated with valid placeholder JWTs
// ---------------------------------------------------------------------------

fn build_chatgpt_auth_json(now: DateTime<Utc>, account_id: &str) -> Result<Value, AgentError> {
    let access_jwt = make_placeholder_jwt(&build_access_token_claims(now, account_id))?;
    let id_jwt = make_placeholder_jwt(&build_id_token_claims(now, account_id))?;

    Ok(json!({
        "auth_mode": "chatgpt",
        "OPENAI_API_KEY": Value::Null,
        "tokens": {
            "id_token": id_jwt,
            "access_token": access_jwt,
            // Non-empty placeholder per #12077 — an empty refresh_token caused
            // Codex to exit at boot before any HTTP egress. It only satisfies
            // local auth/bootstrap; guest refresh is blocked, and the API
            // refreshes real credentials (see the module documentation).
            "refresh_token": PLACEHOLDER_CHATGPT_REFRESH_TOKEN,
            "account_id": account_id,
        },
        "last_refresh": now.to_rfc3339(),
    }))
}

fn build_api_key_auth_json(api_key: &str) -> Value {
    json!({
        "auth_mode": "apikey",
        "OPENAI_API_KEY": api_key,
    })
}

fn prepare_codex_home(codex_home: &Path) -> Result<(), AgentError> {
    use std::os::unix::fs::PermissionsExt;

    let metadata = match std::fs::symlink_metadata(codex_home) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir_all(codex_home)?;
            std::fs::symlink_metadata(codex_home)?
        }
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink() {
        return Err(AgentError::Execution(format!(
            "refusing to write codex auth through symlinked directory {}",
            codex_home.display()
        )));
    }
    if !metadata.is_dir() {
        return Err(AgentError::Execution(format!(
            "codex auth path is not a directory: {}",
            codex_home.display()
        )));
    }

    std::fs::set_permissions(codex_home, std::fs::Permissions::from_mode(CODEX_HOME_MODE))?;

    Ok(())
}

fn remove_auth_json(codex_home: &Path) -> Result<(), AgentError> {
    let auth_path = codex_home.join("auth.json");
    let metadata = match std::fs::symlink_metadata(&auth_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };

    if metadata.is_dir() {
        return Err(AgentError::Execution(format!(
            "codex auth path is a directory: {}",
            auth_path.display()
        )));
    }

    std::fs::remove_file(&auth_path)?;
    Ok(())
}

fn write_auth_json_atomic(codex_home: &Path, serialized: &str) -> Result<(), AgentError> {
    let auth_path = codex_home.join("auth.json");
    runtime_paths::replace_private_atomic(
        auth_path,
        serialized,
        PrivateFileReplacementTarget::ReplaceFinalEntry,
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Setup function
//
// Inputs are explicit so file-state transitions remain testable without
// touching env or the real clock. `cli::codex_setup` derives the desired auth
// state from the captured runtime config.
// ---------------------------------------------------------------------------

pub(crate) fn reconcile_codex_auth_state(
    codex_home: &Path,
    desired: DesiredCodexAuth<'_>,
) -> Result<(), AgentError> {
    prepare_codex_home(codex_home)?;

    match desired {
        DesiredCodexAuth::ChatGpt { now, account_id } => {
            let auth_json = build_chatgpt_auth_json(now, account_id)?;
            let serialized = serde_json::to_string(&auth_json)?;
            write_auth_json_atomic(codex_home, &serialized)
        }
        DesiredCodexAuth::ApiKey { api_key } => {
            let auth_json = build_api_key_auth_json(api_key);
            let serialized = serde_json::to_string(&auth_json)?;
            write_auth_json_atomic(codex_home, &serialized)
        }
        DesiredCodexAuth::None => remove_auth_json(codex_home),
    }
}

#[cfg(test)]
mod tests;
