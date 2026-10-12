use std::sync::Arc;

use async_trait::async_trait;
use sandbox::{BackingProcessIdentity, SandboxBackingProcess};
use tokio::sync::watch;

/// Explicit external mock of one retained backing-generation wait result.
///
/// Generic mock stop/kill operations do not publish this result. Each channel
/// creates its own generation; attach it to exactly that mock backing.
pub struct MockBackingProcess {
    identity: BackingProcessIdentity,
    completion: watch::Receiver<Option<bool>>,
}

/// One-shot producer of an external mock backing's terminal wait observation.
///
/// Dropping it without publishing leaves exit unconfirmed. Terminal methods
/// consume the producer, so a later conflicting result cannot overwrite it.
pub struct MockBackingProcessCompletion {
    sender: watch::Sender<Option<bool>>,
}

impl MockBackingProcess {
    /// Create an independently retained pending backing and its single producer.
    pub fn channel() -> (MockBackingProcessCompletion, Arc<Self>) {
        let (sender, completion) = watch::channel(None);
        (
            MockBackingProcessCompletion { sender },
            Arc::new(Self {
                identity: BackingProcessIdentity::new_generation(),
                completion,
            }),
        )
    }
}

impl MockBackingProcessCompletion {
    /// Model a successful provider-owned child wait, including nonzero status.
    pub fn confirm_exit(self) {
        self.sender.send_replace(Some(true));
    }

    /// Model a failed wait that cannot establish backing exit.
    pub fn fail_wait(self) {
        self.sender.send_replace(Some(false));
    }
}

#[async_trait]
impl SandboxBackingProcess for MockBackingProcess {
    fn identity(&self) -> BackingProcessIdentity {
        self.identity
    }

    async fn exit_confirmed(&self) -> bool {
        let mut completion = self.completion.clone();
        loop {
            if let Some(confirmed) = *completion.borrow_and_update() {
                return confirmed;
            }
            if completion.changed().await.is_err() {
                return false;
            }
        }
    }
}
