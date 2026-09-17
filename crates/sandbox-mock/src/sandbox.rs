use std::collections::VecDeque;
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ::sandbox::*;
use async_trait::async_trait;

use crate::call_records::{
    CodexSessionCleanupCall, CopyFileCall, ExecCall, GuestStateRestoreCall,
    GuestStateRestoreTimezoneCall, ProcessCancelCall, ProcessControlCall, ReadFileCall,
    SessionHistoryIdentityVerifyCall, StartAgentProcessCall, StartProcessCall, StorageManifestCall,
    WaitProcessCall, WriteFileCall, WriteFilesCall,
};
use crate::lifecycle::{MockLifecycleGate, wait_lifecycle_gate};
use crate::overrides::{ExecMatcherOutcome, GuestStateRestoreBehavior, MockSandboxOverrides};
use crate::support::{
    LockIgnoringPoison, MOCK_COPY_FILE_MAX_BYTES, validate_mock_copy_host_path,
    validate_mock_exec_env_keys, validate_mock_guest_file_path,
};

/// A mock [`Sandbox`] that succeeds on all operations by default.
///
/// Queue custom results with [`push_exec_result`](Self::push_exec_result)
/// and [`push_write_file_result`](Self::push_write_file_result).
/// When a queue is empty, the operation returns its default success value.
///
/// This type owns sandbox-local queues and sandbox-local call observations.
/// Sandboxes created by an override-enabled factory also record selected calls
/// in the shared [`MockSandboxOverrides`] observations.
pub struct MockSandbox {
    id: String,
    source_ip: String,
    run_control_id: Option<String>,
    exec_results: Mutex<VecDeque<Result<ExecResult>>>,
    exec_calls: Mutex<Vec<ExecCall>>,
    storage_manifest_calls: Mutex<Vec<StorageManifestCall>>,
    workspace_drive_mount_results: Mutex<VecDeque<Result<ExecResult>>>,
    workspace_drive_mount_calls: Mutex<u32>,
    session_history_identity_verify_calls: Mutex<Vec<SessionHistoryIdentityVerifyCall>>,
    codex_session_cleanup_calls: Mutex<Vec<CodexSessionCleanupCall>>,
    guest_state_restore_calls: Mutex<Vec<GuestStateRestoreCall>>,
    read_file_results: Mutex<VecDeque<Result<Option<Vec<u8>>>>>,
    read_file_calls: Mutex<Vec<ReadFileCall>>,
    copy_file_results: Mutex<VecDeque<Result<Vec<u8>>>>,
    copy_file_calls: Mutex<Vec<CopyFileCall>>,
    copy_file_gate: Mutex<Option<MockLifecycleGate>>,
    write_file_results: Mutex<VecDeque<Result<()>>>,
    write_file_calls: Mutex<Vec<WriteFileCall>>,
    write_files_calls: Mutex<Vec<WriteFilesCall>>,
    private_write_file_results: Mutex<VecDeque<Result<()>>>,
    private_write_file_calls: Mutex<Vec<WriteFileCall>>,
    private_write_files_results: Mutex<VecDeque<Result<()>>>,
    private_write_files_calls: Mutex<Vec<WriteFilesCall>>,
    write_file_gate: Mutex<Option<MockLifecycleGate>>,
    overrides: Option<Arc<MockSandboxOverrides>>,
    /// Holds the stdout channel sender alive when an override requests a
    /// non-closing process stream.
    stdout_tx: Mutex<Option<tokio::sync::mpsc::Sender<ProcessOutputChunk>>>,
}

impl MockSandbox {
    /// Create a sandbox with empty local queues and observations.
    ///
    /// The default source IP is `10.0.0.1`, and no shared
    /// [`MockSandboxOverrides`] are attached.
    pub fn new(id: impl Into<String>) -> Self {
        Self::build(id, None)
    }

    /// Create a sandbox attached directly to shared behavior overrides.
    ///
    /// This is useful when a test does not need to construct a runtime and
    /// factory but still needs command matchers or shared observations.
    pub fn with_overrides(id: impl Into<String>, overrides: Arc<MockSandboxOverrides>) -> Self {
        Self::build(id, Some(overrides))
    }

    fn build(id: impl Into<String>, overrides: Option<Arc<MockSandboxOverrides>>) -> Self {
        Self {
            id: id.into(),
            source_ip: "10.0.0.1".into(),
            run_control_id: None,
            exec_results: Mutex::new(VecDeque::new()),
            exec_calls: Mutex::new(Vec::new()),
            storage_manifest_calls: Mutex::new(Vec::new()),
            workspace_drive_mount_results: Mutex::new(VecDeque::new()),
            workspace_drive_mount_calls: Mutex::new(0),
            session_history_identity_verify_calls: Mutex::new(Vec::new()),
            codex_session_cleanup_calls: Mutex::new(Vec::new()),
            guest_state_restore_calls: Mutex::new(Vec::new()),
            read_file_results: Mutex::new(VecDeque::new()),
            read_file_calls: Mutex::new(Vec::new()),
            copy_file_results: Mutex::new(VecDeque::new()),
            copy_file_calls: Mutex::new(Vec::new()),
            copy_file_gate: Mutex::new(None),
            write_file_results: Mutex::new(VecDeque::new()),
            write_file_calls: Mutex::new(Vec::new()),
            write_files_calls: Mutex::new(Vec::new()),
            private_write_file_results: Mutex::new(VecDeque::new()),
            private_write_file_calls: Mutex::new(Vec::new()),
            private_write_files_results: Mutex::new(VecDeque::new()),
            private_write_files_calls: Mutex::new(Vec::new()),
            write_file_gate: Mutex::new(None),
            overrides,
            stdout_tx: Mutex::new(None),
        }
    }

    /// Override the source IP returned by this sandbox.
    ///
    /// This only changes the value returned by [`Sandbox::source_ip`]; it does
    /// not affect queued behavior or call observations.
    pub fn with_source_ip(mut self, ip: impl Into<String>) -> Self {
        self.source_ip = ip.into();
        self
    }

