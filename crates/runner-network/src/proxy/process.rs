//! Mitmdump process supervision.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead};
use tokio::sync::mpsc;
use tracing::{Instrument, error, info, warn};

use super::control;
use super::control::{ControlHandle, ControlTarget};
use super::delivery::{DeliveryTarget, FlushTask};
use super::log_flush::MitmJsonlFlushHandle;
use super::managed_process::ManagedMitmdump;
use super::registry::{ProxyRegistryHandle, SandboxRegistration, write_empty_registry};
use super::runtime::{CANONICAL_RUNTIME_MARKER_ENV, MitmdumpRuntime};
use super::stderr::log_mitmdump_stderr_line;
use crate::error::{RunnerError, RunnerResult};

/// Timeout for waiting for mitmdump to become ready after spawn.
const READY_TIMEOUT: Duration = Duration::from_secs(10);
const START_MAX_ATTEMPTS: usize = 3;
/// Maximum raw bytes retained from one mitmdump stdout or stderr record.
const MITMDUMP_LOG_RECORD_MAX_BYTES: usize = 64 * 1024;
/// Short bounded retry for Linux `execve` returning ETXTBSY while a freshly
/// installed/replaced mitmdump binary is still observed as writable.
const TEXT_BUSY_SPAWN_RETRY_DELAY: Duration = Duration::from_millis(20);
const TEXT_BUSY_SPAWN_MAX_RETRIES: usize = 5;

#[derive(Debug)]
enum MitmdumpStartupFailure {
    PortInUse(RunnerError),
    Other(RunnerError),
}

impl MitmdumpStartupFailure {
    fn into_runner_error(self) -> RunnerError {
        match self {
            Self::PortInUse(error) | Self::Other(error) => error,
        }
    }

    fn is_port_in_use(&self) -> bool {
        matches!(self, Self::PortInUse(_))
    }
}

impl From<RunnerError> for MitmdumpStartupFailure {
    fn from(error: RunnerError) -> Self {
        Self::Other(error)
    }
}

impl std::fmt::Display for MitmdumpStartupFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PortInUse(error) | Self::Other(error) => error.fmt(formatter),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum MitmdumpLogRecord {
    Line(String),
    Oversized { observed_bytes: usize },
}

