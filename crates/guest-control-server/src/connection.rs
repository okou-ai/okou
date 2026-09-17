use std::io::{self, Read};
use std::os::unix::net::UnixStream;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use guest_contracts::exec_terminal::EXEC_OUTPUT_DRAIN_DEADLINE;
use guest_control_proto::{
    self, BorrowedRawMessage, DecodeWithError, MSG_EXEC_CANCEL, MSG_EXEC_CONTROL, MSG_EXEC_START,
    MSG_FILE_WRITE_STATUS, MSG_FILE_WRITE_STATUS_RESULT, MSG_GUEST_DNS_READINESS,
    MSG_GUEST_STATE_RESTORE, MSG_GUEST_STORAGE_MANIFEST, MSG_MEMORY_SNAPSHOT,
    MSG_MEMORY_SNAPSHOT_RESULT, MSG_OPERATIONS_QUIESCED, MSG_OPERATIONS_RESUMED,
    MSG_QUIESCE_OPERATIONS, MSG_READY, MSG_RESUME_OPERATIONS, MSG_WORKSPACE_DRIVE_MOUNT,
    MSG_WRITE_FILE, MSG_WRITE_FILES, MSG_WRITE_PRIVATE_FILES,
};

use crate::agent_command::GuestAgentProgram;
use crate::error::to_io_error;
use crate::exec_control::{ExecControlRegistry, handle_decoded_exec_control as route_exec_control};
use crate::exec_operation::{
    ExecOperationRegistry, ExecOperationWorkerRequest, cancel_exec_operation, send_error_response,
    start_exec_operation,
};
use crate::file_write_worker::{FileWriteKind, FileWriteSubmitError, FileWriteWorker};
use crate::guest_dns_readiness::{
    GuestDnsReadinessProgram, GuestDnsReadinessSubmitError, GuestDnsReadinessWorker,
};
use crate::guest_state_restore::{
    GuestStateRestoreProgram, GuestStateRestoreSubmission, GuestStateRestoreSubmitError,
    GuestStateRestoreWorker,
};
use crate::guest_storage_manifest::{
    GuestStorageManifestProgram, GuestStorageManifestSubmission, GuestStorageManifestSubmitError,
    GuestStorageManifestWorker,
};
use crate::handlers::{MessageOutcome, handle_basic_message};
use crate::log::log;
use crate::memory_snapshot::MeminfoSource;
use crate::process_containment::{ProcessContainmentMode, verify_exec_process_containment_empty};
use crate::quiesce::{AcquireOperationError, OperationGuard, OperationState, QuiesceResult};
use crate::workspace_drive_mount::{
    WorkspaceDriveMountProgram, WorkspaceDriveMountSubmitError, WorkspaceDriveMountWorker,
};
use crate::writer::GuestWriter;

// Vsock constants (only used on Linux)
#[cfg(target_os = "linux")]
const VSOCK_CID_HOST: u32 = 2;

/// Read buffer size for the connection event loop (local tuning constant).
const READ_BUFFER_SIZE: usize = 64 * 1024; // 64KB
enum ConnectionEnd {
    Closed { stable: bool },
    Shutdown,
}

struct ConnectionFailure {
    error: io::Error,
    stable: bool,
}

enum ReconnectFailure {
    Closed,
    Error(io::Error),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DispatchOutcome {
    Continue,
    Shutdown,
}

enum DecodeDispatchError {
    Dispatch(io::Error),
    Shutdown,
}

/// Signals all operation work spawned for this host connection when the
/// connection loop exits. `run()` may reconnect after a close, but in-flight
/// work belongs to the old connection and must not survive into the next one.
struct ConnectionCancelGuard(Arc<AtomicBool>);

impl Drop for ConnectionCancelGuard {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

struct ConnectionSession {
    started_at: Instant,
    handled_real_host_work: bool,
}

impl ConnectionSession {
    fn new() -> Self {
        Self {
            started_at: Instant::now(),
            handled_real_host_work: false,
        }
    }

    fn mark_real_host_work(&mut self, msg_type: u8) {
        if is_real_host_work_message(msg_type) {
            self.handled_real_host_work = true;
        }
    }

    fn is_stable(&self) -> bool {
        connection_is_stable(self.started_at.elapsed(), self.handled_real_host_work)
    }

    fn closed(&self) -> ConnectionEnd {
        ConnectionEnd::Closed {
            stable: self.is_stable(),
        }
    }