    async fn final_exec_and_park_with_observer_and_handoff(
        &mut self,
        request: &ExecRequest<'_>,
        diagnostic_label: &'static str,
        handoff: Option<(
            &SandboxFinalExecParkHandoff,
            SandboxFinalExecParkHandoffPoint,
        )>,
        observer: &mut dyn SandboxFinalExecParkObserver,
    ) -> Result<SandboxFinalExecParkHandoffOutcome> {
        let preparation_started = Instant::now();
        let exec_result = match self
            .exec_with_diagnostic_label(request, diagnostic_label)
            .await
        {
            Ok(exec_result) => {
                observer.record_stage(
                    SandboxFinalExecParkStage::ReusePreparation,
                    preparation_started.elapsed(),
                    true,
                );
                exec_result
            }
            Err(error) => {
                observer.record_stage(
                    SandboxFinalExecParkStage::ReusePreparation,
                    preparation_started.elapsed(),
                    false,
                );
                return Err(error);
            }
        };
        let handoff_point =
            handoff.and_then(|(signal, point)| signal.accept_if_requested().then_some(point));
        let physical_park_started = Instant::now();
        observer.record_substage(
            SandboxFinalExecParkSubstage::BalloonSetup,
            Duration::ZERO,
            true,
            match handoff_point {
                Some(SandboxFinalExecParkHandoffPoint::BeforeBalloon) => {
                    Some(SandboxFinalExecParkSubstageOutcome::HandoffRequested)
                }
                Some(SandboxFinalExecParkHandoffPoint::DuringBalloonSettle) => None,
                None => Some(SandboxFinalExecParkSubstageOutcome::Skipped),
            },
        );
        observer.record_substage(
            SandboxFinalExecParkSubstage::BalloonSettle,
            Duration::ZERO,
            true,
            Some(match handoff_point {
                Some(SandboxFinalExecParkHandoffPoint::DuringBalloonSettle) => {
                    SandboxFinalExecParkSubstageOutcome::HandoffRequested
                }
                Some(SandboxFinalExecParkHandoffPoint::BeforeBalloon) | None => {
                    SandboxFinalExecParkSubstageOutcome::Skipped
                }
            }),
        );
        let park_outcome = match self.park().await {
            Ok(park_outcome) => {
                observer.record_substage(
                    SandboxFinalExecParkSubstage::VcpuPause,
                    Duration::ZERO,
                    true,
                    None,
                );
                observer.record_stage(
                    SandboxFinalExecParkStage::PhysicalPark,
                    physical_park_started.elapsed(),
                    true,
                );
                park_outcome
            }
            Err(error) => {
                observer.record_substage(
                    SandboxFinalExecParkSubstage::VcpuPause,
                    Duration::ZERO,
                    false,
                    Some(SandboxFinalExecParkSubstageOutcome::Failed),
                );
                observer.record_stage(
                    SandboxFinalExecParkStage::PhysicalPark,
                    physical_park_started.elapsed(),
                    false,
                );
                return Err(error);
            }
        };
        if let Some(point) = handoff_point {
            if let Some(overrides) = &self.overrides {
                overrides
                    .lifecycle
                    .completed_final_exec_park_handoff_points
                    .lock_ignoring_poison()
                    .push(point);
            }
            Ok(SandboxFinalExecParkHandoffOutcome::Handoff { exec_result, point })
        } else {
            Ok(SandboxFinalExecParkHandoffOutcome::Parked(
                SandboxFinalExecParkOutcome {
                    exec_result,
                    park_outcome,
                },
            ))
        }
    }

    /// Queue an exec result. Results are consumed in FIFO order.
    pub fn push_exec_result(&self, result: Result<ExecResult>) {
        self.exec_results.lock_ignoring_poison().push_back(result);
    }

    /// Return this sandbox's recorded exec calls.
    ///
    /// The returned vector is a cloned snapshot in recorded order. When this
    /// sandbox was built with shared overrides, exec calls are also recorded in
    /// [`MockSandboxOverrides::exec_calls`].
    pub fn exec_calls(&self) -> Vec<ExecCall> {
        self.exec_calls.lock_ignoring_poison().clone()
    }

    /// Return this sandbox's recorded fixed storage-manifest calls.
    pub fn storage_manifest_calls(&self) -> Vec<StorageManifestCall> {
        self.storage_manifest_calls.lock_ignoring_poison().clone()
    }

    /// Queue a fixed workspace-drive mount result. Results are consumed in FIFO order.
    ///
    /// Local results, including errors, take precedence over shared overrides.
    /// Shared results are consumed only when this sandbox's queue is empty.
    pub fn push_workspace_drive_mount_result(&self, result: Result<ExecResult>) {
        self.workspace_drive_mount_results
            .lock_ignoring_poison()
            .push_back(result);
    }

    /// Return the total fixed workspace-drive mount calls.
    pub fn workspace_drive_mount_calls(&self) -> u32 {
        *self.workspace_drive_mount_calls.lock_ignoring_poison()
    }

    /// Return this sandbox's recorded fixed live identity verifier calls.
    pub fn session_history_identity_verify_calls(&self) -> Vec<SessionHistoryIdentityVerifyCall> {
        self.session_history_identity_verify_calls
            .lock_ignoring_poison()
            .clone()
    }

    /// Return this sandbox's recorded fixed reused-Codex cleanup calls.
    pub fn codex_session_cleanup_calls(&self) -> Vec<CodexSessionCleanupCall> {
        self.codex_session_cleanup_calls
            .lock_ignoring_poison()
            .clone()
    }

    /// Return this sandbox's recorded fixed guest-state restore calls.
    pub fn guest_state_restore_calls(&self) -> Vec<GuestStateRestoreCall> {
        self.guest_state_restore_calls
            .lock_ignoring_poison()
            .clone()
    }

    /// Queue a small file read result. Results are consumed in FIFO order.
    pub fn push_read_file_result(&self, result: Result<Option<Vec<u8>>>) {
        self.read_file_results
            .lock_ignoring_poison()
            .push_back(result);
    }

    /// Return this sandbox's recorded read-file calls.
    ///
    /// The returned vector is a cloned snapshot in recorded order. Calls are
    /// recorded before mock validation errors such as invalid guest paths,
    /// oversized `max_bytes`, or zero `max_bytes` are returned.
    pub fn read_file_calls(&self) -> Vec<ReadFileCall> {
        self.read_file_calls.lock_ignoring_poison().clone()
    }

    /// Queue bytes for a guest-to-host copy. The mock writes the bytes to the
    /// requested host path and returns the copied byte count.
    pub fn push_copy_file_result(&self, result: Result<Vec<u8>>) {
        self.copy_file_results
            .lock_ignoring_poison()
            .push_back(result);
    }

