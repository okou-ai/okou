//! Private filesystem ownership for PyInstaller one-file extraction.

use std::collections::HashSet;
use std::fs::File;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use nix::fcntl::Flock;
use tracing::{info, warn};

use crate::error::{RunnerError, RunnerResult};
use crate::process::{ProcessStat, ProcessStatRead, process_stat_is_live};

// Marker-bearing descendants can outlive their runner, so cleanup resolves the
// canonical marker from each process environment before signalling it.
pub(super) const CANONICAL_RUNTIME_MARKER_ENV: &str = "OKOU_MITMDUMP_RUNTIME_DIR";
const CANONICAL_RUNTIME_MARKER_PREFIX: &[u8] = b"OKOU_MITMDUMP_RUNTIME_DIR=";
const LAUNCH_PREFIX: &str = "launch-";
const PROCESS_EXIT_TIMEOUT: Duration = Duration::from_secs(5);
const PROCESS_EXIT_POLL_INTERVAL: Duration = Duration::from_millis(20);

#[derive(Clone, Copy)]
struct ProcessIdentity {
    pid: u32,
    starttime: u64,
}

#[derive(Clone)]
struct ProcessObservation {
    identity: ProcessIdentity,
    stat: ProcessStat,
    command: String,
}

struct ProcessSnapshot {
    processes: Vec<ProcessObservation>,
    elapsed: Duration,
    examined: usize,
    same_uid: usize,
}

#[cfg(test)]
struct TestEnvironmentReadError {
    pid: u32,
    error: Box<dyn FnOnce() -> std::io::Error + Send>,
}

/// Serializes owners of the runner-local proxy resources and scopes every
/// PyInstaller extraction to one private launch directory.
pub(super) struct MitmdumpRuntime {
    root: PathBuf,
    _lock: Flock<File>,
    #[cfg(test)]
    test_environment_read_error: std::sync::Mutex<Option<TestEnvironmentReadError>>,
}

impl MitmdumpRuntime {
    pub(super) async fn acquire(root: PathBuf, lock_path: PathBuf) -> RunnerResult<Arc<Self>> {
        crate::private_fs::ensure_private_dir(&root).await?;
        let root = tokio::fs::canonicalize(&root).await.map_err(|error| {
            RunnerError::Config(format!(
                "canonicalize mitmdump runtime directory {}: {error}",
                root.display()
            ))
        })?;
        let runtime_lock = crate::lock::try_acquire(lock_path.clone())
            .await
            .map_err(|error| {
                RunnerError::Config(format!(
                    "acquire mitmdump runtime lock {}: {error}",
                    lock_path.display()
                ))
            })?;
        let runtime = Arc::new(Self {
            root,
            _lock: runtime_lock,
            #[cfg(test)]
            test_environment_read_error: std::sync::Mutex::new(None),
        });
        runtime.reconcile().await?;
        Ok(runtime)
    }

    pub(super) async fn create_launch_dir(&self) -> RunnerResult<tempfile::TempDir> {
        self.reconcile().await?;
        tempfile::Builder::new()
            .prefix(LAUNCH_PREFIX)
            .permissions(std::os::unix::fs::PermissionsExt::from_mode(0o700))
            .tempdir_in(&self.root)
            .map_err(|error| {
                RunnerError::Internal(format!(
                    "create mitmdump launch directory in {}: {error}",
                    self.root.display()
                ))
            })
    }

    pub(super) async fn close_launch(&self, launch: tempfile::TempDir) -> RunnerResult<()> {
        // Persist before the first await so task cancellation cannot let
        // TempDir remove a directory that a marked descendant still uses.
        let path = launch.keep();
        self.close_launch_path(path).await
    }

