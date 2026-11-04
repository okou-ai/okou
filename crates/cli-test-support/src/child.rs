//! Synchronous ownership of direct child processes used by test fixtures.

use std::io::Read;
use std::process::{ExitStatus, Output};
use std::sync::mpsc::{self, Receiver};
use std::time::Instant;

/// Kills and synchronously waits for an owned direct child when dropped.
///
/// Cleanup errors are ignored, including when the child has already been reaped.
/// The inner child remains accessible for IO, PID queries and explicit waiting.
/// This owner does not signal descendants or process groups.
pub struct KillAndWaitChild(pub std::process::Child);

impl Drop for KillAndWaitChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Concurrent pipe draining for synchronous child-process fixtures.
///
/// The reader owns its pipe until EOF. Collection observes completion through a
/// channel, so an inherited open pipe cannot extend the foreground deadline.
pub struct ChildOutputReader {
    rx: Receiver<std::io::Result<Vec<u8>>>,
}

impl ChildOutputReader {
    /// Starts draining one owned pipe on a dedicated thread.
    pub fn spawn(mut pipe: impl Read + Send + 'static) -> Self {
        let (tx, rx) = mpsc::channel();
        let _ = std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = pipe.read_to_end(&mut bytes).map(|_| bytes);
            let _ = tx.send(result);
        });
        Self { rx }
    }

    fn finish(self, stream: &str, deadline: Instant) -> std::io::Result<Vec<u8>> {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let result = match self.rx.recv_timeout(remaining) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    format!("{stream} did not close before the child output deadline"),
                ));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(std::io::Error::other(format!(
                    "{stream} reader exited without output"
                )));
            }
        };
        result.map_err(|error| {
            std::io::Error::new(error.kind(), format!("read child {stream}: {error}"))
        })
    }
}

/// Collects stdout before stderr using the same absolute output deadline.
///
/// Reader timeouts and errors retain their original stream context and IO kind.
/// A timeout returns without joining a reader still waiting for EOF.
pub fn collect_child_output(
    status: ExitStatus,
    stdout_reader: ChildOutputReader,
    stderr_reader: ChildOutputReader,
    deadline: Instant,
) -> std::io::Result<Output> {
    let stdout = stdout_reader.finish("stdout", deadline)?;
    let stderr = stderr_reader.finish("stderr", deadline)?;
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

#[cfg(test)]
mod tests;