    /// Return this sandbox's recorded copy-file calls.
    ///
    /// The returned vector is a cloned snapshot in recorded order. Calls are
    /// recorded before mock validation errors such as invalid guest paths,
    /// oversized `max_bytes`, zero `max_bytes`, zero timeout, or invalid host
    /// paths are returned. When this sandbox was built with shared overrides,
    /// copy-file calls are also recorded in
    /// [`MockSandboxOverrides::copy_file_calls`].
    pub fn copy_file_calls(&self) -> Vec<CopyFileCall> {
        self.copy_file_calls.lock_ignoring_poison().clone()
    }

    /// Block every copy operation with a durable lifecycle gate.
    ///
    /// Calls are recorded and queued results are assigned before entering the
    /// gate, while host publication waits for release.
    pub fn set_copy_file_lifecycle_gate(&self, gate: MockLifecycleGate) {
        *self.copy_file_gate.lock_ignoring_poison() = Some(gate);
    }

    /// Queue a write-operation result.
    ///
    /// Results are consumed in FIFO order by both
    /// [`write_file`](Sandbox::write_file) and [`write_files`](Sandbox::write_files).
    /// When the queue is empty, valid operations return `Ok(())`.
    /// Each non-empty `write_files` invocation consumes one queued result for
    /// the whole batch, not one result per file. Empty batches are recorded but
    /// do not consume a result.
    pub fn push_write_file_result(&self, result: Result<()>) {
        self.write_file_results
            .lock_ignoring_poison()
            .push_back(result);
    }

    /// Return this sandbox's recorded write-file calls.
    ///
    /// The returned vector is a cloned snapshot in recorded order. Calls are
    /// recorded before mock guest-path validation. When this sandbox was built
    /// with shared overrides, write-file calls are also recorded in
    /// [`MockSandboxOverrides::write_file_calls`].
    pub fn write_file_calls(&self) -> Vec<WriteFileCall> {
        self.write_file_calls.lock_ignoring_poison().clone()
    }

    /// Return this sandbox's recorded write-files batch calls.
    ///
    /// Batch entries are also expanded into [`Self::write_file_calls`] so tests
    /// that only need path/content assertions can use one observation surface.
    /// That expansion is only for call recording: queued write results are
    /// consumed, and the write lifecycle gate is entered, per non-empty write
    /// operation rather than per expanded file entry. Invalid and empty batches
    /// remain recorded, but empty batches expand to no write-file calls and do
    /// not consume a result or enter the gate.
    pub fn write_files_calls(&self) -> Vec<WriteFilesCall> {
        self.write_files_calls.lock_ignoring_poison().clone()
    }

    /// Queue a write_private_file result. Results are consumed in FIFO order.
    /// When the queue is empty, a valid write_private_file returns `Ok(())`.
    pub fn push_private_write_file_result(&self, result: Result<()>) {
        self.private_write_file_results
            .lock_ignoring_poison()
            .push_back(result);
    }

    /// Return this sandbox's recorded private write-file calls.
    ///
    /// The returned vector is a cloned snapshot in recorded order. Calls are
    /// recorded before mock guest-path validation. When this sandbox was built
    /// with shared overrides, private write-file calls are also recorded in
    /// [`MockSandboxOverrides::private_write_file_calls`].
    pub fn private_write_file_calls(&self) -> Vec<WriteFileCall> {
        self.private_write_file_calls.lock_ignoring_poison().clone()
    }

    /// Queue a write_private_files result. Results are consumed in FIFO order.
    /// When the queue is empty, a valid non-empty private batch returns
    /// `Ok(())` unless a shared override result is available.
    pub fn push_private_write_files_result(&self, result: Result<()>) {
        self.private_write_files_results
            .lock_ignoring_poison()
            .push_back(result);
    }

    /// Return this sandbox's recorded private write-files batch calls.
    pub fn private_write_files_calls(&self) -> Vec<WriteFilesCall> {
        self.private_write_files_calls
            .lock_ignoring_poison()
            .clone()
    }

    /// Block every write operation with a durable lifecycle gate.
    ///
    /// Calls are recorded before they enter the gate, so tests can assert that a
    /// write was attempted while keeping the mock response pending. Both
    /// [`write_file`](Sandbox::write_file) and [`write_files`](Sandbox::write_files)
    /// enter this gate; non-empty `write_files` calls enter it once for the
    /// whole batch. Empty batches are recorded but do not enter the gate.
    pub fn set_write_file_lifecycle_gate(&self, gate: MockLifecycleGate) {
        *self.write_file_gate.lock_ignoring_poison() = Some(gate);
    }

    /// Remove the durable write-operation gate for future write operations.
    ///
    /// Already-entered writes keep waiting on their cloned gate until the test
    /// releases it.
    pub fn clear_write_file_lifecycle_gate(&self) {
        *self.write_file_gate.lock_ignoring_poison() = None;
    }

