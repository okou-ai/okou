//! Start bounded capture for a standard child that owns its process group.

use std::io;
use std::os::fd::OwnedFd;
use std::process::Child;
use std::sync::{Arc, mpsc};

use super::{BoundedDrainHandle, DrainCancellation};
use crate::process::kill_and_reap_child;

pub(crate) enum FixedGroupOutputError {
    MissingStdout,
    MissingStderr,
    StartStdout(io::Error),
    StartStderr(io::Error),
}

pub(crate) struct FixedGroupOutput {
    pub(crate) child: Child,
    pub(crate) drains: [BoundedDrainHandle; 2],
    pub(crate) done_rx: mpsc::Receiver<()>,
}

impl FixedGroupOutput {
    /// Start capture for an unreaped child that leads its own process group.
    /// On success, transfer the child and both live drains back to the caller.
    /// On failure, reap the child group and retire any drain that started.
    pub(crate) fn start(
        child: Child,
        cancel: &Arc<DrainCancellation>,
        specs: [(usize, &'static str); 2],
    ) -> Result<Self, FixedGroupOutputError> {
        Self::start_with(child, cancel, specs, BoundedDrainHandle::spawn)
    }

    fn start_with(
        mut child: Child,
        cancel: &Arc<DrainCancellation>,
        [(stdout_limit, stdout_name), (stderr_limit, stderr_name)]: [(usize, &'static str); 2],
        mut spawn: impl FnMut(
            OwnedFd,
            usize,
            Arc<DrainCancellation>,
            mpsc::Sender<()>,
            &'static str,
        ) -> io::Result<BoundedDrainHandle>,
    ) -> Result<Self, FixedGroupOutputError> {
        let Some(stdout) = child.stdout.take() else {
            kill_and_reap_child(child);
            return Err(FixedGroupOutputError::MissingStdout);
        };
        let Some(stderr) = child.stderr.take() else {
            drop(stdout);
            kill_and_reap_child(child);
            return Err(FixedGroupOutputError::MissingStderr);
        };

        let (done_tx, done_rx) = mpsc::channel();
        let stdout_drain = match spawn(
            stdout.into(),
            stdout_limit,
            Arc::clone(cancel),
            done_tx.clone(),
            stdout_name,
        ) {
            Ok(drain) => drain,
            Err(error) => {
                drop(stderr);
                kill_and_reap_child(child);
                return Err(FixedGroupOutputError::StartStdout(error));
            }
        };
        let stderr_drain = match spawn(
            stderr.into(),
            stderr_limit,
            Arc::clone(cancel),
            done_tx.clone(),
            stderr_name,
        ) {
            Ok(drain) => drain,
            Err(error) => {
                cancel.cancel();
                kill_and_reap_child(child);
                drop(done_tx);
                let _ = stdout_drain.join();
                return Err(FixedGroupOutputError::StartStderr(error));
            }
        };
        drop(done_tx);
        Ok(Self {
            child,
            drains: [stdout_drain, stderr_drain],
            done_rx,
        })
    }
}

#[cfg(test)]
mod tests;
