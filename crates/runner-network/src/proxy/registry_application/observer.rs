//! Nonblocking registration observations owned by one proxy control generation.

use tokio::sync::mpsc;
use tokio_util::task::AbortOnDropHandle;

use super::RegistryPublication;

/// One active exchange and one pending publication; admission never waits.
pub(in crate::proxy) struct ObservationTask {
    sender: mpsc::Sender<PendingObservation>,
    _task: AbortOnDropHandle<()>,
}

pub(in crate::proxy) struct PendingObservation {
    publication: RegistryPublication,
    unconfirmed_reason: Option<&'static str>,
}

impl PendingObservation {
    pub fn new(publication: RegistryPublication, reason: &'static str) -> Self {
        Self {
            publication,
            unconfirmed_reason: Some(reason),
        }
    }
}

impl Drop for PendingObservation {
    fn drop(&mut self) {
        if let Some(reason) = self.unconfirmed_reason {
            self.publication.unconfirmed(reason);
        }
    }
}

impl ObservationTask {
    pub fn new() -> Self {
        let (sender, mut receiver) = mpsc::channel::<PendingObservation>(1);
        let task = tokio::spawn(async move {
            while let Some(mut pending) = receiver.recv().await {
                pending.publication.observe().await;
                // Both completed receipts and exchange failures were logged by observe.
                pending.unconfirmed_reason = None;
            }
        });
        Self {
            sender,
            _task: AbortOnDropHandle::new(task),
        }
    }

    pub fn request(&self, publication: RegistryPublication) -> Result<(), PendingObservation> {
        let (mut pending, reason) = match self.sender.try_send(PendingObservation::new(
            publication,
            "observation_cancelled",
        )) {
            Ok(()) => return Ok(()),
            Err(mpsc::error::TrySendError::Full(pending)) => (pending, "observation_queue_full"),
            Err(mpsc::error::TrySendError::Closed(pending)) => {
                (pending, "observation_owner_closed")
            }
        };
        pending.unconfirmed_reason = Some(reason);
        Err(pending)
    }
}