    async fn start_process_with_contract(
        &self,
        request: &StartProcessRequest<'_>,
        operation: SandboxOperation,
        controlled: bool,
    ) -> Result<GuestProcessHandle> {
        if let Some(overrides) = &self.overrides
            && let Some(error) = overrides
                .process
                .start_process_errors
                .lock_ignoring_poison()
                .pop_front()
        {
            return Err(error);
        }
        let (mut tx, rx) = match request.output {
            ProcessOutputMode::Stream { queue_capacity, .. } => {
                let (tx, rx) = tokio::sync::mpsc::channel(queue_capacity.max(1));
                (Some(tx), Some(rx))
            }
            ProcessOutputMode::Buffered { .. } => (None, None),
        };
        let mut stream_overflowed = false;
        if let Some(overrides) = &self.overrides {
            let chunks = overrides
                .process
                .start_process_stdout_chunks
                .lock_ignoring_poison()
                .pop_front();
            if let Some(chunks) = chunks {
                let Some(sender) = tx.as_ref() else {
                    return Err(SandboxError::Operation {
                        operation,
                        reason: SandboxOperationReason::Other,
                        message: "mock stdout chunks require streaming output".to_string(),
                    });
                };
                for chunk in chunks {
                    match sender.try_send(chunk) {
                        Ok(()) => {}
                        Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
                            stream_overflowed = true;
                            break;
                        }
                        Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                            return Err(SandboxError::Operation {
                                operation,
                                reason: SandboxOperationReason::Other,
                                message: "mock process stdout receiver closed during start"
                                    .to_string(),
                            });
                        }
                    }
                }
            }
        }
        if stream_overflowed {
            tx = None;
        }
        if self.overrides.as_ref().is_some_and(|overrides| {
            *overrides
                .process
                .keep_stdout_sender_open
                .lock_ignoring_poison()
        }) && let Some(tx) = tx.take()
        {
            *self.stdout_tx.lock_ignoring_poison() = Some(tx);
        }
        let process_control_supported = self.overrides.as_ref().is_none_or(|overrides| {
            *overrides
                .process
                .process_control_supported
                .lock_ignoring_poison()
        });
        let control = (controlled && process_control_supported).then(|| {
            let overrides = self.overrides.clone();
            GuestProcessControlHandle::new_with_outcome(move |message_id, payload, timeout| {
                let overrides = overrides.clone();
                Box::pin(async move {
                    if let Some(overrides) = overrides {
                        overrides
                            .process
                            .process_control_calls
                            .lock_ignoring_poison()
                            .push(ProcessControlCall {
                                message_id: message_id.clone(),
                                payload,
                                timeout,
                            });
                        overrides.process.process_control_notify.notify_waiters();
                        if let Some(outcome) = overrides
                            .process
                            .process_control_outcomes
                            .lock_ignoring_poison()
                            .pop_front()
                        {
                            return outcome;
                        }
                    }
                    ProcessControlOutcome::Delivered(ProcessControlAck { message_id })
                })
            })
        });
        let process_cancel = self.overrides.as_ref().and_then(|overrides| {
            if !*overrides
                .process
                .process_cancel_supported
                .lock_ignoring_poison()
            {
                return None;
            }
            let overrides = Arc::clone(overrides);
            Some(GuestProcessCancelHandle::new(move |timeout| {
                Box::pin(async move {
                    overrides
                        .process
                        .process_cancel_calls
                        .lock_ignoring_poison()
                        .push(ProcessCancelCall { timeout });
                    overrides.process.process_cancel_notify.notify_waiters();
                    if let Some(message) = overrides
                        .process
                        .process_cancel_errors
                        .lock_ignoring_poison()
                        .pop_front()
                    {
                        return Err(std::io::Error::other(message));
                    }
                    if *overrides
                        .process
                        .process_cancel_releases_wait_gate
                        .lock_ignoring_poison()
                    {
                        overrides.release_wait_process_gate();
                    }
                    Ok(())
                })
            }))
        });

        let mut handle = GuestProcessHandle::new(
            1,
            rx,
            control,
            GuestProcessWaiter::new(move |_timeout| {
                Box::pin(async move {
                    let mut exit = ProcessExit::new(1, 0, Vec::new(), Vec::new());
                    exit.stream_overflowed = stream_overflowed;
                    Ok(exit)
                })
            }),
        );
        if let Some(process_cancel) = process_cancel {
            handle = handle.with_cancel_handle(process_cancel);
        }
        if let Some(cancel) = self.overrides.as_ref().and_then(|overrides| {
            overrides
                .process
                .start_process_result_cancellations
                .lock_ignoring_poison()
                .pop_front()
        }) {
            cancel.cancel();
        }
        Ok(handle)
    }
}

fn default_exec_result() -> ExecResult {
    ExecResult::new(0, Vec::new(), Vec::new())
}

fn apply_exec_output_limits(mut result: ExecResult, limits: ExecOutputLimits) -> ExecResult {
    if result.stdout.len() > limits.stdout_limit_bytes as usize {
        result.stdout.truncate(limits.stdout_limit_bytes as usize);
        result.stdout_truncated = true;
    }
    if result.stderr.len() > limits.stderr_limit_bytes as usize {
        result.stderr.truncate(limits.stderr_limit_bytes as usize);
        result.stderr_truncated = true;
    }
    result
}

#[async_trait]
impl Sandbox for MockSandbox {
    fn id(&self) -> &str {
        &self.id
    }

    fn source_ip(&self) -> &str {
        &self.source_ip
    }

    fn bind_run_control(&mut self, run_id: &str) -> Result<()> {
        if self.run_control_id.is_some() {
            return Err(SandboxError::InvalidState {
                context: SandboxInvalidStateContext::Sandbox,
                state: "active".into(),
                message: "run control identity is already bound".into(),
            });
        }
        self.run_control_id = Some(run_id.to_owned());
        if let Some(overrides) = &self.overrides {
            overrides
                .lifecycle
                .run_control_bind_calls
                .lock_ignoring_poison()
                .push(run_id.to_owned());
        }
        Ok(())
    }

    async fn start(&mut self) -> Result<()> {
        let Some(o) = &self.overrides else {
            return Ok(());
        };
        o.lifecycle
            .start_run_control_ids
            .lock_ignoring_poison()
            .push(self.run_control_id.clone());
        wait_lifecycle_gate(&o.lifecycle.start_gate).await;
        o.lifecycle
            .start_results
            .lock_ignoring_poison()
            .pop_front()
            .unwrap_or(Ok(()))
    }

    async fn stop(&mut self) -> Result<()> {
        let Some(o) = &self.overrides else {
            return Ok(());
        };
        *o.lifecycle.stop_calls.lock_ignoring_poison() += 1;
        wait_lifecycle_gate(&o.lifecycle.stop_gate).await;
        o.lifecycle.stop_behaviors.next_result(())
    }

    async fn kill(&mut self) -> Result<()> {
        let Some(o) = &self.overrides else {
            return Ok(());
        };
        *o.lifecycle.kill_calls.lock_ignoring_poison() += 1;
        wait_lifecycle_gate(&o.lifecycle.kill_gate).await;
        o.lifecycle.kill_behaviors.next_result(())
    }

    /// Mock park: bumps the override `park_calls` counter on every call (so
    /// tests can assert exact invocation counts) and consumes one queued
    /// result (FIFO). Empty queue → reusable. The trait's idempotency
    /// requirement is satisfied in practice because the default-Ok behavior
    /// is side-effect-free; tests that need to exercise non-idempotent
    /// scenarios queue explicit results.
    async fn park(&mut self) -> Result<SandboxParkOutcome> {
        let result = if let Some(o) = &self.overrides {
            *o.lifecycle.park_calls.lock_ignoring_poison() += 1;
            wait_lifecycle_gate(&o.lifecycle.park_gate).await;
            o.lifecycle
                .park_behaviors
                .next_result(SandboxParkOutcome::Reusable)
        } else {
            Ok(SandboxParkOutcome::Reusable)
        };
        if result.is_ok() {
            self.run_control_id = None;
        }
        result
    }

    async fn park_for_blank_pool(&mut self) -> Result<SandboxParkOutcome> {
        if let Some(o) = &self.overrides {
            *o.lifecycle.blank_park_calls.lock_ignoring_poison() += 1;
        }
        self.park().await
    }