    pub(super) async fn close_launch_path(&self, path: PathBuf) -> RunnerResult<()> {
        if !self.is_launch_path(&path) {
            return Err(RunnerError::Internal(format!(
                "refusing to close unowned mitmdump launch path {}",
                path.display()
            )));
        }
        if let Err(error) = self.terminate_marked_processes(Some(&path)).await {
            warn!(error = %error, "preserving mitmdump launch directory for later reconciliation");
            return Err(error);
        }
        match tokio::fs::remove_dir_all(&path).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(RunnerError::Internal(format!(
                "remove mitmdump launch directory {}: {error}",
                path.display()
            ))),
        }
    }

    async fn reconcile(&self) -> RunnerResult<()> {
        let launch_dirs = self.discover_launch_dirs().await?;
        if launch_dirs.is_empty() {
            return Ok(());
        }
        self.terminate_marked_processes(None).await?;

        let mut removed = 0usize;
        for launch_dir in launch_dirs {
            match tokio::fs::remove_dir_all(&launch_dir).await {
                Ok(()) => removed += 1,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(RunnerError::Internal(format!(
                        "remove stale mitmdump launch directory {}: {error}",
                        launch_dir.display()
                    )));
                }
            }
        }
        if removed > 0 {
            info!(removed, root = %self.root.display(), "reconciled stale mitmdump launch directories");
        }
        Ok(())
    }

    async fn discover_launch_dirs(&self) -> RunnerResult<Vec<PathBuf>> {
        let expected_uid = nix::unistd::geteuid().as_raw();
        let mut entries = tokio::fs::read_dir(&self.root).await.map_err(|error| {
            RunnerError::Internal(format!(
                "read mitmdump runtime directory {}: {error}",
                self.root.display()
            ))
        })?;
        let mut launch_dirs = Vec::new();
        loop {
            let entry = entries.next_entry().await.map_err(|error| {
                RunnerError::Internal(format!(
                    "read entry in mitmdump runtime directory {}: {error}",
                    self.root.display()
                ))
            })?;
            let Some(entry) = entry else {
                break;
            };
            let name = entry.file_name();
            if !name.as_bytes().starts_with(LAUNCH_PREFIX.as_bytes()) {
                continue;
            }
            let path = entry.path();
            let metadata = tokio::fs::symlink_metadata(&path).await.map_err(|error| {
                RunnerError::Internal(format!(
                    "inspect mitmdump launch path {}: {error}",
                    path.display()
                ))
            })?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err(RunnerError::Config(format!(
                    "mitmdump launch path {} is not an owned directory",
                    path.display()
                )));
            }
            if metadata.uid() != expected_uid {
                return Err(RunnerError::Config(format!(
                    "mitmdump launch directory {} is owned by uid {}, expected {}",
                    path.display(),
                    metadata.uid(),
                    expected_uid
                )));
            }
            launch_dirs.push(path);
        }
        launch_dirs.sort();
        Ok(launch_dirs)
    }

    async fn terminate_marked_processes(&self, exact_path: Option<&Path>) -> RunnerResult<()> {
        let target = exact_path.unwrap_or(&self.root);
        let mut consecutive_empty_scans = 0u8;
        loop {
            let snapshot = self.scan_marked_processes(exact_path).await?;
            log_process_snapshot(target, &snapshot);
            if snapshot.processes.is_empty() {
                consecutive_empty_scans += 1;
                if consecutive_empty_scans == 2 {
                    return Ok(());
                }
            } else {
                consecutive_empty_scans = 0;
                for process in &snapshot.processes {
                    signal_stable_process(self, exact_path, process.identity).await?;
                }
                wait_for_processes_exit(target, &snapshot).await?;
            }
            tokio::time::sleep(PROCESS_EXIT_POLL_INTERVAL).await;
        }
    }

    async fn scan_marked_processes(
        &self,
        exact_path: Option<&Path>,
    ) -> RunnerResult<ProcessSnapshot> {
        let root = self.root.clone();
        let exact_path = exact_path.map(Path::to_path_buf);
        tokio::task::spawn_blocking(move || scan_marked_processes(&root, exact_path.as_deref()))
            .await
            .map_err(|error| {
                RunnerError::Internal(format!(
                    "join mitmdump runtime owner discovery task: {error}"
                ))
            })?
    }

    fn is_launch_path(&self, path: &Path) -> bool {
        is_launch_path(&self.root, path)
    }

    async fn read_process_environment(&self, pid: u32) -> std::io::Result<Vec<u8>> {
        #[cfg(test)]
        {
            let test_error = {
                let mut test_error = self.test_environment_read_error.lock().unwrap();
                if test_error.as_ref().is_some_and(|error| error.pid == pid) {
                    test_error.take()
                } else {
                    None
                }
            };
            if let Some(test_error) = test_error {
                return Err((test_error.error)());
            }
        }
        tokio::fs::read(format!("/proc/{pid}/environ")).await
    }

    #[cfg(test)]
    fn set_test_environment_read_error(
        &self,
        pid: u32,
        error: impl FnOnce() -> std::io::Error + Send + 'static,
    ) {
        let mut test_error = self.test_environment_read_error.lock().unwrap();
        assert!(
            test_error.is_none(),
            "test environment read error is already set"
        );
        *test_error = Some(TestEnvironmentReadError {
            pid,
            error: Box::new(error),
        });
    }
}

