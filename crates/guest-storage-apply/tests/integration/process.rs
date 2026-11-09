use std::fs::File;
use std::io::{self, Read as _, Seek as _, Write as _};
use std::process::{Child, Command, ExitStatus, Output, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const RUN_TIMEOUT: Duration = Duration::from_secs(10);
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(2);
const CHILD_WAIT_POLL_INTERVAL: Duration = Duration::from_millis(1);

pub(super) struct ChildExecution {
    child: Option<Child>,
}

impl ChildExecution {
    pub(super) fn spawn(command: &mut Command) -> io::Result<Self> {
        Ok(Self {
            child: Some(command.spawn()?),
        })
    }

    #[cfg(unix)]
    pub(super) fn id(&self) -> io::Result<u32> {
        self.child
            .as_ref()
            .map(Child::id)
            .ok_or_else(|| io::Error::other("command execution lost its child"))
    }

    pub(super) fn wait_with_timeout(&mut self, timeout: Duration) -> io::Result<ExitStatus> {
        let mut child = self
            .child
            .take()
            .ok_or_else(|| io::Error::other("command execution lost its child"))?;
        let deadline = Instant::now() + timeout;

        loop {
            match child.try_wait() {
                Ok(Some(status)) => return Ok(status),
                Ok(None) => {}
                Err(error) => {
                    let cleanup = terminate_and_reap(child);
                    return Err(io::Error::other(format!(
                        "failed to observe guest-storage-apply completion: {error}; cleanup: {cleanup}"
                    )));
                }
            }

            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            std::thread::sleep(remaining.min(CHILD_WAIT_POLL_INTERVAL));
        }

        let cleanup = terminate_and_reap(child);
        Err(io::Error::new(
            io::ErrorKind::TimedOut,
            format!("guest-storage-apply timed out after {timeout:?}; cleanup: {cleanup}"),
        ))
    }
}

impl Drop for ChildExecution {
    fn drop(&mut self) {
        if let Some(child) = self.child.take() {
            let _ = terminate_and_reap(child);
        }
    }
}

pub(super) struct CommandExecution {
    child: ChildExecution,
    stdout: File,
    stderr: File,
}

impl CommandExecution {
    pub(super) fn spawn(command: &mut Command, stdin: Option<&[u8]>) -> io::Result<Self> {
        Self::spawn_with_stdin(command, stdin_file(stdin)?)
    }

    pub(super) fn spawn_with_stdin(command: &mut Command, stdin: Stdio) -> io::Result<Self> {
        let stdout = tempfile::tempfile()?;
        let stderr = tempfile::tempfile()?;
        command
            .stdin(stdin)
            .stdout(Stdio::from(stdout.try_clone()?))
            .stderr(Stdio::from(stderr.try_clone()?));

        Ok(Self {
            child: ChildExecution::spawn(command)?,
            stdout,
            stderr,
        })
    }

    #[cfg(unix)]
    pub(super) fn id(&self) -> io::Result<u32> {
        self.child.id()
    }

    pub(super) fn wait(self) -> io::Result<Output> {
        self.wait_with_timeout(RUN_TIMEOUT)
    }

    pub(super) fn wait_with_timeout(mut self, timeout: Duration) -> io::Result<Output> {
        match self.child.wait_with_timeout(timeout) {
            Ok(status) => self.read_output(status),
            Err(error) => {
                let diagnostics = self.read_diagnostics();
                Err(io::Error::new(
                    error.kind(),
                    format!("{error}; {diagnostics}"),
                ))
            }
        }
    }

    fn read_output(&mut self, status: ExitStatus) -> io::Result<Output> {
        let (stdout, stderr) = self.read_streams()?;
        Ok(Output {
            status,
            stdout,
            stderr,
        })
    }

    fn read_diagnostics(&mut self) -> String {
        match self.read_streams() {
            Ok((stdout, stderr)) => format!(
                "stdout={:?}; stderr={:?}",
                String::from_utf8_lossy(&stdout),
                String::from_utf8_lossy(&stderr)
            ),
            Err(error) => format!("failed to read captured output: {error}"),
        }
    }

    fn read_streams(&mut self) -> io::Result<(Vec<u8>, Vec<u8>)> {
        Ok((
            read_captured_stream(&mut self.stdout, "stdout")?,
            read_captured_stream(&mut self.stderr, "stderr")?,
        ))
    }
}

pub(super) fn run(command: &mut Command) -> io::Result<Output> {
    CommandExecution::spawn(command, None)?.wait()
}

#[cfg(unix)]
pub(super) fn verify_child_reaped(child_id: u32) -> Result<(), String> {
    let child_id = libc::pid_t::try_from(child_id)
        .map_err(|error| format!("child ID {child_id} does not fit pid_t: {error}"))?;
    let mut status = 0;
    // SAFETY: `child_id` came from the directly owned child, and the lifecycle
    // helper returned only after reaping it. WNOHANG verifies no status remains.
    let result = unsafe { libc::waitpid(child_id, &mut status, libc::WNOHANG) };
    if result != -1 {
        return Err(format!(
            "waitpid returned {result} for reaped child {child_id}"
        ));
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() != Some(libc::ECHILD) {
        return Err(format!("waitpid failed for child {child_id}: {error}"));
    }
    Ok(())
}

fn stdin_file(stdin: Option<&[u8]>) -> io::Result<Stdio> {
    let Some(stdin) = stdin else {
        return Ok(Stdio::null());
    };

    let mut file = tempfile::tempfile()?;
    file.write_all(stdin)?;
    file.rewind()?;
    Ok(Stdio::from(file))
}

fn read_captured_stream(file: &mut File, name: &str) -> io::Result<Vec<u8>> {
    file.rewind()
        .map_err(|error| io::Error::new(error.kind(), format!("rewind {name}: {error}")))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| io::Error::new(error.kind(), format!("read {name}: {error}")))?;
    Ok(bytes)
}

fn terminate_and_reap(mut child: Child) -> String {
    let kill = match child.kill() {
        Ok(()) => "signal sent".to_owned(),
        Err(error) => format!("failed: {error}"),
    };
    let reap = match reap_child_with_timeout(child, CLEANUP_TIMEOUT) {
        Ok(status) => format!("completed with {status}"),
        Err(error) => format!("failed: {error}"),
    };
    format!("kill={kill}, reap={reap}")
}

fn reap_child_with_timeout(mut child: Child, timeout: Duration) -> Result<ExitStatus, String> {
    let (status_tx, status_rx) = mpsc::channel();
    let reaper = std::thread::spawn(move || {
        let _ = status_tx.send(child.wait());
    });

    match status_rx.recv_timeout(timeout) {
        Ok(status) => {
            reaper
                .join()
                .map_err(|_| "child reaper panicked".to_owned())?;
            status.map_err(|error| format!("wait failed: {error}"))
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            drop(reaper);
            Err(format!("child was not reaped within {timeout:?}"))
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            drop(reaper);
            Err("child reaper exited without a status".to_owned())
        }
    }
}