    async fn final_exec_and_park(
        &mut self,
        request: &ExecRequest<'_>,
        diagnostic_label: &'static str,
    ) -> Result<SandboxFinalExecParkOutcome> {
        let exec_result = self
            .exec_with_diagnostic_label(request, diagnostic_label)
            .await?;
        let park_outcome = self.park().await?;
        Ok(SandboxFinalExecParkOutcome {
            exec_result,
            park_outcome,
        })
    }

    async fn final_exec_and_park_with_observer(
        &mut self,
        request: &ExecRequest<'_>,
        diagnostic_label: &'static str,
        observer: &mut dyn SandboxFinalExecParkObserver,
    ) -> Result<SandboxFinalExecParkOutcome> {
        match self
            .final_exec_and_park_with_observer_and_handoff(
                request,
                diagnostic_label,
                None,
                observer,
            )
            .await?
        {
            SandboxFinalExecParkHandoffOutcome::Parked(outcome) => Ok(outcome),
            SandboxFinalExecParkHandoffOutcome::Handoff { .. } => {
                Err(SandboxError::IdleTransition {
                    transition: SandboxIdleTransition::Park,
                    message: "mock accepted a handoff without a handoff signal".into(),
                })
            }
        }
    }

    async fn final_exec_and_park_for_handoff(
        &mut self,
        request: &ExecRequest<'_>,
        diagnostic_label: &'static str,
        handoff: &SandboxFinalExecParkHandoff,
        observer: &mut dyn SandboxFinalExecParkObserver,
    ) -> Result<SandboxFinalExecParkHandoffOutcome> {
        let point = self.overrides.as_ref().and_then(|overrides| {
            overrides
                .lifecycle
                .final_exec_park_handoff_points
                .lock_ignoring_poison()
                .pop_front()
        });
        self.final_exec_and_park_with_observer_and_handoff(
            request,
            diagnostic_label,
            point.map(|point| (handoff, point)),
            observer,
        )
        .await
    }

    /// Mock unpark: counter + queued-result semantics mirror [`park`]
    /// exactly. See [`park`] for details.
    ///
    /// [`park`]: Self::park
    async fn unpark(&mut self) -> Result<()> {
        let Some(o) = &self.overrides else {
            return Ok(());
        };
        o.lifecycle
            .unpark_run_control_ids
            .lock_ignoring_poison()
            .push(self.run_control_id.clone());
        *o.lifecycle.unpark_calls.lock_ignoring_poison() += 1;
        wait_lifecycle_gate(&o.lifecycle.unpark_gate).await;
        o.lifecycle.unpark_behaviors.next_result(())
    }

    async fn unpark_for_terminal_operations(&mut self) -> Result<()> {
        if let Some(o) = &self.overrides {
            *o.lifecycle.terminal_unpark_calls.lock_ignoring_poison() += 1;
        }
        self.unpark().await
    }

    async fn exec(&self, request: &ExecRequest<'_>) -> Result<ExecResult> {
        validate_mock_exec_env_keys(SandboxOperation::Exec, request.env)?;
        let call = ExecCall {
            cmd: request.cmd.to_string(),
            timeout: request.timeout,
            env_keys: request
                .env
                .iter()
                .map(|(key, _)| (*key).to_string())
                .collect(),
            sudo: request.sudo,
            expected_exit_codes: request.expected_exit_codes.to_vec(),
            stdin_bytes: request.stdin_bytes.map(Vec::from),
            output_limits: request.output_limits,
        };
        self.exec_calls.lock_ignoring_poison().push(call.clone());
        if let Some(overrides) = &self.overrides {
            overrides.exec.calls.lock_ignoring_poison().push(call);
            overrides.exec.call_notify.notify_waiters();
            wait_lifecycle_gate(&overrides.exec.lifecycle_gate).await;
        }
        // Check pattern matchers before the FIFO queue.
        let result = if let Some(overrides) = &self.overrides {
            let matched = {
                let mut matchers = overrides.exec.matchers.lock_ignoring_poison();
                matchers
                    .iter()
                    .position(|matcher| request.cmd.contains(&matcher.pattern))
                    .map(|index| matchers.remove(index).outcome)
            };
            match matched {
                Some(ExecMatcherOutcome::Return(result)) => Ok(result),
                Some(ExecMatcherOutcome::Error(error)) => Err(error),
                Some(ExecMatcherOutcome::Panic(message)) => {
                    std::panic::resume_unwind(Box::new(message))
                }
                None => {
                    if let Some(matcher) = overrides
                        .exec
                        .persistent_matchers
                        .lock_ignoring_poison()
                        .iter()
                        .find(|matcher| request.cmd.contains(&matcher.pattern))
                    {
                        Ok(clone_exec_result(&matcher.result))
                    } else {
                        self.exec_results
                            .lock_ignoring_poison()
                            .pop_front()
                            .unwrap_or_else(|| Ok(default_exec_result()))
                    }
                }
            }
        } else {
            self.exec_results
                .lock_ignoring_poison()
                .pop_front()
                .unwrap_or_else(|| Ok(default_exec_result()))
        }?;
        Ok(apply_exec_output_limits(result, request.output_limits))
    }

    async fn apply_storage_manifest(
        &self,
        request: &StorageManifestRequest<'_>,
    ) -> Result<ExecResult> {
        let call = StorageManifestCall {
            manifest_json: request.manifest_json.to_vec(),
            run_id: request.run_id.to_string(),
            runtime_dir: request.runtime_dir.to_string(),
            timeout: request.timeout,
        };
        self.storage_manifest_calls
            .lock_ignoring_poison()
            .push(call.clone());
        if let Some(overrides) = &self.overrides {
            overrides
                .exec
                .storage_manifest_calls
                .lock_ignoring_poison()
                .push(call);
            wait_lifecycle_gate(&overrides.exec.storage_manifest_gate).await;
        }
        let result = self
            .exec_results
            .lock_ignoring_poison()
            .pop_front()
            .or_else(|| {
                self.overrides.as_ref().and_then(|overrides| {
                    overrides
                        .exec
                        .storage_manifest_results
                        .lock_ignoring_poison()
                        .pop_front()
                })
            })
            .unwrap_or_else(|| Ok(default_exec_result()))?;
        Ok(apply_exec_output_limits(result, EXEC_OUTPUT_LIMIT_1_MIB))
    }