fn scan_marked_processes(root: &Path, exact_path: Option<&Path>) -> RunnerResult<ProcessSnapshot> {
    let started = std::time::Instant::now();
    let expected_uid = nix::unistd::geteuid().as_raw();
    let entries = std::fs::read_dir("/proc").map_err(|error| {
        RunnerError::Internal(format!("scan /proc for mitmdump runtime owners: {error}"))
    })?;
    let mut processes = Vec::new();
    let mut seen = HashSet::new();
    let mut examined = 0usize;
    let mut same_uid = 0usize;
    for entry in entries {
        let entry = entry.map_err(|error| {
            RunnerError::Internal(format!(
                "read /proc entry for mitmdump runtime owners: {error}"
            ))
        })?;
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<u32>().ok())
        else {
            continue;
        };
        examined += 1;
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(error) if process_disappeared(&error) => continue,
            Err(error) => {
                return Err(RunnerError::Internal(format!(
                    "inspect /proc/{pid} for mitmdump runtime owner: {error}"
                )));
            }
        };
        if metadata.uid() != expected_uid {
            continue;
        }
        same_uid += 1;
        let Some(environ) = read_process_environ(pid)? else {
            continue;
        };
        let Some(marker) = resolve_runtime_marker(&environ) else {
            continue;
        };
        let marker_path = Path::new(std::ffi::OsStr::from_bytes(marker));
        if !is_launch_path(root, marker_path)
            || exact_path.is_some_and(|expected| marker_path != expected)
        {
            continue;
        }
        let before = match crate::process::read_process_stat_checked_blocking(pid) {
            ProcessStatRead::Found(stat) if process_stat_is_live(&stat) => stat,
            ProcessStatRead::Found(_) | ProcessStatRead::Missing => continue,
            ProcessStatRead::Unreadable(error) if process_disappeared(&error) => continue,
            ProcessStatRead::Unreadable(error) => {
                return Err(RunnerError::Internal(format!(
                    "read /proc/{pid}/stat for mitmdump runtime owner: {error}"
                )));
            }
            ProcessStatRead::Invalid => {
                return Err(RunnerError::Internal(format!(
                    "parse /proc/{pid}/stat for mitmdump runtime owner"
                )));
            }
        };
        let Some(rechecked_environ) = read_process_environ(pid)? else {
            continue;
        };
        if resolve_runtime_marker(&rechecked_environ) != Some(marker) {
            continue;
        }
        let after = match crate::process::read_process_stat_checked_blocking(pid) {
            ProcessStatRead::Found(stat) if process_stat_is_live(&stat) => stat,
            ProcessStatRead::Found(_) | ProcessStatRead::Missing => continue,
            ProcessStatRead::Unreadable(error) if process_disappeared(&error) => continue,
            ProcessStatRead::Unreadable(error) => {
                return Err(RunnerError::Internal(format!(
                    "recheck /proc/{pid}/stat for mitmdump runtime owner: {error}"
                )));
            }
            ProcessStatRead::Invalid => {
                return Err(RunnerError::Internal(format!(
                    "reparse /proc/{pid}/stat for mitmdump runtime owner"
                )));
            }
        };
        if before.procfs_generation() != after.procfs_generation()
            || !seen.insert((pid, after.starttime))
        {
            continue;
        }
        let command = read_process_comm(pid);
        processes.push(ProcessObservation {
            identity: ProcessIdentity {
                pid,
                starttime: after.starttime,
            },
            stat: after,
            command,
        });
    }
    Ok(ProcessSnapshot {
        processes,
        elapsed: started.elapsed(),
        examined,
        same_uid,
    })
}

fn read_process_environ(pid: u32) -> RunnerResult<Option<Vec<u8>>> {
    match std::fs::read(format!("/proc/{pid}/environ")) {
        Ok(environ) => Ok(Some(environ)),
        Err(error) if process_disappeared(&error) => Ok(None),
        Err(error) if process_comm_is_mitmdump(pid)? => Err(RunnerError::Internal(format!(
            "read /proc/{pid}/environ for mitmdump runtime owner: {error}"
        ))),
        Err(_) => Ok(None),
    }
}