    fn failure(&self, error: io::Error) -> ConnectionFailure {
        ConnectionFailure {
            error,
            stable: self.is_stable(),
        }
    }
}

fn unstable_connection_failure(error: io::Error) -> ConnectionFailure {
    ConnectionFailure {
        error,
        stable: false,
    }
}

fn connection_is_stable(elapsed: Duration, handled_real_host_work: bool) -> bool {
    handled_real_host_work || elapsed >= STABLE_CONNECTION_MIN_DURATION
}

fn is_real_host_work_message(msg_type: u8) -> bool {
    matches!(
        msg_type,
        MSG_EXEC_START
            | MSG_EXEC_CANCEL
            | MSG_EXEC_CONTROL
            | MSG_WRITE_FILE
            | guest_control_proto::MSG_WRITE_FILE_STREAM_BEGIN
            | MSG_WRITE_FILES
            | MSG_WRITE_PRIVATE_FILES
            | MSG_GUEST_DNS_READINESS
            | MSG_GUEST_STATE_RESTORE
            | MSG_GUEST_STORAGE_MANIFEST
            | MSG_WORKSPACE_DRIVE_MOUNT
            | MSG_QUIESCE_OPERATIONS
            | MSG_RESUME_OPERATIONS
            | MSG_MEMORY_SNAPSHOT
    )
}

fn acquire_operation_guard(
    operation_state: &OperationState,
    seq: u32,
    writer: &GuestWriter,
) -> io::Result<Option<OperationGuard>> {
    match operation_state.acquire() {
        Ok(guard) => Ok(Some(guard)),
        Err(AcquireOperationError::Quiescing) => {
            send_error_response(seq, "guest operations are quiescing", writer)?;
            Ok(None)
        }
    }
}

fn reject_operation_if_quiescing(
    operation_state: &OperationState,
    seq: u32,
    writer: &GuestWriter,
) -> io::Result<bool> {
    if operation_state.is_quiescing() {
        send_error_response(seq, "guest operations are quiescing", writer)?;
        Ok(true)
    } else {
        Ok(false)
    }
}

fn require_non_zero_sequence(
    seq: u32,
    operation_name: &'static str,
    writer: &GuestWriter,
) -> io::Result<bool> {
    if seq == 0 {
        send_error_response(
            0,
            &format!("{operation_name} requires non-zero sequence"),
            writer,
        )?;
        Ok(false)
    } else {
        Ok(true)
    }
}

fn send_empty_response(msg_type: u8, seq: u32, writer: &GuestWriter) -> io::Result<()> {
    let response = guest_control_proto::encode(msg_type, seq, &[]).map_err(to_io_error)?;
    writer.write_frame(&response)
}

fn validate_empty_control_payload(
    seq: u32,
    payload_name: &'static str,
    payload: &[u8],
    writer: &GuestWriter,
) -> io::Result<bool> {
    match guest_control_proto::decode_empty_payload(payload_name, payload) {
        Ok(()) => Ok(true),
        Err(error) => {
            send_error_response(seq, &error.to_string(), writer)?;
            Ok(false)
        }
    }
}

fn handle_quiesce_operations(
    seq: u32,
    payload: &[u8],
    operation_state: &OperationState,
    process_containment_mode: ProcessContainmentMode,
    writer: &GuestWriter,
) -> io::Result<()> {
    if !validate_empty_control_payload(
        seq,
        "quiesce_operations payload must be empty",
        payload,
        writer,
    )? {
        return Ok(());
    }

    match operation_state.enter_quiescing() {
        // Quiescing atomically fences new guest operations. Once pending is
        // zero, this is the final race-free boundary before the sandbox is parked.
        QuiesceResult::Quiesced => {
            match verify_exec_process_containment_empty(process_containment_mode) {
                Ok(()) => send_empty_response(MSG_OPERATIONS_QUIESCED, seq, writer),
                Err(error) => send_error_response(
                    seq,
                    &format!("guest process containment is not empty: {error}"),
                    writer,
                ),
            }
        }
        QuiesceResult::Busy { pending } => send_error_response(
            seq,
            &format!("guest operations still pending: {pending}"),
            writer,
        ),
    }
}

fn handle_memory_snapshot(
    seq: u32,
    payload: &[u8],
    operation_state: &OperationState,
    meminfo_source: &MeminfoSource,
    writer: &GuestWriter,
) -> io::Result<()> {
    if !validate_empty_control_payload(
        seq,
        "memory_snapshot payload must be empty",
        payload,
        writer,
    )? {
        return Ok(());
    }
    if !operation_state.is_quiesced() {
        return send_error_response(seq, "guest operations are not fully quiesced", writer);
    }
    match meminfo_source.read_memory_snapshot() {
        Ok(snapshot) => {
            let payload = snapshot.encode_payload();
            let response = guest_control_proto::encode(MSG_MEMORY_SNAPSHOT_RESULT, seq, &payload)
                .map_err(to_io_error)?;
            writer.write_frame(&response)
        }
        Err(error) => send_error_response(
            seq,
            &format!("failed to read guest memory snapshot: {error}"),
            writer,
        ),
    }
}

fn handle_resume_operations(
    seq: u32,
    payload: &[u8],
    operation_state: &OperationState,
    writer: &GuestWriter,
) -> io::Result<()> {
    if !validate_empty_control_payload(
        seq,
        "resume_operations payload must be empty",
        payload,
        writer,
    )? {
        return Ok(());
    }

    operation_state.resume();
    send_empty_response(MSG_OPERATIONS_RESUMED, seq, writer)
}

struct ConnectionDispatcher {
    writer: GuestWriter,
    connection_cancel: Arc<AtomicBool>,
    file_write_worker: FileWriteWorker,
    guest_dns_readiness_worker: GuestDnsReadinessWorker,
    guest_state_restore_worker: GuestStateRestoreWorker,
    guest_storage_manifest_worker: GuestStorageManifestWorker,
    workspace_drive_mount_worker: WorkspaceDriveMountWorker,
    exec_operation_registry: ExecOperationRegistry,
    exec_control_registry: ExecControlRegistry,
    operation_state: OperationState,
    guest_agent_program: GuestAgentProgram,
    meminfo_source: MeminfoSource,
    process_containment_mode: ProcessContainmentMode,
    exec_drain_deadline: Duration,
}

struct ConnectionPrograms {
    guest_agent: GuestAgentProgram,
    guest_dns_readiness: GuestDnsReadinessProgram,
    guest_state_restore: GuestStateRestoreProgram,
    guest_storage_manifest: GuestStorageManifestProgram,
    workspace_drive_mount: WorkspaceDriveMountProgram,
}

impl ConnectionPrograms {
    fn production() -> Self {
        Self {
            guest_agent: GuestAgentProgram::production(),
            guest_dns_readiness: GuestDnsReadinessProgram::production(),
            guest_state_restore: GuestStateRestoreProgram::production(),
            guest_storage_manifest: GuestStorageManifestProgram::production(),
            workspace_drive_mount: WorkspaceDriveMountProgram::production(),
        }
    }
}

impl ConnectionDispatcher {
    fn new(
        writer: GuestWriter,
        connection_cancel: Arc<AtomicBool>,
        process_containment_mode: ProcessContainmentMode,
        exec_drain_deadline: Duration,
        programs: ConnectionPrograms,
        meminfo_source: MeminfoSource,
    ) -> io::Result<Self> {
        let file_write_worker =
            FileWriteWorker::start(writer.clone(), Arc::clone(&connection_cancel))?;
        let guest_dns_readiness_worker = GuestDnsReadinessWorker::start(
            writer.clone(),
            Arc::clone(&connection_cancel),
            programs.guest_dns_readiness,
        );
        let guest_storage_manifest_worker = GuestStorageManifestWorker::start(
            writer.clone(),
            Arc::clone(&connection_cancel),
            programs.guest_storage_manifest,
            process_containment_mode,
            exec_drain_deadline,
        );
        let guest_state_restore_worker = GuestStateRestoreWorker::start(
            writer.clone(),
            Arc::clone(&connection_cancel),
            programs.guest_state_restore,
            exec_drain_deadline,
        );
        let workspace_drive_mount_worker = WorkspaceDriveMountWorker::start(
            writer.clone(),
            Arc::clone(&connection_cancel),
            programs.workspace_drive_mount,
            exec_drain_deadline,
        );
        Ok(Self {
            writer,
            connection_cancel,
            file_write_worker,
            guest_dns_readiness_worker,
            guest_state_restore_worker,
            guest_storage_manifest_worker,
            workspace_drive_mount_worker,
            exec_operation_registry: ExecOperationRegistry::default(),
            exec_control_registry: ExecControlRegistry::default(),
            operation_state: OperationState::default(),
            guest_agent_program: programs.guest_agent,
            meminfo_source,
            process_containment_mode,
            exec_drain_deadline,
        })
    }