    async fn mount_workspace_drive(&self) -> Result<ExecResult> {
        *self.workspace_drive_mount_calls.lock_ignoring_poison() += 1;
        if let Some(overrides) = &self.overrides {
            *overrides
                .exec
                .workspace_drive_mount_calls
                .lock_ignoring_poison() += 1;
            overrides
                .exec
                .workspace_drive_mount_call_notify
                .notify_waiters();
            wait_lifecycle_gate(&overrides.exec.workspace_drive_mount_lifecycle_gate).await;
        }
        let local_result = self
            .workspace_drive_mount_results
            .lock_ignoring_poison()
            .pop_front();
        let result = local_result
            .or_else(|| {
                self.overrides.as_ref().and_then(|overrides| {
                    overrides
                        .exec
                        .workspace_drive_mount_results
                        .lock_ignoring_poison()
                        .pop_front()
                })
            })
            .unwrap_or_else(|| Ok(default_exec_result()))?;
        Ok(apply_exec_output_limits(result, EXEC_OUTPUT_LIMIT_64_KIB))
    }

    async fn verify_session_history_identity(
        &self,
        request: &SessionHistoryIdentityVerifyRequest<'_>,
    ) -> Result<ExecResult> {
        let call = SessionHistoryIdentityVerifyCall {
            metadata_path: request.metadata_path.to_owned(),
            runtime_dir: request.runtime_dir.to_owned(),
            framework: request.framework.to_owned(),
            session_id_hash: request.session_id_hash.to_owned(),
            history_ref_kind: request.history_ref_kind.to_owned(),
            history_hash: request.history_hash.to_owned(),
            history_size_bytes: request.history_size_bytes,
            timeout: request.timeout,
        };
        self.session_history_identity_verify_calls
            .lock_ignoring_poison()
            .push(call.clone());
        if let Some(overrides) = &self.overrides {
            overrides
                .exec
                .session_history_identity_verify_calls
                .lock_ignoring_poison()
                .push(call);
        }
        let result = self
            .exec_results
            .lock_ignoring_poison()
            .pop_front()
            .unwrap_or_else(|| Ok(default_exec_result()))?;
        Ok(apply_exec_output_limits(result, EXEC_OUTPUT_LIMIT_64_KIB))
    }

    async fn cleanup_codex_session(
        &self,
        request: &CodexSessionCleanupRequest<'_>,
    ) -> Result<ExecResult> {
        let call = CodexSessionCleanupCall {
            session_id: request.session_id.to_owned(),
            fallback_relative_path: request.fallback_relative_path.to_owned(),
            timeout: request.timeout,
        };
        self.codex_session_cleanup_calls
            .lock_ignoring_poison()
            .push(call.clone());
        if let Some(overrides) = &self.overrides {
            overrides
                .exec
                .codex_session_cleanup_calls
                .lock_ignoring_poison()
                .push(call);
        }
        let result = self
            .exec_results
            .lock_ignoring_poison()
            .pop_front()
            .unwrap_or_else(|| Ok(default_exec_result()))?;
        Ok(apply_exec_output_limits(result, EXEC_OUTPUT_LIMIT_64_KIB))
    }

    async fn restore_guest_state(
        &self,
        request: &GuestStateRestoreRequest<'_>,
    ) -> Result<ExecResult> {
        let timezone = match request.timezone {
            GuestStateRestoreTimezone::None => GuestStateRestoreTimezoneCall::None,
            GuestStateRestoreTimezone::BestEffort(timezone) => {
                GuestStateRestoreTimezoneCall::BestEffort(timezone.to_owned())
            }
            GuestStateRestoreTimezone::Required(timezone) => {
                GuestStateRestoreTimezoneCall::Required(timezone.to_owned())
            }
        };
        let call = GuestStateRestoreCall {
            unix_seconds: request.unix_seconds,
            unix_nanoseconds: request.unix_nanoseconds,
            entropy_len: request.entropy.len(),
            timezone,
            timeout: request.timeout,
        };
        self.guest_state_restore_calls
            .lock_ignoring_poison()
            .push(call.clone());
        if let Some(overrides) = &self.overrides {
            overrides
                .exec
                .guest_state_restore_calls
                .lock_ignoring_poison()
                .push(call);
            overrides
                .exec
                .guest_state_restore_call_notify
                .notify_waiters();
        }
        let result = self
            .exec_results
            .lock_ignoring_poison()
            .pop_front()
            .or_else(|| {
                self.overrides.as_ref().and_then(|overrides| {
                    let behavior = overrides
                        .exec
                        .guest_state_restore_behaviors
                        .lock_ignoring_poison()
                        .pop_front();
                    behavior.map(GuestStateRestoreBehavior::into_result)
                })
            })
            .unwrap_or_else(|| Ok(default_exec_result()))?;
        Ok(apply_exec_output_limits(result, EXEC_OUTPUT_LIMIT_64_KIB))
    }

    async fn read_file(&self, path: &str, max_bytes: u64) -> Result<Option<Vec<u8>>> {
        self.read_file_calls
            .lock_ignoring_poison()
            .push(ReadFileCall {
                path: path.to_string(),
                max_bytes,
            });
        validate_mock_guest_file_path(SandboxOperation::ReadFile, "read_file", path)?;
        if max_bytes > u64::from(u32::MAX) {
            return Err(SandboxError::Operation {
                operation: SandboxOperation::ReadFile,
                reason: SandboxOperationReason::Other,
                message: "mock read_file max_bytes exceeds exec capture limit".into(),
            });
        }
        if max_bytes == 0 {
            return Err(SandboxError::Operation {
                operation: SandboxOperation::ReadFile,
                reason: SandboxOperationReason::Other,
                message: "mock read_file max_bytes must be positive".into(),
            });
        }

        let result = self
            .read_file_results
            .lock_ignoring_poison()
            .pop_front()
            .or_else(|| {
                self.overrides.as_ref().and_then(|overrides| {
                    overrides
                        .file
                        .read_file_results
                        .lock_ignoring_poison()
                        .pop_front()
                })
            })
            .unwrap_or(Ok(None))?;
        if let Some(bytes) = &result
            && bytes.len() as u64 > max_bytes
        {
            return Err(SandboxError::Operation {
                operation: SandboxOperation::ReadFile,
                reason: SandboxOperationReason::Other,
                message: format!("mock read_file exceeded {max_bytes} bytes"),
            });
        }
        Ok(result)
    }

