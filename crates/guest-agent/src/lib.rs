//! Guest agent library for the binary and integration tests.
//!
//! The production runtime model is explicit:
//! - [`run_context::GuestRuntime::from_process_env`] is the startup boundary
//!   that captures runner-provided process state.
//! - [`env::GuestConfigRaw`] owns captured raw startup values.
//! - [`env::GuestConfig`] owns immutable run-scoped configuration.
//! - [`paths::GuestPaths`] owns immutable run-scoped filesystem paths.
//!
//! Do not add process-global facade readers for run-scoped environment values
//! or paths. Thread `GuestConfig` and `GuestPaths` through the caller instead.
//!
//! # Runner-only helper protocol
//!
//! The `guest-agent` executable has the following runner-only helper commands.
//! The handwritten dispatcher in `src/main.rs` handles these commands before the
//! normal asynchronous guest-agent runtime starts. They are an internal
//! protocol between the guest binary and `runner`, not general-purpose user
//! CLI commands.
//!
//! The command name `guest-agent` below stands for the deployed guest-agent
//! executable path. The shared contract crate is the source of truth for the
//! JSON shapes, stable argument spellings, and exit-code constants linked from
//! this section.
//!
//! ## Shared runtime-path rules
//!
//! Commands resolve the canonical
//! [`OKOU_GUEST_RUNTIME_DIR`](guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV)
//! override through one shared contract. An empty value is absent and a
//! non-empty absolute value is selected. Without an override,
//! [`run_dir_from_env`](guest_contracts::runtime_paths::run_dir_from_env) derives
//! `$HOME/.vm0/guest-agent/runs/<run-id>` from
//! [`RUN_ID_ENV`](guest_contracts::env::RUN_ID_ENV) (`OKOU_RUN_ID`) and `HOME`.
//! A relative override is invalid.
//!
//! ## `verify-session-history-identity`
//!
//! ### Invocation
//!
//! ```text
//! guest-agent verify-session-history-identity
//! guest-agent verify-session-history-identity <metadata-path>
//! guest-agent verify-session-history-identity <metadata-path> <framework> <session-id-hash> <history-ref-kind> <history-hash> <history-size-bytes>
//! ```
//!
//! With no arguments, the helper reads the final identity metadata file from
//! the runtime path resolved from the process environment. With arguments, the
//! first argument is always the metadata path. The optional remaining group is
//! either absent or exactly five values. The framework and history-reference
//! kind use the stable spellings accepted by
//! [`SessionHistoryFramework::parse_cli_arg`](guest_contracts::session_history_identity::SessionHistoryFramework::parse_cli_arg)
//! and
//! [`SessionHistoryRefKind::parse_cli_arg`](guest_contracts::session_history_identity::SessionHistoryRefKind::parse_cli_arg).
//! Supplying any other argument count returns
//! [`SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_ARGS`](guest_contracts::session_history_identity::SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_ARGS).
//!
//! The helper consumes no protocol stdin and emits no protocol payload on
//! stdout or stderr. A zero exit status,
//! [`SESSION_HISTORY_IDENTITY_VERIFY_EXIT_SUCCESS`](guest_contracts::session_history_identity::SESSION_HISTORY_IDENTITY_VERIFY_EXIT_SUCCESS),
//! means that the metadata and the current framework-owned session history
//! match. Verification failures are represented by
//! [`crate::session_history_identity::SessionHistoryIdentityVerifyError`] and
//! the corresponding stable exit codes:
//!
//! - [`SESSION_HISTORY_IDENTITY_VERIFY_EXIT_FAILURE`](guest_contracts::session_history_identity::SESSION_HISTORY_IDENTITY_VERIFY_EXIT_FAILURE)
//!   is the uncategorized fallback.
//! - [`SESSION_HISTORY_IDENTITY_VERIFY_EXIT_METADATA_READ`](guest_contracts::session_history_identity::SESSION_HISTORY_IDENTITY_VERIFY_EXIT_METADATA_READ)
//!   means the metadata file could not be read.
//! - [`SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_METADATA`](guest_contracts::session_history_identity::SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_METADATA)
//!   means the metadata failed shared-contract validation.
//! - [`SESSION_HISTORY_IDENTITY_VERIFY_EXIT_FRAMEWORK_MISMATCH`](guest_contracts::session_history_identity::SESSION_HISTORY_IDENTITY_VERIFY_EXIT_FRAMEWORK_MISMATCH)
//!   means the declared framework and history source disagree.
//! - [`SESSION_HISTORY_IDENTITY_VERIFY_EXIT_EXPECTED_MISMATCH`](guest_contracts::session_history_identity::SESSION_HISTORY_IDENTITY_VERIFY_EXIT_EXPECTED_MISMATCH)
//!   means the metadata does not match the five expected identity fields.
//! - [`SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_READ`](guest_contracts::session_history_identity::SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_READ)
//!   means the framework-owned history could not be resolved or read.
//! - [`SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_MISMATCH`](guest_contracts::session_history_identity::SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_MISMATCH)
//!   means the history size or hash differs from the metadata.
//! - [`SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_TOO_LARGE`](guest_contracts::session_history_identity::SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_TOO_LARGE)
//!   means the history exceeds the guest verification budget.
//!
//! The runner caller is `verify_restored_session_identity_for_reuse` in
//! `crates/runner/src/executor/agent_run.rs`. It builds the typed fixed-helper
//! request executed by `verify_final_identity_metadata`, and
//! `session_history_identity_reason_from_helper_result` maps its exit status
//! to runner reasons. Keep those source references in sync with the linked
//! shared constants when changing this protocol.
//!
//! ## `export-session-history-sidecar`
//!
//! ### Invocation and streams
//!
//! ```text
//! guest-agent export-session-history-sidecar <metadata-path> <export-path>
//! ```
//!
//! Exactly two positional paths are required. The helper consumes no stdin.
//! After verifying the identity and source history, it writes the selected
//! sidecar representation to `export-path` and serializes
//! [`SessionHistorySidecarExportMetadata`](guest_contracts::session_history_identity::SessionHistorySidecarExportMetadata)
//! as one JSON value on stdout. The metadata records whether the output is
//! [`SessionHistorySidecarRepresentation::Raw`](guest_contracts::session_history_identity::SessionHistorySidecarRepresentation::Raw)
//! or [`SessionHistorySidecarRepresentation::CodexZstd`](guest_contracts::session_history_identity::SessionHistorySidecarRepresentation::CodexZstd)
//! and records the exact encoded byte length. The runner
//! supplies the runtime-directory environment when the source history needs
//! the guest runtime path contract.
//!
//! A successful export returns
//! [`SESSION_HISTORY_IDENTITY_VERIFY_EXIT_SUCCESS`](guest_contracts::session_history_identity::SESSION_HISTORY_IDENTITY_VERIFY_EXIT_SUCCESS).
//! Missing or extra arguments return
//! [`SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_ARGS`](guest_contracts::session_history_identity::SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_ARGS).
//! Verification
//! failures return the same session-history verification codes documented for
//! [`crate::session_history_identity::SessionHistoryIdentityVerifyError`]. If
//! creating or writing `export-path` fails, the helper returns
//! [`SESSION_HISTORY_SIDECAR_EXPORT_EXIT_WRITE_FAILURE`](guest_contracts::session_history_identity::SESSION_HISTORY_SIDECAR_EXPORT_EXIT_WRITE_FAILURE)
//! and emits the safe
//! [`SessionHistorySidecarExportFailure`](guest_contracts::session_history_identity::SessionHistorySidecarExportFailure)
//! JSON shape on stdout. The failure shape contains only the linked
//! [`SessionHistorySidecarIoErrorClass`](guest_contracts::session_history_identity::SessionHistorySidecarIoErrorClass).
//! The helper does not consume stdin or emit a protocol stderr payload. The
//! write is not transactional, so callers consume the file only after a
//! successful exit and valid metadata.
//!
//! The runner caller and consumer are
//! `crates/runner/src/workspace_promotion.rs::export_session_history_sidecar`.
//! That path parses the linked metadata, validates its encoded size, and
//! cleans up the export when promotion cannot proceed.
//!
//! ## `prepare-for-reuse`
//!
//! ### Invocation and stdin
//!
//! ```text
//! guest-agent prepare-for-reuse < request.json
//! ```
//!
//! The command accepts no positional arguments. Any argument returns
//! [`REUSE_PREPARATION_EXIT_INVALID_REQUEST`](guest_contracts::reuse_preparation::REUSE_PREPARATION_EXIT_INVALID_REQUEST).
//! The request is a serialized
//! [`ReusePreparationRequest`](guest_contracts::reuse_preparation::ReusePreparationRequest) read from
//! stdin, limited to 64 KiB. Its `currentRuntimeDir` is required and its
//! `retainedRuntimeDir` is optional; both paths identify runtime directories
//! that must remain available after cleanup.
//!
//! On success, the helper serializes
//! [`ReusePreparationReport`](guest_contracts::reuse_preparation::ReusePreparationReport) to stdout.
//! Its `before` and `after` values are
//! [`RootFilesystemCapacity`](guest_contracts::reuse_preparation::RootFilesystemCapacity) records, and
//! `removedEntries` reports the number of unprotected direct children removed.
//! Helper failures are written to stderr and use these stable exit codes:
//!
//! - [`REUSE_PREPARATION_EXIT_SUCCESS`](guest_contracts::reuse_preparation::REUSE_PREPARATION_EXIT_SUCCESS)
//!   means a report was emitted.
//! - [`REUSE_PREPARATION_EXIT_INVALID_REQUEST`](guest_contracts::reuse_preparation::REUSE_PREPARATION_EXIT_INVALID_REQUEST)
//!   means stdin, size, JSON, or protected-path validation failed.
//! - [`REUSE_PREPARATION_EXIT_INSPECTION_FAILED`](guest_contracts::reuse_preparation::REUSE_PREPARATION_EXIT_INSPECTION_FAILED)
//!   means rootfs capacity could not be inspected.
//! - [`REUSE_PREPARATION_EXIT_CLEANUP_FAILED`](guest_contracts::reuse_preparation::REUSE_PREPARATION_EXIT_CLEANUP_FAILED)
//!   means protected state or stale runtime state could not be safely handled.
//! - [`REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED`](guest_contracts::reuse_preparation::REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED)
//!   means the supervised-exec containment invariant could not be proven.
//!
//! [`REUSE_PREPARATION_EXIT_WORKSPACE_MOUNT_FAILED`](guest_contracts::reuse_preparation::REUSE_PREPARATION_EXIT_WORKSPACE_MOUNT_FAILED)
//! is reserved for the composed runner workspace-mount wrapper; it is not a
//! guest-helper failure. Cleanup is not transactional: a later failure can be
//! returned after earlier stale entries have already been removed.
//!
//! The runner constructs the request and command in
//! `crates/runner/src/idle_reuse_preparation.rs::IdleReusePreparation::new`,
//! sends the linked request through `exec_request`, and validates the linked
//! report in `validate_result`.
//!
//! ## `cleanup-codex-session`
//!
//! ### Invocation
//!
//! ```text
//! guest-agent cleanup-codex-session <session-id> <fallback-relative-path>
//! ```
//!
//! Exactly two UTF-8 positional arguments are required: a canonical Codex
//! session ID and its matching canonical logical rollout path relative to the
//! fixed Codex home. The helper consumes no protocol stdin. Input validation is
//! owned by [`CodexSessionCleanupRequest`](guest_contracts::codex_session_cleanup::CodexSessionCleanupRequest),
//! including the canonical session-ID and fallback-path rules and the
//! [`CODEX_SESSION_CLEANUP_MAX_PATH_BYTES`](guest_contracts::codex_session_cleanup::CODEX_SESSION_CLEANUP_MAX_PATH_BYTES)
//! path limit. The fixed role owns the
//! [`CODEX_SESSION_CLEANUP_SCAN_BUDGET`](guest_contracts::codex_session_cleanup::CODEX_SESSION_CLEANUP_SCAN_BUDGET)
//! and
//! [`CODEX_SESSION_CLEANUP_OUTPUT_LIMIT_BYTES`](guest_contracts::codex_session_cleanup::CODEX_SESSION_CLEANUP_OUTPUT_LIMIT_BYTES)
//! limits; callers cannot override them.
//!
//! The helper performs bounded cleanup in the retained Codex sessions tree.
//! On success, stdout is either empty or exactly one LF-terminated canonical
//! logical path. Empty stdout means that the runner uses the fallback logical
//! path; a returned path identifies the canonical existing path selected by
//! cleanup. Stderr is reserved for non-protocol diagnostics. Input validation,
//! scan, ambiguity, deletion, output, or helper failures return a nonzero exit
//! status, and the runner does not write replacement history after such a
//! failure.
//!
//! The fixed-role launcher is
//! `crates/guest-control-server/src/agent_command.rs::spawn_codex_session_cleanup_with_pipes`.
//! The runner invokes the operation only for an actually reused sandbox from
//! `crates/runner/src/executor/session_restore/codex.rs::cleanup_existing_codex_session`
//! before writing replacement history, and independently validates the output in
//! `parse_codex_cleanup_output`
//! before using a returned path as the restore destination. Keep these source
//! references in sync with the shared contract when changing this protocol.

