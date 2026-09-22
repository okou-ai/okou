//! Secure workload-cgroup placement owned by Guest Agent.
//!
//! The root guest supervisor places Guest Agent in an operation's `control`
//! leaf and transfers a write-only descriptor for `workload/runtime` over a
//! nonce-authenticated local socket with `SCM_RIGHTS`. Guest Agent adopts that
//! descriptor before starting its async runtime and uses a cloned descriptor
//! only in each CLI child's `pre_exec` hook. The descriptor is never inherited
//! through the sandbox-user launch chain or copied into a workload environment.
//! Guest Agent separately injects the operation-local tool-placement broker
//! endpoint into the managed CLI environment so the Bash launcher can request
//! one root-owned tool cgroup before executing user code.

use std::ffi::OsString;
use std::fs;
use std::io;
use std::os::fd::{AsRawFd, OwnedFd, RawFd};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

use guest_contracts::diagnostics::WorkloadResourceLimitDiagnostic;
use guest_contracts::process_containment::{
    CANONICAL_TOOL_CGROUP_PROCS_ENV, CANONICAL_WORKLOAD_CGROUP_PROCS_ENV, CGROUP_V2_MOUNT_PATH,
    CONTROL_CGROUP_NAME, EXEC_CGROUP_NAME_PREFIX, RUNTIME_CGROUP_NAME, TOOLS_CGROUP_NAME,
    WORKLOAD_CGROUP_NAME, WorkloadResourceEvents,
};

const CGROUP_PROCS_FILE: &str = "cgroup.procs";
const CPU_STAT_FILE: &str = "cpu.stat";
const PROC_SELF_CGROUP: &str = "/proc/self/cgroup";
const CGROUP2_SUPER_MAGIC: u64 = 0x6367_7270;
const WORKLOAD_BOOTSTRAP_IO_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
#[cfg(debug_assertions)]
const TEST_ALLOW_UNMANAGED_PROCESS_CONTROL_ENV: &str = "OKOU_TEST_ALLOW_UNMANAGED_PROCESS_CONTROL";

/// Root-opened capability used only to place CLI children in `workload/runtime`.
#[derive(Clone, Debug)]
pub struct WorkloadContainment {
    placement: Arc<OwnedFd>,
    workload_path: Arc<PathBuf>,
    tool_placement_endpoint: Arc<str>,
    evidence_stream: Arc<Mutex<Option<EvidenceStream>>>,
}

/// Bootstrap completes before Tokio exists; register the socket on first capture.
#[derive(Debug)]
enum EvidenceStream {
    Bootstrap(UnixStream),
    Registered(tokio::net::UnixStream),
}

/// Read-only paths used to sample control and workload CPU accounting.
#[derive(Debug)]
pub struct CgroupCpuStatPaths {
    control: PathBuf,
    workload: PathBuf,
}

impl CgroupCpuStatPaths {
    /// Build a sampler description from explicit `cpu.stat` paths.
    pub fn new(control: PathBuf, workload: PathBuf) -> Self {
        Self { control, workload }
    }

    pub(crate) fn control(&self) -> &Path {
        &self.control
    }

    pub(crate) fn workload(&self) -> &Path {
        &self.workload
    }
}

/// Resource enforcement observed for a completed workload.
#[derive(Debug, Eq, PartialEq)]
pub struct WorkloadResourceDiagnostics {
    /// Hard memory or PID limit counters suitable for structured attribution.
    pub hard_limit: Option<WorkloadResourceLimitDiagnostic>,
    /// CPU throttling or memory-high summary suitable for an informational log.
    pub pressure: Option<String>,
}