    async fn copy_file(
        &self,
        path: &str,
        host_path: &Path,
        options: CopyFileOptions,
    ) -> Result<CopyFileResult> {
        let call = CopyFileCall {
            path: path.to_string(),
            host_path: host_path.to_path_buf(),
            max_bytes: options.max_bytes,
            timeout: options.timeout,
            missing_ok: options.missing_ok,
        };
        self.copy_file_calls
            .lock_ignoring_poison()
            .push(call.clone());
        if let Some(overrides) = &self.overrides {
            overrides
                .file
                .copy_file_calls
                .lock_ignoring_poison()
                .push(call);
        }
        validate_mock_guest_file_path(SandboxOperation::CopyFile, "copy_file", path)?;
        validate_mock_copy_host_path(host_path)?;
        if options.max_bytes == 0 {
            return Err(SandboxError::Operation {
                operation: SandboxOperation::CopyFile,
                reason: SandboxOperationReason::Other,
                message: "mock copy_file max_bytes must be positive".into(),
            });
        }
        if options.max_bytes > MOCK_COPY_FILE_MAX_BYTES {
            return Err(SandboxError::Operation {
                operation: SandboxOperation::CopyFile,
                reason: SandboxOperationReason::Other,
                message: format!(
                    "mock copy_file max_bytes must be at most {MOCK_COPY_FILE_MAX_BYTES}"
                ),
            });
        }
        if options.timeout.is_zero() {
            return Err(SandboxError::Operation {
                operation: SandboxOperation::CopyFile,
                reason: SandboxOperationReason::Other,
                message: "mock copy_file timeout must be positive".into(),
            });
        }

        let queued = self
            .copy_file_results
            .lock_ignoring_poison()
            .pop_front()
            .or_else(|| {
                self.overrides.as_ref().and_then(|overrides| {
                    overrides
                        .file
                        .copy_file_results
                        .lock_ignoring_poison()
                        .pop_front()
                })
            });
        let gate = self
            .copy_file_gate
            .lock_ignoring_poison()
            .clone()
            .or_else(|| {
                self.overrides.as_ref().and_then(|overrides| {
                    overrides.file.copy_file_gate.lock_ignoring_poison().clone()
                })
            });
        if let Some(gate) = gate {
            gate.enter_and_wait().await;
        }
        let bytes = match queued {
            Some(result) => result?,
            None if options.missing_ok => {
                return Ok(CopyFileResult { bytes_copied: 0 });
            }
            None => Vec::new(),
        };
        if bytes.len() as u64 > options.max_bytes {
            return Err(SandboxError::Operation {
                operation: SandboxOperation::CopyFile,
                reason: SandboxOperationReason::Other,
                message: format!("mock copy_file exceeded {} bytes", options.max_bytes),
            });
        }
        if let Some(parent) = host_path.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent)?;
        }
        let parent = host_path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let mut temp_file = tempfile::NamedTempFile::new_in(parent)?;
        #[cfg(unix)]
        temp_file
            .as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))?;
        temp_file.write_all(&bytes)?;
        temp_file.flush()?;
        temp_file.persist(host_path).map_err(|error| error.error)?;
        Ok(CopyFileResult {
            bytes_copied: bytes.len() as u64,
        })
    }

    async fn write_file(&self, path: &str, content: &[u8]) -> Result<()> {
        self.write_file_with_compression(path, content, sandbox::FileCompression::None)
            .await
            .map(|_| ())
    }

    async fn write_file_with_compression(
        &self,
        path: &str,
        content: &[u8],
        compression: sandbox::FileCompression,
    ) -> Result<Option<sandbox::FileWriteMeasurements>> {
        let call = WriteFileCall {
            compression,
            path: path.to_string(),
            content: content.to_vec(),
        };
        self.write_file_calls
            .lock_ignoring_poison()
            .push(call.clone());
        if let Some(overrides) = &self.overrides {
            overrides
                .file
                .write_file_calls
                .lock_ignoring_poison()
                .push(call);
        }
        validate_mock_guest_file_path(SandboxOperation::WriteFile, "write_file", path)?;
        let gate = self.write_file_gate.lock_ignoring_poison().clone();
        if let Some(gate) = gate {
            gate.enter_and_wait().await;
        }
        self.write_file_results
            .lock_ignoring_poison()
            .pop_front()
            .unwrap_or(Ok(()))
            .map(|()| None)
    }

    async fn write_files(&self, files: &[WriteFileEntry<'_>]) -> Result<()> {
        let calls = files
            .iter()
            .map(|file| WriteFileCall {
                compression: sandbox::FileCompression::None,
                path: file.path.to_string(),
                content: file.content.to_vec(),
            })
            .collect::<Vec<_>>();
        let batch_call = WriteFilesCall {
            files: calls.clone(),
        };
        self.write_files_calls
            .lock_ignoring_poison()
            .push(batch_call.clone());
        self.write_file_calls
            .lock_ignoring_poison()
            .extend(calls.clone());
        if let Some(overrides) = &self.overrides {
            overrides
                .file
                .write_files_calls
                .lock_ignoring_poison()
                .push(batch_call);
            overrides
                .file
                .write_file_calls
                .lock_ignoring_poison()
                .extend(calls);
        }
        if files.is_empty() {
            return Ok(());
        }
        for file in files {
            validate_mock_guest_file_path(SandboxOperation::WriteFile, "write_files", file.path)?;
        }
        let gate = self.write_file_gate.lock_ignoring_poison().clone();
        if let Some(gate) = gate {
            gate.enter_and_wait().await;
        }
        self.write_file_results
            .lock_ignoring_poison()
            .pop_front()
            .unwrap_or(Ok(()))
    }

    async fn write_private_file(&self, path: &str, content: &[u8]) -> Result<()> {
        if let Some(overrides) = &self.overrides {
            wait_lifecycle_gate(&overrides.file.private_write_file_gate).await;
        }
        let call = WriteFileCall {
            compression: sandbox::FileCompression::None,
            path: path.to_string(),
            content: content.to_vec(),
        };
        self.private_write_file_calls
            .lock_ignoring_poison()
            .push(call.clone());
        if let Some(overrides) = &self.overrides {
            overrides
                .file
                .private_write_file_calls
                .lock_ignoring_poison()
                .push(call);
        }
        validate_mock_guest_file_path(SandboxOperation::WriteFile, "write_private_file", path)?;
        if let Some(result) = self
            .private_write_file_results
            .lock_ignoring_poison()
            .pop_front()
        {
            return result;
        }
        if let Some(result) = self.overrides.as_ref().and_then(|overrides| {
            overrides
                .file
                .private_write_file_results
                .lock_ignoring_poison()
                .pop_front()
        }) {
            return result;
        }
        Ok(())
    }

    async fn write_private_files(&self, files: &[WriteFileEntry<'_>]) -> Result<()> {
        if files.is_empty() {
            return Ok(());
        }
        if let Some(overrides) = &self.overrides {
            wait_lifecycle_gate(&overrides.file.private_write_file_gate).await;
        }
        let batch_call = WriteFilesCall {
            files: files
                .iter()
                .map(|file| WriteFileCall {
                    compression: sandbox::FileCompression::None,
                    path: file.path.to_string(),
                    content: file.content.to_vec(),
                })
                .collect(),
        };
        self.private_write_files_calls
            .lock_ignoring_poison()
            .push(batch_call.clone());
        if let Some(overrides) = &self.overrides {
            overrides
                .file
                .private_write_files_calls
                .lock_ignoring_poison()
                .push(batch_call);
        }
        for file in files {
            validate_mock_guest_file_path(
                SandboxOperation::WriteFile,
                "write_private_files",
                file.path,
            )?;
        }
        if let Some(result) = self
            .private_write_files_results
            .lock_ignoring_poison()
            .pop_front()
        {
            return result;
        }
        if let Some(result) = self.overrides.as_ref().and_then(|overrides| {
            overrides
                .file
                .private_write_files_results
                .lock_ignoring_poison()
                .pop_front()
        }) {
            return result;
        }
        Ok(())
    }

    async fn start_process(&self, request: &StartProcessRequest<'_>) -> Result<GuestProcessHandle> {
        if let Some(overrides) = &self.overrides {
            wait_lifecycle_gate(&overrides.process.start_process_lifecycle_gate).await;
        }
        let operation = SandboxOperation::StartProcess;
        validate_mock_exec_env_keys(operation, request.env)?;
        request.output.validate(operation)?;
        if let Some(overrides) = &self.overrides {
            overrides
                .process
                .start_process_calls
                .lock_ignoring_poison()
                .push(StartProcessCall {
                    timeout_is_expected: request.timeout_is_expected,
                    cmd: request.cmd.to_string(),
                    timeout: request.timeout,
                    start_timeout: request.start_timeout,
                    env: request
                        .env
                        .iter()
                        .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
                        .collect(),
                    sudo: request.sudo,
                    output: request.output,
                });
        }
        self.start_process_with_contract(request, operation, false)
            .await
    }

    async fn start_agent_process(
        &self,
        request: &StartAgentProcessRequest<'_>,
    ) -> Result<GuestAgentProcessHandle> {
        if let Some(overrides) = &self.overrides {
            wait_lifecycle_gate(&overrides.process.start_process_lifecycle_gate).await;
        }
        let operation = SandboxOperation::StartAgentProcess;
        validate_mock_exec_env_keys(operation, request.env)?;
        request.output.validate(operation)?;
        if let Some(overrides) = &self.overrides {
            overrides
                .process
                .start_agent_process_calls
                .lock_ignoring_poison()
                .push(StartAgentProcessCall {
                    timeout: request.timeout,
                    env: request
                        .env
                        .iter()
                        .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
                        .collect(),
                    output: request.output,
                });
        }
        let process_request = StartProcessRequest {
            timeout_is_expected: false,
            cmd: "",
            timeout: request.timeout,
            start_timeout: DEFAULT_PROCESS_START_TIMEOUT,
            env: request.env,
            sudo: false,
            output: request.output,
        };
        let process = self
            .start_process_with_contract(&process_request, operation, true)
            .await?;
        let ready_at = Instant::now();
        GuestAgentProcessHandle::try_from_process(
            process,
            GuestAgentStartTiming {
                shell_started_at: ready_at,
                ready_at,
                containment_create: Duration::ZERO,
                placement_broker_setup: Duration::ZERO,
                shell_spawn: Duration::ZERO,
                bootstrap_ready_wait: Duration::ZERO,
            },
        )
    }

    async fn wait_process(
        &self,
        mut handle: GuestProcessHandle,
        timeout: Duration,
    ) -> Result<ProcessExit> {
        let Some(waiter) = handle.take_waiter() else {
            return Err(SandboxError::Operation {
                operation: SandboxOperation::WaitProcess,
                reason: SandboxOperationReason::Other,
                message: "start_process handle already consumed".to_string(),
            });
        };
        // `wait_process` consumes the handle; an unclaimed stream receiver can no
        // longer be observed by the caller and would otherwise buffer forever.
        handle.drop_unclaimed_stdout();

        if let Some(overrides) = &self.overrides {
            overrides
                .process
                .wait_process_calls
                .lock_ignoring_poison()
                .push(WaitProcessCall { timeout });
            // Block until the test signals (gives a window for cancellation).
            overrides.wait_for_wait_process_gate().await;
            // Return error when configured (simulates timeout or crash).
            if let Some(ref msg) = overrides.process.wait_process_error {
                return Err(SandboxError::Operation {
                    operation: SandboxOperation::WaitProcess,
                    reason: overrides.process.wait_process_error_reason,
                    message: msg.clone(),
                });
            }
        }
        let observed_exit =
            waiter
                .wait(timeout)
                .await
                .map_err(|error| SandboxError::Operation {
                    operation: SandboxOperation::WaitProcess,
                    reason: SandboxOperationReason::Other,
                    message: error.to_string(),
                })?;
        let observed_stream_overflowed = observed_exit.stream_overflowed;
        let mut exit = if let Some(overrides) = &self.overrides {
            // Return override exit code when configured.
            if let Some(code) = overrides.process.wait_process_code {
                ProcessExit::new(handle.guest_pid, code, Vec::new(), Vec::new())
            } else if let Some(exit) = overrides
                .process
                .wait_process_exits
                .lock_ignoring_poison()
                .pop_front()
            {
                exit
            } else {
                observed_exit
            }
        } else {
            observed_exit
        };
        exit.stream_overflowed |= observed_stream_overflowed;
        if let Some(cancel) = self.overrides.as_ref().and_then(|overrides| {
            overrides
                .process
                .wait_process_result_cancellations
                .lock_ignoring_poison()
                .pop_front()
        }) {
            cancel.cancel();
        }
        Ok(exit)
    }
}

fn clone_exec_result(result: &ExecResult) -> ExecResult {
    ExecResult {
        termination: result.termination,
        guest_duration_ms: result.guest_duration_ms,
        stdout: result.stdout.clone(),
        stderr: result.stderr.clone(),
        diagnostic: result.diagnostic.clone(),
        stdout_truncated: result.stdout_truncated,
        stderr_truncated: result.stderr_truncated,
    }
}
