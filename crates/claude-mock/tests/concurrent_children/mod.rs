use std::io;
use std::process::{Command, Output};

use claude_mock::process_group_child::ProcessGroupChild;

use super::support::{spawn_managed_mock_child, wait_child_output};

/// Own cleanup until a batch member is handed to the output waiter.
pub(super) struct BatchChild(Option<ProcessGroupChild>);

impl BatchChild {
    pub(super) fn spawn(command: &mut Command) -> io::Result<Self> {
        spawn_managed_mock_child(command).map(|child| Self(Some(child)))
    }

    pub(super) fn wait_output(mut self) -> Result<Output, Box<dyn std::error::Error>> {
        let child = self
            .0
            .take()
            .ok_or_else(|| io::Error::other("batch child already consumed"))?;
        wait_child_output(child)
    }
}

impl Drop for BatchChild {
    fn drop(&mut self) {
        if let Some(child) = self.0.take() {
            child.terminate();
        }
    }
}

#[cfg(unix)]
mod tests;