impl WorkloadContainment {
    /// Read root-owned evidence over the existing authenticated bootstrap.
    /// I/O failures and cancellation permanently close this exchange; cleanup
    /// retains its own root-owned capture path and execution outcomes are unaffected.
    /// Concurrent captures skip rather than queue behind an outstanding exchange.
    pub async fn oom_evidence(
        &self,
        reason: guest_contracts::oom_evidence::CaptureReason,
    ) -> Option<guest_contracts::oom_evidence::OomEvidence> {
        use guest_contracts::oom_evidence::{
            CaptureReason, EVIDENCE_IO_TIMEOUT, MAX_EVIDENCE_BYTES, decode_evidence,
        };

        let mut owner = self.evidence_stream.try_lock().ok()?;
        // Restore only a complete exchange. Dropping this future closes the socket
        // so a partial response can never be mistaken for the next capture.
        let mut stream = match owner.take()? {
            EvidenceStream::Bootstrap(stream) => {
                stream.set_nonblocking(true).ok()?;
                tokio::net::UnixStream::from_std(stream).ok()?
            }
            EvidenceStream::Registered(stream) => stream,
        };
        let request = match reason {
            CaptureReason::CliError => 2,
            _ => 1,
        };
        tokio::time::timeout(EVIDENCE_IO_TIMEOUT, stream.write_all(&[request]))
            .await
            .ok()?
            .ok()?;
        let evidence = tokio::time::timeout(EVIDENCE_IO_TIMEOUT, async {
            let mut header = [0; 4];
            stream.read_exact(&mut header).await?;
            let length = u32::from_be_bytes(header) as usize;
            if length > MAX_EVIDENCE_BYTES {
                return Err(io::Error::other("evidence response exceeds byte limit"));
            }
            let mut bytes = vec![0; length];
            stream.read_exact(&mut bytes).await?;
            decode_evidence(&bytes)
        })
        .await
        .ok()?
        .ok()?;
        *owner = Some(EvidenceStream::Registered(stream));
        Some(evidence)
    }
    /// Receive and adopt the production bootstrap descriptor.
    ///
    /// This must run before any other thread can read or mutate process-global
    /// environment state. The caller supplies the once-resolved canonical
    /// process-control presence. A process-control bootstrap requires
    /// the canonical workload and tool capabilities in production. Direct
    /// local execution is unmanaged when the canonical process-control value
    /// and both canonical capabilities are absent.
    /// The canonical placement endpoints are removed from process-global
    /// environment after the pair is captured successfully.
    pub fn from_process_env(process_control_present: bool) -> Result<Option<Self>, String> {
        let (placement_endpoint, tool_endpoint) =
            resolve_cgroup_placement_endpoints_from_process_env()?;

        match (process_control_present, placement_endpoint, tool_endpoint) {
            (false, None, None) => Ok(None),
            (true, None, None) if test_allows_unmanaged_process_control() => Ok(None),
            (true, Some(placement), Some(tool)) => {
                reject_empty_cgroup_placement_endpoint(
                    &placement,
                    CANONICAL_WORKLOAD_CGROUP_PROCS_ENV,
                )?;
                reject_empty_cgroup_placement_endpoint(&tool, CANONICAL_TOOL_CGROUP_PROCS_ENV)?;
                // SAFETY: production calls this before constructing the Tokio
                // runtime, so no other thread can access the environment.
                unsafe {
                    remove_cgroup_placement_endpoints();
                }
                Self::receive(&placement, tool).map(Some).map_err(|error| {
                    format!("invalid {CANONICAL_WORKLOAD_CGROUP_PROCS_ENV}: {error}")
                })
            }
            (true, _, _) => Err(format!(
                "{} and {} are required with {}",
                CANONICAL_WORKLOAD_CGROUP_PROCS_ENV,
                CANONICAL_TOOL_CGROUP_PROCS_ENV,
                process_control_ipc::CANONICAL_BOOTSTRAP_ENV
            )),
            (false, _, _) => Err(format!(
                "{} and {} require {}",
                CANONICAL_WORKLOAD_CGROUP_PROCS_ENV,
                CANONICAL_TOOL_CGROUP_PROCS_ENV,
                process_control_ipc::CANONICAL_BOOTSTRAP_ENV
            )),
        }
    }

    /// Install runtime placement on a Tokio child command.
    ///
    /// The cloned descriptor remains close-on-exec. The pre-exec write moves
    /// the child before its program starts, and exec then closes the capability.
    pub fn configure_command(&self, command: &mut tokio::process::Command) -> io::Result<()> {
        let placement = self.placement.try_clone()?;
        // SAFETY: the closure performs one async-signal-safe raw write to an
        // already-open descriptor between fork and exec.
        unsafe {
            command
                .as_std_mut()
                .pre_exec(move || write_self_to_cgroup(placement.as_raw_fd()));
        }
        Ok(())
    }

