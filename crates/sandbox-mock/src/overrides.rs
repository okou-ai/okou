use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ::sandbox::*;
use tokio_util::sync::CancellationToken;

use crate::call_records::{
    CodexSessionCleanupCall, CopyFileCall, ExecCall, ExecMatcher, FinalizeStagedFileCall,
    GuestStateRestoreCall, ProcessCancelCall, ProcessControlCall, SessionHistoryIdentityVerifyCall,
    StartAgentProcessCall, StartProcessCall, StorageManifestCall, WaitProcessCall, WriteFileCall,
    WriteFilesCall,
};
use crate::lifecycle::{DestroyBehavior, LifecycleBehaviors, MockLifecycleGate};
use crate::support::LockIgnoringPoison;

pub(crate) struct ExecMatcherResult {
    pub(crate) pattern: String,
    pub(crate) result: ExecResult,
}

pub(crate) struct ExecMatcherBehavior {
    pub(crate) pattern: String,
    pub(crate) outcome: ExecMatcherOutcome,
}

pub(crate) enum ExecMatcherOutcome {
    Return(ExecResult),
    Error(SandboxError),
    Panic(String),
}

pub(crate) enum GuestStateRestoreBehavior {
    Return(Result<ExecResult>),
    Panic(String),
}

impl GuestStateRestoreBehavior {
    pub(crate) fn into_result(self) -> Result<ExecResult> {
        match self {
            Self::Return(result) => result,
            Self::Panic(message) => std::panic::resume_unwind(Box::new(message)),
        }
    }
}

#[derive(Default)]
pub(crate) struct ExecOverrideState {
    /// Pattern-matched exec behaviors. First matching pattern wins and is
    /// consumed (one-shot).
    pub(crate) matchers: Mutex<Vec<ExecMatcherBehavior>>,
    /// Pattern-matched exec results that remain available for every matching
    /// call after one-shot matchers have been checked.
    pub(crate) persistent_matchers: Mutex<Vec<ExecMatcherResult>>,
    /// Recorded exec calls across all sandboxes built from this override set.
    pub(crate) calls: Mutex<Vec<ExecCall>>,
    /// Recorded fixed storage-manifest calls across all attached sandboxes.
    pub(crate) storage_manifest_calls: Mutex<Vec<StorageManifestCall>>,
    /// Optional gate entered after recording a fixed storage-manifest call.
    pub(crate) storage_manifest_gate: Mutex<Option<MockLifecycleGate>>,
    /// FIFO results for fixed storage-manifest operations.
    pub(crate) storage_manifest_results: Mutex<VecDeque<Result<ExecResult>>>,
    /// FIFO results for fixed workspace-drive mount operations.
    pub(crate) workspace_drive_mount_results: Mutex<VecDeque<Result<ExecResult>>>,
    /// Total fixed workspace-drive mount calls across attached sandboxes.
    pub(crate) workspace_drive_mount_calls: Mutex<u32>,
    /// Wakes tests after a fixed workspace-drive mount call is recorded.
    pub(crate) workspace_drive_mount_call_notify: tokio::sync::Notify,
    /// Optional gate entered after every fixed workspace-drive mount call is
    /// recorded but before its configured result is selected.
    pub(crate) workspace_drive_mount_lifecycle_gate: Mutex<Option<MockLifecycleGate>>,
    /// Recorded fixed live identity verifier calls across attached sandboxes.
    pub(crate) session_history_identity_verify_calls: Mutex<Vec<SessionHistoryIdentityVerifyCall>>,
    /// Recorded fixed reused-Codex cleanup calls across attached sandboxes.
    pub(crate) codex_session_cleanup_calls: Mutex<Vec<CodexSessionCleanupCall>>,
    /// Recorded fixed guest-state restore calls across all attached sandboxes.
    pub(crate) guest_state_restore_calls: Mutex<Vec<GuestStateRestoreCall>>,
    /// FIFO behaviors for fixed guest-state restore operations.
    pub(crate) guest_state_restore_behaviors: Mutex<VecDeque<GuestStateRestoreBehavior>>,
    /// Wakes tests after a guest-state restore call is recorded.
    pub(crate) guest_state_restore_call_notify: tokio::sync::Notify,
    /// Wakes tests after an exec call is recorded.
    pub(crate) call_notify: tokio::sync::Notify,
    /// Optional gate entered after every exec call is recorded but before its
    /// configured result is selected.
    pub(crate) lifecycle_gate: Mutex<Option<MockLifecycleGate>>,
}

#[derive(Default)]
pub(crate) struct FileOverrideState {
    /// Recorded write_file calls across all sandboxes built from this override set.
    pub(crate) write_file_calls: Mutex<Vec<WriteFileCall>>,
    /// FIFO write_file results consumed by factory-created sandboxes.
    pub(crate) write_file_results: Mutex<VecDeque<Result<()>>>,
    /// Optional gate entered after recording a write_file call.
    pub(crate) write_file_gate: Mutex<Option<MockLifecycleGate>>,
    /// Recorded staged-file finalizer calls across attached sandboxes.
    pub(crate) finalize_staged_file_calls: Mutex<Vec<FinalizeStagedFileCall>>,
    /// FIFO staged-file finalizer results.
    pub(crate) finalize_staged_file_results: Mutex<VecDeque<Result<StagedFileFinalizeOutcome>>>,
    /// Optional gate entered after recording a staged-file finalizer call.
    pub(crate) finalize_staged_file_gate: Mutex<Option<MockLifecycleGate>>,
    /// Recorded write_files calls across all sandboxes built from this override set.
    pub(crate) write_files_calls: Mutex<Vec<WriteFilesCall>>,
    /// Recorded write_private_file calls across all sandboxes built from this override set.
    pub(crate) private_write_file_calls: Mutex<Vec<WriteFileCall>>,
    /// FIFO queue of write_private_file results consumed by factory-created sandboxes.
    pub(crate) private_write_file_results: Mutex<VecDeque<Result<()>>>,
    /// Recorded write_private_files calls across all sandboxes built from this override set.
    pub(crate) private_write_files_calls: Mutex<Vec<WriteFilesCall>>,
    /// FIFO queue of write_private_files results consumed by factory-created sandboxes.
    pub(crate) private_write_files_results: Mutex<VecDeque<Result<()>>>,
    /// FIFO queue of read_file results consumed by factory-created sandboxes.
    pub(crate) read_file_results: Mutex<VecDeque<Result<Option<Vec<u8>>>>>,
    /// FIFO queue of copy_file results consumed by factory-created sandboxes.
    pub(crate) copy_file_results: Mutex<VecDeque<Result<Vec<u8>>>>,
    /// Recorded copy_file calls across all sandboxes built from this override
    /// set.
    pub(crate) copy_file_calls: Mutex<Vec<CopyFileCall>>,
    /// Optional gate entered after copy validation and result assignment but
    /// before host publication.
    pub(crate) copy_file_gate: Mutex<Option<MockLifecycleGate>>,
    /// Optional gate entered before every write_private_file operation.
    pub(crate) private_write_file_gate: Mutex<Option<MockLifecycleGate>>,
}