fn process_comm_is_mitmdump(pid: u32) -> RunnerResult<bool> {
    let path = format!("/proc/{pid}/comm");
    match std::fs::read(&path) {
        Ok(comm) => Ok(comm.strip_suffix(b"\n").unwrap_or(&comm) == b"mitmdump"),
        Err(error) if process_disappeared(&error) => Ok(false),
        Err(error) => Err(RunnerError::Internal(format!(
            "read {path} after an unreadable process environment: {error}"
        ))),
    }
}

fn read_process_comm(pid: u32) -> String {
    let path = format!("/proc/{pid}/comm");
    match std::fs::read(&path) {
        Ok(comm) => {
            let comm = comm.strip_suffix(b"\n").unwrap_or(&comm);
            String::from_utf8_lossy(comm).into_owned()
        }
        Err(_) => "<unavailable>".to_string(),
    }
}

fn process_disappeared(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::NotFound || error.raw_os_error() == Some(nix::libc::ESRCH)
}

fn resolve_runtime_marker(environ: &[u8]) -> Option<&[u8]> {
    environ
        .split(|byte| *byte == 0)
        .find_map(|entry| entry.strip_prefix(CANONICAL_RUNTIME_MARKER_PREFIX))
}

fn is_launch_path(root: &Path, path: &Path) -> bool {
    path.parent() == Some(root)
        && path
            .file_name()
            .is_some_and(|name| name.as_bytes().starts_with(LAUNCH_PREFIX.as_bytes()))
}

fn log_process_snapshot(target: &Path, snapshot: &ProcessSnapshot) {
    if snapshot.elapsed >= PROCESS_EXIT_TIMEOUT {
        let elapsed_ms = snapshot.elapsed.as_millis();
        let matched = snapshot.processes.len();
        warn!(
            target = %target.display(),
            elapsed_ms,
            examined = snapshot.examined,
            same_uid = snapshot.same_uid,
            matched,
            "mitmdump process discovery exceeded the process-exit budget"
        );
    }
}

async fn wait_for_processes_exit(target: &Path, snapshot: &ProcessSnapshot) -> RunnerResult<()> {
    let deadline = tokio::time::Instant::now() + PROCESS_EXIT_TIMEOUT;
    let mut remaining = snapshot.processes.clone();
    loop {
        let mut live = Vec::new();
        for process in &remaining {
            if let Some(observation) = observe_stable_process(process).await? {
                live.push(observation);
            }
        }
        if live.is_empty() {
            return Ok(());
        }
        remaining = live;

        let now = tokio::time::Instant::now();
        if now >= deadline {
            return Err(process_exit_timeout_error(target, snapshot, &remaining));
        }
        tokio::time::sleep_until(std::cmp::min(deadline, now + PROCESS_EXIT_POLL_INTERVAL)).await;
    }
}

async fn observe_stable_process(
    process: &ProcessObservation,
) -> RunnerResult<Option<ProcessObservation>> {
    match crate::process::read_process_stat_checked(process.identity.pid).await {
        ProcessStatRead::Found(stat)
            if process_stat_is_live(&stat) && stat.starttime == process.identity.starttime =>
        {
            Ok(Some(ProcessObservation {
                identity: process.identity,
                stat,
                command: process.command.clone(),
            }))
        }
        ProcessStatRead::Found(_) | ProcessStatRead::Missing => Ok(None),
        ProcessStatRead::Unreadable(error) if process_disappeared(&error) => Ok(None),
        ProcessStatRead::Unreadable(error) => Err(RunnerError::Internal(format!(
            "read /proc/{}/stat while waiting for mitmdump cleanup: {error}",
            process.identity.pid
        ))),
        ProcessStatRead::Invalid => Err(RunnerError::Internal(format!(
            "parse /proc/{}/stat while waiting for mitmdump cleanup",
            process.identity.pid
        ))),
    }
}

fn process_exit_timeout_error(
    target: &Path,
    snapshot: &ProcessSnapshot,
    remaining: &[ProcessObservation],
) -> RunnerError {
    let processes = remaining
        .iter()
        .map(|process| {
            format!(
                "pid={} state={} ppid={} pgid={} starttime={} command={:?}",
                process.identity.pid,
                process.stat.state,
                process.stat.ppid,
                process.stat.pgid,
                process.identity.starttime,
                process.command
            )
        })
        .collect::<Vec<_>>()
        .join("; ");
    RunnerError::Internal(format!(
        "timed out waiting for signalled mitmdump processes using {}: \
         discovery_elapsed_ms={}, examined={}, same_uid={}, matched={}; remaining=[{}]",
        target.display(),
        snapshot.elapsed.as_millis(),
        snapshot.examined,
        snapshot.same_uid,
        snapshot.processes.len(),
        processes
    ))
}