    /// Read workload resource counters after CLI execution.
    pub fn resource_diagnostics(&self) -> io::Result<WorkloadResourceDiagnostics> {
        let cpu = fs::read_to_string(self.workload_path.join("cpu.stat"))?;
        let memory = fs::read_to_string(self.workload_path.join("memory.events"))?;
        let pids = fs::read_to_string(self.workload_path.join("pids.events"))?;
        let tool_pids = fs::read_to_string(
            self.workload_path
                .join(TOOLS_CGROUP_NAME)
                .join("pids.events"),
        )?;
        let mut events = WorkloadResourceEvents::from_file_contents(&cpu, &memory, &pids)?;
        let tool_events = WorkloadResourceEvents::from_file_contents("", "", &tool_pids)?;
        events.pids_max = events.pids_max.max(tool_events.pids_max);

        let hard_limit = events.hard_limit_diagnostic();
        let pressure = events.has_material_pressure().then(|| {
            format!(
                "workload resource pressure observed (cpu_nr_throttled={}, cpu_throttled_usec={}, memory_high={})",
                events.cpu_nr_throttled, events.cpu_throttled_usec, events.memory_high
            )
        });
        Ok(WorkloadResourceDiagnostics {
            hard_limit,
            pressure,
        })
    }

    /// Describe the validated cgroups without transferring placement access.
    pub fn cpu_stat_paths(&self) -> CgroupCpuStatPaths {
        CgroupCpuStatPaths::new(
            self.workload_path
                .with_file_name(CONTROL_CGROUP_NAME)
                .join(CPU_STAT_FILE),
            self.workload_path.join(CPU_STAT_FILE),
        )
    }

    /// Runner-owned endpoint injected into managed CLI environments.
    pub(crate) fn tool_placement_env(&self) -> (&'static str, String) {
        (
            CANONICAL_TOOL_CGROUP_PROCS_ENV,
            self.tool_placement_endpoint.to_string(),
        )
    }

    pub(crate) fn env_source_evidence(&self) -> [(&'static str, &'static str); 2] {
        [
            (CANONICAL_WORKLOAD_CGROUP_PROCS_ENV, "canonical-only"),
            (CANONICAL_TOOL_CGROUP_PROCS_ENV, "canonical-only"),
        ]
    }

    fn receive(endpoint: &str, tool_endpoint: String) -> io::Result<Self> {
        let stream = process_control_ipc::connect_abstract(endpoint)?;
        stream.set_read_timeout(Some(WORKLOAD_BOOTSTRAP_IO_TIMEOUT))?;
        stream.set_write_timeout(Some(WORKLOAD_BOOTSTRAP_IO_TIMEOUT))?;
        let placement = process_control_ipc::receive_workload_placement(&stream)?;
        let mut containment = Self::adopt(placement, tool_endpoint)?;
        process_control_ipc::write_workload_placement_confirmation(&stream)?;
        containment.evidence_stream = Arc::new(Mutex::new(Some(EvidenceStream::Bootstrap(stream))));
        Ok(containment)
    }

    fn adopt(placement: OwnedFd, tool_endpoint: String) -> io::Result<Self> {
        // SAFETY: F_GETFD only inspects the supplied descriptor.
        let descriptor_flags = unsafe { libc::fcntl(placement.as_raw_fd(), libc::F_GETFD) };
        if descriptor_flags < 0 {
            return Err(io::Error::last_os_error());
        }
        deny_peer_process_inspection()?;
        let runtime_path = validate_descriptor(&placement)?;
        let workload_path = runtime_path
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| io::Error::other("runtime cgroup has no workload parent"))?;
        set_close_on_exec(placement.as_raw_fd(), descriptor_flags)?;