fn finish_mitmdump_log_record(
    mut retained: Vec<u8>,
    observed_bytes: usize,
    oversized: bool,
    terminated_by_newline: bool,
) -> io::Result<MitmdumpLogRecord> {
    if oversized {
        return Ok(MitmdumpLogRecord::Oversized { observed_bytes });
    }

    if terminated_by_newline && retained.last() == Some(&b'\r') {
        retained.pop();
    }
    String::from_utf8(retained)
        .map(MitmdumpLogRecord::Line)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

async fn read_mitmdump_log_record<R>(reader: &mut R) -> io::Result<Option<MitmdumpLogRecord>>
where
    R: AsyncBufRead + Unpin,
{
    let mut retained = Vec::new();
    let mut observed_bytes = 0usize;
    let mut oversized = false;

    loop {
        let (consumed_bytes, terminated_by_newline) = {
            let available = reader.fill_buf().await?;
            if available.is_empty() {
                if observed_bytes == 0 {
                    return Ok(None);
                }
                return finish_mitmdump_log_record(retained, observed_bytes, oversized, false)
                    .map(Some);
            }

            let fragment_bytes = available
                .iter()
                .position(|byte| *byte == b'\n')
                .unwrap_or(available.len());
            let terminated_by_newline = fragment_bytes < available.len();
            observed_bytes = observed_bytes.saturating_add(fragment_bytes);

            if !oversized {
                let remaining_bytes = MITMDUMP_LOG_RECORD_MAX_BYTES.saturating_sub(retained.len());
                if fragment_bytes <= remaining_bytes {
                    let (fragment, _) = available.split_at(fragment_bytes);
                    retained.extend_from_slice(fragment);
                } else {
                    oversized = true;
                    retained.clear();
                }
            }

            (
                fragment_bytes + usize::from(terminated_by_newline),
                terminated_by_newline,
            )
        };
        reader.consume(consumed_bytes);

        if terminated_by_newline {
            return finish_mitmdump_log_record(retained, observed_bytes, oversized, true).map(Some);
        }
    }
}

fn log_oversized_mitmdump_record(stream: &'static str, observed_bytes: usize) {
    warn!(
        target: "mitmdump",
        stream,
        max_bytes = MITMDUMP_LOG_RECORD_MAX_BYTES,
        observed_bytes,
        "discarded oversized mitmdump log record"
    );
}

async fn monitor_mitmdump_stdout<R>(stdout: R)
where
    R: AsyncRead + Unpin,
{
    // TermLog is warning-only, but its level is not preserved in the text
    // stream. Keep native stdout in Runner-local logs; addon events that need
    // Axiom bypass TermLog through the stderr envelope.
    let mut reader = tokio::io::BufReader::new(stdout);
    while let Ok(Some(record)) = read_mitmdump_log_record(&mut reader).await {
        match record {
            MitmdumpLogRecord::Line(line) if !line.is_empty() => {
                info!(target: "mitmdump", "{line}");
            }
            MitmdumpLogRecord::Line(_) => {}
            MitmdumpLogRecord::Oversized { observed_bytes } => {
                log_oversized_mitmdump_record("stdout", observed_bytes);
            }
        }
    }
}

async fn monitor_mitmdump_stderr<R>(stderr: R, port: u16) -> bool
where
    R: AsyncRead + Unpin,
{
    let mut reader = tokio::io::BufReader::new(stderr);
    let mut port_in_use = false;
    while let Ok(Some(record)) = read_mitmdump_log_record(&mut reader).await {
        match record {
            MitmdumpLogRecord::Line(line) if !line.is_empty() => {
                port_in_use |= mitmdump_stderr_reports_port_in_use(&line, port);
                log_mitmdump_stderr_line(&line);
            }
            MitmdumpLogRecord::Line(_) => {}
            MitmdumpLogRecord::Oversized { observed_bytes } => {
                log_oversized_mitmdump_record("stderr", observed_bytes);
            }
        }
    }
    port_in_use
}

/// Configuration for starting the proxy.
#[derive(Clone)]
pub struct ProxyConfig {
    /// Path to the mitmdump binary.
    pub mitmdump_bin: PathBuf,
    /// Directory containing mitmproxy CA files (mitmproxy-ca.pem).
    pub ca_dir: PathBuf,
    /// Lock file coordinating CA reconciliation with runner builds.
    pub ca_lock_path: PathBuf,
    /// Directory where addon scripts will be written.
    pub addon_dir: PathBuf,
    /// Path where the proxy registry JSON will be written.
    pub registry_path: PathBuf,
    /// Lock file path for coordinating concurrent registry access.
    pub registry_lock_path: PathBuf,
    /// Path where the runner-owned builtin firewall catalog cache is written.
    pub builtin_firewall_catalog_cache_path: PathBuf,
    /// Private parent directory for per-launch PyInstaller extraction roots.
    pub runtime_dir: PathBuf,
    /// Exclusive lock serializing owners of proxy runtime state.
    pub runtime_lock_path: PathBuf,
    /// Okou API URL passed to the addon (optional).
    pub api_url: Option<String>,
    /// Runner-runtime client session id passed to the addon for platform API requests.
    pub client_session_id: String,
    /// Version of the Runner binary, supplied by the composition root.
    pub client_version: &'static str,
}

/// Manages the mitmdump process lifecycle and proxy registry.
pub struct MitmProxy {
    port: u16,
    config: ProxyConfig,
    runtime: Option<Arc<MitmdumpRuntime>>,
    child: Option<ManagedMitmdump>,
    /// Sender used by the stdout monitor task to signal unexpected exit.
    crash_tx: mpsc::Sender<()>,
    /// Set to `true` during graceful `stop()` / `Drop` to suppress crash notifications.
    stopping: Arc<AtomicBool>,
    /// Private control generation, rotated before every replacement launch.
    usage_state_id: String,
    delivery_flush: Option<FlushTask>,
    control: ControlHandle,
}

impl From<&MitmProxy> for super::run_usage::MitmUsageHandle {
    fn from(proxy: &MitmProxy) -> Self {
        Self::new(proxy.control.clone())
    }
}

impl MitmProxy {
    /// Prepare the proxy: allocate a port, write addon script and empty registry.
    ///
    /// Returns `(proxy, crash_rx)`. The caller should select on `crash_rx` to
    /// detect unexpected mitmdump exits and trigger a restart.
    pub async fn new<N: AsRef<str>, C: AsRef<str>>(
        config: ProxyConfig,
        addon_files: &[(N, C)],
    ) -> RunnerResult<(Self, mpsc::Receiver<()>)> {
        // Acquire ownership before addon/registry preparation, which removes
        // and replaces files shared by every proxy using this runner base dir.
        let runtime =
            MitmdumpRuntime::acquire(config.runtime_dir.clone(), config.runtime_lock_path.clone())
                .await?;
        let port = find_available_port()?;

        // Write addon scripts to directory.
        // Remove-and-recreate to purge stale files from previous binary versions
        // (e.g. a renamed module would leave an orphan .py that Python could import).
        match tokio::fs::remove_dir_all(&config.addon_dir).await {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(RunnerError::Internal(format!(
                    "remove stale addon dir {}: {e}",
                    config.addon_dir.display()
                )));
            }
        }
        tokio::fs::create_dir_all(&config.addon_dir)
            .await
            .map_err(|e| RunnerError::Internal(format!("create addon dir: {e}")))?;
        for (name, content) in addon_files {
            let name = name.as_ref();
            let content = content.as_ref();
            // Addon file names may include subdirectories (e.g.
            // "usage/providers/connectors/x.py") after the usage/ package split.
            // Ensure the parent directory exists before writing.
            let path = config.addon_dir.join(name);
            if let Some(parent) = path.parent() {
                tokio::fs::create_dir_all(parent).await.map_err(|e| {
                    RunnerError::Internal(format!(
                        "create addon parent dir {}: {e}",
                        parent.display()
                    ))
                })?;
            }
            tokio::fs::write(&path, content)
                .await
                .map_err(|e| RunnerError::Internal(format!("write addon {name}: {e}")))?;
        }

        // Write empty registry file.
        write_empty_registry(&config.registry_path).await?;

        let (crash_tx, crash_rx) = mpsc::channel(1);
        let usage_state_id = uuid::Uuid::new_v4().to_string();
        let control = ControlHandle::default();

        Ok((
            Self {
                port,
                config,
                runtime: Some(runtime),
                child: None,
                crash_tx,
                stopping: Arc::new(AtomicBool::new(false)),
                usage_state_id,
                delivery_flush: None,
                control,
            },
            crash_rx,
        ))
    }

    /// Spawn the mitmdump process.
    pub async fn start(&mut self) -> RunnerResult<()> {
        if self.child.is_some() {
            return Err(RunnerError::Internal(
                "mitmdump process is already started".to_string(),
            ));
        }
        let runtime =
            Arc::clone(self.runtime.as_ref().ok_or_else(|| {
                RunnerError::Internal("missing mitmdump runtime owner".to_string())
            })?);

        let mut attempt = 1;
        loop {
            let stopping = Arc::new(AtomicBool::new(false));
            self.stopping = Arc::clone(&stopping);
            match spawn_mitmdump(
                &self.config,
                &runtime,
                self.port,
                &self.crash_tx,
                &stopping,
                &self.usage_state_id,
            )
            .await
            {
                Ok(child) => {
                    self.complete_restart(child);
                    info!(port = self.port, "mitmdump started");
                    return Ok(());
                }
                Err(error) if error.is_port_in_use() && attempt < START_MAX_ATTEMPTS => {
                    warn!(
                        attempt,
                        max_attempts = START_MAX_ATTEMPTS,
                        port = self.port,
                        error = %error,
                        "mitmdump port was claimed before startup; retrying with a fresh port",
                    );
                    self.port = find_available_port()?;
                    attempt += 1;
                }
                Err(error) => return Err(error.into_runner_error()),
            }
        }
    }

    /// The selected mitmdump port.
    ///
    /// Initial startup may replace this port while recovering from a bind
    /// collision. Call this after [`Self::start`] before publishing the port
    /// to sandbox network configuration.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Create a cloneable handle for registry operations (register/unregister sandboxes).
    ///
    /// The handle is `Clone + Send + Sync` and uses file locking for concurrent
    /// access, making it safe to share across executor tasks.
    pub fn registry_handle(&self) -> ProxyRegistryHandle {
        ProxyRegistryHandle {
            registry_path: self.config.registry_path.clone(),
            lock_path: self.config.registry_lock_path.clone(),
            control: self.control.clone(),
        }
    }

    /// Create a cloneable handle for asking the addon to flush accepted JSONL writes.
    pub fn jsonl_flush_handle(&self) -> MitmJsonlFlushHandle {
        MitmJsonlFlushHandle::new(self.control.clone())
    }

    /// Register a sandbox in the proxy registry so the addon can identify its traffic.
    pub async fn register_sandbox(
        &self,
        source_ip: &str,
        registration: &SandboxRegistration<'_>,
    ) -> RunnerResult<()> {
        let registry = self.registry_handle();
        let publication = registry.register_sandbox(source_ip, registration).await?;
        registry.observe_registration(publication);
        Ok(())
    }

    /// Unregister a sandbox from the proxy registry.
    pub async fn unregister_sandbox(&self, source_ip: &str) -> RunnerResult<()> {
        let publication = self.registry_handle().unregister_sandbox(source_ip).await?;
        publication.observe().await;
        Ok(())
    }

    /// Freeze the live launch; callers never follow a later replacement.
    pub fn usage_flush_target(&mut self) -> Option<DeliveryTarget> {
        let child_exited = match self.child.as_mut()?.try_wait() {
            Ok(Some(status)) => {
                error!(
                    r#type = "usage_underbilling",
                    reason = "mitm_exited_before_usage_flush",
                    underbilling_class = "risk",
                    component = "runner",
                    code = status.code(),
                    "mitmdump exited before usage flush"
                );
                true
            }
            Ok(None) => false,
            Err(e) => {
                warn!(error = %e, "failed to query mitmdump status before usage flush");
                false
            }
        };
        if child_exited {
            // Retain the lifecycle owner so the later async stop path can
            // remove its private launch directory deterministically.
            return None;
        }

        let _child_pid = self.child.as_ref().and_then(|child| child.id())?;
        self.control.target().map(DeliveryTarget)
    }

    /// Queue a bounded background control wake without blocking the main loop.
    pub fn request_usage_flush(&mut self) -> bool {
        let Some(target) = self.usage_flush_target() else {
            return false;
        };
        self.delivery_flush
            .get_or_insert_with(FlushTask::new)
            .request(target.0)
    }

    /// Transfer any lingering child and fresh parameters to the restart owner,
    /// permanently silencing the old monitor without waiting for process I/O.
    ///
    /// `stopping` is scoped to a single child. The old flag is set to
    /// `true` (so the old monitor task, which may observe the stdout
    /// pipe close at some arbitrary point after this call returns,
    /// reads "graceful shutdown" and never emits a spurious crash
    /// notification) and the field is replaced with a fresh `Arc` for
    /// the incoming process. The new child's monitor starts from a
    /// clean slate and will detect real crashes.
    ///
    /// The caller drives `MitmRestartParams::spawn` in a background task. It
    /// finishes old-child cleanup before starting the replacement; the caller
    /// then adopts the result with `complete_restart`.
    pub fn begin_restart(&mut self) -> MitmRestartParams {
        let old_child = self.take_stopping_child();
        let new_stopping = Arc::new(AtomicBool::new(false));
        self.stopping = Arc::clone(&new_stopping);
        let usage_state_id = uuid::Uuid::new_v4().to_string();
        self.usage_state_id = usage_state_id.clone();
        MitmRestartParams {
            old_child,
            config: self.config.clone(),
            runtime: self.runtime.clone(),
            port: self.port,
            crash_tx: self.crash_tx.clone(),
            stopping: new_stopping,
            usage_state_id,
        }
    }

    /// Finish a restart by storing the newly spawned child process.
    pub fn complete_restart(&mut self, child: ManagedMitmdump) {
        self.control
            .set_target(child.control_directory().map(|directory| ControlTarget {
                directory: directory.to_path_buf(),
                generation: self.usage_state_id.clone(),
            }));
        self.child = Some(child);
    }

    /// Withdraw the current launch before transferring its child to an explicit stop owner.
    fn take_stopping_child(&mut self) -> Option<ManagedMitmdump> {
        self.control.set_target(None);
        self.delivery_flush = None;
        // Each monitor keeps its own flag: an old child's delayed EOF must
        // never be interpreted as a crash of the replacement.
        self.stopping.store(true, Ordering::Release);
        self.child.take()
    }

    /// Gracefully stop mitmdump (SIGTERM → timeout → SIGKILL).
    pub async fn stop(&mut self) -> RunnerResult<()> {
        let Some(child) = self.take_stopping_child() else {
            return Ok(());
        };
        child.stop_gracefully().await
    }

    /// Immediately kill and reap mitmdump without the graceful SIGTERM window.
    pub async fn kill_now(&mut self) -> RunnerResult<()> {
        let Some(child) = self.take_stopping_child() else {
            return Ok(());
        };
        child.force_stop().await
    }
}