async fn signal_stable_process(
    runtime: &MitmdumpRuntime,
    exact_path: Option<&Path>,
    process: ProcessIdentity,
) -> RunnerResult<()> {
    let Some(pidfd) = open_pidfd(process.pid)? else {
        return Ok(());
    };
    if !marked_process_matches_after_pidfd_open(runtime, exact_path, process).await? {
        return Ok(());
    }
    match rustix::process::pidfd_send_signal(&pidfd, rustix::process::Signal::KILL) {
        Ok(()) | Err(rustix::io::Errno::SRCH) => Ok(()),
        Err(error) => Err(RunnerError::Internal(format!(
            "pidfd signal mitmdump runtime owner pid {}: {error}",
            process.pid
        ))),
    }
}

fn open_pidfd(pid: u32) -> RunnerResult<Option<std::os::fd::OwnedFd>> {
    let raw_pid = i32::try_from(pid)
        .ok()
        .and_then(rustix::process::Pid::from_raw)
        .ok_or_else(|| {
            RunnerError::Internal(format!(
                "convert mitmdump cleanup pid {pid} to a positive process id"
            ))
        })?;
    match rustix::process::pidfd_open(raw_pid, rustix::process::PidfdFlags::empty()) {
        Ok(pidfd) => Ok(Some(pidfd)),
        Err(rustix::io::Errno::SRCH) => Ok(None),
        Err(error) => Err(RunnerError::Internal(format!(
            "open pidfd for mitmdump runtime owner pid {pid}: {error}"
        ))),
    }
}

async fn marked_process_matches_after_pidfd_open(
    runtime: &MitmdumpRuntime,
    exact_path: Option<&Path>,
    process: ProcessIdentity,
) -> RunnerResult<bool> {
    let before = match crate::process::read_process_stat_checked(process.pid).await {
        ProcessStatRead::Found(stat) if process_stat_is_live(&stat) => stat,
        ProcessStatRead::Found(_) | ProcessStatRead::Missing => return Ok(false),
        ProcessStatRead::Unreadable(error) if process_disappeared(&error) => return Ok(false),
        ProcessStatRead::Unreadable(error) => {
            return Err(RunnerError::Internal(format!(
                "recheck /proc/{}/stat after opening mitmdump cleanup pidfd: {error}",
                process.pid
            )));
        }
        ProcessStatRead::Invalid => {
            return Err(RunnerError::Internal(format!(
                "reparse /proc/{}/stat after opening mitmdump cleanup pidfd",
                process.pid
            )));
        }
    };
    if before.starttime != process.starttime {
        return Ok(false);
    }

    let environ = match runtime.read_process_environment(process.pid).await {
        Ok(environ) => environ,
        Err(error) if process_disappeared(&error) => return Ok(false),
        Err(environment_error) => {
            match crate::process::read_process_stat_checked(process.pid).await {
                ProcessStatRead::Found(stat)
                    if process_stat_is_live(&stat) && stat.starttime == process.starttime =>
                {
                    return Err(RunnerError::Internal(format!(
                        "recheck /proc/{}/environ after opening mitmdump cleanup pidfd: {environment_error}",
                        process.pid
                    )));
                }
                ProcessStatRead::Found(_) | ProcessStatRead::Missing => return Ok(false),
                ProcessStatRead::Unreadable(error) if process_disappeared(&error) => {
                    return Ok(false);
                }
                ProcessStatRead::Unreadable(error) => {
                    return Err(RunnerError::Internal(format!(
                        "recheck /proc/{}/stat after environment recheck failed during mitmdump cleanup: {error}; environment error: {environment_error}",
                        process.pid
                    )));
                }
                ProcessStatRead::Invalid => {
                    return Err(RunnerError::Internal(format!(
                        "reparse /proc/{}/stat after environment recheck failed during mitmdump cleanup; environment error: {environment_error}",
                        process.pid
                    )));
                }
            }
        }
    };
    let Some(marker) = resolve_runtime_marker(&environ) else {
        return Ok(false);
    };
    let marker_path = Path::new(std::ffi::OsStr::from_bytes(marker));
    if !is_launch_path(&runtime.root, marker_path)
        || exact_path.is_some_and(|expected| marker_path != expected)
    {
        return Ok(false);
    }

    let after = match crate::process::read_process_stat_checked(process.pid).await {
        ProcessStatRead::Found(stat) if process_stat_is_live(&stat) => stat,
        ProcessStatRead::Found(_) | ProcessStatRead::Missing => return Ok(false),
        ProcessStatRead::Unreadable(error) if process_disappeared(&error) => return Ok(false),
        ProcessStatRead::Unreadable(error) => {
            return Err(RunnerError::Internal(format!(
                "final recheck /proc/{}/stat after opening mitmdump cleanup pidfd: {error}",
                process.pid
            )));
        }
        ProcessStatRead::Invalid => {
            return Err(RunnerError::Internal(format!(
                "final reparse /proc/{}/stat after opening mitmdump cleanup pidfd",
                process.pid
            )));
        }
    };
    Ok(before.procfs_generation() == after.procfs_generation()
        && after.starttime == process.starttime)
}

