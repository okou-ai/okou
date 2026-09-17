use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io;
use std::net::Shutdown;
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use guest_contracts::exec_terminal::{
    EXEC_PROCESS_CONTAINMENT_KILL_EMPTY_TIMEOUT, EXEC_PROCESS_CONTAINMENT_REMOVE_TIMEOUT,
    EXEC_PROCESS_CONTAINMENT_TERM_GRACE,
};
use guest_contracts::process_containment::{
    AGENT_MEMORY_MIN_BYTES, CGROUP_V2_MOUNT_PATH, CONTROL_CGROUP_NAME, CONTROL_CPU_WEIGHT,
    EXEC_CGROUP_BASE_PATH, EXEC_CGROUP_NAME_PREFIX, REQUIRED_CGROUP_CONTROLLERS,
    REQUIRED_CGROUP_SUBTREE_CONTROL, RUNTIME_CGROUP_NAME, TOOL_CGROUP_NAME_PREFIX,
    TOOL_MEMORY_OOM_GROUP, TOOLS_CGROUP_NAME, WORKLOAD_CGROUP_NAME, WORKLOAD_MEMORY_OOM_GROUP,
    WorkloadResourceEvents, WorkloadResourcePolicy,
};
use guest_contracts::storage_resources::StorageResourceUsage;
use guest_control_proto::ExecProcessRole;

use crate::log::log;

mod storage_resources;

use storage_resources::{StorageOperation, read_resource_file};

const CGROUP_EVENTS_FILE: &str = "cgroup.events";
const CGROUP_KILL_FILE: &str = "cgroup.kill";
const CGROUP_PROCS_FILE: &str = "cgroup.procs";
const CGROUP_SUBTREE_CONTROL_FILE: &str = "cgroup.subtree_control";
const CPU_MAX_FILE: &str = "cpu.max";
const CPU_STAT_FILE: &str = "cpu.stat";
const CPU_WEIGHT_FILE: &str = "cpu.weight";
const MEMORY_EVENTS_FILE: &str = "memory.events";
const MEMORY_HIGH_FILE: &str = "memory.high";
const MEMORY_MAX_FILE: &str = "memory.max";
const MEMORY_MIN_FILE: &str = "memory.min";
const MEMORY_OOM_GROUP_FILE: &str = "memory.oom.group";
const PIDS_EVENTS_FILE: &str = "pids.events";
const PIDS_MAX_FILE: &str = "pids.max";
const POLL_INTERVAL: Duration = Duration::from_millis(10);
const WORKLOAD_BOOTSTRAP_ENDPOINT_SUFFIX: &str = "-workload-placement";
const TOOL_PLACEMENT_ENDPOINT_SUFFIX: &str = "-tool-placement";
const TOOL_PLACEMENT_IO_TIMEOUT: Duration = Duration::from_secs(5);
const THREAD_WORKLOAD_BOOTSTRAP: &str = "gctl-workload";
const THREAD_TOOL_PLACEMENT: &str = "gctl-tool-place";
const MEMORY_SUBTREE_CONTROL: &str = "+memory";

static NEXT_CGROUP_ID: AtomicU64 = AtomicU64::new(1);

pub(crate) struct ExecProcessContainment {
    backend: ContainmentBackend,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProcessContainmentCleanupMode {
    Graceful,
    Forced,
}

#[derive(Clone, Copy)]
pub(crate) enum ProcessContainmentMode {
    BuildConfigured,
    TestNoop,
}

enum ContainmentBackend {
    Cgroup(CgroupGuard),
    ProcessGroup,
    TestNoop,
    TestResourceFiles {
        resource_path: PathBuf,
        operation: StorageOperation,
    },
    #[cfg(test)]
    TestDirectory(PathBuf),
}

struct CgroupGuard {
    group_name: String,
    group_path: PathBuf,
    outer_placement: OwnedFd,
    workload_placement: Option<OwnedFd>,
    tools_path: Option<PathBuf>,
    create_elapsed: Duration,
    oom_evidence: Option<Arc<Mutex<crate::oom_evidence::EvidenceMonitor>>>,
    storage_operation: Option<StorageOperation>,
}

pub(crate) struct PreparedProcessContainmentCommand<'a> {
    pub(crate) directory: Option<BorrowedFd<'a>>,
    pub(crate) deny_process_inspection: bool,
}

pub(crate) struct WorkloadPlacementBootstrap {
    endpoint: String,
    tool_endpoint: String,
    setup_elapsed: Duration,
    ready_rx: mpsc::Receiver<io::Result<()>>,
    cancel: Arc<AtomicBool>,
    cancel_wake_writer: Option<OwnedFd>,
    active_tool_placement: Arc<ActiveToolPlacement>,
    workers: Vec<JoinHandle<()>>,
}

#[derive(Default)]
struct ActiveToolPlacement {
    stream: Mutex<Option<Arc<UnixStream>>>,
}

struct ActiveToolPlacementStream {
    active: Arc<ActiveToolPlacement>,
    stream: Arc<UnixStream>,
}

impl ActiveToolPlacement {
    fn register(
        self: &Arc<Self>,
        stream: UnixStream,
        cancel: &AtomicBool,
    ) -> io::Result<Option<ActiveToolPlacementStream>> {
        let mut active = self
            .stream
            .lock()
            .map_err(|_| io::Error::other("active tool placement state is unavailable"))?;
        if cancel.load(Ordering::Acquire) {
            return Ok(None);
        }
        let stream = Arc::new(stream);
        *active = Some(Arc::clone(&stream));
        Ok(Some(ActiveToolPlacementStream {
            active: Arc::clone(self),
            stream,
        }))
    }

    fn clear(&self) -> io::Result<()> {
        let mut active = self
            .stream
            .lock()
            .map_err(|_| io::Error::other("active tool placement state is unavailable"))?;
        *active = None;
        Ok(())
    }

    fn shutdown(&self) -> io::Result<()> {
        let stream = {
            let mut active = self
                .stream
                .lock()
                .map_err(|_| io::Error::other("active tool placement state is unavailable"))?;
            active.take()
        };
        match stream {
            Some(stream) => stream.shutdown(Shutdown::Both),
            None => Ok(()),
        }
    }
}

impl AsRef<UnixStream> for ActiveToolPlacementStream {
    fn as_ref(&self) -> &UnixStream {
        &self.stream
    }
}

impl Drop for ActiveToolPlacementStream {
    fn drop(&mut self) {
        if let Err(error) = self.active.clear() {
            log(
                "WARN",
                &format!("active tool placement cleanup failed: {error}"),
            );
        }
    }
}

impl WorkloadPlacementBootstrap {
    pub(crate) fn endpoint(&self) -> &str {
        &self.endpoint
    }

    pub(crate) fn tool_endpoint(&self) -> &str {
        &self.tool_endpoint
    }

    pub(crate) fn setup_elapsed(&self) -> Duration {
        self.setup_elapsed
    }

    pub(crate) fn recv_ready_timeout(
        &self,
        timeout: Duration,
    ) -> Result<io::Result<()>, mpsc::RecvTimeoutError> {
        self.ready_rx.recv_timeout(timeout)
    }
}

impl Drop for WorkloadPlacementBootstrap {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Release);
        // Closing the sole pipe writer wakes every worker poll through POLLHUP.
        drop(self.cancel_wake_writer.take());
        if let Err(error) = self.active_tool_placement.shutdown() {
            log(
                "WARN",
                &format!("active tool placement shutdown failed: {error}"),
            );
        }
        for worker in self.workers.drain(..) {
            if let Err(error) = worker.join() {
                log(
                    "WARN",
                    &format!("process placement worker panicked: {error:?}"),
                );
            }
        }
    }
}

#[derive(Debug)]
pub(crate) struct ProcessContainmentError {
    stage: &'static str,
    source: io::Error,
}

impl std::fmt::Display for ProcessContainmentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.stage, self.source)
    }
}

impl std::error::Error for ProcessContainmentError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.source)
    }
}

impl ProcessContainmentError {
    fn new(stage: &'static str, source: io::Error) -> Self {
        Self { stage, source }
    }
}

impl ExecProcessContainment {
    pub(crate) fn for_test_storage_resources(
        resource_path: PathBuf,
        run_id: &str,
        sequence: u32,
    ) -> Self {
        Self {
            backend: ContainmentBackend::TestResourceFiles {
                resource_path,
                operation: StorageOperation::new(run_id, sequence, Instant::now()),
            },
        }
    }

    pub(crate) fn create(
        sequence: u32,
        mode: ProcessContainmentMode,
        role: ExecProcessRole,
    ) -> Result<Self, ProcessContainmentError> {
        // The exec request parser admits this role only after validating its
        // fixed Runner-owned helper contract. Workload and Agent roles retain
        // workload cgroup containment.
        if matches!(
            role,
            ExecProcessRole::SessionHistoryIdentityVerifier | ExecProcessRole::CodexSessionCleanup
        ) {
            return Ok(Self {
                backend: ContainmentBackend::ProcessGroup,
            });
        }
        if use_test_noop_backend(mode) {
            return Ok(Self {
                backend: ContainmentBackend::TestNoop,
            });
        }

        CgroupGuard::create(sequence, role).map(|guard| Self {
            backend: ContainmentBackend::Cgroup(guard),
        })
    }

    pub(crate) fn prepare_command(&self) -> PreparedProcessContainmentCommand<'_> {
        match &self.backend {
            ContainmentBackend::Cgroup(guard) => guard.prepare_command(),
            ContainmentBackend::ProcessGroup
            | ContainmentBackend::TestNoop
            | ContainmentBackend::TestResourceFiles { .. } => PreparedProcessContainmentCommand {
                directory: None,
                deny_process_inspection: false,
            },
            #[cfg(test)]
            ContainmentBackend::TestDirectory(_) => PreparedProcessContainmentCommand {
                directory: None,
                deny_process_inspection: false,
            },
        }
    }

    pub(crate) fn with_storage_resources(mut self, run_id: &str, sequence: u32) -> Self {
        if let ContainmentBackend::Cgroup(guard) = &mut self.backend {
            guard.storage_operation = Some(StorageOperation::new(run_id, sequence, Instant::now()));
        }
        self
    }

    pub(crate) fn create_elapsed(&self) -> Duration {
        match &self.backend {
            ContainmentBackend::Cgroup(guard) => guard.create_elapsed,
            ContainmentBackend::ProcessGroup
            | ContainmentBackend::TestNoop
            | ContainmentBackend::TestResourceFiles { .. } => Duration::ZERO,
            #[cfg(test)]
            ContainmentBackend::TestDirectory(_) => Duration::ZERO,
        }
    }

    pub(crate) fn requires_pre_reap_process_group_cleanup(&self) -> bool {
        matches!(self.backend, ContainmentBackend::ProcessGroup)
    }

    pub(crate) fn start_workload_placement_bootstrap(
        &self,
        control_endpoint: &str,
        expected_uid: libc::uid_t,
    ) -> Result<Option<WorkloadPlacementBootstrap>, ProcessContainmentError> {
        match &self.backend {
            ContainmentBackend::Cgroup(guard) => guard
                .start_workload_placement_bootstrap(control_endpoint, expected_uid)
                .map(Some),
            ContainmentBackend::ProcessGroup
            | ContainmentBackend::TestNoop
            | ContainmentBackend::TestResourceFiles { .. } => Ok(None),
            #[cfg(test)]
            ContainmentBackend::TestDirectory(_) => Ok(None),
        }
    }

    pub(crate) fn cleanup(
        self,
        mode: ProcessContainmentCleanupMode,
    ) -> Result<(), ProcessContainmentError> {
        self.cleanup_with_evidence(mode, false).map(|_| ())
    }

    pub(crate) fn capture_error(&self) {
        if let ContainmentBackend::Cgroup(guard) = &self.backend
            && let Some(monitor) = &guard.oom_evidence
            && let Ok(mut monitor) = monitor.lock()
        {
            monitor.capture(guest_contracts::oom_evidence::CaptureReason::CliError);
        }
    }

    pub(crate) fn cleanup_with_evidence(
        self,
        mode: ProcessContainmentCleanupMode,
        process_completed: bool,
    ) -> Result<Option<String>, ProcessContainmentError> {
        self.cleanup_with_outputs(mode, &mut None, process_completed)
    }

    pub(crate) fn cleanup_with_storage_resources(
        self,
        mode: ProcessContainmentCleanupMode,
        resources: &mut Option<StorageResourceUsage>,
    ) -> Result<(), ProcessContainmentError> {
        self.cleanup_with_outputs(mode, resources, false)
            .map(|_| ())
    }

    fn cleanup_with_outputs(
        self,
        mode: ProcessContainmentCleanupMode,
        resources: &mut Option<StorageResourceUsage>,
        process_completed: bool,
    ) -> Result<Option<String>, ProcessContainmentError> {
        match self.backend {
            ContainmentBackend::Cgroup(guard) => guard.cleanup(mode, resources, process_completed),
            ContainmentBackend::ProcessGroup | ContainmentBackend::TestNoop => Ok(None),
            ContainmentBackend::TestResourceFiles {
                resource_path,
                operation,
            } => {
                let snapshot_started = Instant::now();
                let events = ResourceEventFiles::read(&resource_path);
                *resources = Some(operation.collect(
                    &format!("exec-1-{}-1", operation.sequence),
                    &resource_path,
                    mode,
                    snapshot_started,
                    &events,
                ));
                Ok(None)
            }
            #[cfg(test)]
            ContainmentBackend::TestDirectory(group_path) => fs::remove_dir(group_path)
                .map(|()| None)
                .map_err(|error| ProcessContainmentError::new("remove test cgroup", error)),
        }
    }
}