    fn dispatch(&self, msg: BorrowedRawMessage<'_>) -> io::Result<DispatchOutcome> {
        match msg.msg_type {
            guest_control_proto::MSG_WRITE_FILE_STREAM_BEGIN => {
                self.handle_file_write(msg, FileWriteKind::Stream)?
            }
            guest_control_proto::MSG_WRITE_FILE_STREAM_DATA
            | guest_control_proto::MSG_WRITE_FILE_STREAM_END => {
                self.file_write_worker.stream_data(msg)?;
            }
            MSG_EXEC_START => self.handle_exec_start(msg)?,
            MSG_EXEC_CANCEL => self.handle_exec_cancel(msg)?,
            MSG_EXEC_CONTROL => self.handle_exec_control(msg)?,
            MSG_WRITE_FILE => self.handle_file_write(msg, FileWriteKind::File)?,
            MSG_WRITE_FILES => self.handle_file_write(msg, FileWriteKind::Files)?,
            MSG_WRITE_PRIVATE_FILES => self.handle_file_write(msg, FileWriteKind::PrivateFiles)?,
            MSG_GUEST_DNS_READINESS => self.handle_guest_dns_readiness(msg)?,
            MSG_GUEST_STATE_RESTORE => self.handle_guest_state_restore(msg)?,
            MSG_GUEST_STORAGE_MANIFEST => self.handle_guest_storage_manifest(msg)?,
            MSG_WORKSPACE_DRIVE_MOUNT => self.handle_workspace_drive_mount(msg)?,
            MSG_QUIESCE_OPERATIONS => self.handle_quiesce_operations(msg)?,
            MSG_RESUME_OPERATIONS => self.handle_resume_operations(msg)?,
            MSG_MEMORY_SNAPSHOT => self.handle_memory_snapshot(msg)?,
            MSG_FILE_WRITE_STATUS => self.handle_file_write_status(msg)?,
            _ => return self.handle_basic_message(msg),
        }

        Ok(DispatchOutcome::Continue)
    }

    fn handle_file_write_status(&self, msg: BorrowedRawMessage<'_>) -> io::Result<()> {
        if !require_non_zero_sequence(msg.seq, "file-write status", &self.writer)?
            || !validate_empty_control_payload(
                msg.seq,
                "file-write status payload must be empty",
                msg.payload,
                &self.writer,
            )?
        {
            return Ok(());
        }
        // This read-only control query neither acquires normal-operation
        // ownership nor changes the quiesce fence. Release the snapshot lock
        // before acquiring the response writer.
        let payload = self.file_write_worker.status().encode_payload();
        let response = guest_control_proto::encode(MSG_FILE_WRITE_STATUS_RESULT, msg.seq, &payload)
            .map_err(to_io_error)?;
        self.writer.write_frame(&response)
    }

    fn handle_exec_start(&self, msg: BorrowedRawMessage<'_>) -> io::Result<()> {
        if !require_non_zero_sequence(msg.seq, "exec start", &self.writer)? {
            return Ok(());
        }
        if reject_operation_if_quiescing(&self.operation_state, msg.seq, &self.writer)? {
            return Ok(());
        }
        let decoded = match guest_control_proto::decode_exec_start(msg.payload) {
            Ok(decoded) => decoded,
            Err(error) => {
                send_error_response(msg.seq, &error.to_string(), &self.writer)?;
                return Ok(());
            }
        };
        let mut request = match ExecOperationWorkerRequest::from_decoded(
            msg.seq,
            decoded,
            self.process_containment_mode,
            self.exec_drain_deadline,
            self.guest_agent_program.clone(),
        ) {
            Ok(request) => request,
            Err(error) => {
                send_error_response(msg.seq, &error.to_string(), &self.writer)?;
                return Ok(());
            }
        };
        let Some(operation_guard) =
            acquire_operation_guard(&self.operation_state, msg.seq, &self.writer)?
        else {
            return Ok(());
        };
        if let Some((control_nonce, control_sink)) = request.exec_control_registration() {
            let registration =
                match self
                    .exec_control_registry
                    .register(msg.seq, control_nonce, control_sink)
                {
                    Ok(registration) => registration,
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                        operation_guard.release();
                        send_error_response(
                            msg.seq,
                            "exec operation already active",
                            &self.writer,
                        )?;
                        return Ok(());
                    }
                    Err(error) => {
                        operation_guard.release();
                        send_error_response(
                            msg.seq,
                            &format!("exec control setup failed: {error}"),
                            &self.writer,
                        )?;
                        return Ok(());
                    }
                };
            request.attach_exec_control(registration.guard, registration.bootstrap_endpoint);
        }
        if let Err(error) = request.validate_control_attachment() {
            operation_guard.release();
            send_error_response(msg.seq, &error.to_string(), &self.writer)?;
            return Ok(());
        }
        start_exec_operation(
            request,
            operation_guard,
            self.writer.clone(),
            self.connection_cancel.clone(),
            self.exec_operation_registry.clone(),
        )
    }

