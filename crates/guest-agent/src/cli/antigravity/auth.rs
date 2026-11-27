//! Install a member's personal Google (Antigravity) OAuth credential into the
//! `agy` sandbox before launch, and reconcile stale credentials on reuse.
//!
//! Codex keeps real OAuth tokens outside the sandbox and lets the mitm firewall
//! swap them in on egress (`codex_auth`). The official `agy` CLI cannot work
//! that way: it validates a signed-in Google account from its local credential
//! store *before* issuing any model request, so a placeholder yields
//! `Authentication required` with zero upstream calls. Internal personal
//! subscription runs therefore place one real, short-lived native credential
//! inside the member's own `agy` environment. The API service owns the OAuth
//! lifecycle (connect, refresh, disconnect) and passes exactly one run-scoped
//! credential per launch. Like Claude Code, agy runs its commands directly in
//! the Okou sandbox without its own terminal sandbox, so those commands can
//! read this credential; the staff pilot accepts that until firewall-side
//! replacement keeps the real credential out of the sandbox.
//!
//! Scope: internal staff opt-in behind the `_geminiAntigravity` switch. This
//! path intentionally relies on the official Antigravity OAuth client identity
//! for Okou-internal testing; it is not an externally offered capability.
//!
//! Format ownership: the API emits the exact native-credential JSON that `agy`
//! expects and this module writes it **verbatim**. Keeping the field layout in
//! the API (a data concern) means the credential shape can be corrected during
//! acceptance without shipping a new runner image. The guest only validates
//! that the payload is a JSON object carrying the minimum token fields, then
//! installs it atomically with `0600` permissions.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use guest_contracts::runtime_paths::{PrivateFileReplacementTarget, replace_private_atomic};
use serde_json::Value;

use crate::error::AgentError;

/// Run-scoped env var carrying the native OAuth credential as a JSON object.
/// Set by the runner from the API's selected personal subscription. Never a
/// placeholder: a run without a real credential must not reach this harness.
pub(super) const CREDENTIAL_ENV: &str = "OKOU_ANTIGRAVITY_OAUTH_TOKEN";

/// `agy` config directory, relative to the member's home directory. Confirmed
/// against `agy 1.5.15` (`~/.gemini/antigravity-cli/{settings.json,cache,...}`).
const CONFIG_REL_DIR: &[&str] = &[".gemini", "antigravity-cli"];

/// Native credential file name inside [`CONFIG_REL_DIR`]. The CLI stores the
/// personal OAuth grant under its `standalone-oauth-token` keyring item and, on
/// Linux hosts without a system keyring, falls back to this file. Confirmed at
/// first real sign-in during acceptance; isolated here as the single source of
/// truth so a correction is a one-line change.
const CREDENTIAL_FILE: &str = "antigravity-oauth-token";
const SETTINGS_FILE: &str = "settings.json";

const CONFIG_DIR_MODE: u32 = 0o700;

/// The member's validated native credential for one run. `agy` reads the
/// project id and tokens from this payload once it is on disk, so the guest
/// keeps the object intact rather than lifting fields out of it.
pub(super) struct AntigravityCredential {
    native_json: String,
}

impl AntigravityCredential {
    /// Parse and validate the API-provided credential payload.
    ///
    /// The payload must be a JSON object carrying non-empty `access_token` and
    /// `refresh_token` strings; this catches gross misconfiguration (empty or
    /// placeholder env) before `agy` starts. All other fields are passed
    /// through untouched so the API owns the exact native layout.
    pub(super) fn parse(raw: &str) -> Result<Self, AgentError> {
        let value: Value = serde_json::from_str(raw).map_err(|error| {
            AgentError::Execution(format!("Antigravity credential is not valid JSON: {error}"))
        })?;
        let Value::Object(ref fields) = value else {
            return Err(AgentError::Execution(
                "Antigravity credential must be a JSON object".into(),
            ));
        };
        for required in ["access_token", "refresh_token"] {
            let present = fields
                .get(required)
                .and_then(Value::as_str)
                .is_some_and(|token| !token.is_empty());
            if !present {
                return Err(AgentError::Execution(format!(
                    "Antigravity credential is missing a non-empty {required}"
                )));
            }
        }
        // Re-serialize the validated object so trailing bytes or formatting in
        // the env value cannot reach the file agy reads.
        let native_json = serde_json::to_string(&value)?;
        Ok(Self { native_json })
    }
}