pub(crate) fn verify_exec_process_containment_empty(
    mode: ProcessContainmentMode,
) -> Result<(), ProcessContainmentError> {
    if use_test_noop_backend(mode) {
        return Ok(());
    }
    verify_exec_process_containment_empty_in(Path::new(EXEC_CGROUP_BASE_PATH))
}

fn use_test_noop_backend(mode: ProcessContainmentMode) -> bool {
    // Host-side connection tests pass TestNoop explicitly, while library unit
    // tests and downstream test-support builds select it at compile time.
    // Controlled containment tests exercise real behavior through paths they own.
    matches!(mode, ProcessContainmentMode::TestNoop) || cfg!(test) || cfg!(feature = "test-support")
}

fn verify_exec_process_containment_empty_in(
    base_path: &Path,
) -> Result<(), ProcessContainmentError> {
    for entry in fs::read_dir(base_path)
        .map_err(|error| ProcessContainmentError::new("read exec cgroup base", error))?
    {
        let entry =
            entry.map_err(|error| ProcessContainmentError::new("read exec cgroup entry", error))?;
        if entry
            .file_type()
            .map_err(|error| ProcessContainmentError::new("inspect exec cgroup entry", error))?
            .is_dir()
        {
            return Err(ProcessContainmentError::new(
                "verify exec cgroup empty",
                io::Error::other("exec operation cgroup remains after quiesce"),
            ));
        }
    }

    if read_populated(base_path)? {
        return Err(ProcessContainmentError::new(
            "verify exec cgroup empty",
            io::Error::other("exec cgroup remains populated after quiesce"),
        ));
    }
    Ok(())
}

impl CgroupGuard {
    fn create(sequence: u32, role: ExecProcessRole) -> Result<Self, ProcessContainmentError> {
        let policy = workload_resource_policy(role)?;
        Self::create_in(Path::new(EXEC_CGROUP_BASE_PATH), sequence, role, policy)
    }

    fn create_in(
        base_path: &Path,
        sequence: u32,
        role: ExecProcessRole,
        policy: WorkloadResourcePolicy,
    ) -> Result<Self, ProcessContainmentError> {
        let trusted_control = role == ExecProcessRole::Agent;
        let started = Instant::now();
        let id = NEXT_CGROUP_ID.fetch_add(1, Ordering::Relaxed);
        let group_name = format!(
            "{EXEC_CGROUP_NAME_PREFIX}{}-{sequence}-{id}",
            std::process::id()
        );
        let group_path = base_path.join(&group_name);
        fs::create_dir(&group_path)
            .map_err(|error| ProcessContainmentError::new("create cgroup", error))?;

        let setup: Result<(OwnedFd, Option<OwnedFd>, Option<PathBuf>), ProcessContainmentError> =
            (|| {
                enable_required_controllers(&group_path)?;
                let control_path = group_path.join(CONTROL_CGROUP_NAME);
                let workload_path = group_path.join(WORKLOAD_CGROUP_NAME);
                fs::create_dir(&control_path).map_err(|error| {
                    ProcessContainmentError::new("create control cgroup", error)
                })?;
                fs::create_dir(&workload_path).map_err(|error| {
                    ProcessContainmentError::new("create workload cgroup", error)
                })?;
                configure_resource_policy(
                    &group_path,
                    &control_path,
                    &workload_path,
                    trusted_control,
                    policy,
                )?;

                let (workload_placement_path, tools_path) = if trusted_control {
                    enable_required_controllers(&workload_path)?;
                    let runtime_path = workload_path.join(RUNTIME_CGROUP_NAME);
                    let tools_path = workload_path.join(TOOLS_CGROUP_NAME);
                    fs::create_dir(&runtime_path).map_err(|error| {
                        ProcessContainmentError::new("create runtime cgroup", error)
                    })?;
                    write_cgroup_value(
                        &runtime_path,
                        MEMORY_MIN_FILE,
                        &policy.runtime_memory_min_bytes.to_string(),
                        "protect native agent runtime memory",
                    )?;
                    fs::create_dir(&tools_path).map_err(|error| {
                        ProcessContainmentError::new("create tools cgroup", error)
                    })?;
                    write_cgroup_value(
                        &tools_path,
                        CGROUP_SUBTREE_CONTROL_FILE,
                        MEMORY_SUBTREE_CONTROL,
                        "enable tool memory controller",
                    )?;
                    write_cgroup_value(
                        &tools_path,
                        MEMORY_OOM_GROUP_FILE,
                        WORKLOAD_MEMORY_OOM_GROUP,
                        "configure tools memory.oom.group",
                    )?;
                    (runtime_path, Some(tools_path))
                } else {
                    (workload_path.clone(), None)
                };

                let outer_path = if trusted_control {
                    &control_path
                } else {
                    &workload_path
                };
                // Direct creation needs the cgroup directory, not cgroup.procs.
                // It stays private to this owner; runtime/tool brokers retain
                // their separate, write-only placement descriptors.
                let outer_placement = OpenOptions::new()
                    .read(true)
                    .custom_flags(libc::O_DIRECTORY | libc::O_CLOEXEC)
                    .open(outer_path)
                    .and_then(|file| crate::process::private_descriptor(file.into()))
                    .map_err(|error| {
                        ProcessContainmentError::new("open outer cgroup directory", error)
                    })?;
                let workload_placement = if trusted_control {
                    Some(open_placement(
                        &workload_placement_path,
                        "open workload cgroup.procs",
                    )?)
                } else {
                    None
                };
                Ok((outer_placement, workload_placement, tools_path))
            })();

        let (outer_placement, workload_placement, tools_path) = match setup {
            Ok(placements) => placements,
            Err(original) => {
                if let Err(rollback) = remove_cgroup_hierarchy(&group_path) {
                    log(
                        "ERROR",
                        &format!(
                            "exec process containment creation rollback failed group={group_name} original_stage={} original_error={} rollback_stage={} rollback_error={}",
                            original.stage, original.source, rollback.stage, rollback.source
                        ),
                    );
                }
                return Err(original);
            }
        };

        Ok(Self {
            oom_evidence: trusted_control
                .then(|| crate::oom_evidence::EvidenceMonitor::new(group_path.clone()))
                .flatten()
                .map(|monitor| Arc::new(Mutex::new(monitor))),
            group_name,
            group_path,
            outer_placement,
            workload_placement,
            tools_path,
            create_elapsed: started.elapsed(),
            storage_operation: None,
        })
    }