#[derive(Default)]
pub(crate) struct LifecycleOverrideState {
    /// Full run IDs passed to `bind_run_control`, in call order.
    pub(crate) run_control_bind_calls: Mutex<Vec<String>>,
    /// Assignment visible when `start` was entered.
    pub(crate) start_run_control_ids: Mutex<Vec<Option<String>>>,
    /// Assignment visible when `unpark` was entered.
    pub(crate) unpark_run_control_ids: Mutex<Vec<Option<String>>>,
    /// FIFO queue of start results consumed by every sandbox built with
    /// these overrides. Empty queue → default Ok(()).
    pub(crate) start_results: Mutex<VecDeque<Result<()>>>,
    /// Optional gate that records and blocks every `start()` entry until released.
    pub(crate) start_gate: Mutex<Option<MockLifecycleGate>>,
    /// FIFO queue of stop behaviours consumed by every sandbox built with
    /// these overrides. Empty queue → default Ok(()).
    pub(crate) stop_behaviors: LifecycleBehaviors<()>,
    /// Optional gate that blocks every `stop()` entry before its result is consumed.
    pub(crate) stop_gate: Mutex<Option<MockLifecycleGate>>,
    /// FIFO queue of kill behaviours consumed by every sandbox built with
    /// these overrides. Empty queue → default Ok(()).
    pub(crate) kill_behaviors: LifecycleBehaviors<()>,
    /// Optional gate that blocks every `kill()` entry before its result is consumed.
    pub(crate) kill_gate: Mutex<Option<MockLifecycleGate>>,
    /// FIFO queue of park results consumed by every sandbox built with
    /// these overrides. Empty queue → default reusable outcome.
    pub(crate) park_behaviors: LifecycleBehaviors<SandboxParkOutcome>,
    /// FIFO handoff points returned by `final_exec_and_park_for_handoff` when
    /// an exact-successor request is pending. Empty queue preserves full park.
    pub(crate) final_exec_park_handoff_points: Mutex<VecDeque<SandboxFinalExecParkHandoffPoint>>,
    /// Completed handoff points returned across all sandboxes built with these
    /// overrides.
    pub(crate) completed_final_exec_park_handoff_points:
        Mutex<Vec<SandboxFinalExecParkHandoffPoint>>,
    /// Optional gate that records and blocks every `park()` entry until released.
    pub(crate) park_gate: Mutex<Option<MockLifecycleGate>>,
    /// FIFO queue of unpark results consumed by every sandbox built with
    /// these overrides. Empty queue → default Ok(()).
    pub(crate) unpark_behaviors: LifecycleBehaviors<()>,
    /// Optional gate that blocks every recorded `unpark()` entry until released.
    pub(crate) unpark_gate: Mutex<Option<MockLifecycleGate>>,
    /// Optional gate that records and blocks every factory `destroy()` entry
    /// until released.
    pub(crate) destroy_gate: Mutex<Option<MockLifecycleGate>>,
    /// FIFO queue of destroy behaviours consumed by every factory built with
    /// these overrides. Empty queue → default successful destroy.
    pub(crate) destroy_behaviors: Mutex<VecDeque<DestroyBehavior>>,
    /// Total `park()` calls across all sandboxes built from this override set.
    pub(crate) park_calls: Mutex<u32>,
    pub(crate) blank_park_calls: Mutex<u32>,
    /// Total `unpark()` calls across all sandboxes built from this override set.
    pub(crate) unpark_calls: Mutex<u32>,
    /// Total terminal-only `unpark()` calls across all attached sandboxes.
    pub(crate) terminal_unpark_calls: Mutex<u32>,
    /// Total `stop()` calls across all attached sandboxes.
    pub(crate) stop_calls: Mutex<u32>,
    /// Total `kill()` calls across all attached sandboxes.
    pub(crate) kill_calls: Mutex<u32>,
    /// Total factory `destroy()` calls across all factories built from this
    /// override set.
    pub(crate) destroy_calls: Mutex<u32>,
}