    fn handle_exec_cancel(&self, msg: BorrowedRawMessage<'_>) -> io::Result<()> {
        if !require_non_zero_sequence(msg.seq, "exec cancel", &self.writer)? {
            return Ok(());
        }
        if let Err(error) = guest_control_proto::decode_exec_cancel(msg.payload) {
            log(
                "WARN",
                &format!(
                    "exec cancel: ignoring malformed payload seq={} error={error}",
                    msg.seq
                ),
            );
        }
        cancel_exec_operation(&self.exec_operation_registry, msg.seq);
        Ok(())
    }

    fn handle_exec_control(&self, msg: BorrowedRawMessage<'_>) -> io::Result<()> {
        if !require_non_zero_sequence(msg.seq, "exec control", &self.writer)? {
            return Ok(());
        }
        let decoded = match guest_control_proto::decode_exec_control(msg.payload) {
            Ok(decoded) => decoded,
            Err(error) => {
                send_error_response(msg.seq, &error.to_string(), &self.writer)?;
                return Ok(());
            }
        };
        route_exec_control(msg.seq, decoded, &self.exec_control_registry, &self.writer)
    }

    fn handle_file_write(
        &self,
        msg: BorrowedRawMessage<'_>,
        kind: FileWriteKind,
    ) -> io::Result<()> {
        if !require_non_zero_sequence(msg.seq, kind.operation_label(), &self.writer)? {
            return Ok(());
        }
        if reject_operation_if_quiescing(&self.operation_state, msg.seq, &self.writer)? {
            return Ok(());
        }
        if let Err(error) = kind.validate_payload(msg.payload) {
            send_error_response(msg.seq, &error.to_string(), &self.writer)?;
            return Ok(());
        }
        let Some(admission) = self.file_write_worker.try_admit() else {
            send_error_response(msg.seq, "guest file write already active", &self.writer)?;
            return Ok(());
        };
        let Some(operation_guard) =
            acquire_operation_guard(&self.operation_state, msg.seq, &self.writer)?
        else {
            return Ok(());
        };
        match self
            .file_write_worker
            .submit(kind, msg.seq, msg.payload, operation_guard, admission)
        {
            Ok(()) => Ok(()),
            Err(FileWriteSubmitError::Busy) => {
                send_error_response(msg.seq, "guest file write already active", &self.writer)
            }
            Err(FileWriteSubmitError::Disconnected) => Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "guest file-write worker stopped",
            )),
        }
    }

    fn handle_guest_dns_readiness(&self, msg: BorrowedRawMessage<'_>) -> io::Result<()> {
        if !require_non_zero_sequence(msg.seq, "guest DNS readiness", &self.writer)? {
            return Ok(());
        }
        if reject_operation_if_quiescing(&self.operation_state, msg.seq, &self.writer)? {
            return Ok(());
        }
        let decoded = match guest_control_proto::decode_guest_dns_readiness_request(msg.payload) {
            Ok(decoded) => decoded,
            Err(error) => {
                send_error_response(msg.seq, &error.to_string(), &self.writer)?;
                return Ok(());
            }
        };
        let Some(admission) = self.guest_dns_readiness_worker.try_admit() else {
            send_error_response(
                msg.seq,
                "guest DNS readiness operation already active",
                &self.writer,
            )?;
            return Ok(());
        };
        let Some(operation_guard) =
            acquire_operation_guard(&self.operation_state, msg.seq, &self.writer)?
        else {
            return Ok(());
        };
        match self.guest_dns_readiness_worker.submit(
            msg.seq,
            decoded.timeout_ms,
            decoded.hostname,
            operation_guard,
            admission,
        ) {
            Ok(()) => Ok(()),
            Err(GuestDnsReadinessSubmitError::Busy) => send_error_response(
                msg.seq,
                "guest DNS readiness operation already active",
                &self.writer,
            ),
            Err(GuestDnsReadinessSubmitError::Disconnected) => Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "guest DNS readiness worker stopped",
            )),
            Err(GuestDnsReadinessSubmitError::Start(error)) => send_error_response(
                msg.seq,
                &format!("failed to start guest DNS readiness worker: {error}"),
                &self.writer,
            ),
        }
    }

    fn handle_guest_storage_manifest(&self, msg: BorrowedRawMessage<'_>) -> io::Result<()> {
        if !require_non_zero_sequence(msg.seq, "guest storage manifest", &self.writer)? {
            return Ok(());
        }
        if reject_operation_if_quiescing(&self.operation_state, msg.seq, &self.writer)? {
            return Ok(());
        }
        let decoded = match guest_control_proto::decode_guest_storage_manifest_request(msg.payload)
        {
            Ok(decoded) => decoded,
            Err(error) => {
                send_error_response(msg.seq, &error.to_string(), &self.writer)?;
                return Ok(());
            }
        };
        let Some(admission) = self.guest_storage_manifest_worker.try_admit() else {
            send_error_response(
                msg.seq,
                "guest storage manifest operation already active",
                &self.writer,
            )?;
            return Ok(());
        };
        let Some(operation_guard) =
            acquire_operation_guard(&self.operation_state, msg.seq, &self.writer)?
        else {
            return Ok(());
        };
        match self.guest_storage_manifest_worker.submit(
            GuestStorageManifestSubmission {
                seq: msg.seq,
                timeout_ms: decoded.timeout_ms,
                run_id: decoded.run_id,
                runtime_dir: decoded.runtime_dir,
                manifest_json: decoded.manifest_json,
            },
            operation_guard,
            admission,
        ) {
            Ok(()) => Ok(()),
            Err(GuestStorageManifestSubmitError::Busy) => send_error_response(
                msg.seq,
                "guest storage manifest operation already active",
                &self.writer,
            ),
            Err(GuestStorageManifestSubmitError::Disconnected) => Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "guest storage manifest worker stopped",
            )),
            Err(GuestStorageManifestSubmitError::Start(error)) => send_error_response(
                msg.seq,
                &format!("failed to start guest storage manifest worker: {error}"),
                &self.writer,
            ),
        }
    }

    fn handle_guest_state_restore(&self, msg: BorrowedRawMessage<'_>) -> io::Result<()> {
        if !require_non_zero_sequence(msg.seq, "guest state restore", &self.writer)? {
            return Ok(());
        }
        if reject_operation_if_quiescing(&self.operation_state, msg.seq, &self.writer)? {
            return Ok(());
        }
        let decoded = match guest_control_proto::decode_guest_state_restore_request(msg.payload) {
            Ok(decoded) => decoded,
            Err(error) => {
                send_error_response(msg.seq, &error.to_string(), &self.writer)?;
                return Ok(());
            }
        };
        let Some(admission) = self.guest_state_restore_worker.try_admit() else {
            send_error_response(
                msg.seq,
                "guest state restore operation already active",
                &self.writer,
            )?;
            return Ok(());
        };
        let Some(operation_guard) =
            acquire_operation_guard(&self.operation_state, msg.seq, &self.writer)?
        else {
            return Ok(());
        };
        match self.guest_state_restore_worker.submit(
            GuestStateRestoreSubmission {
                seq: msg.seq,
                timeout_ms: decoded.timeout_ms,
                unix_seconds: decoded.unix_seconds,
                unix_nanoseconds: decoded.unix_nanoseconds,
                entropy: decoded.entropy,
                timezone: decoded.timezone,
            },
            operation_guard,
            admission,
        ) {
            Ok(()) => Ok(()),
            Err(GuestStateRestoreSubmitError::Busy) => send_error_response(
                msg.seq,
                "guest state restore operation already active",
                &self.writer,
            ),
            Err(GuestStateRestoreSubmitError::Disconnected) => Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "guest state restore worker stopped",
            )),
            Err(GuestStateRestoreSubmitError::Start(error)) => send_error_response(
                msg.seq,
                &format!("failed to start guest state restore worker: {error}"),
                &self.writer,
            ),
        }
    }

    fn handle_workspace_drive_mount(&self, msg: BorrowedRawMessage<'_>) -> io::Result<()> {
        if !require_non_zero_sequence(msg.seq, "workspace drive mount", &self.writer)? {
            return Ok(());
        }
        if reject_operation_if_quiescing(&self.operation_state, msg.seq, &self.writer)? {
            return Ok(());
        }
        if let Err(error) = guest_control_proto::decode_workspace_drive_mount_request(msg.payload) {
            send_error_response(msg.seq, &error.to_string(), &self.writer)?;
            return Ok(());
        }
        let Some(admission) = self.workspace_drive_mount_worker.try_admit() else {
            send_error_response(
                msg.seq,
                "workspace drive mount operation already active",
                &self.writer,
            )?;
            return Ok(());
        };
        let Some(operation_guard) =
            acquire_operation_guard(&self.operation_state, msg.seq, &self.writer)?
        else {
            return Ok(());
        };
        match self
            .workspace_drive_mount_worker
            .submit(msg.seq, operation_guard, admission)
        {
            Ok(()) => Ok(()),
            Err(WorkspaceDriveMountSubmitError::Busy) => send_error_response(
                msg.seq,
                "workspace drive mount operation already active",
                &self.writer,
            ),
            Err(WorkspaceDriveMountSubmitError::Disconnected) => Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "workspace drive mount worker stopped",
            )),
            Err(WorkspaceDriveMountSubmitError::Start(error)) => send_error_response(
                msg.seq,
                &format!("failed to start workspace drive mount worker: {error}"),
                &self.writer,
            ),
        }
    }

    fn handle_quiesce_operations(&self, msg: BorrowedRawMessage<'_>) -> io::Result<()> {
        handle_quiesce_operations(
            msg.seq,
            msg.payload,
            &self.operation_state,
            self.process_containment_mode,
            &self.writer,
        )
    }

    fn handle_resume_operations(&self, msg: BorrowedRawMessage<'_>) -> io::Result<()> {
        handle_resume_operations(msg.seq, msg.payload, &self.operation_state, &self.writer)
    }

    fn handle_memory_snapshot(&self, msg: BorrowedRawMessage<'_>) -> io::Result<()> {
        handle_memory_snapshot(
            msg.seq,
            msg.payload,
            &self.operation_state,
            &self.meminfo_source,
            &self.writer,
        )
    }

    fn handle_basic_message(&self, msg: BorrowedRawMessage<'_>) -> io::Result<DispatchOutcome> {
        match handle_basic_message(msg)? {
            MessageOutcome::Response(response) => {
                self.writer.write_frame(&response)?;
                Ok(DispatchOutcome::Continue)
            }
            MessageOutcome::Shutdown(response) => {
                if let Err(e) = self.writer.write_frame_after_lock(&response, || {
                    self.connection_cancel.store(true, Ordering::Release);
                }) {
                    log("WARN", &format!("Failed to send shutdown_ack: {e}"));
                }
                Ok(DispatchOutcome::Shutdown)
            }
        }
    }
}

