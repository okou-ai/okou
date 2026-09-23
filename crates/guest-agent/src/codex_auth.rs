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
//! sandbox. Codex 0.156.1 compares the local account ID with workspace
//! discovery, so the selected workspace ID is copied into auth.json. The
//! bearer and refresh tokens remain placeholders; the mitm firewall injects
//! real credentials on egress.
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
/// Codex 0.156.1's `AuthManager::should_refresh_proactively` returns true when
/// its `exp` is no later than five minutes from now:
/// <https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/login/src/auth/manager.rs#L2955-L2974>.
/// This version is pinned by `CODEX_CLI_VERSION` in
/// `crates/runner/scripts/build-template.sh`; an `exp` ~100 years from now
/// therefore keeps the predicate false during runs.
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
            // Non-empty placeholder per #12077 — empty refresh_token caused
            // codex CLI to exit 1 at boot before reaching any HTTP egress,
            // bypassing the firewall replacement entirely. The opaque marker
            // is replaced with the real refresh_token on /oauth/token egress.
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
mod tests {
    //! Integration tests against the single auth reconciliation entry point.
    //! We deliberately avoid testing the
    //! private builders (`make_placeholder_jwt`, `build_access_token_claims`,
    //! etc.) directly: every property they care about (3-segment JWTs,
    //! HS256 header, ChatGPT-namespace claims, far-future `exp`,
    //! plan_type ≠ free, id_token shape, no real-token shapes) is asserted
    //! against the reconciled file. This keeps the internal
    //! shape of the builders refactorable without churning tests, per the
    //! project's "Integration Tests Only" rule.
    use super::*;

    use std::os::unix::fs::{PermissionsExt, symlink};

    use chrono::TimeZone;
    use tempfile::TempDir;

    fn fixed_now() -> DateTime<Utc> {
        // 2026-01-01T00:00:00Z — well after assistant knowledge cutoff
        // so any "exp must be > now" check is unambiguous.
        Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap()
    }

    fn decode_segment(segment: &str) -> Value {
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(segment)
            .expect("JWT segment must be base64url");
        serde_json::from_slice(&bytes).expect("JWT segment must be JSON")
    }

    fn reconcile_chatgpt_auth(
        codex_home: &std::path::Path,
        now: DateTime<Utc>,
    ) -> Result<(), AgentError> {
        reconcile_codex_auth_state(
            codex_home,
            DesiredCodexAuth::ChatGpt {
                now,
                account_id: PLACEHOLDER_CHATGPT_ACCOUNT_ID,
            },
        )
    }

    /// Reconcile ChatGPT auth against a temp dir and return the
    /// parsed `auth.json` plus the path it was written to.
    fn run_setup_and_parse(tmp: &TempDir, now: DateTime<Utc>) -> (Value, std::path::PathBuf) {
        let codex_home = tmp.path().join(".codex");
        reconcile_chatgpt_auth(&codex_home, now).unwrap();
        let auth_path = codex_home.join("auth.json");
        let body = std::fs::read_to_string(&auth_path).unwrap();
        let parsed: Value = serde_json::from_str(&body).unwrap();
        (parsed, auth_path)
    }

    fn read_auth_json(tmp: &TempDir) -> Value {
        let auth_path = tmp.path().join(".codex").join("auth.json");
        let body = std::fs::read_to_string(auth_path).unwrap();
        serde_json::from_str(&body).unwrap()
    }

