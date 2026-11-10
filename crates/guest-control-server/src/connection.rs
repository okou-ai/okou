mod dispatcher;

use std::io::{self, Read};
use std::os::unix::net::UnixStream;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use guest_contracts::exec_terminal::EXEC_OUTPUT_DRAIN_DEADLINE;
use guest_control_proto::{
    self, DecodeWithError, MSG_EXEC_CANCEL, MSG_EXEC_CONTROL, MSG_EXEC_START,
    MSG_GUEST_DNS_READINESS, MSG_GUEST_STATE_RESTORE, MSG_GUEST_STORAGE_MANIFEST,
    MSG_HOME_DRIVE_MOUNT, MSG_MEMORY_SNAPSHOT, MSG_QUIESCE_OPERATIONS, MSG_READY,
    MSG_RESUME_OPERATIONS, MSG_WRITE_FILE, MSG_WRITE_FILES, MSG_WRITE_PRIVATE_FILES,
};

use self::dispatcher::{ConnectionDispatcher, DispatchOutcome};
use crate::agent_command::GuestAgentProgram;
use crate::error::to_io_error;
use crate::guest_dns_readiness::GuestDnsReadinessProgram;
use crate::guest_state_restore::GuestStateRestoreProgram;
use crate::guest_storage_manifest::GuestStorageManifestProgram;
use crate::home_drive_mount::HomeDriveMountProgram;
use crate::log::log;
use crate::memory_snapshot::MeminfoSource;
use crate::process_containment::ProcessContainmentMode;
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
            | MSG_WRITE_FILES
            | MSG_WRITE_PRIVATE_FILES
            | MSG_GUEST_DNS_READINESS
            | MSG_GUEST_STATE_RESTORE
            | MSG_GUEST_STORAGE_MANIFEST
            | guest_control_proto::MSG_GUEST_AGENT_INSTRUCTIONS
            | MSG_HOME_DRIVE_MOUNT
            | MSG_QUIESCE_OPERATIONS
            | MSG_RESUME_OPERATIONS
            | MSG_MEMORY_SNAPSHOT
    )
}

struct ConnectionPrograms {
    guest_agent: GuestAgentProgram,
    guest_dns_readiness: GuestDnsReadinessProgram,
    guest_state_restore: GuestStateRestoreProgram,
    guest_storage_manifest: GuestStorageManifestProgram,
    home_drive_mount: HomeDriveMountProgram,
}

impl ConnectionPrograms {
    fn production() -> Self {
        Self {
            guest_agent: GuestAgentProgram::production(),
            guest_dns_readiness: GuestDnsReadinessProgram::production(),
            guest_state_restore: GuestStateRestoreProgram::production(),
            guest_storage_manifest: GuestStorageManifestProgram::production(),
            home_drive_mount: HomeDriveMountProgram::production(),
        }
    }
}

/// Connect to vsock (Linux only - this binary runs inside Firecracker VM)
#[cfg(target_os = "linux")]
pub fn connect_vsock() -> io::Result<UnixStream> {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

    // SAFETY: Creating a vsock socket with valid constants. fd is checked for errors below.
    let fd = unsafe { libc::socket(libc::AF_VSOCK, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fd is a newly created socket and ownership is adopted exactly once.
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };

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
            fd.as_raw_fd(),
            &addr as *const libc::sockaddr_vm as *const libc::sockaddr,
            std::mem::size_of::<libc::sockaddr_vm>() as u32,
        )
    };

    if ret < 0 {
        return Err(io::Error::last_os_error());
    }

    Ok(UnixStream::from(fd))
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

/// Handles a test DNS readiness executable with a gate before its timeout.
///
/// Use a zero-capacity channel. Receiving the owned child's PID starts the timer;
/// receive or drop the receiver before joining the connection so assertion-failure
/// cleanup can proceed.
#[doc(hidden)]
pub fn handle_connection_with_test_dns_readiness_timeout_gate(
    stream: UnixStream,
    program: std::path::PathBuf,
    timeout_gate: std::sync::mpsc::SyncSender<u32>,
) -> io::Result<()> {
    handle_connection_with_mode_and_program(
        stream,
        ProcessContainmentMode::TestNoop,
        EXEC_OUTPUT_DRAIN_DEADLINE,
        ConnectionPrograms {
            guest_dns_readiness: GuestDnsReadinessProgram::for_test_timeout(program, timeout_gate),
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

/// Handles a host-side test connection with a test home mount executable
/// and child timeout.
#[doc(hidden)]
pub fn handle_connection_with_test_home_drive_mount_program(
    stream: UnixStream,
    program: std::path::PathBuf,
    timeout_ms: u32,
) -> io::Result<()> {
    handle_connection_with_mode_and_program(
        stream,
        ProcessContainmentMode::TestNoop,
        EXEC_OUTPUT_DRAIN_DEADLINE,
        ConnectionPrograms {
            home_drive_mount: HomeDriveMountProgram::for_test(program, timeout_ms),
            ..ConnectionPrograms::production()
        },
        MeminfoSource::production(),
    )
}

/// Handles a test home mount executable with a readiness gate before its timeout.
///
/// Use a zero-capacity channel. Receiving the owned child's PID starts the timer;
/// receive or drop the receiver before joining the connection so assertion-failure
/// cleanup can proceed.
#[doc(hidden)]
pub fn handle_connection_with_test_home_drive_mount_timeout_gate(
    stream: UnixStream,
    program: std::path::PathBuf,
    timeout_ms: u32,
    timeout_gate: std::sync::mpsc::SyncSender<u32>,
) -> io::Result<()> {
    handle_connection_with_mode_and_program(
        stream,
        ProcessContainmentMode::TestNoop,
        EXEC_OUTPUT_DRAIN_DEADLINE,
        ConnectionPrograms {
            home_drive_mount: HomeDriveMountProgram::for_test_timeout(
                program,
                timeout_ms,
                timeout_gate,
            ),
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
mod tests;
