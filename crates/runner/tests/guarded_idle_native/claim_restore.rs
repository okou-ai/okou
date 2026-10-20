//! Observe actual completed restore before cancelling only claim observation.

use std::sync::Mutex;

use sandbox::{BackingProcessIdentity, SandboxBackingProcess};
use sandbox_firecracker::{GuestPreparationCheckpoint, GuestPreparationStage};
use serde_json::{Value, json};
use tokio::sync::watch;

use super::*;

pub struct Probe {
    original: Mutex<Option<(String, BackingProcessIdentity)>>,
    completed: watch::Sender<Option<Value>>,
}

impl Probe {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            original: Mutex::new(None),
            completed: watch::channel(None).0,
        })
    }

    pub fn arm(&self, id: String, backing: &Arc<dyn SandboxBackingProcess>) -> TestResult<()> {
        let mut original = self
            .original
            .lock()
            .map_err(|_| io::Error::other("restore probe poisoned"))?;
        if original.is_some() || self.completed.borrow().is_some() {
            return Err(io::Error::other("native claim restore already armed").into());
        }
        *original = Some((id, backing.identity()));
        Ok(())
    }

    pub fn checkpoint(self: &Arc<Self>) -> GuestPreparationCheckpoint {
        let probe = self.clone();
        Arc::new(move |observed| {
            let probe = probe.clone();
            Box::pin(async move {
                if observed.stage != GuestPreparationStage::Restore {
                    return Ok(());
                }
                let original = probe
                    .original
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .take();
                if let Some((id, generation)) = original {
                    if id != observed.sandbox_id || generation != observed.backing.identity() {
                        return Err(sandbox::SandboxError::Initialization {
                            phase: sandbox::SandboxInitializationPhase::SandboxAllocation,
                            message: "claim restore changed the original Guest/backing".into(),
                        });
                    }
                    probe.completed.send_replace(Some(json!({
                        "sandbox_id": id, "backing_generation": generation.generation(),
                        "completed_ns": evidence::clocks().map_err(|error| sandbox::SandboxError::Initialization {
                            phase: sandbox::SandboxInitializationPhase::SandboxAllocation,
                            message: error.to_string(),
                        })?.0,
                        "actual_restore_rpc_completed": true,
                    })));
                }
                Ok(())
            })
        })
    }

    pub async fn wait(&self) -> TestResult<Value> {
        let mut completed = self.completed.subscribe();
        loop {
            if let Some(result) = completed.borrow_and_update().clone() {
                return Ok(result);
            }
            completed.changed().await?;
        }
    }
}