#[cfg(any(test, feature = "test-support"))]
impl MitmProxy {
    /// Create a noop proxy for testing. No real process is spawned.
    ///
    /// `stop()` already handles `child: None` (returns immediately).
    /// `begin_restart()` returns parameters whose spawn path fails
    /// deterministically because there is no runtime owner, allowing tests
    /// to exercise restart failure handling without starting a process.
    pub fn noop() -> (Self, mpsc::Receiver<()>) {
        let (crash_tx, crash_rx) = mpsc::channel(1);
        (
            Self {
                port: 0,
                config: ProxyConfig {
                    mitmdump_bin: std::path::PathBuf::new(),
                    ca_dir: std::path::PathBuf::new(),
                    ca_lock_path: std::path::PathBuf::new(),
                    addon_dir: std::path::PathBuf::new(),
                    registry_path: std::path::PathBuf::new(),
                    registry_lock_path: std::path::PathBuf::new(),
                    builtin_firewall_catalog_cache_path: std::path::PathBuf::new(),
                    runtime_dir: std::path::PathBuf::new(),
                    runtime_lock_path: std::path::PathBuf::new(),
                    api_url: None,
                    client_session_id: "runner-session-test".to_string(),
                    client_version: "test-runner-version",
                },
                runtime: None,
                child: None,
                crash_tx,
                stopping: Arc::new(AtomicBool::new(false)),
                usage_state_id: "test-usage-state-id".to_string(),
                delivery_flush: None,
                control: ControlHandle::default(),
            },
            crash_rx,
        )
    }