pub(crate) struct ProcessOverrideState {
    /// Optional gate entered before every start_process operation.
    pub(crate) start_process_lifecycle_gate: Mutex<Option<MockLifecycleGate>>,
    /// When `Some`, `wait_process` returns this exit code instead of 0.
    pub(crate) wait_process_code: Option<i32>,
    /// When set, `wait_process` awaits this [`tokio::sync::Notify`] before
    /// returning — giving the test a window to cancel the job.
    pub(crate) wait_process_gate: Option<Arc<tokio::sync::Notify>>,
    /// Optional durable gate that records and blocks every `wait_process`
    /// entry until released.
    pub(crate) wait_process_lifecycle_gate: Mutex<Option<MockLifecycleGate>>,
    /// FIFO queue of start-process errors consumed by factory-created
    /// sandboxes. Empty queue follows the default successful start behavior.
    pub(crate) start_process_errors: Mutex<VecDeque<SandboxError>>,
    /// When `Some`, `wait_process` returns a wait-process operation error to
    /// simulate timeout or crash.
    pub(crate) wait_process_error: Option<String>,
    /// Structured reason used for a configured `wait_process` error.
    pub(crate) wait_process_error_reason: SandboxOperationReason,
    /// FIFO queue of full wait_process exits consumed by factory-created
    /// sandboxes. Empty queue follows the existing default/override behavior.
    pub(crate) wait_process_exits: Mutex<VecDeque<ProcessExit>>,
    /// FIFO tokens cancelled immediately before successful start_process
    /// results are returned.
    pub(crate) start_process_result_cancellations: Mutex<VecDeque<CancellationToken>>,
    /// FIFO tokens cancelled immediately before successful wait_process
    /// results are returned.
    pub(crate) wait_process_result_cancellations: Mutex<VecDeque<CancellationToken>>,
    /// Recorded wait_process calls across all sandboxes built from this
    /// override set.
    pub(crate) wait_process_calls: Mutex<Vec<WaitProcessCall>>,
    /// Recorded start_process output modes across all sandboxes built from
    /// this override set.
    pub(crate) start_process_calls: Mutex<Vec<StartProcessCall>>,
    /// Recorded start_agent_process calls across all sandboxes built from this
    /// override set.
    pub(crate) start_agent_process_calls: Mutex<Vec<StartAgentProcessCall>>,
    /// FIFO queue of stdout chunk batches emitted by factory-created
    /// sandboxes during streaming start_process calls.
    pub(crate) start_process_stdout_chunks: Mutex<VecDeque<Vec<ProcessOutputChunk>>>,
    /// Whether factory-created sandboxes retain the stdout sender after
    /// `start_process` returns.
    pub(crate) keep_stdout_sender_open: Mutex<bool>,
    /// Whether factory-created sandboxes expose a process cancel handle.
    pub(crate) process_cancel_supported: Mutex<bool>,
    /// Whether factory-created sandboxes expose a process-control handle.
    pub(crate) process_control_supported: Mutex<bool>,
    /// Recorded process cancel calls across all sandboxes built from this
    /// override set.
    pub(crate) process_cancel_calls: Mutex<Vec<ProcessCancelCall>>,
    /// Wakes tests waiting for process cancel calls to be recorded.
    pub(crate) process_cancel_notify: tokio::sync::Notify,
    /// FIFO queue of process cancel errors consumed by cancel handles.
    pub(crate) process_cancel_errors: Mutex<VecDeque<String>>,
    /// Recorded process-control calls across all sandboxes built from this
    /// override set.
    pub(crate) process_control_calls: Mutex<Vec<ProcessControlCall>>,
    /// Wakes tests waiting for process-control calls to be recorded.
    pub(crate) process_control_notify: tokio::sync::Notify,
    /// FIFO queue of structured process-control outcomes consumed by control handles.
    pub(crate) process_control_outcomes: Mutex<VecDeque<ProcessControlOutcome>>,
    /// Whether a successful process cancel releases the configured
    /// `wait_process` gate. Tests can disable this to exercise bounded wait
    /// timeout paths after cancel is sent.
    pub(crate) process_cancel_releases_wait_gate: Mutex<bool>,
}

impl Default for ProcessOverrideState {
    fn default() -> Self {
        Self {
            start_process_lifecycle_gate: Mutex::new(None),
            wait_process_code: None,
            wait_process_gate: None,
            wait_process_lifecycle_gate: Mutex::new(None),
            start_process_errors: Mutex::new(VecDeque::new()),
            wait_process_error: None,
            wait_process_error_reason: SandboxOperationReason::Timeout,
            wait_process_exits: Mutex::new(VecDeque::new()),
            start_process_result_cancellations: Mutex::new(VecDeque::new()),
            wait_process_result_cancellations: Mutex::new(VecDeque::new()),
            wait_process_calls: Mutex::new(Vec::new()),
            start_process_calls: Mutex::new(Vec::new()),
            start_agent_process_calls: Mutex::new(Vec::new()),
            start_process_stdout_chunks: Mutex::new(VecDeque::new()),
            keep_stdout_sender_open: Mutex::new(false),
            process_cancel_supported: Mutex::new(true),
            process_control_supported: Mutex::new(true),
            process_cancel_calls: Mutex::new(Vec::new()),
            process_cancel_notify: tokio::sync::Notify::new(),
            process_cancel_errors: Mutex::new(VecDeque::new()),
            process_control_calls: Mutex::new(Vec::new()),
            process_control_notify: tokio::sync::Notify::new(),
            process_control_outcomes: Mutex::new(VecDeque::new()),
            process_cancel_releases_wait_gate: Mutex::new(true),
        }
    }
}

#[derive(Default)]
pub(crate) struct FactoryOverrideState {
    /// FIFO queue of create results consumed by every factory built with
    /// these overrides. Empty queue → default Ok(()).
    pub(crate) create_results: Mutex<VecDeque<Result<()>>>,
    /// Sandbox create configs observed across factories built with these overrides.
    pub(crate) create_configs: Mutex<Vec<SandboxConfig>>,
    /// Optional gate that records and blocks every factory `create()` entry until released.
    pub(crate) create_gate: Mutex<Option<MockLifecycleGate>>,
}

/// Shared behavior overrides propagated from runtime → factory → sandbox.
///
/// Tests create this via
/// [`MockSandboxRuntime::with_overrides`](crate::MockSandboxRuntime::with_overrides) so every
/// sandbox produced by the factory can share queued behavior and call
/// observations. Queue fields on this type are shared globally by every
/// factory and sandbox that receives the same `Arc<MockSandboxOverrides>`.
///
/// Accessors on this type return shared observation snapshots across that
/// override set. Sandbox-local observations remain available through
/// [`MockSandbox`](crate::MockSandbox) accessors.
pub struct MockSandboxOverrides {
    pub(crate) exec: ExecOverrideState,
    pub(crate) file: FileOverrideState,
    pub(crate) lifecycle: LifecycleOverrideState,
    pub(crate) process: ProcessOverrideState,
    pub(crate) factory: FactoryOverrideState,
}

impl MockSandboxOverrides {
    /// Create an override set with empty shared queues and observations.
    ///
    /// Sandboxes and factories only share this state after the same instance is
    /// passed through
    /// [`MockSandboxRuntime::with_overrides`](crate::MockSandboxRuntime::with_overrides) or
    /// [`MockSandboxFactory::with_overrides`](crate::MockSandboxFactory::with_overrides).
    pub fn new() -> Self {
        Self {
            exec: ExecOverrideState::default(),
            file: FileOverrideState::default(),
            lifecycle: LifecycleOverrideState::default(),
            process: ProcessOverrideState::default(),
            factory: FactoryOverrideState::default(),
        }
    }

