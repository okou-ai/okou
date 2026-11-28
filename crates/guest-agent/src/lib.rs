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
//! Helpers that use runtime paths resolve the canonical
//! [`OKOU_GUEST_RUNTIME_DIR`](guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV)
//! override through one shared contract. An empty value is absent and a
//! non-empty absolute value is selected. Without an override,
//! [`run_dir_from_env`](guest_contracts::runtime_paths::run_dir_from_env) derives
//! `$HOME/.vm0/guest-agent/runs/<run-id>` from
//! [`RUN_ID_ENV`](guest_contracts::env::RUN_ID_ENV) (`OKOU_RUN_ID`) and `HOME`.
//! A relative override is invalid.
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
//! stdin, limited to 64 KiB. Its `currentRuntimeDir` is required and identifies
//! the runtime directory that must remain available after cleanup.
//!
//! On success, the helper serializes
//! [`ReusePreparationReport`](guest_contracts::reuse_preparation::ReusePreparationReport) to stdout.
//! Its rootfs `before`/`after` and post-cleanup `home` values are
//! [`FilesystemCapacity`](guest_contracts::reuse_preparation::FilesystemCapacity) records, and
//! `removedEntries` reports the number of unprotected direct children removed.
//! A home below its byte or inode reserve also gets one fixed npm/pip cache
//! reclamation attempt before the report. Healthy homes retain package caches;
//! the current runtime and ordinary user files remain protected.
//! Helper failures are written to stderr and use these stable exit codes:
//!
//! - [`REUSE_PREPARATION_EXIT_SUCCESS`](guest_contracts::reuse_preparation::REUSE_PREPARATION_EXIT_SUCCESS)
//!   means a report was emitted.
//! - [`REUSE_PREPARATION_EXIT_INVALID_REQUEST`](guest_contracts::reuse_preparation::REUSE_PREPARATION_EXIT_INVALID_REQUEST)
//!   means stdin, size, JSON, or protected-path validation failed.
//! - [`REUSE_PREPARATION_EXIT_INSPECTION_FAILED`](guest_contracts::reuse_preparation::REUSE_PREPARATION_EXIT_INSPECTION_FAILED)
//!   means rootfs or home capacity could not be inspected.
//! - [`REUSE_PREPARATION_EXIT_CLEANUP_FAILED`](guest_contracts::reuse_preparation::REUSE_PREPARATION_EXIT_CLEANUP_FAILED)
//!   means protected state or stale runtime state could not be safely handled.
//! - [`REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED`](guest_contracts::reuse_preparation::REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED)
//!   means the supervised-exec containment invariant could not be proven.
//!
//! [`REUSE_PREPARATION_EXIT_HOME_MOUNT_FAILED`](guest_contracts::reuse_preparation::REUSE_PREPARATION_EXIT_HOME_MOUNT_FAILED)
//! is reserved for the composed runner home-mount wrapper; it is not a
//! guest-helper failure. Cleanup is not transactional: a later failure can be
//! returned after earlier stale entries have already been removed.
//!
//! The runner constructs the request and command in
//! `crates/runner-lifecycle/src/idle_reuse_preparation.rs::IdleReusePreparation::new`,
//! sends the linked request through `exec_request`, and validates the linked
//! report in `validate_result`.
//!
//! ## `prepare-for-cache`
//!
//! ```text
//! guest-agent prepare-for-cache < request.json
//! ```
//!
//! This terminal helper consumes a [`ReusePreparationRequest`](guest_contracts::reuse_preparation::ReusePreparationRequest)
//! and returns a [`ReusePreparationReport`](guest_contracts::reuse_preparation::ReusePreparationReport)
//! with the existing exit-code categories.
//! It accepts only the canonical managed runtime parent
//! `/home/user/.vm0/guest-agent/runs`. Any existing current runtime anchor must
//! pass the existing containment, no-follow, mount and identity checks before
//! mutation. Once required finalization, diagnostic and log readers finish, it
//! removes all completed runtime children (including the current anchor) and
//! managed Codex auth. It does not delete ordinary user files or framework
//! histories/catalogs. After managed cleanup, a below-reserve home gets one
//! fixed npm/pip cache reclamation attempt, shared with idle preparation.
//! Healthy homes retain package caches. The existing helper deadline bounds
//! cleanup. Unlike idle preparation, Runner does not apply a rootfs-reserve
//! gate to its report. Failure rejects optional publication; successful
//! deletion is not a forensic block-erasure guarantee. Runner invokes it from
//! `crates/runner-lifecycle/src/home_promotion.rs` before freeze and stop.
//!
//! ## `recover-disk-space`
//!
//! `guest-agent recover-disk-space home|rootfs` runs before ordinary environment
//! initialization and emits one [`DiskCleanupReport`](guest_contracts::disk_cleanup::DiskCleanupReport)
//! JSON line. It needs no API credentials, protocol stdin or writable bootstrap
//! file. Exit 0 means the fixed cleanup completed; exit 1 means inspection,
//! containment or cleanup failed; exit 2 means the fixed selector is invalid.
//! A successful helper does not itself establish enough space for startup.
//!
//! [`disk_cleanup`] owns the fixed disposable-path allowlists. Rootfs recovery
//! also discards `/tmp` contents, including leftovers from earlier runs, while
//! preserving the directory itself. Persistent state outside the selected paths
//! remains untouched. The helper reuses the sole-supervised-workload proof and
//! fd-relative mount/symlink protections.
//! Candidates share a two-second cooperative deletion budget. Capacity is checked
//! in bounded batches; sufficient space or budget exhaustion stops deletion
//! normally, and optional candidate errors are skipped. A blocked kernel call
//! still needs the existing outer operation timeout. Deletion may be partial.
//! Runner retires prefetch before cleanup and
//! retries only acknowledged ENOSPC failures from deterministic bootstrap-file
//! replacement, once, when current measured capacity meets the retry reserve. It
//! never replays process start or user execution. This is guest filesystem
//! recovery; host/cache-image GC has separate ownership.
//! Idle and terminal reuse preparation also invoke the same home-cache deletion
//! primitive once under home pressure, within their final fenced helper exec.