        Ok(Self {
            placement: Arc::new(placement),
            workload_path: Arc::new(workload_path),
            tool_placement_endpoint: Arc::from(tool_endpoint),
            evidence_stream: Arc::new(Mutex::new(None)),
        })
    }
}

fn resolve_cgroup_placement_endpoints_from_process_env()
-> Result<(Option<String>, Option<String>), String> {
    let workload_canonical = std::env::var_os(CANONICAL_WORKLOAD_CGROUP_PROCS_ENV);
    let tool_canonical = std::env::var_os(CANONICAL_TOOL_CGROUP_PROCS_ENV);

    Ok((
        canonical_cgroup_placement_endpoint(
            CANONICAL_WORKLOAD_CGROUP_PROCS_ENV,
            workload_canonical,
        )?,
        canonical_cgroup_placement_endpoint(CANONICAL_TOOL_CGROUP_PROCS_ENV, tool_canonical)?,
    ))
}

fn canonical_cgroup_placement_endpoint(
    key: &'static str,
    value: Option<OsString>,
) -> Result<Option<String>, String> {
    value
        .map(|value| {
            value
                .into_string()
                .map_err(|_| format!("{key} must be valid UTF-8"))
        })
        .transpose()
}

fn reject_empty_cgroup_placement_endpoint(endpoint: &str, key: &'static str) -> Result<(), String> {
    if endpoint.is_empty() {
        return Err(format!(
            "invalid cgroup placement environment: key={key} state=empty"
        ));
    }
    Ok(())
}

unsafe fn remove_cgroup_placement_endpoints() {
    for key in [
        CANONICAL_WORKLOAD_CGROUP_PROCS_ENV,
        CANONICAL_TOOL_CGROUP_PROCS_ENV,
    ] {
        // SAFETY: the caller runs before constructing the Tokio runtime, so no
        // other thread can access the process environment.
        unsafe {
            std::env::remove_var(key);
        }
    }
}

fn test_allows_unmanaged_process_control() -> bool {
    #[cfg(debug_assertions)]
    {
        matches!(
            std::env::var(TEST_ALLOW_UNMANAGED_PROCESS_CONTROL_ENV),
            Ok(value) if value == "true"
        )
    }
    #[cfg(not(debug_assertions))]
    {
        false
    }
}

fn deny_peer_process_inspection() -> io::Result<()> {
    // SAFETY: PR_SET_DUMPABLE changes only the current single-threaded Guest
    // Agent bootstrap process. Reapplying it here is required because the
    // preceding credential and exec transitions may reset the value set by
    // `guest-control-server` before exec.
    if unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn validate_descriptor(placement: &OwnedFd) -> io::Result<PathBuf> {
    // SAFETY: F_GETFL only reads flags from a valid owned descriptor.
    let status_flags = unsafe { libc::fcntl(placement.as_raw_fd(), libc::F_GETFL) };
    if status_flags < 0 {
        return Err(io::Error::last_os_error());
    }
    if status_flags & libc::O_ACCMODE != libc::O_WRONLY {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "workload placement fd is not write-only",
        ));
    }

    let mut stats = std::mem::MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: `placement` is valid and `stats` points to writable memory.
    if unsafe { libc::fstatfs(placement.as_raw_fd(), stats.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful fstatfs initialized `stats`.
    if unsafe { stats.assume_init() }.f_type as u64 != CGROUP2_SUPER_MAGIC {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "workload placement fd is not on cgroup v2",
        ));
    }

    let expected = expected_workload_procs_path()?;
    let actual = fs::read_link(format!("/proc/self/fd/{}", placement.as_raw_fd()))?;
    if actual != expected {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "workload placement fd targets {}, expected {}",
                actual.display(),
                expected.display()
            ),
        ));
    }
    expected
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| io::Error::other("workload cgroup.procs path has no parent"))
}