    fn prepare_command(&self) -> PreparedProcessContainmentCommand<'_> {
        let trusted_control = self.workload_placement.is_some();
        PreparedProcessContainmentCommand {
            directory: Some(self.outer_placement.as_fd()),
            deny_process_inspection: trusted_control,
        }
    }

    fn start_workload_placement_bootstrap(
        &self,
        control_endpoint: &str,
        expected_uid: libc::uid_t,
    ) -> Result<WorkloadPlacementBootstrap, ProcessContainmentError> {
        let started = Instant::now();
        let placement = self
            .workload_placement
            .as_ref()
            .ok_or_else(|| {
                ProcessContainmentError::new(
                    "prepare workload placement bootstrap",
                    io::Error::other("trusted control cgroup has no workload placement capability"),
                )
            })?
            .try_clone()
            .map_err(|error| {
                ProcessContainmentError::new("clone workload cgroup.procs for bootstrap", error)
            })?;
        let endpoint = format!("{control_endpoint}{WORKLOAD_BOOTSTRAP_ENDPOINT_SUFFIX}");
        let listener = process_control_ipc::bind_abstract_listener(&endpoint).map_err(|error| {
            ProcessContainmentError::new("bind workload placement bootstrap endpoint", error)
        })?;
        let tool_endpoint = format!("{control_endpoint}{TOOL_PLACEMENT_ENDPOINT_SUFFIX}");
        let tool_listener = process_control_ipc::bind_abstract_listener(&tool_endpoint)
            .map_err(|error| ProcessContainmentError::new("bind tool placement endpoint", error))?;
        let expected_cgroup = self.group_path.join(CONTROL_CGROUP_NAME);
        let expected_runtime_cgroup = self
            .group_path
            .join(WORKLOAD_CGROUP_NAME)
            .join(RUNTIME_CGROUP_NAME);
        let tools_path = self.tools_path.clone().ok_or_else(|| {
            ProcessContainmentError::new(
                "prepare tool placement broker",
                io::Error::other("trusted control cgroup has no tools domain"),
            )
        })?;
        let (cancel_reader, cancel_wake_writer) = placement_cancel_pipe().map_err(|error| {
            ProcessContainmentError::new("prepare placement cancellation", error)
        })?;
        let cancel_reader = Arc::new(cancel_reader);
        let workload_cancel_reader = Arc::clone(&cancel_reader);
        let tool_cancel_reader = Arc::clone(&cancel_reader);
        let active_tool_placement = Arc::new(ActiveToolPlacement::default());
        let worker_active_tool_placement = Arc::clone(&active_tool_placement);
        let mut cancel_wake_writer = Some(cancel_wake_writer);
        let cancel = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = mpsc::channel();
        let worker_cancel = Arc::clone(&cancel);
        let oom_evidence = self.oom_evidence.clone();
        let workload_worker = thread::Builder::new()
            .name(THREAD_WORKLOAD_BOOTSTRAP.to_owned())
            .spawn(move || {
                let result = serve_workload_placement(
                    listener,
                    placement,
                    expected_uid,
                    &expected_cgroup,
                    &worker_cancel,
                    workload_cancel_reader.as_raw_fd(),
                );
                match result {
                    Ok(stream) => {
                        let _ = ready_tx.send(Ok(()));
                        if let Some(evidence) = oom_evidence {
                            serve_oom_evidence(
                                stream,
                                evidence,
                                expected_uid,
                                &expected_cgroup,
                                &worker_cancel,
                                workload_cancel_reader.as_raw_fd(),
                            );
                        }
                    }
                    Err(error) => {
                        let _ = ready_tx.send(Err(error));
                    }
                }
            })
            .map_err(|error| {
                ProcessContainmentError::new("start workload placement bootstrap worker", error)
            })?;
        let tool_cancel = Arc::clone(&cancel);
        let tool_worker = match thread::Builder::new()
            .name(THREAD_TOOL_PLACEMENT.to_owned())
            .spawn(move || {
                serve_tool_placement(
                    tool_listener,
                    expected_uid,
                    &expected_runtime_cgroup,
                    &tools_path,
                    &worker_active_tool_placement,
                    &tool_cancel,
                    tool_cancel_reader.as_raw_fd(),
                );
            }) {
            Ok(worker) => worker,
            Err(error) => {
                cancel.store(true, Ordering::Release);
                drop(cancel_wake_writer.take());
                let _ = workload_worker.join();
                return Err(ProcessContainmentError::new(
                    "start tool placement worker",
                    error,
                ));
            }
        };
        Ok(WorkloadPlacementBootstrap {
            endpoint,
            tool_endpoint,
            setup_elapsed: started.elapsed(),
            ready_rx,
            cancel,
            cancel_wake_writer,
            active_tool_placement,
            workers: vec![workload_worker, tool_worker],
        })
    }

    fn cleanup(
        self,
        mode: ProcessContainmentCleanupMode,
        resources: &mut Option<StorageResourceUsage>,
        process_completed: bool,
    ) -> Result<Option<String>, ProcessContainmentError> {
        let started = Instant::now();
        let CgroupGuard {
            group_name,
            group_path,
            outer_placement,
            workload_placement,
            tools_path: _,
            create_elapsed,
            oom_evidence,
            storage_operation,
        } = self;
        drop(outer_placement);
        drop(workload_placement);

        // Capture before any cleanup enumeration, signal or removal. Placement
        // workers have joined, so this lock cannot wait behind socket IO.
        let evidence = oom_evidence.and_then(|monitor| {
            Some(
                monitor
                    .lock()
                    .ok()?
                    .capture(guest_contracts::oom_evidence::CaptureReason::Cleanup),
            )
        });
        log_resource_events(
            &group_name,
            &group_path.join(WORKLOAD_CGROUP_NAME),
            storage_operation.as_ref(),
            mode,
            resources,
            evidence.as_ref().filter(|_| process_completed),
        );
        let oom_diagnostic = evidence.and_then(|evidence| {
            if evidence.incidents.is_empty() {
                return None;
            }
            let json = serde_json::to_string(&evidence).ok()?;
            (json.len() <= guest_contracts::oom_evidence::MAX_EVIDENCE_BYTES)
                .then(|| format!("{}{json}", guest_contracts::oom_evidence::EVIDENCE_PREFIX))
        });
        let result = cleanup_cgroup(&group_path, mode);
        match result {
            Ok(report) => {
                let evidence = cleanup_evidence_line(
                    &group_name,
                    mode,
                    &report,
                    create_elapsed,
                    started.elapsed(),
                );
                if let Some(evidence) = evidence.as_deref() {
                    log("INFO", evidence);
                }
                Ok(oom_diagnostic.or(evidence))
            }
            Err(error) => {
                log(
                    "ERROR",
                    &format!(
                        "exec process containment cleanup failed group={group_name} mode={mode:?} stage={} error={}",
                        error.stage, error.source
                    ),
                );
                Err(error)
            }
        }
    }
}

fn workload_resource_policy(
    role: ExecProcessRole,
) -> Result<WorkloadResourcePolicy, ProcessContainmentError> {
    WorkloadResourcePolicy::for_current_guest_capacity(role == ExecProcessRole::Agent).map_err(
        |message| {
            ProcessContainmentError::new(
                "derive workload resource policy",
                io::Error::other(message),
            )
        },
    )
}

fn enable_required_controllers(group_path: &Path) -> Result<(), ProcessContainmentError> {
    fs::write(
        group_path.join(CGROUP_SUBTREE_CONTROL_FILE),
        REQUIRED_CGROUP_SUBTREE_CONTROL.as_bytes(),
    )
    .map_err(|error| ProcessContainmentError::new("enable cgroup controllers", error))?;
    let enabled = fs::read_to_string(group_path.join(CGROUP_SUBTREE_CONTROL_FILE))
        .map_err(|error| ProcessContainmentError::new("read cgroup controllers", error))?;
    let enabled = enabled
        .split_ascii_whitespace()
        .map(|controller| controller.trim_start_matches('+'))
        .collect::<HashSet<_>>();
    if REQUIRED_CGROUP_CONTROLLERS
        .into_iter()
        .all(|controller| enabled.contains(controller))
    {
        return Ok(());
    }
    Err(ProcessContainmentError::new(
        "verify cgroup controllers",
        io::Error::other("operation cgroup is missing a required controller"),
    ))
}

fn configure_resource_policy(
    group_path: &Path,
    control_path: &Path,
    workload_path: &Path,
    trusted_control: bool,
    policy: WorkloadResourcePolicy,
) -> Result<(), ProcessContainmentError> {
    write_cgroup_value(
        workload_path,
        CPU_MAX_FILE,
        &format!("{} {}", policy.cpu_quota_us, policy.cpu_period_us),
        "configure workload cpu.max",
    )?;
    write_cgroup_value(
        workload_path,
        MEMORY_HIGH_FILE,
        policy.memory_high,
        "configure workload memory.high",
    )?;
    write_cgroup_value(
        workload_path,
        MEMORY_MAX_FILE,
        &policy.memory_max_bytes.to_string(),
        "configure workload memory.max",
    )?;
    write_cgroup_value(
        workload_path,
        MEMORY_OOM_GROUP_FILE,
        policy.memory_oom_group,
        "configure workload memory.oom.group",
    )?;
    write_cgroup_value(
        workload_path,
        PIDS_MAX_FILE,
        policy.pids_max,
        "configure workload pids.max",
    )?;

    if trusted_control {
        let weight = CONTROL_CPU_WEIGHT.to_string();
        write_cgroup_value(
            group_path,
            CPU_WEIGHT_FILE,
            &weight,
            "prioritize controlled operation CPU",
        )?;
        write_cgroup_value(
            control_path,
            CPU_WEIGHT_FILE,
            &weight,
            "prioritize Guest Agent CPU",
        )?;
        write_cgroup_value(
            group_path,
            MEMORY_MIN_FILE,
            &AGENT_MEMORY_MIN_BYTES.to_string(),
            "protect controlled operation memory",
        )?;
        write_cgroup_value(
            control_path,
            MEMORY_MIN_FILE,
            &policy.control_memory_min_bytes.to_string(),
            "protect Guest Agent memory",
        )?;
        write_cgroup_value(
            workload_path,
            MEMORY_MIN_FILE,
            &policy.runtime_memory_min_bytes.to_string(),
            "preserve runtime ancestor memory protection",
        )?;
    }
    Ok(())
}

fn write_cgroup_value(
    group_path: &Path,
    filename: &str,
    value: &str,
    stage: &'static str,
) -> Result<(), ProcessContainmentError> {
    fs::write(group_path.join(filename), value.as_bytes())
        .map_err(|error| ProcessContainmentError::new(stage, error))
}

fn open_placement(
    group_path: &Path,
    stage: &'static str,
) -> Result<OwnedFd, ProcessContainmentError> {
    OpenOptions::new()
        .write(true)
        .open(group_path.join(CGROUP_PROCS_FILE))
        .map(Into::into)
        .map_err(|error| ProcessContainmentError::new(stage, error))
}

fn log_resource_events(
    group_name: &str,
    workload_path: &Path,
    storage_operation: Option<&StorageOperation>,
    mode: ProcessContainmentCleanupMode,
    resources: &mut Option<StorageResourceUsage>,
    evidence: Option<&guest_contracts::oom_evidence::OomEvidence>,
) {
    let snapshot_started = Instant::now();
    let files = ResourceEventFiles::read(workload_path);
    if let Some(operation) = storage_operation {
        *resources =
            Some(operation.collect(group_name, workload_path, mode, snapshot_started, &files));
    }
    let events = match files.into_events() {
        Ok(events) => events,
        Err(error) => {
            log(
                "WARN",
                &format!(
                    "exec workload resource diagnostics unavailable group={group_name} error={error}"
                ),
            );
            return;
        }
    };
    if let Some(hard_limit) = events.hard_limit_diagnostic() {
        let contained = mode == ProcessContainmentCleanupMode::Graceful
            && evidence
                .is_some_and(|evidence| evidence.proves_contained_resource_limit(&hard_limit));
        let classification = if contained {
            "contained_tool_oom"
        } else {
            "unproven_containment"
        };
        log(
            if contained { "INFO" } else { "WARN" },
            &format!(
                "exec workload hard resource limit reached group={group_name} oom_classification={classification} memory_max={} memory_oom={} memory_oom_kill={} memory_oom_group_kill={} pids_max={}",
                hard_limit.memory_max_events,
                hard_limit.memory_oom_events,
                hard_limit.memory_oom_kill_events,
                hard_limit.memory_oom_group_kill_events,
                hard_limit.pids_max_events
            ),
        );
    }
    if events.has_material_pressure() {
        log(
            "INFO",
            &format!(
                "exec workload resource pressure observed group={group_name} cpu_nr_throttled={} cpu_throttled_usec={} memory_high={}",
                events.cpu_nr_throttled, events.cpu_throttled_usec, events.memory_high
            ),
        );
    }
}

struct ResourceEventFiles {
    cpu: io::Result<String>,
    memory: io::Result<String>,
    pids: io::Result<String>,
}

impl ResourceEventFiles {
    fn read(workload_path: &Path) -> Self {
        Self {
            cpu: read_resource_file(workload_path, CPU_STAT_FILE),
            memory: read_resource_file(workload_path, MEMORY_EVENTS_FILE),
            pids: read_resource_file(workload_path, PIDS_EVENTS_FILE),
        }
    }

    fn into_events(self) -> io::Result<WorkloadResourceEvents> {
        WorkloadResourceEvents::from_file_contents(&self.cpu?, &self.memory?, &self.pids?)
    }
}

#[derive(Debug)]
struct CleanupReport {
    descendants_observed: bool,
    cgroup_kill_used: bool,
    initial_members: usize,
    graceful_errors: usize,
}

fn cleanup_evidence_line(
    group_name: &str,
    mode: ProcessContainmentCleanupMode,
    report: &CleanupReport,
    create_elapsed: Duration,
    cleanup_elapsed: Duration,
) -> Option<String> {
    // Healthy exec cleanup is a hot path. Produce evidence only when
    // containment had work beyond removing an empty leaf.
    if !report.descendants_observed && !report.cgroup_kill_used && report.graceful_errors == 0 {
        return None;
    }
    Some(format!(
        "exec process containment cleaned group={group_name} mode={mode:?} descendants_observed={} cgroup_kill_used={} initial_members={} graceful_errors={} create_us={} cleanup_ms={}",
        report.descendants_observed,
        report.cgroup_kill_used,
        report.initial_members,
        report.graceful_errors,
        create_elapsed.as_micros(),
        cleanup_elapsed.as_millis()
    ))
}

