//! In-process exact-run Guest attachment. No ticket authority or public listener.
//! #37027 redeems tickets first, then calls `open` for the exact redeemed RunId.

use std::collections::HashMap;
use std::io;
use std::sync::{Arc, Mutex};

use runner_types::ids::RunId;
use sandbox::{GuestDuplexAcceptor, GuestDuplexStream, Sandbox};
use tokio::io::{AsyncReadExt, AsyncWriteExt, ReadHalf, WriteHalf};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;

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
    /// Unsupported/old guest providers return None; never fall back to cached state.
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
        let (read, write) = tokio::io::split(accepted.stream);
        let lease = Arc::new(permit);
        let broken = CancellationToken::new();
        Ok(Channel {
            rx: Receiver {
                read,
                run_cancelled: entry.cancelled.clone(),
                assignment_cancelled: accepted.cancelled.clone(),
                broken: broken.clone(),
                _lease: Arc::clone(&lease),
            },
            tx: Sender {
                write,
                run_cancelled: entry.cancelled.clone(),
                assignment_cancelled: accepted.cancelled,
                broken,
                finished: false,
                _lease: lease,
            },
        })
    }
}

fn unavailable() -> io::Error {
    io::Error::new(
        io::ErrorKind::NotConnected,
        "live run Guest assignment unavailable",
    )
}

/// Framed opaque duplex channel with independent direction ownership.
pub struct Channel {
    rx: Receiver,
    tx: Sender,
}
impl Channel {
    pub fn split(self) -> (Sender, Receiver) {
        (self.tx, self.rx)
    }
    pub async fn send(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.tx.send(bytes).await
    }
    pub async fn recv(&mut self) -> io::Result<Option<Vec<u8>>> {
        self.rx.recv().await
    }
    pub async fn finish_send(&mut self) -> io::Result<()> {
        self.tx.finish().await
    }
    pub async fn cancelled(&self) {
        tokio::select! {
            () = self.tx.run_cancelled.cancelled() => (),
            () = self.tx.assignment_cancelled.cancelled() => (),
            () = self.tx.broken.cancelled() => (),
        }
    }
}

pub struct Sender {
    write: WriteHalf<Box<dyn GuestDuplexStream>>,
    run_cancelled: CancellationToken,
    assignment_cancelled: CancellationToken,
    broken: CancellationToken,
    finished: bool,
    _lease: Arc<OwnedSemaphorePermit>,
}
impl Sender {
    /// Ordered within this direction; call sequentially. OS backpressure bounds pending bytes.
    pub async fn send(&mut self, bytes: &[u8]) -> io::Result<()> {
        if self.finished {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "send direction already closed",
            ));
        }
        if bytes.len() > MAX_FRAME_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "guest frame too large",
            ));
        }
        let header = (bytes.len() as u32).to_be_bytes();
        let result = tokio::select! {
            biased;
            () = self.broken.cancelled() => Err(unavailable()),
            () = self.run_cancelled.cancelled() => Err(unavailable()),
            () = self.assignment_cancelled.cancelled() => Err(unavailable()),
            result = async {
                self.write.write_all(&header).await?;
                self.write.write_all(bytes).await
            } => result,
        };
        if result.is_err() {
            self.broken.cancel();
        }
        result
    }
    /// Half-close host→Guest; Guest→host remains readable.
    pub async fn finish(&mut self) -> io::Result<()> {
        if self.finished {
            return Ok(());
        }
        let result = tokio::select! {
            biased;
            () = self.run_cancelled.cancelled() => Err(unavailable()),
            () = self.assignment_cancelled.cancelled() => Err(unavailable()),
            () = self.broken.cancelled() => Err(unavailable()),
            result = self.write.shutdown() => result,
        };
        if result.is_err() {
            self.broken.cancel();
        } else {
            self.finished = true;
        }
        result
    }
}

pub struct Receiver {
    read: ReadHalf<Box<dyn GuestDuplexStream>>,
    run_cancelled: CancellationToken,
    assignment_cancelled: CancellationToken,
    broken: CancellationToken,
    _lease: Arc<OwnedSemaphorePermit>,
}
impl Receiver {
    pub async fn recv(&mut self) -> io::Result<Option<Vec<u8>>> {
        let result = tokio::select! {
            biased;
            () = self.broken.cancelled() => Err(unavailable()),
            () = self.run_cancelled.cancelled() => Err(unavailable()),
            () = self.assignment_cancelled.cancelled() => Err(unavailable()),
            result = async {
                let mut first = [0u8; 1];
                if self.read.read(&mut first).await? == 0 { return Ok(None); }
                let mut header = [first[0], 0, 0, 0];
                self.read.read_exact(&mut header[1..]).await?;
                let size = u32::from_be_bytes(header) as usize;
                if size > MAX_FRAME_BYTES {
                    return Err(io::Error::new(io::ErrorKind::InvalidData, "guest frame too large"));
                }
                let mut payload = vec![0u8; size];
                self.read.read_exact(&mut payload).await?;
                Ok(Some(payload))
            } => result,
        };
        if result.is_err() {
            self.broken.cancel();
        }
        result
    }
}

#[cfg(test)]
mod tests;
