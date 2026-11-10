//! Connection-local message policy and operation owners.
//!
//! Transport, cancellation scope and reconnect/session policy remain in the parent.

use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use guest_control_proto::{
    self, BorrowedRawMessage, MSG_EXEC_CANCEL, MSG_EXEC_CONTROL, MSG_EXEC_START,
    MSG_FILE_WRITE_STATUS, MSG_FILE_WRITE_STATUS_RESULT, MSG_GUEST_DNS_READINESS,
    MSG_GUEST_STATE_RESTORE, MSG_GUEST_STORAGE_MANIFEST, MSG_HOME_DRIVE_MOUNT, MSG_MEMORY_SNAPSHOT,
    MSG_MEMORY_SNAPSHOT_RESULT, MSG_OPERATIONS_QUIESCED, MSG_OPERATIONS_RESUMED,
    MSG_QUIESCE_OPERATIONS, MSG_RESUME_OPERATIONS, MSG_WRITE_FILE, MSG_WRITE_FILES,
    MSG_WRITE_PRIVATE_FILES,
};

use super::ConnectionPrograms;
use crate::agent_command::GuestAgentProgram;
use crate::error::to_io_error;
use crate::exec_control::{ExecControlRegistry, handle_decoded_exec_control as route_exec_control};
use crate::exec_operation::{
    ExecOperationRegistry, ExecOperationWorkerRequest, cancel_exec_operation, send_error_response,
    start_exec_operation,
};
use crate::file_write_worker::{FileWriteKind, FileWriteSubmitError, FileWriteWorker};
use crate::guest_dns_readiness::{GuestDnsReadinessSubmitError, GuestDnsReadinessWorker};
use crate::guest_state_restore::{
    GuestStateRestoreSubmission, GuestStateRestoreSubmitError, GuestStateRestoreWorker,
};
use crate::guest_storage_manifest::{
    GuestStorageManifestSubmission, GuestStorageManifestSubmitError, GuestStorageManifestWorker,
};
use crate::handlers::{MessageOutcome, handle_basic_message};
use crate::home_drive_mount::{HomeDriveMountSubmitError, HomeDriveMountWorker};
use crate::log::log;
use crate::memory_snapshot::MeminfoSource;
use crate::process_containment::{ProcessContainmentMode, verify_exec_process_containment_empty};
use crate::quiesce::{AcquireOperationError, OperationGuard, OperationState, QuiesceResult};
use crate::writer::GuestWriter;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum DispatchOutcome {
    Continue,
    Shutdown,
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

pub(super) struct ConnectionDispatcher {
    writer: GuestWriter,
    connection_cancel: Arc<AtomicBool>,
    file_write_worker: FileWriteWorker,
    guest_dns_readiness_worker: GuestDnsReadinessWorker,
    guest_state_restore_worker: GuestStateRestoreWorker,
    guest_storage_manifest_worker: GuestStorageManifestWorker,
    home_drive_mount_worker: HomeDriveMountWorker,
    exec_operation_registry: ExecOperationRegistry,
    exec_control_registry: ExecControlRegistry,
    operation_state: OperationState,
    guest_agent_program: GuestAgentProgram,
    meminfo_source: MeminfoSource,
    process_containment_mode: ProcessContainmentMode,
    exec_drain_deadline: Duration,
}

impl ConnectionDispatcher {
    pub(super) fn new(
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
        let home_drive_mount_worker = HomeDriveMountWorker::start(
            writer.clone(),
            Arc::clone(&connection_cancel),
            programs.home_drive_mount,
            exec_drain_deadline,
        );
        Ok(Self {
            writer,
            connection_cancel,
            file_write_worker,
            guest_dns_readiness_worker,
            guest_state_restore_worker,
            guest_storage_manifest_worker,
            home_drive_mount_worker,
            exec_operation_registry: ExecOperationRegistry::default(),
            exec_control_registry: ExecControlRegistry::default(),
            operation_state: OperationState::default(),
            guest_agent_program: programs.guest_agent,
            meminfo_source,
            process_containment_mode,
            exec_drain_deadline,
        })
    }

    pub(super) fn dispatch(&self, msg: BorrowedRawMessage<'_>) -> io::Result<DispatchOutcome> {
        match msg.msg_type {
            MSG_EXEC_START => self.handle_exec_start(msg)?,
            MSG_EXEC_CANCEL => self.handle_exec_cancel(msg)?,
            MSG_EXEC_CONTROL => self.handle_exec_control(msg)?,
            MSG_WRITE_FILE => self.handle_file_write(msg, FileWriteKind::File)?,
            MSG_WRITE_FILES => self.handle_file_write(msg, FileWriteKind::Files)?,
            MSG_WRITE_PRIVATE_FILES => self.handle_file_write(msg, FileWriteKind::PrivateFiles)?,
            MSG_GUEST_DNS_READINESS => self.handle_guest_dns_readiness(msg)?,
            MSG_GUEST_STATE_RESTORE => self.handle_guest_state_restore(msg)?,
            MSG_GUEST_STORAGE_MANIFEST | guest_control_proto::MSG_GUEST_AGENT_INSTRUCTIONS => {
                self.handle_guest_storage_manifest(msg)?
            }
            MSG_HOME_DRIVE_MOUNT => self.handle_home_drive_mount(msg)?,
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
        let decoded = if msg.msg_type == guest_control_proto::MSG_GUEST_AGENT_INSTRUCTIONS {
            guest_control_proto::decode_guest_agent_instructions_request(msg.payload)
                .map(|decoded| (decoded.input, Some(decoded.operation)))
        } else {
            guest_control_proto::decode_guest_storage_manifest_request(msg.payload)
                .map(|decoded| (decoded, None))
        };
        let (decoded, instruction_operation) = match decoded {
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
                instruction_operation,
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

    fn handle_home_drive_mount(&self, msg: BorrowedRawMessage<'_>) -> io::Result<()> {
        if !require_non_zero_sequence(msg.seq, "home drive mount", &self.writer)? {
            return Ok(());
        }
        if reject_operation_if_quiescing(&self.operation_state, msg.seq, &self.writer)? {
            return Ok(());
        }
        let operation = match guest_control_proto::decode_home_drive_mount_request(msg.payload) {
            Ok(operation) => operation,
            Err(error) => {
                send_error_response(msg.seq, &error.to_string(), &self.writer)?;
                return Ok(());
            }
        };
        let Some(admission) = self.home_drive_mount_worker.try_admit() else {
            send_error_response(
                msg.seq,
                "home drive mount operation already active",
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
            .home_drive_mount_worker
            .submit(msg.seq, operation, operation_guard, admission)
        {
            Ok(()) => Ok(()),
            Err(HomeDriveMountSubmitError::Busy) => send_error_response(
                msg.seq,
                "home drive mount operation already active",
                &self.writer,
            ),
            Err(HomeDriveMountSubmitError::Disconnected) => Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "home drive mount worker stopped",
            )),
            Err(HomeDriveMountSubmitError::Start(error)) => send_error_response(
                msg.seq,
                &format!("failed to start home drive mount worker: {error}"),
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