fn cleanup_cgroup(
    group_path: &Path,
    mode: ProcessContainmentCleanupMode,
) -> Result<CleanupReport, ProcessContainmentError> {
    let descendants_observed = match read_populated(group_path) {
        Ok(populated) => populated,
        Err(error) => {
            log(
                "WARN",
                &format!(
                    "exec process containment cleanup could not read initial populated state mode={mode:?} error={error}"
                ),
            );
            true
        }
    };
    let mut cgroup_kill_used = false;
    let mut initial_members = 0;
    let mut graceful_errors = 0;

    if descendants_observed && mode == ProcessContainmentCleanupMode::Graceful {
        let leaf_paths = match cgroup_leaf_paths(group_path) {
            Ok(paths) => paths,
            Err(error) => {
                graceful_errors += 1;
                log(
                    "WARN",
                    &format!(
                        "exec process containment graceful leaf enumeration failed error={error}"
                    ),
                );
                Vec::new()
            }
        };
        for leaf_path in leaf_paths {
            match read_member_pids(&leaf_path) {
                Ok(pids) => {
                    initial_members += pids.len();
                    graceful_errors += signal_term(&leaf_path, &pids);
                }
                Err(error) => {
                    graceful_errors += 1;
                    log(
                        "WARN",
                        &format!(
                            "exec process containment graceful enumeration failed leaf={} error={error}",
                            leaf_path.display()
                        ),
                    );
                }
            }
        }

        if let Err(error) = wait_until_empty(group_path, EXEC_PROCESS_CONTAINMENT_TERM_GRACE) {
            log(
                "WARN",
                &format!(
                    "exec process containment graceful wait could not read populated state error={error}"
                ),
            );
        }
    }

    let remains_populated = if mode == ProcessContainmentCleanupMode::Forced {
        true
    } else {
        match read_populated(group_path) {
            Ok(populated) => populated,
            Err(error) => {
                log(
                    "WARN",
                    &format!(
                        "exec process containment cleanup could not confirm empty state before cgroup.kill error={error}"
                    ),
                );
                true
            }
        }
    };
    if remains_populated {
        fs::write(group_path.join(CGROUP_KILL_FILE), b"1")
            .map_err(|error| ProcessContainmentError::new("write cgroup.kill", error))?;
        cgroup_kill_used = true;
        if !wait_until_empty(group_path, EXEC_PROCESS_CONTAINMENT_KILL_EMPTY_TIMEOUT)? {
            return Err(ProcessContainmentError::new(
                "wait for cgroup.kill",
                io::Error::new(
                    io::ErrorKind::TimedOut,
                    "cgroup remained populated after cgroup.kill",
                ),
            ));
        }
    }

    remove_cgroup_hierarchy(group_path)?;
    Ok(CleanupReport {
        descendants_observed,
        cgroup_kill_used,
        initial_members,
        graceful_errors,
    })
}

fn placement_cancel_pipe() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut fds = [0; 2];
    // SAFETY: `pipe2` initializes two file descriptors in `fds` on success.
    if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: both descriptors were freshly returned by `pipe2` and ownership
    // is transferred to the returned `OwnedFd` values.
    let reader = unsafe { OwnedFd::from_raw_fd(fds[0]) };
    // SAFETY: see above; this is the distinct writer descriptor.
    let writer = unsafe { OwnedFd::from_raw_fd(fds[1]) };
    Ok((reader, writer))
}

enum PlacementWaitOutcome {
    ListenerReady,
    Cancelled,
}

fn wait_for_placement_or_cancelled(
    listener: &UnixListener,
    cancel_fd: RawFd,
) -> io::Result<PlacementWaitOutcome> {
    loop {
        let mut pollfds = [
            libc::pollfd {
                fd: listener.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: cancel_fd,
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        // SAFETY: `pollfds` points to two initialized descriptor entries that
        // remain owned by the caller for the duration of this call.
        let result = unsafe { libc::poll(pollfds.as_mut_ptr(), pollfds.len() as libc::nfds_t, -1) };
        if result > 0 {
            let listener_revents = pollfds[0].revents;
            let cancel_revents = pollfds[1].revents;
            if cancel_revents & (libc::POLLIN | libc::POLLHUP) != 0 {
                return Ok(PlacementWaitOutcome::Cancelled);
            }
            if cancel_revents & (libc::POLLERR | libc::POLLNVAL) != 0 {
                return Err(io::Error::other(
                    "placement cancellation descriptor became unavailable",
                ));
            }
            if listener_revents & libc::POLLIN != 0 {
                return Ok(PlacementWaitOutcome::ListenerReady);
            }
            if listener_revents & libc::POLLNVAL != 0 {
                return Err(io::Error::other(
                    "placement listener descriptor became unavailable",
                ));
            }
            if listener_revents & (libc::POLLERR | libc::POLLHUP) != 0 {
                return Err(listener
                    .take_error()?
                    .unwrap_or_else(|| io::Error::other("placement listener became unavailable")));
            }
            continue;
        }
        if result == 0 {
            continue;
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

fn accept_placement_or_cancelled(
    listener: &UnixListener,
    cancel: &AtomicBool,
    cancel_fd: RawFd,
) -> io::Result<Option<UnixStream>> {
    loop {
        if cancel.load(Ordering::Acquire) {
            return Ok(None);
        }
        match wait_for_placement_or_cancelled(listener, cancel_fd)? {
            PlacementWaitOutcome::Cancelled => return Ok(None),
            PlacementWaitOutcome::ListenerReady => {
                if cancel.load(Ordering::Acquire) {
                    return Ok(None);
                }
                match listener.accept() {
                    Ok((stream, _)) => {
                        if cancel.load(Ordering::Acquire) {
                            return Ok(None);
                        }
                        return Ok(Some(stream));
                    }
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                    Err(error) => return Err(error),
                }
            }
        }
    }
}

fn serve_workload_placement(
    listener: UnixListener,
    placement: OwnedFd,
    expected_uid: libc::uid_t,
    expected_cgroup: &Path,
    cancel: &AtomicBool,
    cancel_fd: RawFd,
) -> io::Result<UnixStream> {
    loop {
        let stream = match accept_placement_or_cancelled(&listener, cancel, cancel_fd) {
            Ok(Some(stream)) => stream,
            Ok(None) => return Err(workload_bootstrap_cancelled()),
            Err(error) => return Err(error),
        };

        match workload_bootstrap_peer_matches(&stream, expected_uid, expected_cgroup) {
            Ok(true) => {
                stream.set_nonblocking(true)?;
                send_workload_placement_or_cancelled(
                    &stream,
                    placement.as_fd(),
                    cancel,
                    cancel_fd,
                )?;
                read_workload_confirmation_or_cancelled(&stream, cancel, cancel_fd)?;
                if !workload_bootstrap_peer_matches(&stream, expected_uid, expected_cgroup)? {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "workload placement peer left the control cgroup before confirmation",
                    ));
                }
                return Ok(stream);
            }
            Ok(false) => {
                log(
                    "WARN",
                    "workload placement bootstrap rejected an unexpected peer",
                );
            }
            Err(error) => {
                log(
                    "WARN",
                    &format!("workload placement bootstrap peer validation failed: {error}"),
                );
            }
        }
    }
}

fn serve_oom_evidence(
    mut stream: UnixStream,
    monitor: Arc<Mutex<crate::oom_evidence::EvidenceMonitor>>,
    expected_uid: libc::uid_t,
    expected_cgroup: &Path,
    cancel: &AtomicBool,
    cancel_fd: RawFd,
) {
    use guest_contracts::oom_evidence::{CaptureReason, EVIDENCE_IO_TIMEOUT, write_evidence};
    use std::io::Read;
    if stream.set_nonblocking(false).is_err()
        || stream.set_read_timeout(Some(EVIDENCE_IO_TIMEOUT)).is_err()
    {
        return;
    }
    loop {
        if wait_placement_stream_or_cancelled(&stream, libc::POLLIN, cancel, cancel_fd).is_err() {
            return;
        }
        if !matches!(
            workload_bootstrap_peer_matches(&stream, expected_uid, expected_cgroup),
            Ok(true)
        ) {
            return;
        }
        let mut request = [0];
        if stream.read_exact(&mut request).is_err() {
            return;
        }
        let reason = match request[0] {
            1 | 3 => CaptureReason::Sample,
            2 | 4 => CaptureReason::CliError,
            _ => return,
        };
        let progress = if request[0] >= 3 {
            let mut bytes = [0; 8];
            if stream.read_exact(&mut bytes).is_err() {
                return;
            }
            Some(u64::from_be_bytes(bytes))
        } else {
            None
        };
        let evidence = match monitor.lock() {
            Ok(mut monitor) => {
                monitor.record_runtime_progress(progress);
                monitor.capture(reason)
            }
            Err(_) => return,
        };
        // Never retain the monitor lock while waiting for a recipient.
        if write_evidence(&stream, &evidence).is_err() {
            return;
        }
    }
}

fn send_workload_placement_or_cancelled(
    stream: &UnixStream,
    placement: std::os::fd::BorrowedFd<'_>,
    cancel: &AtomicBool,
    cancel_fd: RawFd,
) -> io::Result<()> {
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err(workload_bootstrap_cancelled());
        }
        match process_control_ipc::send_workload_placement(stream, placement) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                wait_placement_stream_or_cancelled(stream, libc::POLLOUT, cancel, cancel_fd)?;
            }
            Err(error) => return Err(error),
        }
    }
}

fn read_workload_confirmation_or_cancelled(
    stream: &UnixStream,
    cancel: &AtomicBool,
    cancel_fd: RawFd,
) -> io::Result<()> {
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err(workload_bootstrap_cancelled());
        }
        match process_control_ipc::read_workload_placement_confirmation(stream) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                wait_placement_stream_or_cancelled(stream, libc::POLLIN, cancel, cancel_fd)?;
            }
            Err(error) => return Err(error),
        }
    }
}