    /// Asserts the three independent ChatGPT-mode signals, the placeholder
    /// account_id, both JWT shapes (3 segments + HS256 header), the
    /// ChatGPT-namespace claims (account id, plan type ≠ free, user id,
    /// fedramp flag), the far-future `exp`, the non-empty placeholder
    /// refresh token, and the RFC3339 `last_refresh` — i.e. everything
    /// the private builders previously asserted in isolation, asserted
    /// here against the fabricated file.
    #[test]
    fn reconcile_chatgpt_auth_writes_well_formed_chatgpt_auth_json() {
        let tmp = TempDir::new().unwrap();
        let now = fixed_now();
        let (auth, auth_path) = run_setup_and_parse(&tmp, now);

        // File created with mode 0o600 (mask off file-type bits).
        let mode = std::fs::metadata(&auth_path).unwrap().permissions().mode();
        assert_eq!(
            mode & 0o7777,
            0o600,
            "auth.json must be mode 0o600 (got {mode:o})"
        );

        // Three independent ChatGPT-mode signals.
        assert_eq!(auth["auth_mode"], "chatgpt");
        assert_eq!(auth["OPENAI_API_KEY"], Value::Null);
        assert!(auth["tokens"].is_object(), "tokens must be populated");

        // tokens.account_id and refresh_token shape.
        assert_eq!(auth["tokens"]["account_id"], PLACEHOLDER_CHATGPT_ACCOUNT_ID);
        // Non-empty placeholder (#12077): empty refresh_token caused codex
        // CLI to exit 1 at boot before reaching firewall egress.
        assert_eq!(
            auth["tokens"]["refresh_token"],
            PLACEHOLDER_CHATGPT_REFRESH_TOKEN
        );
        assert!(
            !PLACEHOLDER_CHATGPT_REFRESH_TOKEN.is_empty(),
            "refresh_token must not be empty",
        );

        // last_refresh is RFC3339-parseable.
        let last_refresh = auth["last_refresh"].as_str().unwrap();
        DateTime::parse_from_rfc3339(last_refresh).expect("last_refresh must be RFC3339");

        // Both JWTs: 3 non-empty segments, HS256 header, far-future exp,
        // ChatGPT-namespace claims with non-free plan type.
        let fifty_years_secs = 50 * 365 * 24 * 3600;
        for token_field in ["access_token", "id_token"] {
            let jwt = auth["tokens"][token_field]
                .as_str()
                .unwrap_or_else(|| panic!("{token_field} must be a string"));
            let segments: Vec<&str> = jwt.split('.').collect();
            assert_eq!(segments.len(), 3, "{token_field} must be a 3-segment JWT");
            for (i, seg) in segments.iter().enumerate() {
                assert!(
                    !seg.is_empty(),
                    "{token_field} segment {i} must be non-empty"
                );
            }

            let header = decode_segment(segments[0]);
            assert_eq!(
                header["alg"], "HS256",
                "{token_field} header must use HS256"
            );
            assert_eq!(header["typ"], "JWT");

            let claims = decode_segment(segments[1]);
            let auth_ns = &claims["https://api.openai.com/auth"];
            assert_eq!(
                auth_ns["chatgpt_account_id"], PLACEHOLDER_CHATGPT_ACCOUNT_ID,
                "{token_field} must carry placeholder account id"
            );
            let plan_type = auth_ns["chatgpt_plan_type"]
                .as_str()
                .unwrap_or_else(|| panic!("{token_field} must declare chatgpt_plan_type"));
            assert_ne!(
                plan_type, "free",
                "{token_field} plan type must not be 'free' (codex rejects)"
            );
            assert_eq!(claims["iat"].as_i64().unwrap(), now.timestamp());
            let exp = claims["exp"].as_i64().expect("exp must be i64");
            assert!(
                exp > now.timestamp() + fifty_years_secs,
                "{token_field} exp must be at least 50 years in future"
            );
        }

        // id_token-only fields parsed by codex's IdTokenInfo struct
        // (chatgpt_user_id, chatgpt_account_is_fedramp). Decode again
        // for clarity rather than threading through the loop above.
        let id_jwt = auth["tokens"]["id_token"].as_str().unwrap();
        let id_claims = decode_segment(id_jwt.split('.').nth(1).unwrap());
        let id_ns = &id_claims["https://api.openai.com/auth"];
        assert!(
            id_ns["chatgpt_user_id"].is_string(),
            "id_token must include chatgpt_user_id"
        );
        assert_eq!(id_ns["chatgpt_account_is_fedramp"], false);
    }