pub(super) fn preserve_launch(launch: tempfile::TempDir, error: &impl std::fmt::Display) {
    let path = launch.path().to_path_buf();
    let _kept_path = launch.keep();
    warn!(path = %path.display(), error = %error, "preserving mitmdump launch directory for later reconciliation");
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

    use super::*;

    struct ProbeChild {
        child: Child,
        stdin: ChildStdin,
        stdout: BufReader<ChildStdout>,
    }

    impl ProbeChild {
        fn spawn(marker: Option<(&str, &Path)>) -> Self {
            let mut command = Command::new("cat");
            command
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .env_remove(CANONICAL_RUNTIME_MARKER_ENV);
            if let Some((name, value)) = marker {
                command.env(name, value);
            }
            let mut child = command.spawn().unwrap();
            let stdin = child.stdin.take().unwrap();
            let stdout = BufReader::new(child.stdout.take().unwrap());
            Self {
                child,
                stdin,
                stdout,
            }
        }

        fn pid(&self) -> u32 {
            self.child.id()
        }

        fn assert_responds(&mut self) {
            writeln!(self.stdin, "probe").unwrap();
            self.stdin.flush().unwrap();
            let mut response = String::new();
            self.stdout.read_line(&mut response).unwrap();
            assert_eq!(response, "probe\n");
        }
    }

    fn marker_environment(canonical: Option<&[u8]>) -> Vec<u8> {
        let mut environ = b"UNRELATED=value\0".to_vec();
        if let Some(value) = canonical {
            environ.extend_from_slice(CANONICAL_RUNTIME_MARKER_PREFIX);
            environ.extend_from_slice(value);
            environ.push(0);
        }
        environ
    }

    #[tokio::test]
    async fn acquisition_reconciles_canonical_process() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("runtime");
        let lock_path = dir.path().join("runtime.lock");
        crate::private_fs::ensure_private_dir(&root).await.unwrap();
        let launch = root.join("launch-canonical");
        std::fs::create_dir(&launch).unwrap();
        let mut child = ProbeChild::spawn(Some((CANONICAL_RUNTIME_MARKER_ENV, &launch)));

        let runtime = MitmdumpRuntime::acquire(root, lock_path).await.unwrap();

        let status = child
            .child
            .try_wait()
            .unwrap()
            .expect("canonical-marked process is still running after reconciliation");
        assert!(
            !status.success(),
            "canonical-marked process was not signalled"
        );
        assert!(!launch.exists(), "stale canonical launch was not removed");
        drop(runtime);
    }

    #[test]
    fn runtime_marker_resolver_reads_canonical_marker_as_raw_bytes() {
        let canonical = b"/runtime/launch-canonical";
        let non_unicode = b"/runtime/launch-\xff";

        assert!(resolve_runtime_marker(&marker_environment(None)).is_none());
        assert_eq!(
            resolve_runtime_marker(&marker_environment(Some(b""))),
            Some(b"".as_slice()),
        );
        assert_eq!(
            resolve_runtime_marker(&marker_environment(Some(non_unicode))),
            Some(non_unicode.as_slice()),
        );
        assert_eq!(
            resolve_runtime_marker(&marker_environment(Some(canonical))),
            Some(canonical.as_slice()),
        );
    }

    impl Drop for ProbeChild {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    async fn process_identity(pid: u32) -> ProcessIdentity {
        let ProcessStatRead::Found(stat) = crate::process::read_process_stat_checked(pid).await
        else {
            panic!("probe child process stat is unavailable");
        };
        ProcessIdentity {
            pid,
            starttime: stat.starttime,
        }
    }

    async fn test_runtime(root: &Path) -> Arc<MitmdumpRuntime> {
        MitmdumpRuntime::acquire(root.to_path_buf(), root.join("runtime.lock"))
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn pidfd_signal_rejects_replacement_process_generation() {
        let root = tempfile::tempdir().unwrap();
        let runtime = test_runtime(root.path()).await;
        let launch = root.path().join("launch-stale-generation");
        std::fs::create_dir(&launch).unwrap();
        let mut replacement = ProbeChild::spawn(Some((CANONICAL_RUNTIME_MARKER_ENV, &launch)));
        let current = process_identity(replacement.pid()).await;
        let stale = ProcessIdentity {
            starttime: current.starttime.checked_add(1).unwrap(),
            ..current
        };

        signal_stable_process(&runtime, Some(&launch), stale)
            .await
            .unwrap();

        replacement.assert_responds();
    }

    #[tokio::test]
    async fn pidfd_signal_rechecks_runtime_marker() {
        let root = tempfile::tempdir().unwrap();
        let runtime = test_runtime(root.path()).await;
        let launch = root.path().join("launch-removed-marker");
        std::fs::create_dir(&launch).unwrap();
        let mut replacement = ProbeChild::spawn(None);
        let current = process_identity(replacement.pid()).await;

        signal_stable_process(&runtime, Some(&launch), current)
            .await
            .unwrap();

        replacement.assert_responds();
    }

    #[tokio::test]
    async fn close_launch_accepts_environment_error_after_process_becomes_zombie() {
        let root = tempfile::tempdir().unwrap();
        let runtime = test_runtime(root.path()).await;
        let launch = root.path().join("launch-zombie-environment");
        std::fs::create_dir(&launch).unwrap();
        let child = ProbeChild::spawn(Some((CANONICAL_RUNTIME_MARKER_ENV, &launch)));
        let pid = child.pid();

        runtime.set_test_environment_read_error(pid, move || {
            let pid = nix::unistd::Pid::from_raw(i32::try_from(pid).unwrap());
            nix::sys::signal::kill(pid, nix::sys::signal::Signal::SIGKILL).unwrap();
            let deadline = std::time::Instant::now() + Duration::from_secs(1);
            loop {
                match crate::process::read_process_stat_checked_blocking(pid.as_raw() as u32) {
                    ProcessStatRead::Found(stat) if !process_stat_is_live(&stat) => break,
                    ProcessStatRead::Found(_) => {}
                    ProcessStatRead::Missing => panic!("probe child disappeared before reaping"),
                    ProcessStatRead::Unreadable(error) => {
                        panic!("probe child stat became unreadable: {error}")
                    }
                    ProcessStatRead::Invalid => panic!("probe child stat became invalid"),
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "probe child did not become a zombie"
                );
                std::thread::sleep(Duration::from_millis(1));
            }
            std::io::Error::from_raw_os_error(nix::libc::EACCES)
        });

        runtime.close_launch_path(launch.clone()).await.unwrap();

        assert!(!launch.exists());
        drop(child);
    }

    #[tokio::test]
    async fn close_launch_rejects_environment_error_for_live_process() {
        let root = tempfile::tempdir().unwrap();
        let runtime = test_runtime(root.path()).await;
        let launch = root.path().join("launch-live-environment-error");
        std::fs::create_dir(&launch).unwrap();
        let mut child = ProbeChild::spawn(Some((CANONICAL_RUNTIME_MARKER_ENV, &launch)));
        let pid = child.pid();
        runtime.set_test_environment_read_error(pid, || {
            std::io::Error::from_raw_os_error(nix::libc::EACCES)
        });

        let error = runtime
            .close_launch_path(launch.clone())
            .await
            .unwrap_err()
            .to_string();

        assert!(error.contains("recheck /proc/"));
        assert!(error.contains("/environ after opening mitmdump cleanup pidfd"));
        assert!(error.contains("Permission denied"));
        assert!(launch.exists());
        child.assert_responds();
    }
}