pub mod active_input;
mod active_input_receipts;
mod artifact;
pub mod checkpoint;
pub mod cli;
mod codex_auth;
pub mod codex_session_cleanup;
pub mod complete;
mod constants;
mod content_hash;
pub mod control;
pub mod env;
pub mod error;
pub mod events;
pub mod failure_diagnostics;
mod failure_patterns;
pub mod heartbeat;
pub mod http;
pub mod masker;
pub mod metrics;
mod nofollow_fs;
pub mod paths;
mod provider_failure;
pub mod reuse_preparation;
pub mod run_context;
pub mod session_history;
pub mod session_history_identity;
pub mod session_metadata;
pub mod telemetry;
pub mod timing;
mod upstream_error_text;
mod urls;
pub mod workload_containment;

#[cfg(test)]
static SYSTEM_LOG_TEST_MUTEX: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[cfg(test)]
static SANDBOX_OPS_TEST_MUTEX: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[cfg(test)]
pub(crate) struct SandboxOpsTestGuard {
    _ownership: tokio::sync::MutexGuard<'static, ()>,
    override_installed: bool,
}

#[cfg(test)]
impl SandboxOpsTestGuard {
    pub(crate) async fn lock() -> Self {
        let ownership = SANDBOX_OPS_TEST_MUTEX.lock().await;
        Self {
            _ownership: ownership,
            override_installed: false,
        }
    }

    pub(crate) async fn with_override(path: &std::path::Path) -> Self {
        let mut guard = Self::lock().await;
        guard.install_override(path);
        guard
    }

    pub(crate) fn install_override(&mut self, path: &std::path::Path) {
        guest_telemetry::telemetry::set_sandbox_ops_log_file(path);
        self.override_installed = true;
    }
}

#[cfg(test)]
impl Drop for SandboxOpsTestGuard {
    fn drop(&mut self) {
        if self.override_installed {
            guest_telemetry::telemetry::clear_sandbox_ops_log_file();
        }
    }
}

#[cfg(test)]
pub(crate) fn lock_system_log_test_state() -> tokio::sync::MutexGuard<'static, ()> {
    SYSTEM_LOG_TEST_MUTEX.blocking_lock()
}

#[cfg(test)]
pub(crate) async fn lock_system_log_test_state_async() -> tokio::sync::MutexGuard<'static, ()> {
    SYSTEM_LOG_TEST_MUTEX.lock().await
}