fn config_dir(home_dir: &str) -> PathBuf {
    let mut path = PathBuf::from(home_dir);
    path.extend(CONFIG_REL_DIR);
    path
}

/// Create (or validate) the `agy` config directory as a private `0700` real
/// directory, refusing to follow a symlink planted by a reused sandbox.
fn prepare_config_dir(config_dir: &Path) -> Result<(), AgentError> {
    let metadata = match std::fs::symlink_metadata(config_dir) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir_all(config_dir)?;
            std::fs::symlink_metadata(config_dir)?
        }
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink() {
        return Err(AgentError::Execution(format!(
            "refusing to write antigravity credential through symlinked directory {}",
            config_dir.display()
        )));
    }
    if !metadata.is_dir() {
        return Err(AgentError::Execution(format!(
            "antigravity config path is not a directory: {}",
            config_dir.display()
        )));
    }
    std::fs::set_permissions(config_dir, std::fs::Permissions::from_mode(CONFIG_DIR_MODE))?;
    Ok(())
}

fn remove_credential(token_path: &Path) -> Result<(), AgentError> {
    match std::fs::symlink_metadata(token_path) {
        Ok(metadata) if metadata.is_dir() => Err(AgentError::Execution(format!(
            "antigravity credential path is a directory: {}",
            token_path.display()
        ))),
        Ok(_) => {
            std::fs::remove_file(token_path)?;
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

/// Reconcile the on-disk native credential before `agy` starts.
///
/// With a credential, install it atomically as a private `0600` file. Without
/// one, remove any credential left by a previous run in a reused sandbox so a
/// misconfigured run fails closed (`Authentication required`) rather than
/// silently reusing another selection's grant.
pub(super) fn reconcile_credential(
    home_dir: &str,
    credential: Option<&AntigravityCredential>,
) -> Result<(), AgentError> {
    let config_dir = config_dir(home_dir);
    let token_path = config_dir.join(CREDENTIAL_FILE);
    match credential {
        Some(credential) => {
            prepare_config_dir(&config_dir)?;
            replace_private_atomic(
                &token_path,
                credential.native_json.as_bytes(),
                PrivateFileReplacementTarget::ReplaceFinalEntry,
            )
            .map_err(|error| {
                AgentError::Execution(format!(
                    "failed to install antigravity credential at {}: {error}",
                    token_path.display()
                ))
            })
        }
        None => remove_credential(&token_path),
    }
}

/// Write `settings.json` inside `~/.gemini/antigravity-cli` atomically before
/// launching `agy acp` (which does not accept a `--settings` CLI flag).
pub(super) fn write_settings(home_dir: &str, settings: &Value) -> Result<(), AgentError> {
    let config_dir = config_dir(home_dir);
    prepare_config_dir(&config_dir)?;
    let settings_path = config_dir.join(SETTINGS_FILE);
    let bytes = serde_json::to_vec(settings)?;
    replace_private_atomic(
        &settings_path,
        &bytes,
        PrivateFileReplacementTarget::ReplaceFinalEntry,
    )
    .map_err(|error| {
        AgentError::Execution(format!(
            "failed to write antigravity settings at {}: {error}",
            settings_path.display()
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_payload() -> String {
        serde_json::json!({
            "access_token": "test-access",
            "refresh_token": "test-refresh",
            "id_token": "header.payload.sig",
            "token_type": "Bearer",
            "scope": "https://www.googleapis.com/auth/cloud-platform",
            "expiry": "2026-11-25T12:00:00Z",
            "project_id": "rising-fact-p41fc",
            "email": "member@example.com"
        })
        .to_string()
    }

    fn token_path(home: &Path) -> PathBuf {
        let mut path = home.to_path_buf();
        path.extend(CONFIG_REL_DIR);
        path.push(CREDENTIAL_FILE);
        path
    }

    #[test]
    fn parse_preserves_full_payload() {
        let credential = AntigravityCredential::parse(&valid_payload()).unwrap();
        let value: Value = serde_json::from_str(&credential.native_json).unwrap();
        assert_eq!(value["access_token"], "test-access");
        assert_eq!(value["refresh_token"], "test-refresh");
        assert_eq!(value["project_id"], "rising-fact-p41fc");
    }

    #[test]
    fn parse_rejects_non_object() {
        assert!(AntigravityCredential::parse("\"just-a-string\"").is_err());
        assert!(AntigravityCredential::parse("not json").is_err());
    }

    #[test]
    fn parse_rejects_missing_or_empty_tokens() {
        let missing = serde_json::json!({ "access_token": "test-access" }).to_string();
        assert!(AntigravityCredential::parse(&missing).is_err());
        let empty =
            serde_json::json!({ "access_token": "", "refresh_token": "test-refresh" }).to_string();
        assert!(AntigravityCredential::parse(&empty).is_err());
    }

    #[test]
    fn parse_allows_minimal_payload() {
        let payload = serde_json::json!({
            "access_token": "test-access",
            "refresh_token": "test-refresh"
        })
        .to_string();
        AntigravityCredential::parse(&payload).unwrap();
    }

    #[test]
    fn reconcile_writes_private_credential_file() {
        let home = tempfile::tempdir().unwrap();
        let credential = AntigravityCredential::parse(&valid_payload()).unwrap();
        reconcile_credential(home.path().to_str().unwrap(), Some(&credential)).unwrap();

        let path = token_path(home.path());
        let written = std::fs::read_to_string(&path).unwrap();
        let value: Value = serde_json::from_str(&written).unwrap();
        assert_eq!(value["email"], "member@example.com");
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "credential file must be private");
        let dir_mode = std::fs::metadata(path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(dir_mode, CONFIG_DIR_MODE);
    }

    #[test]
    fn reconcile_overwrites_previous_credential() {
        let home = tempfile::tempdir().unwrap();
        let first = AntigravityCredential::parse(&valid_payload()).unwrap();
        reconcile_credential(home.path().to_str().unwrap(), Some(&first)).unwrap();

        let second_payload = serde_json::json!({
            "access_token": "test-access-2",
            "refresh_token": "test-refresh-2"
        })
        .to_string();
        let second = AntigravityCredential::parse(&second_payload).unwrap();
        reconcile_credential(home.path().to_str().unwrap(), Some(&second)).unwrap();

        let written = std::fs::read_to_string(token_path(home.path())).unwrap();
        let value: Value = serde_json::from_str(&written).unwrap();
        assert_eq!(value["access_token"], "test-access-2");
    }

    #[test]
    fn reconcile_none_removes_stale_credential() {
        let home = tempfile::tempdir().unwrap();
        let credential = AntigravityCredential::parse(&valid_payload()).unwrap();
        reconcile_credential(home.path().to_str().unwrap(), Some(&credential)).unwrap();
        assert!(token_path(home.path()).exists());

        reconcile_credential(home.path().to_str().unwrap(), None).unwrap();
        assert!(!token_path(home.path()).exists());
    }

    #[test]
    fn reconcile_none_on_clean_sandbox_is_ok() {
        let home = tempfile::tempdir().unwrap();
        reconcile_credential(home.path().to_str().unwrap(), None).unwrap();
    }

    #[test]
    fn prepare_config_dir_refuses_symlinked_directory() {
        let home = tempfile::tempdir().unwrap();
        let gemini = home.path().join(".gemini");
        std::fs::create_dir_all(&gemini).unwrap();
        let real_elsewhere = home.path().join("elsewhere");
        std::fs::create_dir_all(&real_elsewhere).unwrap();
        std::os::unix::fs::symlink(&real_elsewhere, gemini.join("antigravity-cli")).unwrap();

        let credential = AntigravityCredential::parse(&valid_payload()).unwrap();
        let error = reconcile_credential(home.path().to_str().unwrap(), Some(&credential))
            .expect_err("symlinked config dir must be refused");
        assert!(matches!(error, AgentError::Execution(_)));
    }
}