fn wait_placement_stream_or_cancelled(
    stream: &UnixStream,
    events: libc::c_short,
    cancel: &AtomicBool,
    cancel_fd: RawFd,
) -> io::Result<()> {
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err(workload_bootstrap_cancelled());
        }
        let mut pollfds = [
            libc::pollfd {
                fd: stream.as_raw_fd(),
                events,
                revents: 0,
            },
            libc::pollfd {
                fd: cancel_fd,
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        // SAFETY: both poll entries reference live descriptors owned by the
        // bootstrap for the duration of this call.
        let result = unsafe { libc::poll(pollfds.as_mut_ptr(), pollfds.len() as libc::nfds_t, -1) };
        if result > 0 {
            let stream_revents = pollfds[0].revents;
            let cancel_revents = pollfds[1].revents;
            if cancel.load(Ordering::Acquire)
                || cancel_revents & (libc::POLLIN | libc::POLLHUP) != 0
            {
                return Err(workload_bootstrap_cancelled());
            }
            if cancel_revents & (libc::POLLERR | libc::POLLNVAL) != 0 {
                return Err(io::Error::other(
                    "placement cancellation descriptor became unavailable",
                ));
            }
            if stream_revents & events != 0 {
                return Ok(());
            }
            if stream_revents & libc::POLLNVAL != 0 {
                return Err(io::Error::other(
                    "workload placement stream descriptor became unavailable",
                ));
            }
            if stream_revents & (libc::POLLERR | libc::POLLHUP) != 0 {
                return Err(stream.take_error()?.unwrap_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "workload placement stream closed before confirmation",
                    )
                }));
            }
            continue;
        }
        if result == 0 {
            continue;
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

fn workload_bootstrap_cancelled() -> io::Error {
    io::Error::new(
        io::ErrorKind::Interrupted,
        "workload placement bootstrap cancelled",
    )
}

fn serve_tool_placement(
    listener: UnixListener,
    expected_uid: libc::uid_t,
    expected_runtime_cgroup: &Path,
    tools_path: &Path,
    active_tool_placement: &Arc<ActiveToolPlacement>,
    cancel: &AtomicBool,
    cancel_fd: RawFd,
) {
    let mut next_tool_id = 1_u64;
    loop {
        let stream = match accept_placement_or_cancelled(&listener, cancel, cancel_fd) {
            Ok(Some(stream)) => stream,
            Ok(None) => return,
            Err(error) => {
                log("WARN", &format!("tool placement accept failed: {error}"));
                return;
            }
        };
        let stream = match active_tool_placement.register(stream, cancel) {
            Ok(Some(stream)) => stream,
            Ok(None) => return,
            Err(error) => {
                log(
                    "WARN",
                    &format!("tool placement stream registration failed: {error}"),
                );
                return;
            }
        };
        if let Err(error) = stream
            .as_ref()
            .set_read_timeout(Some(TOOL_PLACEMENT_IO_TIMEOUT))
        {
            log(
                "WARN",
                &format!("tool placement read timeout setup failed: {error}"),
            );
            continue;
        }
        if let Err(error) = stream
            .as_ref()
            .set_write_timeout(Some(TOOL_PLACEMENT_IO_TIMEOUT))
        {
            log(
                "WARN",
                &format!("tool placement write timeout setup failed: {error}"),
            );
            continue;
        }

        let placement = place_tool_peer(
            stream.as_ref(),
            expected_uid,
            expected_runtime_cgroup,
            tools_path,
            next_tool_id,
        );
        next_tool_id = next_tool_id.saturating_add(1);
        if let Err(error) = placement {
            if cancel.load(Ordering::Acquire) {
                return;
            }
            log("WARN", &format!("tool placement rejected: {error}"));
        }
    }
}

fn place_tool_peer(
    stream: &std::os::unix::net::UnixStream,
    expected_uid: libc::uid_t,
    expected_runtime_cgroup: &Path,
    tools_path: &Path,
    tool_id: u64,
) -> io::Result<()> {
    if !peer_matches(stream, expected_uid, expected_runtime_cgroup)? {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "peer is not in the operation runtime cgroup",
        ));
    }
    reap_empty_tool_cgroups(tools_path)?;
    let tool_path = tools_path.join(format!("{TOOL_CGROUP_NAME_PREFIX}{tool_id}"));
    fs::create_dir(&tool_path)?;
    let placement_result = (|| {
        fs::write(
            tool_path.join(MEMORY_OOM_GROUP_FILE),
            TOOL_MEMORY_OOM_GROUP.as_bytes(),
        )?;
        let placement = OpenOptions::new()
            .write(true)
            .open(tool_path.join(CGROUP_PROCS_FILE))?;
        process_control_ipc::send_tool_placement(stream, placement.as_fd())?;
        process_control_ipc::read_tool_placement_confirmation(stream)?;
        if !peer_matches(stream, expected_uid, &tool_path)? {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "peer did not enter the assigned tool cgroup",
            ));
        }
        process_control_ipc::write_tool_placement_ack(stream)
    })();
    if placement_result.is_err() && matches!(read_populated(&tool_path), Ok(false)) {
        let _ = fs::remove_dir(&tool_path);
    }
    placement_result
}

fn reap_empty_tool_cgroups(tools_path: &Path) -> io::Result<()> {
    for entry in fs::read_dir(tools_path)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir()
            || !entry
                .file_name()
                .as_encoded_bytes()
                .starts_with(TOOL_CGROUP_NAME_PREFIX.as_bytes())
        {
            continue;
        }
        let path = entry.path();
        if matches!(read_populated(&path), Ok(false)) {
            fs::remove_dir(path)?;
        }
    }
    Ok(())
}

fn workload_bootstrap_peer_matches(
    stream: &std::os::unix::net::UnixStream,
    expected_uid: libc::uid_t,
    expected_cgroup: &Path,
) -> io::Result<bool> {
    peer_matches(stream, expected_uid, expected_cgroup)
}

fn peer_matches(
    stream: &std::os::unix::net::UnixStream,
    expected_uid: libc::uid_t,
    expected_cgroup: &Path,
) -> io::Result<bool> {
    // SAFETY: zeroed ucred is a valid output buffer for SO_PEERCRED.
    let mut credentials = unsafe { std::mem::zeroed::<libc::ucred>() };
    let mut credentials_len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: stream is a connected Unix socket and the output pointers refer
    // to a correctly sized ucred buffer and socklen_t.
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            std::ptr::addr_of_mut!(credentials).cast(),
            std::ptr::addr_of_mut!(credentials_len),
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    if credentials_len as usize != std::mem::size_of::<libc::ucred>()
        || credentials.pid <= 0
        || credentials.uid != expected_uid
    {
        return Ok(false);
    }

    let cgroup = fs::read_to_string(format!("/proc/{}/cgroup", credentials.pid));
    let cgroup = match cgroup {
        Ok(cgroup) => cgroup,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    let relative = cgroup.lines().find_map(|line| line.strip_prefix("0::"));
    let Some(relative) = relative.and_then(|path| path.strip_prefix('/')) else {
        return Ok(false);
    };
    Ok(Path::new(CGROUP_V2_MOUNT_PATH).join(relative) == expected_cgroup)
}

fn read_populated(group_path: &Path) -> Result<bool, ProcessContainmentError> {
    let content = fs::read_to_string(group_path.join(CGROUP_EVENTS_FILE))
        .map_err(|error| ProcessContainmentError::new("read cgroup.events", error))?;
    parse_populated(&content).ok_or_else(|| {
        ProcessContainmentError::new(
            "parse cgroup.events",
            io::Error::new(
                io::ErrorKind::InvalidData,
                "cgroup.events is missing populated state",
            ),
        )
    })
}

fn parse_populated(content: &str) -> Option<bool> {
    content.lines().find_map(|line| {
        let (key, value) = line.split_once(' ')?;
        if key != "populated" {
            return None;
        }
        match value {
            "0" => Some(false),
            "1" => Some(true),
            _ => None,
        }
    })
}

fn read_member_pids(group_path: &Path) -> io::Result<Vec<libc::pid_t>> {
    let content = fs::read_to_string(group_path.join(CGROUP_PROCS_FILE))?;
    content
        .lines()
        .map(|line| {
            let pid = line
                .parse::<libc::pid_t>()
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
            if pid <= 0 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "cgroup.procs contains a non-positive pid",
                ));
            }
            Ok(pid)
        })
        .collect()
}

fn signal_term(group_path: &Path, pids: &[libc::pid_t]) -> usize {
    let mut errors = 0;
    let mut candidates = Vec::with_capacity(pids.len());
    for &pid in pids {
        let pidfd = match open_pidfd(pid) {
            Ok(Some(pidfd)) => pidfd,
            Ok(None) => continue,
            Err(_) => {
                errors += 1;
                continue;
            }
        };
        candidates.push((pid, pidfd));
    }
    if candidates.is_empty() {
        return errors;
    }

    // Opening a pidfd stabilizes identity only from that point onward. Recheck
    // membership so a PID recycled after the first enumeration is never
    // signalled through a pidfd opened for an unrelated process.
    let current_members = match read_member_pids(group_path) {
        Ok(pids) => pids.into_iter().collect::<HashSet<_>>(),
        Err(_) => return errors + 1,
    };
    for (pid, pidfd) in candidates {
        if !current_members.contains(&pid) {
            continue;
        }
        if let Err(error) = signal_pidfd(&pidfd, libc::SIGTERM)
            && error.raw_os_error() != Some(libc::ESRCH)
        {
            errors += 1;
        }
    }
    errors
}

fn open_pidfd(pid: libc::pid_t) -> io::Result<Option<OwnedFd>> {
    // SAFETY: `pidfd_open` does not dereference user pointers and the PID came
    // from the kernel-owned cgroup.procs file.
    let result = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
    if result < 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            return Ok(None);
        }
        return Err(error);
    }
    let fd = RawFd::try_from(result)
        .map_err(|_| io::Error::other("pidfd_open returned an invalid file descriptor"))?;
    // SAFETY: `fd` is a new descriptor returned by pidfd_open.
    Ok(Some(unsafe { OwnedFd::from_raw_fd(fd) }))
}