    /// Queue one staged-file finalizer result shared by attached sandboxes.
    pub fn push_finalize_staged_file_result(&self, result: Result<StagedFileFinalizeOutcome>) {
        self.file
            .finalize_staged_file_results
            .lock_ignoring_poison()
            .push_back(result);
    }

    /// Queue one write_file result shared by attached sandboxes.
    pub fn push_write_file_result(&self, result: Result<()>) {
        self.file
            .write_file_results
            .lock_ignoring_poison()
            .push_back(result);
    }

    /// Return recorded staged-file finalizer calls.
    pub fn finalize_staged_file_calls(&self) -> Vec<FinalizeStagedFileCall> {
        self.file
            .finalize_staged_file_calls
            .lock_ignoring_poison()
            .clone()
    }

    /// Block staged-file finalization after call recording.
    pub fn set_finalize_staged_file_lifecycle_gate(&self, gate: MockLifecycleGate) {
        *self.file.finalize_staged_file_gate.lock_ignoring_poison() = Some(gate);
    }

    /// Block write_file after call recording.
    pub fn set_write_file_lifecycle_gate(&self, gate: MockLifecycleGate) {
        *self.file.write_file_gate.lock_ignoring_poison() = Some(gate);
    }

    /// Create overrides that make `wait_process` return a custom exit code.
    pub fn with_wait_process_code(code: i32) -> Self {
        let mut overrides = Self::new();
        overrides.process.wait_process_code = Some(code);
        overrides
    }

    /// Create overrides that block `wait_process` until the gate is notified.
    pub fn with_wait_process_gate(gate: Arc<tokio::sync::Notify>) -> Self {
        let mut overrides = Self::new();
        overrides.process.wait_process_gate = Some(gate);
        overrides
    }

    /// Block every `start_process` call before validation or call recording.
    pub fn set_start_process_lifecycle_gate(&self, gate: MockLifecycleGate) {
        *self
            .process
            .start_process_lifecycle_gate
            .lock_ignoring_poison() = Some(gate);
    }

    /// Remove the start-process gate for future calls.
    ///
    /// Already-entered calls keep waiting on their cloned gate until released
    /// or cancelled.
    pub fn clear_start_process_lifecycle_gate(&self) {
        *self
            .process
            .start_process_lifecycle_gate
            .lock_ignoring_poison() = None;
    }

    /// Block every `wait_process` call with a durable lifecycle gate.
    ///
    /// Prefer this over [`Self::with_wait_process_gate`]: entries and releases
    /// are durable, so tests do not need to pre-arm `Notify` futures.
    pub fn set_wait_process_lifecycle_gate(&self, gate: MockLifecycleGate) {
        *self
            .process
            .wait_process_lifecycle_gate
            .lock_ignoring_poison() = Some(gate);
    }

    /// Remove the durable `wait_process` gate for future wait calls.
    ///
    /// Already-entered wait calls keep waiting on their cloned gate until the
    /// test releases it.
    pub fn clear_wait_process_lifecycle_gate(&self) {
        *self
            .process
            .wait_process_lifecycle_gate
            .lock_ignoring_poison() = None;
    }

    /// Queue a start-process error applied to the next matching start call.
    /// Consumed FIFO across all sandboxes; empty queue follows the default
    /// successful start behavior.
    pub fn push_start_process_error(&self, error: SandboxError) {
        self.process
            .start_process_errors
            .lock_ignoring_poison()
            .push_back(error);
    }

    /// Create overrides that make `wait_process` return an error (simulating
    /// timeout or crash). The stdout channel sender is kept alive so the
    /// drain task blocks unless the caller aborts it.
    pub fn with_wait_process_error(msg: impl Into<String>) -> Self {
        let mut overrides = Self::new();
        overrides.process.wait_process_error = Some(msg.into());
        *overrides
            .process
            .keep_stdout_sender_open
            .lock_ignoring_poison() = true;
        overrides
    }

    /// Create overrides that make `wait_process` return an error with the supplied reason.
    pub fn with_wait_process_error_reason(
        reason: SandboxOperationReason,
        msg: impl Into<String>,
    ) -> Self {
        let mut overrides = Self::with_wait_process_error(msg);
        overrides.process.wait_process_error_reason = reason;
        overrides
    }

    /// Queue a full `wait_process` exit applied to the next matching wait call.
    /// Consumed FIFO across all sandboxes; empty queue follows the existing
    /// default/override behavior.
    pub fn push_wait_process_exit(&self, exit: ProcessExit) {
        self.process
            .wait_process_exits
            .lock_ignoring_poison()
            .push_back(exit);
    }

    /// Cancel a token immediately before the next successful `start_process`
    /// result is returned.
    pub fn cancel_after_next_start_process_result(&self, cancel: CancellationToken) {
        self.process
            .start_process_result_cancellations
            .lock_ignoring_poison()
            .push_back(cancel);
    }

    /// Cancel a token immediately before the next successful `wait_process`
    /// result is returned.
    pub fn cancel_after_next_wait_process_result(&self, cancel: CancellationToken) {
        self.process
            .wait_process_result_cancellations
            .lock_ignoring_poison()
            .push_back(cancel);
    }

    /// Block every `exec` call with a durable lifecycle gate after recording it.
    pub fn set_exec_lifecycle_gate(&self, gate: MockLifecycleGate) {
        *self.exec.lifecycle_gate.lock_ignoring_poison() = Some(gate);
    }

    /// Block every fixed workspace-drive mount call with a durable lifecycle
    /// gate after recording it.
    pub fn set_workspace_drive_mount_lifecycle_gate(&self, gate: MockLifecycleGate) {
        *self
            .exec
            .workspace_drive_mount_lifecycle_gate
            .lock_ignoring_poison() = Some(gate);
    }

    /// Register a one-shot pattern matcher for an ordinary exited result.
    ///
    /// The first registered matcher whose pattern occurs in a command is
    /// consumed. The result is constructed with [`ExecResult::new`], then the
    /// request's [`ExecOutputLimits`] are applied before it is returned.
    pub fn add_exec_matcher(&self, matcher: ExecMatcher) {
        self.exec
            .matchers
            .lock_ignoring_poison()
            .push(ExecMatcherBehavior {
                pattern: matcher.pattern,
                outcome: ExecMatcherOutcome::Return(ExecResult::new(
                    matcher.exit_code,
                    matcher.stdout,
                    matcher.stderr,
                )),
            });
    }