    pub fn set_control_directory_for_test(&self, directory: PathBuf) {
        self.control.set_target(Some(ControlTarget {
            directory,
            generation: self.usage_state_id.clone(),
        }));
    }

    pub fn set_child_for_test(&mut self, child: tokio::process::Child) {
        self.child = Some(ManagedMitmdump::unmanaged(child));
    }

    #[allow(clippy::expect_used)]
    pub fn set_reap_gate_for_test(&mut self, gate: crate::test_fixtures::ReapGate) {
        self.child
            .as_mut()
            .expect("test child installed")
            .set_reap_gate(gate);
    }
}

impl Drop for MitmProxy {
    fn drop(&mut self) {
        self.control.set_target(None);
        self.stopping.store(true, Ordering::Release);
        self.delivery_flush = None;
        drop(self.child.take());
    }
}

/// Parameters needed to spawn a mitmdump process, returned by
/// [`MitmProxy::begin_restart`]. All fields are owned/cloned so the spawn
/// can happen in a background task without borrowing `MitmProxy`.
pub struct MitmRestartParams {
    old_child: Option<ManagedMitmdump>,
    config: ProxyConfig,
    runtime: Option<Arc<MitmdumpRuntime>>,
    port: u16,
    crash_tx: mpsc::Sender<()>,
    stopping: Arc<AtomicBool>,
    usage_state_id: String,
}