    /// The serialized `auth.json` must never contain real OpenAI /
    /// Anthropic / Google bearer-token shapes — guards against a future
    /// refactor accidentally embedding live credentials in the
    /// fabricated bootstrap file.
    #[test]
    fn reconcile_chatgpt_auth_writes_no_real_token_shapes() {
        let tmp = TempDir::new().unwrap();
        let (_, auth_path) = run_setup_and_parse(&tmp, fixed_now());
        let serialized = std::fs::read_to_string(&auth_path).unwrap();
        for needle in ["sk-proj-", "sk-ant-", "Bearer ya29.", "eyJhbGciOiJSUzI1NiI"] {
            assert!(
                !serialized.contains(needle),
                "fabricated auth.json must not contain real-token shape {needle:?}: {serialized}"
            );
        }
    }

    #[test]
    fn reconcile_chatgpt_auth_uses_selected_workspace_id_without_real_tokens() {
        let tmp = TempDir::new().unwrap();
        let account_id = "ws_selected_workspace";
        let codex_home = tmp.path().join(".codex");
        reconcile_codex_auth_state(
            &codex_home,
            DesiredCodexAuth::ChatGpt {
                now: fixed_now(),
                account_id,
            },
        )
        .unwrap();

        let auth = read_auth_json(&tmp);
        assert_eq!(auth["tokens"]["account_id"], account_id);
        assert_eq!(
            auth["tokens"]["refresh_token"],
            PLACEHOLDER_CHATGPT_REFRESH_TOKEN,
        );
        for token_field in ["access_token", "id_token"] {
            let jwt = auth["tokens"][token_field].as_str().unwrap();
            let claims = decode_segment(jwt.split('.').nth(1).unwrap());
            assert_eq!(
                claims["https://api.openai.com/auth"]["chatgpt_account_id"],
                account_id,
            );
            assert!(jwt.ends_with("PLACEHOLDER_SIG_DO_NOT_TRUST"));
        }
    }

    #[test]
    fn reconcile_chatgpt_auth_overwrites_existing_auth_json() {
        let tmp = TempDir::new().unwrap();
        let codex_home = tmp.path().join(".codex");
        std::fs::create_dir_all(&codex_home).unwrap();
        let auth_path = codex_home.join("auth.json");
        std::fs::write(&auth_path, b"STALE_CONTENT_FROM_PRIOR_RUN").unwrap();

        reconcile_chatgpt_auth(&tmp.path().join(".codex"), fixed_now()).unwrap();

        let body = std::fs::read_to_string(&auth_path).unwrap();
        assert!(
            !body.contains("STALE_CONTENT_FROM_PRIOR_RUN"),
            "stale content must be replaced: {body}"
        );
        // And the new content must parse as our auth.json shape.
        serde_json::from_str::<Value>(&body).unwrap();
    }

    #[test]
    fn reconcile_codex_auth_state_writes_api_key_auth_json() {
        let tmp = TempDir::new().unwrap();

        reconcile_codex_auth_state(
            &tmp.path().join(".codex"),
            DesiredCodexAuth::ApiKey {
                api_key: "sk-test-local",
            },
        )
        .unwrap();

        let auth = read_auth_json(&tmp);
        assert_eq!(auth["auth_mode"], "apikey");
        assert_eq!(auth["OPENAI_API_KEY"], "sk-test-local");
        assert!(
            auth.get("tokens").is_none(),
            "API-key auth.json must not retain ChatGPT tokens: {auth}"
        );
    }

    #[test]
    fn reconcile_codex_auth_state_api_key_overwrites_chatgpt_auth_json() {
        let tmp = TempDir::new().unwrap();
        reconcile_chatgpt_auth(&tmp.path().join(".codex"), fixed_now()).unwrap();

        reconcile_codex_auth_state(
            &tmp.path().join(".codex"),
            DesiredCodexAuth::ApiKey {
                api_key: "sk-test-next-run",
            },
        )
        .unwrap();

        let auth = read_auth_json(&tmp);
        assert_eq!(auth["auth_mode"], "apikey");
        assert_eq!(auth["OPENAI_API_KEY"], "sk-test-next-run");
        assert!(
            auth.get("tokens").is_none(),
            "API-key reconciliation must remove stale ChatGPT tokens: {auth}"
        );
    }