pub mod active_input;
mod artifact;
pub mod cli;
mod codex_auth;
mod codex_failure;
pub mod complete;
mod constants;
mod content_hash;
pub mod control;
pub mod disk_cleanup;
pub mod env;
pub mod error;
pub mod events;
pub mod failure_diagnostics;
mod failure_patterns;
mod filesystem;
pub mod finalization;
pub mod heartbeat;
pub mod http;
pub mod masker;
pub mod metrics;
mod nofollow_fs;
pub mod paths;
mod provider_failure;
pub mod reuse_preparation;
pub mod run_context;
pub mod session_metadata;
mod steered_inputs;
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
    // Clear the destination before releasing the test-state lock.
    _override: Option<guest_telemetry::test_support::SandboxOpsOverrideGuard>,
    _ownership: tokio::sync::MutexGuard<'static, ()>,
}

#[cfg(test)]
impl SandboxOpsTestGuard {
    pub(crate) async fn lock() -> Self {
        let ownership = SANDBOX_OPS_TEST_MUTEX.lock().await;
        Self {
            _override: None,
            _ownership: ownership,
        }
    }

    pub(crate) async fn with_override(path: &std::path::Path) -> Self {
        let mut guard = Self::lock().await;
        guard.install_override(path);
        guard
    }

    pub(crate) fn install_override(&mut self, path: &std::path::Path) {
        guest_telemetry::telemetry::set_sandbox_ops_log_file(path);
        // A temporary guard on repeated installation would clear the new sink.
        self._override
            .get_or_insert_with(|| guest_telemetry::test_support::SandboxOpsOverrideGuard);
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