    /// Register a pattern matcher that returns the supplied full exec result.
    ///
    /// Use this when a test needs a non-ordinary terminal state, diagnostic
    /// text, or pre-existing result metadata. The request's
    /// [`ExecOutputLimits`] are still applied before the result is returned.
    pub fn add_exec_result_matcher(&self, pattern: impl Into<String>, result: ExecResult) {
        self.exec
            .matchers
            .lock_ignoring_poison()
            .push(ExecMatcherBehavior {
                pattern: pattern.into(),
                outcome: ExecMatcherOutcome::Return(result),
            });
    }

    /// Register a one-shot pattern matcher that returns an exec transport error.
    pub fn add_exec_error_matcher(&self, pattern: impl Into<String>, error: SandboxError) {
        self.exec
            .matchers
            .lock_ignoring_poison()
            .push(ExecMatcherBehavior {
                pattern: pattern.into(),
                outcome: ExecMatcherOutcome::Error(error),
            });
    }

    /// Register a one-shot pattern matcher that panics from the exec boundary.
    pub fn add_exec_panic_matcher(&self, pattern: impl Into<String>, message: impl Into<String>) {
        self.exec
            .matchers
            .lock_ignoring_poison()
            .push(ExecMatcherBehavior {
                pattern: pattern.into(),
                outcome: ExecMatcherOutcome::Panic(message.into()),
            });
    }

    /// Register a persistent matcher for an ordinary exited result.
    ///
    /// One-shot matchers take precedence. The persistent matcher is not
    /// consumed and can serve repeated calls across sandboxes.
    pub fn add_persistent_exec_matcher(&self, matcher: ExecMatcher) {
        self.exec
            .persistent_matchers
            .lock_ignoring_poison()
            .push(ExecMatcherResult {
                pattern: matcher.pattern,
                result: ExecResult::new(matcher.exit_code, matcher.stdout, matcher.stderr),
            });
    }

    /// Return recorded exec calls across all sandboxes built from this
    /// override set.
    ///
    /// The returned vector is a cloned snapshot in recorded order. Each record
    /// is captured before exec matchers or queued exec results are consumed.
    pub fn exec_calls(&self) -> Vec<ExecCall> {
        self.exec.calls.lock_ignoring_poison().clone()
    }

    /// Return fixed storage-manifest calls across all attached sandboxes.
    pub fn storage_manifest_calls(&self) -> Vec<StorageManifestCall> {
        self.exec
            .storage_manifest_calls
            .lock_ignoring_poison()
            .clone()
    }

    /// Block fixed storage-manifest operations until the gate is released.
    pub fn set_storage_manifest_lifecycle_gate(&self, gate: MockLifecycleGate) {
        *self.exec.storage_manifest_gate.lock_ignoring_poison() = Some(gate);
    }

    /// Queue a fixed storage-manifest result across attached sandboxes.
    pub fn push_storage_manifest_result(&self, result: Result<ExecResult>) {
        self.exec
            .storage_manifest_results
            .lock_ignoring_poison()
            .push_back(result);
    }

    /// Queue a fixed workspace-drive mount result across attached sandboxes.
    pub fn push_workspace_drive_mount_result(&self, result: Result<ExecResult>) {
        self.exec
            .workspace_drive_mount_results
            .lock_ignoring_poison()
            .push_back(result);
    }

    /// Return the total fixed workspace-drive mount calls across attached
    /// sandboxes.
    pub fn workspace_drive_mount_calls(&self) -> u32 {
        *self.exec.workspace_drive_mount_calls.lock_ignoring_poison()
    }

    /// Return fixed live session-history identity verifier calls.
    pub fn session_history_identity_verify_calls(&self) -> Vec<SessionHistoryIdentityVerifyCall> {
        self.exec
            .session_history_identity_verify_calls
            .lock_ignoring_poison()
            .clone()
    }

    /// Return fixed reused-Codex cleanup calls across all attached sandboxes.
    pub fn codex_session_cleanup_calls(&self) -> Vec<CodexSessionCleanupCall> {
        self.exec
            .codex_session_cleanup_calls
            .lock_ignoring_poison()
            .clone()
    }

    /// Queue a result for the next fixed guest-state restore operation.
    pub fn push_guest_state_restore_result(&self, result: Result<ExecResult>) {
        self.exec
            .guest_state_restore_behaviors
            .lock_ignoring_poison()
            .push_back(GuestStateRestoreBehavior::Return(result));
    }

    /// Queue a panic for the next fixed guest-state restore operation.
    pub fn push_guest_state_restore_panic(&self, message: impl Into<String>) {
        self.exec
            .guest_state_restore_behaviors
            .lock_ignoring_poison()
            .push_back(GuestStateRestoreBehavior::Panic(message.into()));
    }

    /// Return fixed guest-state restore calls across all attached sandboxes.
    pub fn guest_state_restore_calls(&self) -> Vec<GuestStateRestoreCall> {
        self.exec
            .guest_state_restore_calls
            .lock_ignoring_poison()
            .clone()
    }