    #[test]
    fn reconcile_codex_auth_state_no_auth_removes_existing_auth_json() {
        let tmp = TempDir::new().unwrap();
        reconcile_chatgpt_auth(&tmp.path().join(".codex"), fixed_now()).unwrap();
        let auth_path = tmp.path().join(".codex").join("auth.json");

        reconcile_codex_auth_state(&tmp.path().join(".codex"), DesiredCodexAuth::None).unwrap();

        let err = std::fs::symlink_metadata(&auth_path).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::NotFound);
    }

    #[test]
    fn reconcile_codex_auth_state_no_auth_removes_auth_json_symlink_without_touching_target() {
        let tmp = TempDir::new().unwrap();
        let codex_home = tmp.path().join(".codex");
        std::fs::create_dir_all(&codex_home).unwrap();
        let auth_path = codex_home.join("auth.json");
        let symlink_target = tmp.path().join("target-auth.json");
        std::fs::write(&symlink_target, b"TARGET_CONTENT_MUST_SURVIVE").unwrap();
        symlink(&symlink_target, &auth_path).unwrap();

        reconcile_codex_auth_state(&tmp.path().join(".codex"), DesiredCodexAuth::None).unwrap();

        assert_eq!(
            std::fs::read_to_string(&symlink_target).unwrap(),
            "TARGET_CONTENT_MUST_SURVIVE",
            "no-auth reconciliation must not touch the old symlink target"
        );
        let err = std::fs::symlink_metadata(&auth_path).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::NotFound);
    }

    #[test]
    fn reconcile_codex_auth_state_no_auth_succeeds_when_auth_json_missing() {
        let tmp = TempDir::new().unwrap();

        reconcile_codex_auth_state(&tmp.path().join(".codex"), DesiredCodexAuth::None).unwrap();

        let codex_home = tmp.path().join(".codex");
        assert!(
            codex_home.is_dir(),
            "no-auth reconciliation should still normalize .codex"
        );
        let mode = std::fs::metadata(&codex_home).unwrap().permissions().mode();
        assert_eq!(mode & 0o7777, CODEX_HOME_MODE);
    }

    #[test]
    fn reconcile_codex_auth_state_no_auth_rejects_auth_json_directory() {
        let tmp = TempDir::new().unwrap();
        let auth_path = tmp.path().join(".codex").join("auth.json");
        std::fs::create_dir_all(&auth_path).unwrap();

        let err = reconcile_codex_auth_state(&tmp.path().join(".codex"), DesiredCodexAuth::None)
            .unwrap_err();

        assert!(
            err.to_string().contains("auth.json"),
            "unexpected error: {err}"
        );
        assert!(auth_path.is_dir(), "auth.json directory must be preserved");
    }

    #[test]
    fn reconcile_chatgpt_auth_replaces_permissive_auth_json_with_private_file() {
        let tmp = TempDir::new().unwrap();
        let codex_home = tmp.path().join(".codex");
        std::fs::create_dir_all(&codex_home).unwrap();
        let auth_path = codex_home.join("auth.json");
        std::fs::write(&auth_path, b"STALE_CONTENT_FROM_PRIOR_RUN").unwrap();
        std::fs::set_permissions(&auth_path, std::fs::Permissions::from_mode(0o644)).unwrap();

        reconcile_chatgpt_auth(&tmp.path().join(".codex"), fixed_now()).unwrap();

        let mode = std::fs::metadata(&auth_path).unwrap().permissions().mode();
        assert_eq!(
            mode & 0o7777,
            AUTH_JSON_MODE,
            "auth.json must be replaced with mode 0o600 (got {mode:o})"
        );

        let body = std::fs::read_to_string(&auth_path).unwrap();
        assert!(
            !body.contains("STALE_CONTENT_FROM_PRIOR_RUN"),
            "stale content must be replaced: {body}"
        );
        serde_json::from_str::<Value>(&body).unwrap();
    }

    #[test]
    fn reconcile_chatgpt_auth_replaces_auth_json_symlink_without_truncating_target() {
        let tmp = TempDir::new().unwrap();
        let codex_home = tmp.path().join(".codex");
        std::fs::create_dir_all(&codex_home).unwrap();
        let auth_path = codex_home.join("auth.json");
        let symlink_target = tmp.path().join("target-auth.json");
        std::fs::write(&symlink_target, b"TARGET_CONTENT_MUST_SURVIVE").unwrap();
        symlink(&symlink_target, &auth_path).unwrap();

        reconcile_chatgpt_auth(&tmp.path().join(".codex"), fixed_now()).unwrap();

        assert_eq!(
            std::fs::read_to_string(&symlink_target).unwrap(),
            "TARGET_CONTENT_MUST_SURVIVE",
            "atomic replacement must not truncate the old symlink target"
        );
        assert!(
            !std::fs::symlink_metadata(&auth_path)
                .unwrap()
                .file_type()
                .is_symlink(),
            "auth.json should be a regular replacement file, not the old symlink"
        );

        let mode = std::fs::metadata(&auth_path).unwrap().permissions().mode();
        assert_eq!(mode & 0o7777, AUTH_JSON_MODE);
        let body = std::fs::read_to_string(&auth_path).unwrap();
        serde_json::from_str::<Value>(&body).unwrap();
    }

    #[test]
    fn reconcile_chatgpt_auth_normalizes_existing_codex_home_permissions() {
        let tmp = TempDir::new().unwrap();
        let codex_home = tmp.path().join(".codex");
        std::fs::create_dir_all(&codex_home).unwrap();
        std::fs::set_permissions(&codex_home, std::fs::Permissions::from_mode(0o755)).unwrap();

        reconcile_chatgpt_auth(&tmp.path().join(".codex"), fixed_now()).unwrap();

        let mode = std::fs::metadata(&codex_home).unwrap().permissions().mode();
        assert_eq!(
            mode & 0o7777,
            CODEX_HOME_MODE,
            ".codex must be mode 0o700 (got {mode:o})"
        );
    }

    #[test]
    fn reconcile_chatgpt_auth_rejects_symlinked_codex_home() {
        let tmp = TempDir::new().unwrap();
        let target = tmp.path().join("real-codex-home");
        std::fs::create_dir_all(&target).unwrap();
        symlink(&target, tmp.path().join(".codex")).unwrap();

        let err = reconcile_chatgpt_auth(&tmp.path().join(".codex"), fixed_now()).unwrap_err();
        assert!(
            err.to_string().contains("symlinked directory"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn reconcile_chatgpt_auth_rejects_file_at_codex_home_path() {
        let tmp = TempDir::new().unwrap();
        let codex_home = tmp.path().join(".codex");
        std::fs::write(&codex_home, b"not a directory").unwrap();

        let err = reconcile_chatgpt_auth(&tmp.path().join(".codex"), fixed_now()).unwrap_err();
        assert!(
            err.to_string().contains(".codex"),
            "unexpected error: {err}"
        );
        assert_eq!(
            std::fs::read_to_string(&codex_home).unwrap(),
            "not a directory",
            "setup must not replace a non-directory .codex path"
        );
    }

    #[test]
    fn reconcile_chatgpt_auth_preserves_auth_json_directory_on_error() {
        let tmp = TempDir::new().unwrap();
        let codex_home = tmp.path().join(".codex");
        let auth_path = codex_home.join("auth.json");
        std::fs::create_dir_all(&auth_path).unwrap();

        let err = reconcile_chatgpt_auth(&tmp.path().join(".codex"), fixed_now()).unwrap_err();
        assert!(
            err.to_string().contains("auth.json"),
            "unexpected error: {err}"
        );
        assert!(
            auth_path.is_dir(),
            "failed atomic replacement must preserve an existing auth.json directory"
        );

        let entries = std::fs::read_dir(&codex_home)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        assert_eq!(
            entries,
            vec![std::ffi::OsString::from("auth.json")],
            "failed atomic replacement must not leave temp files behind"
        );
    }
}