/// Connect to vsock (Linux only - this binary runs inside Firecracker VM)
#[cfg(target_os = "linux")]
pub fn connect_vsock() -> io::Result<UnixStream> {
    use std::os::unix::io::FromRawFd;

    // SAFETY: Creating a vsock socket with valid constants. fd is checked for errors below.
    let fd = unsafe { libc::socket(libc::AF_VSOCK, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }

    let addr = libc::sockaddr_vm {
        svm_family: libc::AF_VSOCK as u16,
        svm_reserved1: 0,
        svm_port: guest_control_proto::VSOCK_PORT,
        svm_cid: VSOCK_CID_HOST,
        svm_zero: [0; 4],
    };

    // SAFETY: fd is a valid socket from above, addr is properly initialized, and
    // size_of returns the correct sockaddr_vm size. Errors are checked below.
    let ret = unsafe {
        libc::connect(
            fd,
            &addr as *const libc::sockaddr_vm as *const libc::sockaddr,
            std::mem::size_of::<libc::sockaddr_vm>() as u32,
        )
    };

    if ret < 0 {
        // SAFETY: fd is a valid open socket descriptor, and we're about to return an error.
        unsafe { libc::close(fd) };
        return Err(io::Error::last_os_error());
    }

    // SAFETY: fd is a valid, connected socket descriptor. Ownership transfers to UnixStream.
    Ok(unsafe { UnixStream::from_raw_fd(fd) })
}

/// Stub for non-Linux platforms (for IDE support)
#[cfg(not(target_os = "linux"))]
pub fn connect_vsock() -> io::Result<UnixStream> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "vsock is only supported on Linux",
    ))
}