    /// Wait until at least `expected` guest-state restore calls are recorded.
    pub async fn wait_guest_state_restore_call_count(
        &self,
        expected: usize,
        timeout: Duration,
    ) -> bool {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let notified = self.exec.guest_state_restore_call_notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();

            if self
                .exec
                .guest_state_restore_calls
                .lock_ignoring_poison()
                .len()
                >= expected
            {
                return true;
            }

            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return false;
            }
            if tokio::time::timeout(remaining, notified).await.is_err() {
                return false;
            }
        }
    }

    /// Wait until at least `expected` exec calls have been recorded.
    pub async fn wait_exec_call_count(&self, expected: usize, timeout: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let notified = self.exec.call_notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();

            if self.exec.calls.lock_ignoring_poison().len() >= expected {
                return true;
            }

            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return false;
            }
            if tokio::time::timeout(remaining, notified).await.is_err() {
                return false;
            }
        }
    }

    /// Wait until at least `expected` fixed workspace-drive mount calls have
    /// been recorded.
    pub async fn wait_workspace_drive_mount_call_count(
        &self,
        expected: u32,
        timeout: Duration,
    ) -> bool {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let notified = self.exec.workspace_drive_mount_call_notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();

            if self.workspace_drive_mount_calls() >= expected {
                return true;
            }

            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return false;
            }
            if tokio::time::timeout(remaining, notified).await.is_err() {
                return false;
            }
        }
    }

    /// Return recorded write-file calls across all sandboxes built from this
    /// override set.
    ///
    /// The returned vector is a cloned snapshot in recorded order. Shared
    /// overrides observe these calls but do not provide a shared write-file
    /// result queue.
    pub fn write_file_calls(&self) -> Vec<WriteFileCall> {
        self.file.write_file_calls.lock_ignoring_poison().clone()
    }

    /// Return recorded write-files batch calls across all sandboxes built from
    /// this override set.
    pub fn write_files_calls(&self) -> Vec<WriteFilesCall> {
        self.file.write_files_calls.lock_ignoring_poison().clone()
    }

    /// Return recorded private write-file calls across all sandboxes built
    /// from this override set.
    pub fn private_write_file_calls(&self) -> Vec<WriteFileCall> {
        self.file
            .private_write_file_calls
            .lock_ignoring_poison()
            .clone()
    }

    /// Return recorded private write-files batch calls across all sandboxes
    /// built from this override set.
    pub fn private_write_files_calls(&self) -> Vec<WriteFilesCall> {
        self.file
            .private_write_files_calls
            .lock_ignoring_poison()
            .clone()
    }

    /// Queue a write_private_file result applied to the next private write made
    /// through any sandbox built from these overrides after that sandbox's
    /// local private-write queue is empty.
    pub fn push_private_write_file_result(&self, result: Result<()>) {
        self.file
            .private_write_file_results
            .lock_ignoring_poison()
            .push_back(result);
    }

    /// Queue a write_private_files result applied to the next private batch
    /// made through any sandbox built from these overrides after that
    /// sandbox's local private-batch queue is empty.
    pub fn push_private_write_files_result(&self, result: Result<()>) {
        self.file
            .private_write_files_results
            .lock_ignoring_poison()
            .push_back(result);
    }

    /// Queue a read_file result applied to the next read made through any
    /// sandbox built from these overrides after that sandbox's local read queue
    /// is empty.
    pub fn push_read_file_result(&self, result: Result<Option<Vec<u8>>>) {
        self.file
            .read_file_results
            .lock_ignoring_poison()
            .push_back(result);
    }

    /// Queue a `copy_file` result shared by factory-created sandboxes.
    ///
    /// A sandbox-local result takes precedence. Shared results are consumed in
    /// FIFO order after the local queue is empty.
    pub fn push_copy_file_result(&self, result: Result<Vec<u8>>) {
        self.file
            .copy_file_results
            .lock_ignoring_poison()
            .push_back(result);
    }

    /// Block copy operations after validation and result assignment but before
    /// host publication.
    pub fn set_copy_file_lifecycle_gate(&self, gate: MockLifecycleGate) {
        *self.file.copy_file_gate.lock_ignoring_poison() = Some(gate);
    }

    /// Remove the copy gate for future calls.
    ///
    /// Already-entered copies keep waiting on their cloned gate until released
    /// or cancelled.
    pub fn clear_copy_file_lifecycle_gate(&self) {
        *self.file.copy_file_gate.lock_ignoring_poison() = None;
    }

    /// Block every `write_private_file` call before validation, recording, or
    /// queued-result consumption.
    pub fn set_private_write_file_lifecycle_gate(&self, gate: MockLifecycleGate) {
        *self.file.private_write_file_gate.lock_ignoring_poison() = Some(gate);
    }

    /// Remove the private-write gate for future calls.
    ///
    /// Already-entered calls keep waiting on their cloned gate until released
    /// or cancelled.
    pub fn clear_private_write_file_lifecycle_gate(&self) {
        *self.file.private_write_file_gate.lock_ignoring_poison() = None;
    }

    /// Queue a factory `create()` result applied to the next factory create
    /// call made through these overrides. Consumed FIFO across all factories;
    /// empty queue → default Ok(()).
    pub fn push_create_result(&self, result: Result<()>) {
        self.factory
            .create_results
            .lock_ignoring_poison()
            .push_back(result);
    }

    /// Return sandbox create configs observed by factories using this override
    /// set.
    ///
    /// The returned vector is a cloned snapshot in recorded order. A create
    /// config is recorded before factory-local or shared queued create errors
    /// are returned.
    pub fn create_configs(&self) -> Vec<SandboxConfig> {
        self.factory.create_configs.lock_ignoring_poison().clone()
    }

    /// Block every factory `create()` call with a durable lifecycle gate.
    pub fn set_create_lifecycle_gate(&self, gate: MockLifecycleGate) {
        *self.factory.create_gate.lock_ignoring_poison() = Some(gate);
    }

    /// Queue a `start()` result applied to the next factory-created sandbox.
    /// Consumed FIFO across all sandboxes; empty queue → default Ok(()).
    pub fn push_start_result(&self, result: Result<()>) {
        self.lifecycle
            .start_results
            .lock_ignoring_poison()
            .push_back(result);
    }

    /// Block every `start()` call with a durable lifecycle gate.
    pub fn set_start_lifecycle_gate(&self, gate: MockLifecycleGate) {
        *self.lifecycle.start_gate.lock_ignoring_poison() = Some(gate);
    }

    /// Return full run identities bound across all mock sandboxes.
    pub fn run_control_bind_calls(&self) -> Vec<String> {
        self.lifecycle
            .run_control_bind_calls
            .lock_ignoring_poison()
            .clone()
    }

    /// Return the assignment visible at each sandbox start.
    pub fn start_run_control_ids(&self) -> Vec<Option<String>> {
        self.lifecycle
            .start_run_control_ids
            .lock_ignoring_poison()
            .clone()
    }

    /// Return the assignment visible at each sandbox unpark.
    pub fn unpark_run_control_ids(&self) -> Vec<Option<String>> {
        self.lifecycle
            .unpark_run_control_ids
            .lock_ignoring_poison()
            .clone()
    }

    /// Queue a `stop()` result applied to the next factory-created sandbox.
    /// Consumed FIFO across all sandboxes; empty queue → default Ok(()).
    pub fn push_stop_result(&self, result: Result<()>) {
        self.lifecycle.stop_behaviors.push_result(result);
    }

    /// Queue a `stop()` panic applied to the next factory-created sandbox.
    /// Used by runner tests to exercise panic-safe cleanup boundaries.
    pub fn push_stop_panic(&self, message: impl Into<String>) {
        self.lifecycle.stop_behaviors.push_panic(message);
    }

    /// Block every `stop()` call before consuming its queued result or panic.
    pub fn set_stop_lifecycle_gate(&self, gate: MockLifecycleGate) {
        *self.lifecycle.stop_gate.lock_ignoring_poison() = Some(gate);
    }

    /// Queue a `kill()` result applied to the next factory-created sandbox.
    /// Consumed FIFO across all sandboxes; empty queue → default Ok(()).
    pub fn push_kill_result(&self, result: Result<()>) {
        self.lifecycle.kill_behaviors.push_result(result);
    }

    /// Queue a `kill()` panic applied to the next factory-created sandbox.
    /// Used by runner tests to exercise panic-safe cleanup boundaries.
    pub fn push_kill_panic(&self, message: impl Into<String>) {
        self.lifecycle.kill_behaviors.push_panic(message);
    }

    /// Block every `kill()` call before consuming its queued result or panic.
    pub fn set_kill_lifecycle_gate(&self, gate: MockLifecycleGate) {
        *self.lifecycle.kill_gate.lock_ignoring_poison() = Some(gate);
    }

    /// Block every `unpark()` call after recording it and before consuming its result.
    pub fn set_unpark_lifecycle_gate(&self, gate: MockLifecycleGate) {
        *self.lifecycle.unpark_gate.lock_ignoring_poison() = Some(gate);
    }

    /// Queue a `park()` result applied to the next factory-created sandbox.
    /// Consumed FIFO across all sandboxes; empty queue → reusable.
    pub fn push_park_result(&self, result: Result<SandboxParkOutcome>) {
        self.lifecycle.park_behaviors.push_result(result);
    }

    /// Queue a `park()` panic applied to the next factory-created sandbox.
    /// Used by runner tests to exercise panic-safe cleanup boundaries.
    pub fn push_park_panic(&self, message: impl Into<String>) {
        self.lifecycle.park_behaviors.push_panic(message);
    }

    /// Queue an interrupt point for the next handoff-aware final park.
    ///
    /// The point is returned only when a live exact-successor request can be
    /// accepted after the final guest operation. Otherwise the mock completes
    /// the ordinary park path.
    pub fn push_final_exec_park_handoff_point(&self, point: SandboxFinalExecParkHandoffPoint) {
        self.lifecycle
            .final_exec_park_handoff_points
            .lock_ignoring_poison()
            .push_back(point);
    }

    /// Return handoff points successfully returned by handoff-aware final park.
    pub fn completed_final_exec_park_handoff_points(
        &self,
    ) -> Vec<SandboxFinalExecParkHandoffPoint> {
        self.lifecycle
            .completed_final_exec_park_handoff_points
            .lock_ignoring_poison()
            .clone()
    }

    /// Block every `park()` call with a durable lifecycle gate.
    pub fn set_park_lifecycle_gate(&self, gate: MockLifecycleGate) {
        *self.lifecycle.park_gate.lock_ignoring_poison() = Some(gate);
    }

    /// Queue an `unpark()` result applied to the next factory-created sandbox.
    /// Consumed FIFO across all sandboxes; empty queue → default Ok(()).
    pub fn push_unpark_result(&self, result: Result<()>) {
        self.lifecycle.unpark_behaviors.push_result(result);
    }

    /// Queue an `unpark()` panic applied to the next factory-created sandbox.
    /// Used by runner tests to exercise panic-safe cleanup boundaries.
    pub fn push_unpark_panic(&self, message: impl Into<String>) {
        self.lifecycle.unpark_behaviors.push_panic(message);
    }

    /// Block every factory `destroy()` call with a durable lifecycle gate.
    pub fn set_destroy_lifecycle_gate(&self, gate: MockLifecycleGate) {
        *self.lifecycle.destroy_gate.lock_ignoring_poison() = Some(gate);
    }

    /// Queue a factory `destroy()` panic applied to the next destroy call made
    /// through these overrides. Consumed FIFO across all factories.
    pub fn push_destroy_panic(&self, message: impl Into<String>) {
        self.lifecycle
            .destroy_behaviors
            .lock_ignoring_poison()
            .push_back(DestroyBehavior::Panic(message.into()));
    }

    /// Total `park()` calls across all sandboxes built from this override set.
    pub fn park_call_count(&self) -> u32 {
        *self.lifecycle.park_calls.lock_ignoring_poison()
    }

    /// Total blank preparation park calls, also included in ordinary park counts.
    pub fn blank_park_call_count(&self) -> u32 {
        *self.lifecycle.blank_park_calls.lock_ignoring_poison()
    }

    /// Total `unpark()` calls across all sandboxes built from this override set.
    pub fn unpark_call_count(&self) -> u32 {
        *self.lifecycle.unpark_calls.lock_ignoring_poison()
    }

    /// Total terminal-only `unpark()` calls across all attached sandboxes.
    pub fn terminal_unpark_call_count(&self) -> u32 {
        *self.lifecycle.terminal_unpark_calls.lock_ignoring_poison()
    }

    /// Total `stop()` calls across all attached sandboxes.
    pub fn stop_call_count(&self) -> u32 {
        *self.lifecycle.stop_calls.lock_ignoring_poison()
    }

    /// Total `kill()` calls across all attached sandboxes.
    pub fn kill_call_count(&self) -> u32 {
        *self.lifecycle.kill_calls.lock_ignoring_poison()
    }

    /// Total factory `destroy()` calls across all factories built from this
    /// override set.
    pub fn destroy_call_count(&self) -> u32 {
        *self.lifecycle.destroy_calls.lock_ignoring_poison()
    }

    /// Return recorded start-process calls across all sandboxes built from this
    /// override set.
    ///
    /// The returned vector is a cloned snapshot in recorded order.
    pub fn start_process_calls(&self) -> Vec<StartProcessCall> {
        self.process
            .start_process_calls
            .lock_ignoring_poison()
            .clone()
    }

    /// Return recorded start-Agent-process calls across all sandboxes built
    /// from this override set.
    pub fn start_agent_process_calls(&self) -> Vec<StartAgentProcessCall> {
        self.process
            .start_agent_process_calls
            .lock_ignoring_poison()
            .clone()
    }

    /// Return recorded wait-process calls across all sandboxes built from this
    /// override set.
    ///
    /// The returned vector is a cloned snapshot in recorded order.
    pub fn wait_process_calls(&self) -> Vec<WaitProcessCall> {
        self.process
            .wait_process_calls
            .lock_ignoring_poison()
            .clone()
    }

    /// Return recorded copy-file calls across all sandboxes built from this
    /// override set.
    ///
    /// The returned vector is a cloned snapshot in recorded order.
    pub fn copy_file_calls(&self) -> Vec<CopyFileCall> {
        self.file.copy_file_calls.lock_ignoring_poison().clone()
    }

    /// Queue stdout chunks emitted by the next streaming `start_process` call.
    /// Consumed FIFO across all sandboxes; empty queue emits no chunks.
    pub fn push_start_process_stdout_chunks(&self, chunks: Vec<ProcessOutputChunk>) {
        self.process
            .start_process_stdout_chunks
            .lock_ignoring_poison()
            .push_back(chunks);
    }

    /// Configure `wait_process` to return an error while preserving any other
    /// overrides already set on this instance.
    pub fn set_wait_process_error(&mut self, msg: impl Into<String>) {
        self.process.wait_process_error = Some(msg.into());
        *self.process.keep_stdout_sender_open.lock_ignoring_poison() = true;
    }

    /// Configure whether future streaming process handles retain their stdout sender.
    pub fn set_keep_stdout_sender_open(&self, keep_open: bool) {
        *self.process.keep_stdout_sender_open.lock_ignoring_poison() = keep_open;
    }

    /// Configure whether future `start_process` handles include a cancel handle.
    pub fn set_process_cancel_supported(&self, supported: bool) {
        *self.process.process_cancel_supported.lock_ignoring_poison() = supported;
    }

    /// Configure whether future `start_process` handles include a control handle.
    pub fn set_process_control_supported(&self, supported: bool) {
        *self
            .process
            .process_control_supported
            .lock_ignoring_poison() = supported;
    }

    /// Return recorded process-cancel calls across all sandboxes built from
    /// this override set.
    ///
    /// The returned vector is a cloned snapshot in recorded order. Cancel
    /// attempts are recorded before any queued cancel send error is returned.
    pub fn process_cancel_calls(&self) -> Vec<ProcessCancelCall> {
        self.process
            .process_cancel_calls
            .lock_ignoring_poison()
            .clone()
    }

    /// Return recorded process-control calls across all sandboxes built from
    /// this override set.
    ///
    /// The returned vector is a cloned snapshot in recorded order. Control
    /// attempts are recorded before any queued control send error is returned.
    pub fn process_control_calls(&self) -> Vec<ProcessControlCall> {
        self.process
            .process_control_calls
            .lock_ignoring_poison()
            .clone()
    }

    /// Wait until at least `expected` process cancel calls have been recorded.
    pub async fn wait_for_process_cancel_calls(&self, expected: usize, timeout: Duration) -> bool {
        tokio::time::timeout(timeout, async {
            loop {
                let notified = self.process.process_cancel_notify.notified();
                if self
                    .process
                    .process_cancel_calls
                    .lock_ignoring_poison()
                    .len()
                    >= expected
                {
                    return;
                }
                notified.await;
            }
        })
        .await
        .is_ok()
    }

    /// Wait until at least `expected` process-control calls have been recorded.
    pub async fn wait_for_process_control_calls(&self, expected: usize, timeout: Duration) -> bool {
        tokio::time::timeout(timeout, async {
            loop {
                let notified = self.process.process_control_notify.notified();
                if self
                    .process
                    .process_control_calls
                    .lock_ignoring_poison()
                    .len()
                    >= expected
                {
                    return;
                }
                notified.await;
            }
        })
        .await
        .is_ok()
    }

    /// Queue a process cancel send error consumed by the next cancel handle.
    pub fn push_process_cancel_error(&self, message: impl Into<String>) {
        self.process
            .process_cancel_errors
            .lock_ignoring_poison()
            .push_back(message.into());
    }

    /// Queue a process-control send error consumed by the next control handle.
    pub fn push_process_control_error(&self, message: impl Into<String>) {
        self.push_process_control_io_error(std::io::ErrorKind::Other, message);
    }

    /// Queue a process-control send error with a specific I/O kind.
    pub fn push_process_control_io_error(
        &self,
        kind: std::io::ErrorKind,
        message: impl Into<String>,
    ) {
        self.push_process_control_outcome(ProcessControlOutcome::Failed {
            kind: ProcessControlFailureKind::Operation,
            write_state: ProcessControlWriteState::PossiblyWritten,
            error: std::io::Error::new(kind, message.into()),
        });
    }

    /// Queue a structured process-control outcome consumed by the next control handle.
    pub fn push_process_control_outcome(&self, outcome: ProcessControlOutcome) {
        self.process
            .process_control_outcomes
            .lock_ignoring_poison()
            .push_back(outcome);
    }

    /// Configure whether successful process cancellation releases a configured
    /// `wait_process` gate.
    pub fn set_process_cancel_releases_wait_gate(&self, releases: bool) {
        *self
            .process
            .process_cancel_releases_wait_gate
            .lock_ignoring_poison() = releases;
    }

    pub(crate) async fn wait_for_wait_process_gate(&self) {
        let lifecycle_gate = {
            self.process
                .wait_process_lifecycle_gate
                .lock_ignoring_poison()
                .clone()
        };
        if let Some(gate) = lifecycle_gate {
            gate.enter_and_wait().await;
        } else if let Some(gate) = &self.process.wait_process_gate {
            gate.notified().await;
        }
    }

    pub(crate) fn release_wait_process_gate(&self) {
        if let Some(gate) = &self.process.wait_process_gate {
            gate.notify_one();
        }
        if let Some(gate) = self
            .process
            .wait_process_lifecycle_gate
            .lock_ignoring_poison()
            .clone()
        {
            gate.release_one();
        }
    }
}

impl Default for MockSandboxOverrides {
    fn default() -> Self {
        Self::new()
    }
}
