//! In-process exact-run Guest attachment. No ticket authority or public listener.
//! #37027 redeems tickets first, then calls `open` for the exact redeemed RunId.

use std::collections::HashMap;
use std::io;
use std::sync::{Arc, Mutex};

use runner_types::ids::RunId;
use sandbox::{GuestDuplexAcceptor, Sandbox};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

mod channel;
pub use channel::{Channel, ChannelCancellation, Receiver, Sender};
pub use guest_contracts::private_duplex::{MAX_FRAME_BYTES, MAX_STREAMS_PER_RUN};

type Entries = Arc<Mutex<HashMap<RunId, Arc<Entry>>>>;

#[derive(Clone, Default)]
pub struct RunGuestChannels {
    entries: Entries,
}

struct Entry {
    sandbox_id: String,
    acceptor: Arc<dyn GuestDuplexAcceptor>,
    cancelled: CancellationToken,
    permits: Arc<Semaphore>,
}

/// Sole owner of an execution epoch; dropping it revokes all existing channels.
pub struct Registration {
    entries: Entries,
    run_id: RunId,
    entry: Arc<Entry>,
}

impl Drop for Registration {
    fn drop(&mut self) {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        if entries
            .get(&self.run_id)
            .is_some_and(|current| Arc::ptr_eq(current, &self.entry))
        {
            // Cancel while holding the registry lock: lookup cannot race a new epoch.
            self.entry.cancelled.cancel();
            entries.remove(&self.run_id);
        }
    }
}

impl RunGuestChannels {
    /// Install only from the executor while it owns the prepared live sandbox.
    /// Providers without a live duplex acceptor return None; never use cached state.
    pub fn register(
        &self,
        run_id: RunId,
        sandbox: &dyn Sandbox,
        cancel: &CancellationToken,
    ) -> Option<Registration> {
        let acceptor = sandbox.guest_duplex(&run_id.to_string())?;
        Some(self.register_acceptor(run_id, sandbox.id().to_owned(), acceptor, cancel))
    }

    fn register_acceptor(
        &self,
        run_id: RunId,
        sandbox_id: String,
        acceptor: Arc<dyn GuestDuplexAcceptor>,
        cancel: &CancellationToken,
    ) -> Registration {
        let entry = Arc::new(Entry {
            sandbox_id,
            acceptor,
            cancelled: cancel.child_token(),
            permits: Arc::new(Semaphore::new(MAX_STREAMS_PER_RUN)),
        });
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        assert!(
            !entries.contains_key(&run_id),
            "duplicate live Guest channel run: {run_id}"
        );
        entries.insert(run_id, Arc::clone(&entry));
        Registration {
            entries: Arc::clone(&self.entries),
            run_id,
            entry,
        }
    }

    /// Exact in-process lookup; no DB, status file, guessed sandbox or idle cache.
    /// Success requires the provider to confirm Guest worker readiness, not just activation.
    pub async fn open(&self, run_id: RunId) -> io::Result<Channel> {
        let entry = self
            .entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&run_id)
            .cloned()
            .ok_or_else(unavailable)?;
        let permit = entry.permits.clone().try_acquire_owned().map_err(|_| {
            io::Error::new(io::ErrorKind::WouldBlock, "run channel capacity exhausted")
        })?;
        if entry.cancelled.is_cancelled() {
            return Err(unavailable());
        }
        let accepted = tokio::select! {
            biased;
            () = entry.cancelled.cancelled() => return Err(unavailable()),
            result = entry.acceptor.accept() => result?,
        };
        let current = self
            .entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&run_id)
            .is_some_and(|registered| Arc::ptr_eq(registered, &entry));
        if !current
            || accepted.sandbox_id != entry.sandbox_id
            || entry.cancelled.is_cancelled()
            || accepted.cancelled.is_cancelled()
        {
            return Err(unavailable());
        }
        Ok(Channel::new(
            accepted.stream,
            permit,
            entry.cancelled.clone(),
            accepted.cancelled,
        ))
    }
}

fn unavailable() -> io::Error {
    io::Error::new(
        io::ErrorKind::NotConnected,
        "live run Guest assignment unavailable",
    )
}

#[cfg(test)]
mod tests;