/// Connect to Unix socket (for testing)
pub fn connect_unix(path: &str) -> io::Result<UnixStream> {
    UnixStream::connect(path)
}

/// Handle connection - the main event loop
/// Uses separate reader/writer to avoid deadlock between main loop and background threads
pub fn handle_connection(stream: UnixStream) -> io::Result<()> {
    handle_connection_with_mode(stream, ProcessContainmentMode::BuildConfigured)
}

/// Handles a host-side test connection without accessing the guest cgroup hierarchy.
///
/// This remains available without `test-support` so this crate's integration
/// tests can select deterministic containment in their normal library build.
#[doc(hidden)]
pub fn handle_connection_with_test_process_containment(stream: UnixStream) -> io::Result<()> {
    handle_connection_with_mode(stream, ProcessContainmentMode::TestNoop)
}

/// Handles a host-side test connection with an explicit exec output drain deadline.
///
/// This integration-test hook retains test process containment while allowing a real exec request
/// to exercise timeout-driven output cancellation without waiting for the production deadline.
#[doc(hidden)]
pub fn handle_connection_with_test_process_containment_and_exec_drain_deadline(
    stream: UnixStream,
    exec_drain_deadline: Duration,
) -> io::Result<()> {
    handle_connection_with_mode_and_exec_drain_deadline(
        stream,
        ProcessContainmentMode::TestNoop,
        exec_drain_deadline,
    )
}

/// Handles a host-side test connection with an explicit meminfo source file.
#[doc(hidden)]
pub fn handle_connection_with_test_memory_snapshot_path(
    stream: UnixStream,
    path: std::path::PathBuf,
) -> io::Result<()> {
    handle_connection_with_mode_and_program(
        stream,
        ProcessContainmentMode::TestNoop,
        EXEC_OUTPUT_DRAIN_DEADLINE,
        ConnectionPrograms::production(),
        MeminfoSource::for_test(path),
    )
}

/// Handles a host-side test connection with a test DNS readiness executable.
///
/// This remains available without `test-support` so integration tests can
/// compile against the normal production library configuration.
#[doc(hidden)]
pub fn handle_connection_with_test_dns_readiness_program(
    stream: UnixStream,
    program: std::path::PathBuf,
) -> io::Result<()> {
    handle_connection_with_mode_and_program(
        stream,
        ProcessContainmentMode::TestNoop,
        EXEC_OUTPUT_DRAIN_DEADLINE,
        ConnectionPrograms {
            guest_dns_readiness: GuestDnsReadinessProgram::for_test(program),
            ..ConnectionPrograms::production()
        },
        MeminfoSource::production(),
    )
}

/// Handles a host-side test connection with a test storage helper executable.
#[doc(hidden)]
pub fn handle_connection_with_test_storage_manifest_program(
    stream: UnixStream,
    program: std::path::PathBuf,
) -> io::Result<()> {
    handle_connection_with_mode_and_program(
        stream,
        ProcessContainmentMode::TestNoop,
        EXEC_OUTPUT_DRAIN_DEADLINE,
        ConnectionPrograms {
            guest_storage_manifest: GuestStorageManifestProgram::for_test(program),
            ..ConnectionPrograms::production()
        },
        MeminfoSource::production(),
    )
}

/// Exercises storage RPC diagnostics using owned resource files.
/// No real guest cgroup hierarchy is accessed by this integration-test hook.
#[doc(hidden)]
pub fn handle_connection_with_test_storage_resources(
    stream: UnixStream,
    program: std::path::PathBuf,
    resource_path: std::path::PathBuf,
) -> io::Result<()> {
    handle_connection_with_mode_and_program(
        stream,
        ProcessContainmentMode::TestNoop,
        EXEC_OUTPUT_DRAIN_DEADLINE,
        ConnectionPrograms {
            guest_storage_manifest: GuestStorageManifestProgram::for_test_resources(
                program,
                resource_path,
            ),
            ..ConnectionPrograms::production()
        },
        MeminfoSource::production(),
    )
}

/// Holds each test storage helper before starting its real request timeout.
///
/// Use a zero-capacity channel. Receiving the owned child's PID starts the timer,
/// allowing tests to establish helper readiness first. Receive or drop the
/// receiver before joining the connection so cleanup can proceed on test failure.
/// An optional resource path selects owned diagnostic files instead of cgroups.
#[doc(hidden)]
pub fn handle_connection_with_test_storage_manifest_timeout_gate(
    stream: UnixStream,
    program: std::path::PathBuf,
    resource_path: Option<std::path::PathBuf>,
    timeout_gate: std::sync::mpsc::SyncSender<u32>,
) -> io::Result<()> {
    handle_connection_with_mode_and_program(
        stream,
        ProcessContainmentMode::TestNoop,
        EXEC_OUTPUT_DRAIN_DEADLINE,
        ConnectionPrograms {
            guest_storage_manifest: GuestStorageManifestProgram::for_test_timeout(
                program,
                resource_path,
                timeout_gate,
            ),
            ..ConnectionPrograms::production()
        },
        MeminfoSource::production(),
    )
}

/// Handles a host-side test connection with a test workspace mount executable
/// and child timeout.
#[doc(hidden)]
pub fn handle_connection_with_test_workspace_drive_mount_program(
    stream: UnixStream,
    program: std::path::PathBuf,
    timeout_ms: u32,
) -> io::Result<()> {
    handle_connection_with_mode_and_program(
        stream,
        ProcessContainmentMode::TestNoop,
        EXEC_OUTPUT_DRAIN_DEADLINE,
        ConnectionPrograms {
            workspace_drive_mount: WorkspaceDriveMountProgram::for_test(program, timeout_ms),
            ..ConnectionPrograms::production()
        },
        MeminfoSource::production(),
    )
}

