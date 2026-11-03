//! Synchronous ownership of direct child processes used by test fixtures.

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

#[cfg(test)]
mod tests;