fn signal_pidfd(pidfd: &OwnedFd, signal: libc::c_int) -> io::Result<()> {
    // SAFETY: `pidfd` is valid, signal is a standard signal number, and a null
    // siginfo pointer requests ordinary signal semantics.
    let result = unsafe {
        libc::syscall(
            libc::SYS_pidfd_send_signal,
            pidfd.as_raw_fd(),
            signal,
            std::ptr::null::<libc::siginfo_t>(),
            0,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

fn wait_until_empty(group_path: &Path, timeout: Duration) -> Result<bool, ProcessContainmentError> {
    let deadline = Instant::now() + timeout;
    loop {
        if !read_populated(group_path)? {
            return Ok(true);
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Ok(false);
        }
        thread::sleep(remaining.min(POLL_INTERVAL));
    }
}

fn remove_empty_cgroup_until(
    group_path: &Path,
    deadline: Instant,
) -> Result<(), ProcessContainmentError> {
    #[cfg(test)]
    remove_test_cgroup_interface_files(group_path);
    loop {
        match fs::remove_dir(group_path) {
            Ok(()) => return Ok(()),
            Err(error)
                if matches!(
                    error.raw_os_error(),
                    Some(libc::EBUSY) | Some(libc::ENOTEMPTY)
                ) && Instant::now() < deadline =>
            {
                let remaining = deadline.saturating_duration_since(Instant::now());
                thread::sleep(remaining.min(POLL_INTERVAL));
            }
            Err(error) => {
                return Err(ProcessContainmentError::new("remove cgroup", error));
            }
        }
    }
}

#[cfg(test)]
fn remove_test_cgroup_interface_files(group_path: &Path) {
    for filename in [
        CGROUP_EVENTS_FILE,
        CGROUP_KILL_FILE,
        CGROUP_PROCS_FILE,
        CGROUP_SUBTREE_CONTROL_FILE,
        CPU_MAX_FILE,
        CPU_STAT_FILE,
        CPU_WEIGHT_FILE,
        MEMORY_EVENTS_FILE,
        "memory.events.local",
        "memory.current",
        "memory.peak",
        "memory.stat",
        MEMORY_HIGH_FILE,
        MEMORY_MAX_FILE,
        MEMORY_MIN_FILE,
        MEMORY_OOM_GROUP_FILE,
        PIDS_EVENTS_FILE,
        PIDS_MAX_FILE,
    ] {
        let _ = fs::remove_file(group_path.join(filename));
    }
}

fn cgroup_leaf_paths(group_path: &Path) -> io::Result<Vec<PathBuf>> {
    let mut leaves = Vec::new();
    collect_cgroup_leaves(group_path, &mut leaves)?;
    Ok(leaves)
}

fn collect_cgroup_leaves(group_path: &Path, leaves: &mut Vec<PathBuf>) -> io::Result<()> {
    let children = child_cgroup_paths(group_path)?;
    if children.is_empty() {
        leaves.push(group_path.to_path_buf());
        return Ok(());
    }
    for child in children {
        collect_cgroup_leaves(&child, leaves)?;
    }
    Ok(())
}

fn child_cgroup_paths(group_path: &Path) -> io::Result<Vec<PathBuf>> {
    let mut children = Vec::new();
    for entry in fs::read_dir(group_path)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            children.push(entry.path());
        }
    }
    children.sort();
    Ok(children)
}

fn remove_cgroup_hierarchy(group_path: &Path) -> Result<(), ProcessContainmentError> {
    let deadline = Instant::now() + EXEC_PROCESS_CONTAINMENT_REMOVE_TIMEOUT;
    remove_cgroup_descendants(group_path, deadline)?;
    remove_empty_cgroup_until(group_path, deadline)
}

fn remove_cgroup_descendants(
    group_path: &Path,
    deadline: Instant,
) -> Result<(), ProcessContainmentError> {
    let children = match child_cgroup_paths(group_path) {
        Ok(children) => children,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(ProcessContainmentError::new("read child cgroups", error)),
    };
    for child in children {
        remove_cgroup_descendants(&child, deadline)?;
        match remove_empty_cgroup_until(&child, deadline) {
            Ok(()) => {}
            Err(error) if error.source.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Child, Command, Stdio};
    use std::sync::mpsc;

    struct ChildGuard(Child);

    fn current_cgroup_path() -> PathBuf {
        let current_cgroup = fs::read_to_string("/proc/self/cgroup").unwrap();
        let relative = current_cgroup
            .lines()
            .find_map(|line| line.strip_prefix("0::/"))
            .unwrap();
        Path::new(CGROUP_V2_MOUNT_PATH).join(relative)
    }

    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[test]
    fn oom_evidence_is_captured_before_forced_cleanup_removes_sources() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("exec-281-10-3");
        for suffix in ["", "workload", "workload/runtime", "workload/tools"] {
            let path = root.join(suffix);
            fs::create_dir_all(&path).unwrap();
            fs::write(path.join("cgroup.events"), "populated 0\n").unwrap();
            fs::write(path.join("memory.current"), "4096").unwrap();
            fs::write(path.join("memory.peak"), "8192").unwrap();
            fs::write(path.join("memory.max"), "16384").unwrap();
            fs::write(
                path.join("memory.stat"),
                "anon 1024\nfile 2048\nkernel 1024\n",
            )
            .unwrap();
            fs::write(path.join("memory.events"), "oom 0\noom_kill 0\n").unwrap();
        }
        let monitor = crate::oom_evidence::EvidenceMonitor::without_kernel_for_test(root.clone());
        fs::write(root.join("workload/memory.events"), "oom 1\noom_kill 1\n").unwrap();
        let guard = CgroupGuard {
            group_name: "exec-281-10-3".into(),
            group_path: root.clone(),
            outer_placement: fs::File::open(&root).unwrap().into(),
            workload_placement: None,
            tools_path: None,
            create_elapsed: Duration::ZERO,
            oom_evidence: Some(Arc::new(Mutex::new(monitor))),
            storage_operation: None,
        };
        let mut resources = None;
        let diagnostic = guard
            .cleanup(ProcessContainmentCleanupMode::Forced, &mut resources, false)
            .unwrap()
            .unwrap();
        assert!(!root.exists());
        assert!(resources.is_none());
        let evidence: guest_contracts::oom_evidence::OomEvidence = serde_json::from_str(
            diagnostic
                .strip_prefix(guest_contracts::oom_evidence::EVIDENCE_PREFIX)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(evidence.incidents[0].groups[0].current, Some(4096));
        assert_eq!(evidence.incidents[0].groups[0].delta.oom_kill, Some(1));
        assert!(evidence.incidents[0].before_cleanup);
    }

    #[test]
    fn oom_evidence_exchange_is_owned_by_authenticated_peer_and_cancel_wake() {
        let directory = tempfile::tempdir().unwrap();
        let monitor = crate::oom_evidence::EvidenceMonitor::without_kernel_for_test(
            directory.path().to_path_buf(),
        );
        let (mut client, server) = UnixStream::pair().unwrap();
        let (cancel_reader, cancel_writer) = placement_cancel_pipe().unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let expected = current_cgroup_path();
        // SAFETY: geteuid only returns the current identity.
        let uid = unsafe { libc::geteuid() };
        let (done_tx, done_rx) = mpsc::channel();
        let worker = thread::spawn(move || {
            serve_oom_evidence(
                server,
                Arc::new(Mutex::new(monitor)),
                uid,
                &expected,
                &cancel,
                cancel_reader.as_raw_fd(),
            );
            done_tx.send(()).unwrap();
        });
        client.write_all(&[1]).unwrap();
        let first = guest_contracts::oom_evidence::read_evidence(&client).unwrap();
        client.write_all(&[2]).unwrap();
        let error = guest_contracts::oom_evidence::read_evidence(&client).unwrap();
        assert_eq!(first.operation_id, error.operation_id);
        assert!(first.incidents.is_empty());
        assert_eq!(error.incidents.len(), 1);
        assert!(error.incidents[0].kernel_events.is_empty());
        let progress = 1_000_u64;
        client.write_all(&[3]).unwrap();
        client.write_all(&progress.to_be_bytes()).unwrap();
        let continued = guest_contracts::oom_evidence::read_evidence(&client).unwrap();
        assert_eq!(continued.runtime_progress_at, Some(progress));
        assert_eq!(continued.operation_id, first.operation_id);
        client.write_all(&[4]).unwrap();
        client.write_all(&u64::MAX.to_be_bytes()).unwrap();
        let future = guest_contracts::oom_evidence::read_evidence(&client).unwrap();
        assert_eq!(
            future.runtime_progress_at,
            Some(progress),
            "future timestamps cannot prove survival"
        );
        assert!(
            !future.proves_contained_tool_oom(),
            "native activity alone never proves tool containment"
        );
        drop(cancel_writer);
        done_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        worker.join().unwrap();
    }

    #[test]
    fn parses_recursive_populated_state() {
        assert_eq!(parse_populated("populated 0\nfrozen 0\n"), Some(false));
        assert_eq!(parse_populated("populated 1\nfrozen 0\n"), Some(true));
        assert_eq!(parse_populated("frozen 0\n"), None);
        assert_eq!(parse_populated("populated 2\n"), None);
    }

    #[test]
    fn cleanup_evidence_reports_material_cgroup_kill() {
        let evidence = cleanup_evidence_line(
            "exec-7-1",
            ProcessContainmentCleanupMode::Graceful,
            &CleanupReport {
                descendants_observed: true,
                cgroup_kill_used: true,
                initial_members: 61,
                graceful_errors: 0,
            },
            Duration::from_micros(42),
            Duration::from_millis(17),
        )
        .unwrap();

        assert_eq!(
            evidence,
            "exec process containment cleaned group=exec-7-1 mode=Graceful descendants_observed=true cgroup_kill_used=true initial_members=61 graceful_errors=0 create_us=42 cleanup_ms=17"
        );
    }

    #[test]
    fn cleanup_evidence_omits_empty_healthy_cleanup() {
        assert!(
            cleanup_evidence_line(
                "exec-8-1",
                ProcessContainmentCleanupMode::Graceful,
                &CleanupReport {
                    descendants_observed: false,
                    cgroup_kill_used: false,
                    initial_members: 0,
                    graceful_errors: 0,
                },
                Duration::ZERO,
                Duration::ZERO,
            )
            .is_none()
        );
    }

    #[test]
    fn quiesce_accepts_empty_exec_cgroup_base() {
        let base = tempfile::tempdir().unwrap();
        fs::write(base.path().join(CGROUP_EVENTS_FILE), b"populated 0\n").unwrap();

        verify_exec_process_containment_empty_in(base.path()).unwrap();
    }

    #[test]
    fn quiesce_rejects_stale_exec_cgroup_leaf() {
        let base = tempfile::tempdir().unwrap();
        fs::write(base.path().join(CGROUP_EVENTS_FILE), b"populated 0\n").unwrap();
        fs::create_dir(base.path().join("exec-stale")).unwrap();

        let error = verify_exec_process_containment_empty_in(base.path())
            .expect_err("stale operation leaf must reject quiesce");

        assert_eq!(error.stage, "verify exec cgroup empty");
    }

    #[test]
    fn quiesce_rejects_populated_exec_cgroup_base() {
        let base = tempfile::tempdir().unwrap();
        fs::write(base.path().join(CGROUP_EVENTS_FILE), b"populated 1\n").unwrap();

        let error = verify_exec_process_containment_empty_in(base.path())
            .expect_err("populated containment must reject quiesce");

        assert_eq!(error.stage, "verify exec cgroup empty");
    }

    #[test]
    fn forced_cleanup_attempts_cgroup_kill_when_events_are_unreadable() {
        let group = tempfile::tempdir().unwrap();
        let kill_path = group.path().join(CGROUP_KILL_FILE);
        fs::write(&kill_path, b"").unwrap();

        let error = cleanup_cgroup(group.path(), ProcessContainmentCleanupMode::Forced)
            .expect_err("missing cgroup.events should leave cleanup unproven");

        assert_eq!(error.stage, "read cgroup.events");
        assert_eq!(fs::read(&kill_path).unwrap(), b"1");
    }

    #[test]
    fn graceful_cleanup_attempts_cgroup_kill_when_events_are_unreadable() {
        let group = tempfile::tempdir().unwrap();
        let kill_path = group.path().join(CGROUP_KILL_FILE);
        fs::write(&kill_path, b"").unwrap();

        let error = cleanup_cgroup(group.path(), ProcessContainmentCleanupMode::Graceful)
            .expect_err("missing cgroup.events should leave cleanup unproven");

        assert_eq!(error.stage, "read cgroup.events");
        assert_eq!(fs::read(&kill_path).unwrap(), b"1");
    }

    #[test]
    fn workload_bootstrap_authenticates_peer_uid_and_cgroup() {
        let (peer, _server) = std::os::unix::net::UnixStream::pair().unwrap();
        // SAFETY: geteuid is a simple scalar getter with no preconditions.
        let uid = unsafe { libc::geteuid() };
        let expected = current_cgroup_path();

        assert!(workload_bootstrap_peer_matches(&peer, uid, &expected).unwrap());
        assert!(!workload_bootstrap_peer_matches(&peer, uid.wrapping_add(1), &expected).unwrap());
        assert!(
            !workload_bootstrap_peer_matches(&peer, uid, &expected.join("not-the-peer-cgroup"))
                .unwrap()
        );
    }

    #[test]
    fn workload_bootstrap_completes_after_authenticated_descriptor_confirmation() {
        let endpoint_id = NEXT_CGROUP_ID.fetch_add(1, Ordering::Relaxed);
        let endpoint = format!(
            "vm0-test-workload-confirm-{}-{endpoint_id}",
            std::process::id()
        );
        let listener = process_control_ipc::bind_abstract_listener(&endpoint).unwrap();
        let placement: OwnedFd = tempfile::tempfile().unwrap().into();
        let (cancel_reader, _cancel_writer) = placement_cancel_pipe().unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let server_cancel = Arc::clone(&cancel);
        // SAFETY: geteuid is a simple scalar getter with no preconditions.
        let uid = unsafe { libc::geteuid() };
        let expected = current_cgroup_path();
        let server = thread::spawn(move || {
            serve_workload_placement(
                listener,
                placement,
                uid,
                &expected,
                &server_cancel,
                cancel_reader.as_raw_fd(),
            )
        });

        let client = process_control_ipc::connect_abstract(&endpoint).unwrap();
        let descriptor = process_control_ipc::receive_workload_placement(&client).unwrap();
        process_control_ipc::write_workload_placement_confirmation(&client).unwrap();

        server.join().unwrap().unwrap();
        drop(descriptor);
    }

    #[test]
    fn workload_bootstrap_fails_when_descriptor_recipient_disconnects_before_confirmation() {
        let endpoint_id = NEXT_CGROUP_ID.fetch_add(1, Ordering::Relaxed);
        let endpoint = format!(
            "vm0-test-workload-disconnect-{}-{endpoint_id}",
            std::process::id()
        );
        let listener = process_control_ipc::bind_abstract_listener(&endpoint).unwrap();
        let placement: OwnedFd = tempfile::tempfile().unwrap().into();
        let (cancel_reader, _cancel_writer) = placement_cancel_pipe().unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let server_cancel = Arc::clone(&cancel);
        // SAFETY: geteuid is a simple scalar getter with no preconditions.
        let uid = unsafe { libc::geteuid() };
        let expected = current_cgroup_path();
        let server = thread::spawn(move || {
            serve_workload_placement(
                listener,
                placement,
                uid,
                &expected,
                &server_cancel,
                cancel_reader.as_raw_fd(),
            )
        });

        let client = process_control_ipc::connect_abstract(&endpoint).unwrap();
        let descriptor = process_control_ipc::receive_workload_placement(&client).unwrap();
        drop(client);

        let error = server
            .join()
            .unwrap()
            .expect_err("missing placement confirmation must fail readiness");
        assert!(matches!(
            error.kind(),
            io::ErrorKind::UnexpectedEof
                | io::ErrorKind::ConnectionReset
                | io::ErrorKind::BrokenPipe
        ));
        drop(descriptor);
    }

    #[test]
    fn placement_accept_returns_connection_while_active() {
        let endpoint_id = NEXT_CGROUP_ID.fetch_add(1, Ordering::Relaxed);
        let endpoint = format!(
            "vm0-test-placement-accept-{}-{endpoint_id}",
            std::process::id()
        );
        let listener = process_control_ipc::bind_abstract_listener(&endpoint).unwrap();
        let client = process_control_ipc::connect_abstract(&endpoint).unwrap();
        let (cancel_reader, cancel_writer) = placement_cancel_pipe().unwrap();
        let cancel = AtomicBool::new(false);

        let accepted =
            accept_placement_or_cancelled(&listener, &cancel, cancel_reader.as_raw_fd()).unwrap();

        assert!(accepted.is_some());
        drop(cancel_writer);
        drop(client);
    }

    #[test]
    fn placement_cancel_wins_over_ready_connection() {
        let endpoint_id = NEXT_CGROUP_ID.fetch_add(1, Ordering::Relaxed);
        let endpoint = format!(
            "vm0-test-placement-cancel-ready-{}-{endpoint_id}",
            std::process::id()
        );
        let listener = process_control_ipc::bind_abstract_listener(&endpoint).unwrap();
        let _client = process_control_ipc::connect_abstract(&endpoint).unwrap();
        let (cancel_reader, cancel_writer) = placement_cancel_pipe().unwrap();
        let cancel = AtomicBool::new(false);
        drop(cancel_writer);

        let accepted =
            accept_placement_or_cancelled(&listener, &cancel, cancel_reader.as_raw_fd()).unwrap();

        assert!(accepted.is_none());
    }

    #[test]
    fn placement_bootstrap_drop_wakes_all_idle_accept_workers() {
        let endpoint_id = NEXT_CGROUP_ID.fetch_add(1, Ordering::Relaxed);
        let endpoint_base = format!(
            "vm0-test-placement-cancel-{}-{endpoint_id}",
            std::process::id()
        );
        let endpoint = format!("{endpoint_base}-workload");
        let tool_endpoint = format!("{endpoint_base}-tool");
        let workload_listener = process_control_ipc::bind_abstract_listener(&endpoint).unwrap();
        let tool_listener = process_control_ipc::bind_abstract_listener(&tool_endpoint).unwrap();
        let (cancel_reader, cancel_writer) = placement_cancel_pipe().unwrap();
        let cancel_reader = Arc::new(cancel_reader);
        let workload_cancel_reader = Arc::clone(&cancel_reader);
        let tool_cancel_reader = Arc::clone(&cancel_reader);
        let (ready_tx, ready_rx) = mpsc::channel();
        let worker_done = Arc::new(AtomicU64::new(0));
        let workload_ready_tx = ready_tx.clone();
        let workload_done = Arc::clone(&worker_done);
        let workload_worker = thread::Builder::new()
            .name("test-workload-placement-cancel".to_owned())
            .spawn(move || {
                workload_ready_tx.send(()).unwrap();
                match wait_for_placement_or_cancelled(
                    &workload_listener,
                    workload_cancel_reader.as_raw_fd(),
                )
                .unwrap()
                {
                    PlacementWaitOutcome::Cancelled => {}
                    PlacementWaitOutcome::ListenerReady => {
                        panic!("idle workload placement listener unexpectedly became ready");
                    }
                }
                workload_done.fetch_add(1, Ordering::Release);
            })
            .unwrap();
        let tool_done = Arc::clone(&worker_done);
        let tool_worker = thread::Builder::new()
            .name("test-tool-placement-cancel".to_owned())
            .spawn(move || {
                ready_tx.send(()).unwrap();
                match wait_for_placement_or_cancelled(
                    &tool_listener,
                    tool_cancel_reader.as_raw_fd(),
                )
                .unwrap()
                {
                    PlacementWaitOutcome::Cancelled => {}
                    PlacementWaitOutcome::ListenerReady => {
                        panic!("idle tool placement listener unexpectedly became ready");
                    }
                }
                tool_done.fetch_add(1, Ordering::Release);
            })
            .unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let cancel_after_drop = Arc::clone(&cancel);
        let (_bootstrap_ready_tx, bootstrap_ready_rx) = mpsc::channel();
        let bootstrap = WorkloadPlacementBootstrap {
            endpoint,
            tool_endpoint,
            setup_elapsed: Duration::ZERO,
            ready_rx: bootstrap_ready_rx,
            cancel,
            cancel_wake_writer: Some(cancel_writer),
            active_tool_placement: Arc::new(ActiveToolPlacement::default()),
            workers: vec![workload_worker, tool_worker],
        };

        for _ in 0..2 {
            ready_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("placement worker should enter its idle wait");
        }
        let (drop_done_tx, drop_done_rx) = mpsc::channel();
        let drop_worker = thread::spawn(move || {
            drop(bootstrap);
            drop_done_tx.send(()).unwrap();
        });

        drop_done_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("bootstrap drop should actively wake and join the idle worker");
        drop_worker.join().unwrap();
        assert!(cancel_after_drop.load(Ordering::Acquire));
        assert_eq!(worker_done.load(Ordering::Acquire), 2);
    }

    #[test]
    fn placement_bootstrap_drop_interrupts_accepted_tool_handshake() {
        let endpoint_id = NEXT_CGROUP_ID.fetch_add(1, Ordering::Relaxed);
        let endpoint_base = format!(
            "vm0-test-placement-active-cancel-{}-{endpoint_id}",
            std::process::id()
        );
        let endpoint = format!("{endpoint_base}-workload");
        let tool_endpoint = format!("{endpoint_base}-tool");
        let workload_listener = process_control_ipc::bind_abstract_listener(&endpoint).unwrap();
        let tool_listener = process_control_ipc::bind_abstract_listener(&tool_endpoint).unwrap();
        let (cancel_reader, cancel_writer) = placement_cancel_pipe().unwrap();
        let cancel_reader = Arc::new(cancel_reader);
        let workload_cancel_reader = Arc::clone(&cancel_reader);
        let tool_cancel_reader = Arc::clone(&cancel_reader);
        let cancel = Arc::new(AtomicBool::new(false));
        let tool_cancel = Arc::clone(&cancel);
        let cancel_after_drop = Arc::clone(&cancel);
        let active_tool_placement = Arc::new(ActiveToolPlacement::default());
        let worker_active_tool_placement = Arc::clone(&active_tool_placement);
        let active_after_success = Arc::clone(&active_tool_placement);
        let (ready_tx, ready_rx) = mpsc::channel();
        let workload_ready_tx = ready_tx.clone();
        let (successful_done_tx, successful_done_rx) = mpsc::channel();
        let (stalled_error_tx, stalled_error_rx) = mpsc::channel();
        let worker_done = Arc::new(AtomicU64::new(0));
        let workload_done = Arc::clone(&worker_done);
        let tool_done = Arc::clone(&worker_done);
        // SAFETY: geteuid is a simple scalar getter with no preconditions.
        let expected_uid = unsafe { libc::geteuid() };
        let current_cgroup = fs::read_to_string("/proc/self/cgroup").unwrap();
        let relative_cgroup = current_cgroup
            .lines()
            .find_map(|line| line.strip_prefix("0::/"))
            .unwrap();
        let expected_cgroup = Path::new(CGROUP_V2_MOUNT_PATH).join(relative_cgroup);

        let workload_worker = thread::Builder::new()
            .name("test-workload-placement-active-cancel".to_owned())
            .spawn(move || {
                workload_ready_tx.send(()).unwrap();
                match wait_for_placement_or_cancelled(
                    &workload_listener,
                    workload_cancel_reader.as_raw_fd(),
                )
                .unwrap()
                {
                    PlacementWaitOutcome::Cancelled => {}
                    PlacementWaitOutcome::ListenerReady => {
                        panic!("idle workload placement listener unexpectedly became ready");
                    }
                }
                workload_done.fetch_add(1, Ordering::Release);
            })
            .unwrap();
        let tool_worker = thread::Builder::new()
            .name("test-tool-placement-active-cancel".to_owned())
            .spawn(move || {
                ready_tx.send(()).unwrap();
                let placement = std::fs::File::open("/dev/null").unwrap();

                let successful_stream = accept_placement_or_cancelled(
                    &tool_listener,
                    &tool_cancel,
                    tool_cancel_reader.as_raw_fd(),
                )
                .unwrap()
                .unwrap();
                let successful_stream = worker_active_tool_placement
                    .register(successful_stream, &tool_cancel)
                    .unwrap()
                    .unwrap();
                successful_stream
                    .as_ref()
                    .set_read_timeout(Some(TOOL_PLACEMENT_IO_TIMEOUT))
                    .unwrap();
                successful_stream
                    .as_ref()
                    .set_write_timeout(Some(TOOL_PLACEMENT_IO_TIMEOUT))
                    .unwrap();
                assert!(
                    peer_matches(successful_stream.as_ref(), expected_uid, &expected_cgroup)
                        .unwrap()
                );
                process_control_ipc::send_tool_placement(
                    successful_stream.as_ref(),
                    placement.as_fd(),
                )
                .unwrap();
                process_control_ipc::read_tool_placement_confirmation(successful_stream.as_ref())
                    .unwrap();
                process_control_ipc::write_tool_placement_ack(successful_stream.as_ref()).unwrap();
                drop(successful_stream);
                successful_done_tx.send(()).unwrap();

                let stalled_stream = accept_placement_or_cancelled(
                    &tool_listener,
                    &tool_cancel,
                    tool_cancel_reader.as_raw_fd(),
                )
                .unwrap()
                .unwrap();
                let stalled_stream = worker_active_tool_placement
                    .register(stalled_stream, &tool_cancel)
                    .unwrap()
                    .unwrap();
                stalled_stream
                    .as_ref()
                    .set_read_timeout(Some(TOOL_PLACEMENT_IO_TIMEOUT))
                    .unwrap();
                stalled_stream
                    .as_ref()
                    .set_write_timeout(Some(TOOL_PLACEMENT_IO_TIMEOUT))
                    .unwrap();
                assert!(
                    peer_matches(stalled_stream.as_ref(), expected_uid, &expected_cgroup).unwrap()
                );
                process_control_ipc::send_tool_placement(
                    stalled_stream.as_ref(),
                    placement.as_fd(),
                )
                .unwrap();
                let error =
                    process_control_ipc::read_tool_placement_confirmation(stalled_stream.as_ref())
                        .expect_err("bootstrap drop should interrupt the confirmation read");
                stalled_error_tx.send(error.kind()).unwrap();
                tool_done.fetch_add(1, Ordering::Release);
            })
            .unwrap();
        let (_bootstrap_ready_tx, bootstrap_ready_rx) = mpsc::channel();
        let bootstrap = WorkloadPlacementBootstrap {
            endpoint,
            tool_endpoint: tool_endpoint.clone(),
            setup_elapsed: Duration::ZERO,
            ready_rx: bootstrap_ready_rx,
            cancel,
            cancel_wake_writer: Some(cancel_writer),
            active_tool_placement,
            workers: vec![workload_worker, tool_worker],
        };

        for _ in 0..2 {
            ready_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("placement worker should enter its wait");
        }
        let successful_client = process_control_ipc::connect_abstract(&tool_endpoint).unwrap();
        successful_client
            .set_read_timeout(Some(TOOL_PLACEMENT_IO_TIMEOUT))
            .unwrap();
        successful_client
            .set_write_timeout(Some(TOOL_PLACEMENT_IO_TIMEOUT))
            .unwrap();
        let successful_placement =
            process_control_ipc::receive_tool_placement(&successful_client).unwrap();
        drop(successful_placement);
        process_control_ipc::write_tool_placement_confirmation(&successful_client).unwrap();
        process_control_ipc::read_tool_placement_ack(&successful_client).unwrap();
        successful_done_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("successful placement should clear its active stream");
        assert!(active_after_success.stream.lock().unwrap().is_none());

        let stalled_client = process_control_ipc::connect_abstract(&tool_endpoint).unwrap();
        stalled_client
            .set_read_timeout(Some(TOOL_PLACEMENT_IO_TIMEOUT))
            .unwrap();
        stalled_client
            .set_write_timeout(Some(TOOL_PLACEMENT_IO_TIMEOUT))
            .unwrap();
        let stalled_placement =
            process_control_ipc::receive_tool_placement(&stalled_client).unwrap();
        drop(stalled_placement);

        let (drop_done_tx, drop_done_rx) = mpsc::channel();
        let drop_worker = thread::spawn(move || {
            drop(bootstrap);
            drop_done_tx.send(()).unwrap();
        });

        drop_done_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("bootstrap drop should interrupt and join the accepted handshake");
        drop_worker.join().unwrap();
        let stalled_error = stalled_error_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("accepted handshake should report interrupted I/O");
        assert_ne!(stalled_error, io::ErrorKind::TimedOut);
        process_control_ipc::read_tool_placement_ack(&stalled_client)
            .expect_err("cancelled placement must not receive an acknowledgement");
        assert!(cancel_after_drop.load(Ordering::Acquire));
        assert_eq!(worker_done.load(Ordering::Acquire), 2);
    }

    #[test]
    fn discovers_nested_control_runtime_and_tool_leaves() {
        let base = tempfile::tempdir().unwrap();
        let operation = base.path().join("exec-nested");
        let control = operation.join(CONTROL_CGROUP_NAME);
        let runtime = operation
            .join(WORKLOAD_CGROUP_NAME)
            .join(RUNTIME_CGROUP_NAME);
        let tool = operation
            .join(WORKLOAD_CGROUP_NAME)
            .join(TOOLS_CGROUP_NAME)
            .join("tool-7");
        fs::create_dir_all(&control).unwrap();
        fs::create_dir_all(&runtime).unwrap();
        fs::create_dir_all(&tool).unwrap();

        let leaves = cgroup_leaf_paths(&operation).unwrap();

        assert_eq!(leaves, vec![control, runtime, tool]);
    }

    #[test]
    fn removes_nested_cgroup_hierarchy_bottom_up() {
        let base = tempfile::tempdir().unwrap();
        let operation = base.path().join("exec-nested");
        fs::create_dir_all(
            operation
                .join(WORKLOAD_CGROUP_NAME)
                .join(TOOLS_CGROUP_NAME)
                .join("tool-9"),
        )
        .unwrap();
        fs::create_dir_all(
            operation
                .join(WORKLOAD_CGROUP_NAME)
                .join(RUNTIME_CGROUP_NAME),
        )
        .unwrap();
        fs::create_dir_all(operation.join(CONTROL_CGROUP_NAME)).unwrap();

        remove_cgroup_hierarchy(&operation).unwrap();

        assert!(!operation.exists());
    }

    #[test]
    fn controlled_operation_preserves_both_memory_floors_without_partitioning_workload() {
        let operation = tempfile::tempdir().unwrap();
        let control = operation.path().join(CONTROL_CGROUP_NAME);
        let workload = operation.path().join(WORKLOAD_CGROUP_NAME);
        fs::create_dir(&control).unwrap();
        fs::create_dir(&workload).unwrap();
        let policy =
            WorkloadResourcePolicy::for_guest_capacity(2, 4096 * 1024 * 1024, true).unwrap();

        configure_resource_policy(operation.path(), &control, &workload, true, policy).unwrap();

        for (path, expected) in [
            (operation.path(), 512 * 1024 * 1024),
            (control.as_path(), 128 * 1024 * 1024),
            (workload.as_path(), 384 * 1024 * 1024),
        ] {
            assert_eq!(
                fs::read_to_string(path.join(MEMORY_MIN_FILE)).unwrap(),
                expected.to_string()
            );
        }
        assert_eq!(
            fs::read_to_string(workload.join(MEMORY_MAX_FILE)).unwrap(),
            (3968_u64 * 1024 * 1024).to_string()
        );
        assert_eq!(
            fs::read_to_string(workload.join(MEMORY_HIGH_FILE)).unwrap(),
            "max"
        );
    }

    #[test]
    fn ordinary_exec_does_not_receive_agent_memory_protection() {
        let operation = tempfile::tempdir().unwrap();
        let control = operation.path().join(CONTROL_CGROUP_NAME);
        let workload = operation.path().join(WORKLOAD_CGROUP_NAME);
        fs::create_dir(&control).unwrap();
        fs::create_dir(&workload).unwrap();
        for path in [operation.path(), control.as_path(), workload.as_path()] {
            fs::write(path.join(MEMORY_MIN_FILE), "0").unwrap();
        }
        let policy =
            WorkloadResourcePolicy::for_guest_capacity(2, 480 * 1024 * 1024, false).unwrap();

        configure_resource_policy(operation.path(), &control, &workload, false, policy).unwrap();

        for path in [operation.path(), control.as_path(), workload.as_path()] {
            assert_eq!(fs::read_to_string(path.join(MEMORY_MIN_FILE)).unwrap(), "0");
        }
        assert_eq!(
            fs::read_to_string(workload.join(MEMORY_MAX_FILE)).unwrap(),
            (352 * 1024 * 1024).to_string()
        );
    }

    #[test]
    fn controlled_operation_rejects_failed_runtime_ancestor_protection() {
        let operation = tempfile::tempdir().unwrap();
        let control = operation.path().join(CONTROL_CGROUP_NAME);
        let workload = operation.path().join(WORKLOAD_CGROUP_NAME);
        fs::create_dir(&control).unwrap();
        fs::create_dir_all(workload.join(MEMORY_MIN_FILE)).unwrap();
        let policy =
            WorkloadResourcePolicy::for_guest_capacity(2, 4096 * 1024 * 1024, true).unwrap();

        let error = configure_resource_policy(operation.path(), &control, &workload, true, policy)
            .unwrap_err();

        assert_eq!(error.stage, "preserve runtime ancestor memory protection");
    }

    #[test]
    fn partial_creation_failure_removes_operation_cgroup() {
        let base = tempfile::tempdir().unwrap();

        let policy =
            WorkloadResourcePolicy::for_guest_capacity(2, u64::from(4096_u32) * 1024 * 1024, true)
                .unwrap();
        // A plain directory can supply the outer directory capability, but
        // cannot supply the Agent's kernel-created runtime cgroup.procs file.
        let result = CgroupGuard::create_in(base.path(), 17, ExecProcessRole::Agent, policy);
        let Err(error) = result else {
            panic!("placement-file open unexpectedly succeeded");
        };

        assert_eq!(error.stage, "open workload cgroup.procs");
        assert_eq!(error.source.kind(), io::ErrorKind::NotFound);
        assert!(fs::read_dir(base.path()).unwrap().next().is_none());
    }

    #[test]
    fn spawn_failure_removes_owned_operation_cgroup() {
        let base = tempfile::tempdir().unwrap();
        let group_path = base.path().join("exec-spawn-failure");
        fs::create_dir(&group_path).unwrap();
        let containment = ExecProcessContainment {
            backend: ContainmentBackend::TestDirectory(group_path.clone()),
        };

        let result = crate::shell_command::spawn_shell_command_with_pipes(
            "bad\0command",
            &[],
            false,
            false,
            containment,
        );
        let Err(error) = result else {
            panic!("invalid command unexpectedly spawned");
        };

        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert!(!group_path.exists());
    }

    #[test]
    fn spawn_failure_preserves_primary_error_when_cleanup_fails() {
        let base = tempfile::tempdir().unwrap();
        let group_path = base.path().join("exec-cleanup-failure");
        fs::create_dir(&group_path).unwrap();
        fs::write(group_path.join("blocker"), b"keep directory non-empty").unwrap();
        let containment = ExecProcessContainment {
            backend: ContainmentBackend::TestDirectory(group_path.clone()),
        };

        let result = crate::shell_command::spawn_shell_command_with_pipes(
            "bad\0command",
            &[],
            false,
            false,
            containment,
        );
        let Err(error) = result else {
            panic!("invalid command unexpectedly spawned");
        };

        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert!(group_path.is_dir());
    }

    #[test]
    fn graceful_signal_rechecks_membership_after_opening_pidfd() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join(CGROUP_PROCS_FILE), "").unwrap();
        let mut child = ChildGuard(
            Command::new("/bin/sh")
                .arg("-c")
                .arg(
                    "trap 'printf \"term\\n\"; exit 42' TERM; \
                     printf 'ready\\n'; \
                     while IFS= read -r line; do printf '%s\\n' \"$line\"; done",
                )
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let enumerated_pid = libc::pid_t::try_from(child.0.id()).unwrap();
        let mut stdout = BufReader::new(child.0.stdout.take().unwrap());
        let mut response = String::new();
        stdout.read_line(&mut response).unwrap();
        assert_eq!(response, "ready\n");

        let errors = signal_term(directory.path(), &[enumerated_pid]);
        writeln!(child.0.stdin.as_mut().unwrap(), "probe").unwrap();
        response.clear();
        stdout.read_line(&mut response).unwrap();

        assert_eq!(errors, 0);
        assert_eq!(response, "probe\n");
    }
}