/// Handles a host-side test connection with a test guest-state helper.
#[doc(hidden)]
pub fn handle_connection_with_test_guest_state_restore_program(
    stream: UnixStream,
    program: std::path::PathBuf,
) -> io::Result<()> {
    handle_connection_with_mode_and_program(
        stream,
        ProcessContainmentMode::TestNoop,
        EXEC_OUTPUT_DRAIN_DEADLINE,
        ConnectionPrograms {
            guest_state_restore: GuestStateRestoreProgram::for_test(program),
            ..ConnectionPrograms::production()
        },
        MeminfoSource::production(),
    )
}

/// Handles a host-side test connection with a fixed test Guest Agent executable.
#[doc(hidden)]
pub fn handle_connection_with_test_guest_agent_program(
    stream: UnixStream,
    program: std::path::PathBuf,
) -> io::Result<()> {
    handle_connection_with_mode_and_program(
        stream,
        ProcessContainmentMode::TestNoop,
        EXEC_OUTPUT_DRAIN_DEADLINE,
        ConnectionPrograms {
            guest_agent: GuestAgentProgram::for_test(program),
            ..ConnectionPrograms::production()
        },
        MeminfoSource::production(),
    )
}

fn handle_connection_with_mode(
    stream: UnixStream,
    process_containment_mode: ProcessContainmentMode,
) -> io::Result<()> {
    handle_connection_with_mode_and_exec_drain_deadline(
        stream,
        process_containment_mode,
        EXEC_OUTPUT_DRAIN_DEADLINE,
    )
}

fn handle_connection_with_mode_and_exec_drain_deadline(
    stream: UnixStream,
    process_containment_mode: ProcessContainmentMode,
    exec_drain_deadline: Duration,
) -> io::Result<()> {
    handle_connection_with_mode_and_program(
        stream,
        process_containment_mode,
        exec_drain_deadline,
        ConnectionPrograms::production(),
        MeminfoSource::production(),
    )
}

fn handle_connection_with_mode_and_program(
    stream: UnixStream,
    process_containment_mode: ProcessContainmentMode,
    exec_drain_deadline: Duration,
    programs: ConnectionPrograms,
    meminfo_source: MeminfoSource,
) -> io::Result<()> {
    match handle_connection_with_outcome(
        stream,
        process_containment_mode,
        exec_drain_deadline,
        programs,
        meminfo_source,
    ) {
        Ok(_) => Ok(()),
        Err(failure) => Err(failure.error),
    }
}

fn handle_connection_with_outcome(
    stream: UnixStream,
    process_containment_mode: ProcessContainmentMode,
    exec_drain_deadline: Duration,
    programs: ConnectionPrograms,
    meminfo_source: MeminfoSource,
) -> Result<ConnectionEnd, ConnectionFailure> {
    // Clone the stream to get separate reader and writer
    // This avoids deadlock: reader can block while worker threads write results.
    let mut reader = stream.try_clone().map_err(unstable_connection_failure)?;
    let writer = GuestWriter::new(stream);
    let connection_cancel = Arc::new(AtomicBool::new(false));
    let _cancel_on_drop = ConnectionCancelGuard(connection_cancel.clone());

    let mut decoder = guest_control_proto::Decoder::new();

    // Send ready signal
    {
        let ready = guest_control_proto::encode(MSG_READY, 0, &[])
            .map_err(to_io_error)
            .map_err(unstable_connection_failure)?;
        writer
            .write_frame(&ready)
            .map_err(unstable_connection_failure)?;
    }
    log("INFO", "Sent ready signal");

    let mut session = ConnectionSession::new();
    let dispatcher = ConnectionDispatcher::new(
        writer,
        connection_cancel.clone(),
        process_containment_mode,
        exec_drain_deadline,
        programs,
        meminfo_source,
    )
    .map_err(|error| session.failure(error))?;
    let mut buf = [0u8; READ_BUFFER_SIZE];
    loop {
        // Read from stream (reader is separate, no lock needed)
        let n = reader
            .read(&mut buf)
            .map_err(|error| session.failure(error))?;

        if n == 0 {
            break;
        }

        // n <= buf.len() is guaranteed by read()
        match decoder.decode_with(buf.get(..n).unwrap_or_default(), |msg| {
            match dispatcher.dispatch(msg) {
                Ok(DispatchOutcome::Continue) => {
                    session.mark_real_host_work(msg.msg_type);
                    Ok(())
                }
                Ok(DispatchOutcome::Shutdown) => Err(DecodeDispatchError::Shutdown),
                Err(error) => Err(DecodeDispatchError::Dispatch(error)),
            }
        }) {
            Ok(()) => {}
            Err(DecodeWithError::Protocol(error)) => {
                return Err(session.failure(to_io_error(error)));
            }
            Err(DecodeWithError::Visitor(DecodeDispatchError::Dispatch(error))) => {
                return Err(session.failure(error));
            }
            Err(DecodeWithError::Visitor(DecodeDispatchError::Shutdown)) => {
                // Shutdown is terminal, so ignore all later frames while
                // retaining the transport until the host has observed the ACK
                // or abandoned its bounded graceful-shutdown attempt.
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(_) => {}
                        Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                        Err(_) => break,
                    }
                }
                log("INFO", "Shutdown complete, exiting");
                return Ok(ConnectionEnd::Shutdown);
            }
        }
    }

    log("INFO", "Host disconnected");
    Ok(session.closed())
}

/// Maximum reconnection attempts before giving up
const MAX_RECONNECT_ATTEMPTS: u32 = 50;
/// Delay between reconnection attempts (10ms for fast reconnect after snapshot restore)
const RECONNECT_DELAY_MS: u64 = 10;
const STABLE_CONNECTION_MIN_DURATION: Duration = Duration::from_secs(1);

fn next_reconnect_attempts(current_attempts: u32, connection_was_stable: bool) -> u32 {
    if connection_was_stable {
        1
    } else {
        current_attempts + 1
    }
}