fn expected_workload_procs_path() -> io::Result<PathBuf> {
    let content = fs::read_to_string(PROC_SELF_CGROUP)?;
    let relative = content
        .lines()
        .find_map(|line| line.strip_prefix("0::"))
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "current unified cgroup path is missing",
            )
        })?;
    let path = Path::new(relative);
    let components = path.components().collect::<Vec<_>>();
    let [
        Component::RootDir,
        Component::Normal(base),
        Component::Normal(operation),
        Component::Normal(leaf),
    ] = components.as_slice()
    else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Guest Agent is not in a canonical control cgroup",
        ));
    };
    if *base != "vm0-exec"
        || !operation
            .as_encoded_bytes()
            .starts_with(EXEC_CGROUP_NAME_PREFIX.as_bytes())
        || *leaf != CONTROL_CGROUP_NAME
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Guest Agent is not in a canonical control cgroup",
        ));
    }

    Ok(Path::new(CGROUP_V2_MOUNT_PATH)
        .join(base)
        .join(operation)
        .join(WORKLOAD_CGROUP_NAME)
        .join(RUNTIME_CGROUP_NAME)
        .join(CGROUP_PROCS_FILE))
}

fn set_close_on_exec(fd: RawFd, current_flags: libc::c_int) -> io::Result<()> {
    // SAFETY: `fd` is valid and this only adds FD_CLOEXEC.
    if unsafe { libc::fcntl(fd, libc::F_SETFD, current_flags | libc::FD_CLOEXEC) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn write_self_to_cgroup(fd: RawFd) -> io::Result<()> {
    loop {
        // SAFETY: `fd` is open for writing and the one-byte buffer is valid.
        let written = unsafe { libc::write(fd, b"0".as_ptr().cast(), 1) };
        if written == 1 {
            return Ok(());
        }
        if written < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        return Err(io::Error::from_raw_os_error(libc::EIO));
    }
}

#[cfg(test)]
mod evidence_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Seek, SeekFrom};
    use std::os::unix::ffi::OsStringExt;
    use std::process::Stdio;

    use guest_contracts::process_containment::MATERIAL_CPU_THROTTLED_USEC;

    #[test]
    fn pre_exec_places_child_without_inheriting_descriptor() {
        let mut placement = tempfile::NamedTempFile::new().unwrap();
        let containment = WorkloadContainment {
            placement: Arc::new(placement.as_file().try_clone().unwrap().into()),
            workload_path: Arc::new(PathBuf::from("/unused")),
            tool_placement_endpoint: Arc::from("test-tool-endpoint"),
            evidence_stream: Arc::new(Mutex::new(None)),
        };
        let mut command = tokio::process::Command::new("/bin/sh");
        command
            .arg("-c")
            .arg(
                r#"for descriptor in /proc/self/fd/*; do
  if [ "$descriptor" -ef "$1" ]; then
    exit 1
  fi
done"#,
            )
            .arg("sh")
            .arg(placement.path())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        containment.configure_command(&mut command).unwrap();

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let status = runtime
            .block_on(async move { command.status().await })
            .unwrap();

        assert!(status.success());
        placement.as_file_mut().seek(SeekFrom::Start(0)).unwrap();
        let mut content = String::new();
        placement
            .as_file_mut()
            .read_to_string(&mut content)
            .unwrap();
        assert_eq!(content, "0");
    }

    #[test]
    fn exposes_runner_owned_tool_endpoint_for_cli_environment() {
        let containment = WorkloadContainment {
            placement: Arc::new(tempfile::tempfile().unwrap().into()),
            workload_path: Arc::new(PathBuf::from("/unused")),
            tool_placement_endpoint: Arc::from("runner-tool-endpoint"),
            evidence_stream: Arc::new(Mutex::new(None)),
        };

        assert_eq!(
            containment.tool_placement_env(),
            (
                CANONICAL_TOOL_CGROUP_PROCS_ENV,
                "runner-tool-endpoint".to_string()
            )
        );
        assert_eq!(
            containment.env_source_evidence(),
            [
                (CANONICAL_WORKLOAD_CGROUP_PROCS_ENV, "canonical-only"),
                (CANONICAL_TOOL_CGROUP_PROCS_ENV, "canonical-only"),
            ]
        );
    }

    #[test]
    fn canonical_cgroup_placement_endpoint_preserves_values_and_empty() {
        assert_eq!(
            canonical_cgroup_placement_endpoint(CANONICAL_WORKLOAD_CGROUP_PROCS_ENV, None),
            Ok(None)
        );
        assert_eq!(
            canonical_cgroup_placement_endpoint(
                CANONICAL_WORKLOAD_CGROUP_PROCS_ENV,
                Some(OsString::from("canonical-endpoint")),
            ),
            Ok(Some("canonical-endpoint".to_string()))
        );
        assert_eq!(
            canonical_cgroup_placement_endpoint(
                CANONICAL_WORKLOAD_CGROUP_PROCS_ENV,
                Some(OsString::new()),
            ),
            Ok(Some(String::new()))
        );
    }

    #[test]
    fn rejects_non_unicode_canonical_cgroup_placement_endpoint_without_values() {
        let error = canonical_cgroup_placement_endpoint(
            CANONICAL_WORKLOAD_CGROUP_PROCS_ENV,
            Some(OsString::from_vec(vec![0xff])),
        )
        .unwrap_err();

        assert_eq!(
            error,
            format!("{CANONICAL_WORKLOAD_CGROUP_PROCS_ENV} must be valid UTF-8")
        );
    }

    #[test]
    fn reports_hard_limits_and_pressure_from_cgroup_counters() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(
            directory.path().join("cpu.stat"),
            "usage_usec 10\nnr_throttled 2\nthrottled_usec 3\n",
        )
        .unwrap();
        fs::write(
            directory.path().join("memory.events"),
            "low 0\nhigh 4\nmax 5\noom 1\noom_kill 1\noom_group_kill 1\n",
        )
        .unwrap();
        fs::write(directory.path().join("pids.events"), "max 6\n").unwrap();
        fs::create_dir(directory.path().join(TOOLS_CGROUP_NAME)).unwrap();
        fs::write(
            directory.path().join(TOOLS_CGROUP_NAME).join("pids.events"),
            "max 7\n",
        )
        .unwrap();
        let containment = WorkloadContainment {
            placement: Arc::new(tempfile::tempfile().unwrap().into()),
            workload_path: Arc::new(directory.path().to_path_buf()),
            tool_placement_endpoint: Arc::from("test-tool-endpoint"),
            evidence_stream: Arc::new(Mutex::new(None)),
        };

        let diagnostics = containment.resource_diagnostics().unwrap();

        assert_eq!(
            diagnostics.hard_limit,
            Some(WorkloadResourceLimitDiagnostic {
                memory_max_events: 5,
                memory_oom_events: 1,
                memory_oom_kill_events: 1,
                memory_oom_group_kill_events: 1,
                pids_max_events: 7,
            })
        );
        assert_eq!(
            diagnostics.pressure.as_deref(),
            Some(
                "workload resource pressure observed (cpu_nr_throttled=2, cpu_throttled_usec=3, memory_high=4)"
            )
        );
    }

    #[test]
    fn ignores_immaterial_cpu_throttling() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(
            directory.path().join("cpu.stat"),
            format!(
                "usage_usec 10\nnr_throttled 2\nthrottled_usec {}\n",
                MATERIAL_CPU_THROTTLED_USEC - 1
            ),
        )
        .unwrap();
        fs::write(
            directory.path().join("memory.events"),
            "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\noom_group_kill 0\n",
        )
        .unwrap();
        fs::write(directory.path().join("pids.events"), "max 0\n").unwrap();
        fs::create_dir(directory.path().join(TOOLS_CGROUP_NAME)).unwrap();
        fs::write(
            directory.path().join(TOOLS_CGROUP_NAME).join("pids.events"),
            "max 0\n",
        )
        .unwrap();
        let containment = WorkloadContainment {
            placement: Arc::new(tempfile::tempfile().unwrap().into()),
            workload_path: Arc::new(directory.path().to_path_buf()),
            tool_placement_endpoint: Arc::from("test-tool-endpoint"),
            evidence_stream: Arc::new(Mutex::new(None)),
        };

        let diagnostics = containment.resource_diagnostics().unwrap();

        assert_eq!(
            diagnostics,
            WorkloadResourceDiagnostics {
                hard_limit: None,
                pressure: None,
            }
        );
    }
}