#[derive(Debug, thiserror::Error)]
pub enum MitmRestartError {
    #[error("old mitmdump cleanup failed: {0}")]
    Cleanup(RunnerError),
    #[error(transparent)]
    Startup(#[from] RunnerError),
}

impl MitmRestartParams {
    /// Spawn mitmdump using these parameters. Suitable for `tokio::spawn`.
    pub async fn spawn(self) -> Result<ManagedMitmdump, MitmRestartError> {
        if let Some(mut child) = self.old_child {
            let pid = child.id();
            match child.try_wait() {
                Ok(Some(_)) => {}
                result => error!(
                    r#type = "usage_underbilling",
                    reason = "mitm_restart_in_memory_usage_risk",
                    underbilling_class = "risk",
                    component = "runner",
                    ?result,
                    "restarting mitmdump without confirmed exit; in-memory usage may be lost"
                ),
            }
            // Includes reaping and launch-directory cleanup. A replacement
            // must not start while the old process tree is still owned.
            child
                .force_stop()
                .instrument(tracing::info_span!("mitm_old_child_cleanup", pid))
                .await
                .map_err(MitmRestartError::Cleanup)?;
        }
        let runtime = self
            .runtime
            .ok_or_else(|| RunnerError::Internal("missing mitmdump runtime owner".to_string()))?;
        spawn_mitmdump(
            &self.config,
            &runtime,
            self.port,
            &self.crash_tx,
            &self.stopping,
            &self.usage_state_id,
        )
        .await
        .map_err(|failure| MitmRestartError::Startup(failure.into_runner_error()))
    }
}

/// Spawn a mitmdump process, wire up stdout/stderr monitors, and wait for
/// it to become ready. This is a free function so it can run in a
/// `tokio::spawn` without borrowing `MitmProxy`.
async fn spawn_mitmdump(
    config: &ProxyConfig,
    runtime: &Arc<MitmdumpRuntime>,
    port: u16,
    crash_tx: &mpsc::Sender<()>,
    stopping: &Arc<AtomicBool>,
    usage_state_id: &str,
) -> Result<ManagedMitmdump, MitmdumpStartupFailure> {
    let _prepared_ca = crate::ca::prepare_for_proxy(&config.ca_dir, &config.ca_lock_path).await?;
    let launch = runtime.create_launch_dir().await?;
    let launch_path = launch.path().to_path_buf();
    let mut cmd = tokio::process::Command::new(&config.mitmdump_bin);
    cmd.arg("--mode")
        .arg("transparent")
        .arg("--listen-port")
        .arg(port.to_string())
        .arg("--set")
        .arg(format!("confdir={}", config.ca_dir.display()))
        .arg("--set")
        .arg("upstream_cert=false")
        .arg("--set")
        .arg(format!(
            "okou_proxy_registry_path={}",
            config.registry_path.display()
        ))
        .arg("--set")
        .arg(format!("okou_usage_state_id={usage_state_id}"))
        .arg("--set")
        .arg(format!("okou_control_socket_dir={}", launch_path.display()))
        .arg("--set")
        .arg(format!(
            "okou_builtin_firewall_catalog_cache_path={}",
            config.builtin_firewall_catalog_cache_path.display()
        ))
        .arg("--set")
        .arg(format!(
            "okou_client_session_id={}",
            config.client_session_id
        ))
        .arg("--set")
        .arg(format!("okou_client_version={}", config.client_version))
        .arg("--scripts")
        .arg(config.addon_dir.join("mitm_addon.py"))
        .arg("--set")
        .arg("flow_detail=0")
        .arg("--set")
        .arg("termlog_verbosity=warn");
    if let Some(url) = &config.api_url {
        cmd.arg("--set").arg(format!("okou_api_url={url}"));
    }
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    cmd.env("TMPDIR", &launch_path)
        .env(CANONICAL_RUNTIME_MARKER_ENV, &launch_path)
        .process_group(0);
    cmd.kill_on_drop(true);

    // This covers the direct PyInstaller bootloader; managed process-group
    // shutdown and marker reconciliation cover its forked application child.
    runner_host::parent_death::configure_parent_death_signal(&mut cmd);

    info!(port, bin = %config.mitmdump_bin.display(), "starting mitmdump");

    let child = spawn_mitmdump_child(&mut cmd, &config.mitmdump_bin).await?;
    let mut child = ManagedMitmdump::new(child, launch, Arc::clone(runtime))?;

    // Start draining stdout before readiness so the child cannot block on a
    // full pipe. Crash forwarding is attached only after startup succeeds.
    let stdout_monitor = child
        .child_mut()
        .and_then(|child| child.stdout.take())
        .map(|stdout| tokio::spawn(async move { monitor_mitmdump_stdout(stdout).await }));
    let stderr_monitor = child
        .child_mut()
        .and_then(|child| child.stderr.take())
        .map(|stderr| tokio::spawn(async move { monitor_mitmdump_stderr(stderr, port).await }));

    if let Err(error) = wait_for_ready(
        child.child_mut().ok_or_else(|| {
            RunnerError::Internal("missing mitmdump child during readiness check".to_string())
        })?,
        port,
        &launch_path,
        usage_state_id,
        READY_TIMEOUT,
    )
    .await
    {
        stopping.store(true, Ordering::Release);
        let stop_result = child.force_stop().await;
        let stdout_result = match stdout_monitor {
            Some(stdout_monitor) => stdout_monitor.await.map_err(|join_error| {
                RunnerError::Internal(format!(
                    "join mitmdump stdout monitor after startup failure: {join_error}"
                ))
            }),
            None => Ok(()),
        };
        let port_in_use_result = match stderr_monitor {
            Some(stderr_monitor) => stderr_monitor.await.map_err(|join_error| {
                RunnerError::Internal(format!(
                    "join mitmdump stderr monitor after startup failure: {join_error}"
                ))
            }),
            None => Ok(false),
        };
        stop_result?;
        stdout_result?;
        if port_in_use_result? {
            return Err(MitmdumpStartupFailure::PortInUse(error));
        }
        return Err(MitmdumpStartupFailure::Other(error));
    }

    if let Some(stdout_monitor) = stdout_monitor {
        let crash_tx = crash_tx.clone();
        let stopping = Arc::clone(stopping);
        tokio::spawn(async move {
            let _ = stdout_monitor.await;
            if !stopping.load(Ordering::Acquire) {
                let _ = crash_tx.send(()).await;
            }
        });
    }

    Ok(child)
}

fn mitmdump_stderr_reports_port_in_use(line: &str, port: u16) -> bool {
    let line = line.to_ascii_lowercase();
    line.contains("failed to listen on")
        && line.contains(&format!(":{port}"))
        && line.contains("address already in use")
}

fn is_text_file_busy(error: &std::io::Error) -> bool {
    error.raw_os_error() == Some(nix::libc::ETXTBSY)
}

async fn spawn_mitmdump_child(
    cmd: &mut tokio::process::Command,
    bin: &Path,
) -> RunnerResult<tokio::process::Child> {
    spawn_mitmdump_child_with_retry(cmd, bin, TEXT_BUSY_SPAWN_RETRY_DELAY, |attempt, error| {
        warn!(
            attempt,
            bin = %bin.display(),
            error = %error,
            "mitmdump binary is text-busy, retrying spawn"
        );
    })
    .await
}

async fn spawn_mitmdump_child_with_retry(
    cmd: &mut tokio::process::Command,
    bin: &Path,
    retry_delay: Duration,
    on_text_busy: impl FnMut(usize, &std::io::Error),
) -> RunnerResult<tokio::process::Child> {
    retry_text_busy_spawn(bin, retry_delay, || cmd.spawn(), on_text_busy).await
}

async fn retry_text_busy_spawn<T>(
    bin: &Path,
    retry_delay: Duration,
    mut spawn: impl FnMut() -> std::io::Result<T>,
    mut on_text_busy: impl FnMut(usize, &std::io::Error),
) -> RunnerResult<T> {
    let mut attempt = 0usize;
    loop {
        match spawn() {
            Ok(child) => return Ok(child),
            Err(error) if is_text_file_busy(&error) && attempt < TEXT_BUSY_SPAWN_MAX_RETRIES => {
                attempt += 1;
                on_text_busy(attempt, &error);
                tokio::time::sleep(retry_delay).await;
            }
            Err(error) => {
                return Err(RunnerError::Internal(format!(
                    "spawn mitmdump {}: {error}",
                    bin.display()
                )));
            }
        }
    }
}

/// Wait for the addon to initialize and mitmdump to start listening on `port`.
async fn wait_for_ready(
    child: &mut tokio::process::Child,
    port: u16,
    control_directory: &Path,
    expected_usage_state_id: &str,
    timeout: Duration,
) -> RunnerResult<()> {
    let poll_interval = Duration::from_millis(200);
    let deadline = tokio::time::Instant::now() + timeout;
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));

    while tokio::time::Instant::now() < deadline {
        // Check if process died.
        match child.try_wait() {
            Ok(Some(status)) => {
                return Err(RunnerError::Internal(format!(
                    "mitmdump exited immediately with {}",
                    status
                        .code()
                        .map_or("unknown".to_string(), |c| c.to_string()),
                )));
            }
            Ok(None) => {}
            Err(e) => {
                return Err(RunnerError::Internal(format!(
                    "mitmdump process check: {e}"
                )));
            }
        }
        let probe_deadline = deadline.min(tokio::time::Instant::now() + Duration::from_secs(1));
        let addon_is_ready =
            control::status(control_directory, expected_usage_state_id, probe_deadline)
                .await
                .is_ok();
        if addon_is_ready
            && matches!(
                tokio::time::timeout_at(deadline, tokio::net::TcpStream::connect(addr)).await,
                Ok(Ok(_))
            )
        {
            return Ok(());
        }
        tokio::time::sleep_until(deadline.min(tokio::time::Instant::now() + poll_interval)).await;
    }

    Err(RunnerError::Internal(format!(
        "mitmdump did not initialize its addon and start listening on port {port} within {}s",
        timeout.as_secs()
    )))
}

/// Find an available TCP port by binding to port 0.
fn find_available_port() -> RunnerResult<u16> {
    let listener = std::net::TcpListener::bind("0.0.0.0:0")
        .map_err(|e| RunnerError::Internal(format!("bind port 0: {e}")))?;
    let port = listener
        .local_addr()
        .map_err(|e| RunnerError::Internal(format!("local_addr: {e}")))?
        .port();
    Ok(port)
}

#[cfg(test)]
mod tests;