fn retry_or_fail(failure: ReconnectFailure, attempts: u32) -> io::Result<()> {
    if attempts >= MAX_RECONNECT_ATTEMPTS {
        return match failure {
            ReconnectFailure::Closed => {
                log(
                    "ERROR",
                    &format!(
                        "Max reconnect attempts ({}) reached",
                        MAX_RECONNECT_ATTEMPTS
                    ),
                );
                Err(io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "Max reconnect attempts reached",
                ))
            }
            ReconnectFailure::Error(error) => {
                log(
                    "ERROR",
                    &format!(
                        "Max reconnect attempts ({}) reached: {}",
                        MAX_RECONNECT_ATTEMPTS, error
                    ),
                );
                Err(error)
            }
        };
    }

    match failure {
        ReconnectFailure::Closed => {
            log(
                "INFO",
                &format!(
                    "Connection closed, reconnecting ({}/{})...",
                    attempts, MAX_RECONNECT_ATTEMPTS
                ),
            );
        }
        ReconnectFailure::Error(error) => {
            log(
                "WARN",
                &format!(
                    "Connection error: {}, reconnecting ({}/{})...",
                    error, attempts, MAX_RECONNECT_ATTEMPTS
                ),
            );
        }
    }

    thread::sleep(Duration::from_millis(RECONNECT_DELAY_MS));
    Ok(())
}

/// Run the guest control server over vsock, or over a host-side Unix test socket.
/// Includes reconnection logic for snapshot restore scenarios where
/// the connection is lost when VM is paused and resumed.
pub fn run(unix_socket: Option<&str>) -> io::Result<()> {
    log("INFO", "Starting guest-control-server...");

    let mut attempts = 0u32;
    // The Unix transport exists for host-side integration tests and does not
    // own the guest cgroup hierarchy. Deployed guests connect over vsock.
    let process_containment_mode = if unix_socket.is_some() {
        ProcessContainmentMode::TestNoop
    } else {
        ProcessContainmentMode::BuildConfigured
    };

    loop {
        let result = if let Some(path) = unix_socket {
            log("INFO", &format!("Connecting to Unix socket: {}...", path));
            connect_unix(path)
                .map_err(unstable_connection_failure)
                .and_then(|stream| {
                    log("INFO", "Connected");
                    handle_connection_with_outcome(
                        stream,
                        process_containment_mode,
                        EXEC_OUTPUT_DRAIN_DEADLINE,
                        ConnectionPrograms::production(),
                        MeminfoSource::production(),
                    )
                })
        } else {
            log("INFO", "Connecting to host (CID=2)...");
            connect_vsock()
                .map_err(unstable_connection_failure)
                .and_then(|stream| {
                    log("INFO", "Connected");
                    handle_connection_with_outcome(
                        stream,
                        process_containment_mode,
                        EXEC_OUTPUT_DRAIN_DEADLINE,
                        ConnectionPrograms::production(),
                        MeminfoSource::production(),
                    )
                })
        };

        match result {
            Ok(ConnectionEnd::Shutdown) => return Ok(()),
            Ok(ConnectionEnd::Closed { stable }) => {
                attempts = next_reconnect_attempts(attempts, stable);
                retry_or_fail(ReconnectFailure::Closed, attempts)?;
            }
            Err(failure) => {
                attempts = next_reconnect_attempts(attempts, failure.stable);
                retry_or_fail(ReconnectFailure::Error(failure.error), attempts)?;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use guest_control_proto::{MSG_PING, MSG_SHUTDOWN};

    #[test]
    fn retry_closed_failure_returns_connection_reset_when_exhausted() {
        let result = retry_or_fail(ReconnectFailure::Closed, MAX_RECONNECT_ATTEMPTS);

        assert!(result.is_err());
        if let Err(error) = result {
            assert_eq!(error.kind(), io::ErrorKind::ConnectionReset);
            assert_eq!(error.to_string(), "Max reconnect attempts reached");
        }
    }

    #[test]
    fn retry_error_failure_returns_original_error_when_exhausted() {
        let result = retry_or_fail(
            ReconnectFailure::Error(io::Error::new(
                io::ErrorKind::TimedOut,
                "connection timed out",
            )),
            MAX_RECONNECT_ATTEMPTS,
        );

        assert!(result.is_err());
        if let Err(error) = result {
            assert_eq!(error.kind(), io::ErrorKind::TimedOut);
            assert_eq!(error.to_string(), "connection timed out");
        }
    }

    #[test]
    fn connection_stability_requires_duration_or_real_work() {
        assert!(!connection_is_stable(
            STABLE_CONNECTION_MIN_DURATION - Duration::from_millis(1),
            false
        ));
        assert!(connection_is_stable(STABLE_CONNECTION_MIN_DURATION, false));
        assert!(connection_is_stable(Duration::ZERO, true));
    }

    #[test]
    fn liveness_and_shutdown_messages_do_not_count_as_real_host_work() {
        assert!(!is_real_host_work_message(MSG_PING));
        assert!(!is_real_host_work_message(MSG_SHUTDOWN));
    }

    #[test]
    fn operation_messages_count_as_real_host_work() {
        for msg_type in [
            MSG_EXEC_START,
            MSG_EXEC_CANCEL,
            MSG_EXEC_CONTROL,
            MSG_WRITE_FILE,
            guest_control_proto::MSG_WRITE_FILE_STREAM_BEGIN,
            MSG_WRITE_FILES,
            MSG_WRITE_PRIVATE_FILES,
            MSG_GUEST_DNS_READINESS,
            MSG_GUEST_STORAGE_MANIFEST,
            MSG_QUIESCE_OPERATIONS,
            MSG_RESUME_OPERATIONS,
        ] {
            assert!(is_real_host_work_message(msg_type));
        }
    }

    #[test]
    fn stable_connection_resets_reconnect_attempt_streak_before_counting_failure() {
        assert_eq!(next_reconnect_attempts(20, true), 1);
    }

    #[test]
    fn unstable_connection_continues_reconnect_attempt_streak() {
        assert_eq!(next_reconnect_attempts(20, false), 21);
    }
}
