//! Async boundary for synchronous COW storage operations.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use tokio::sync::Semaphore;

use crate::cow::CowLayer;
use crate::error::{NbdCowError, Result};

/// Async handle for serialized COW storage operations.
///
/// `CowLayer` performs synchronous positioned file I/O. `CowIo` keeps that
/// blocking work out of async dispatch tasks while preserving one active COW
/// operation per device.
///
/// # Cancellation
///
/// All async operations on this handle share the same cancellation boundary.
/// Cancelling an operation while it is waiting for the per-device operation
/// slot prevents that operation from being submitted. Once its blocking task
/// has been submitted, dropping the operation future, including by aborting its
/// owning task, discards only the result. The operation continues to completion
/// and retains the operation slot while it runs, so later COW operations wait
/// for that in-flight work even after its original awaiter is gone.
#[derive(Clone)]
pub struct CowIo {
    inner: Arc<CowIoInner>,
}

struct CowIoInner {
    cow: Mutex<CowLayer>,
    operation_slot: Arc<Semaphore>,
}

/// Snapshot of COW state counters used for diagnostics and tests.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CowIoStatus {
    /// Blocks already materialized in the sparse COW file.
    pub dirty_blocks: usize,
    /// Blocks currently buffered in memory and not yet flushed.
    pub buffered_blocks: usize,
    /// Approximate memory used by the write buffer.
    pub buffer_bytes: usize,
}

impl CowIo {
    /// Create a new async COW I/O boundary around a synchronous COW layer.
    pub fn new(cow: CowLayer) -> Self {
        Self {
            inner: Arc::new(CowIoInner {
                cow: Mutex::new(cow),
                operation_slot: Arc::new(Semaphore::new(1)),
            }),
        }
    }

    /// Read data at `offset` into the provided buffer and return it.
    pub async fn read(&self, offset: u64, mut data: Vec<u8>) -> Result<Vec<u8>> {
        self.run("read", move |cow| {
            cow.read(offset, &mut data)?;
            Ok(data)
        })
        .await
    }

    /// Write `data` at `offset`, flushing buffered data when the threshold is reached.
    ///
    /// An already-full buffer must be flushed before admitting this write. If
    /// that flush fails, incoming bytes are not applied and earlier buffered
    /// data remains available for reads and retry. The check and write share
    /// the device's operation slot across all clones of this handle.
    ///
    /// Starting with an empty layer, retained payload is bounded by a
    /// sub-threshold buffer plus the full blocks touched by one write,
    /// including partial edge blocks. One write can exceed the threshold;
    /// callers must bound request size separately from the flush threshold.
    ///
    /// # Cancellation
    ///
    /// Cancellation is not a rollback. Once submitted, this write and any
    /// threshold-triggered flush may complete after the operation future is
    /// dropped. See [`CowIo`] for the shared cancellation boundary.
    pub async fn write(&self, offset: u64, data: Vec<u8>) -> Result<Vec<u8>> {
        self.run("write", move |cow| {
            if cow.needs_flush() {
                cow.flush()?;
            }
            let needs_flush = cow.write(offset, &data)?;
            if needs_flush {
                cow.flush()?;
            }
            Ok(data)
        })
        .await
    }

    /// Flush pending data and sync the COW file when it exists.
    ///
    /// # Cancellation
    ///
    /// Cancellation is not a rollback. Once submitted, pending data may still
    /// be flushed and the COW file sync may complete after the operation future
    /// is dropped. See [`CowIo`] for the shared cancellation boundary.
    pub async fn sync(&self) -> Result<()> {
        self.run("sync", CowLayer::sync).await
    }

    pub(crate) async fn save_bitmap(&self, path: PathBuf) -> Result<()> {
        self.run("save bitmap", move |cow| {
            cow.sync()?;
            cow.save_bitmap(&path)
        })
        .await
    }

    /// Return a consistent snapshot of COW counters.
    pub async fn status(&self) -> Result<CowIoStatus> {
        self.run("status", |cow| {
            Ok(CowIoStatus {
                dirty_blocks: cow.dirty_block_count(),
                buffered_blocks: cow.buffered_block_count(),
                buffer_bytes: cow.buffer_bytes(),
            })
        })
        .await
    }

    pub(crate) fn relocate_cow_file_after_rename(&self, cow_file: PathBuf) -> Result<()> {
        let mut cow = lock_cow(&self.inner, "backing-file relocation")?;
        cow.relocate_cow_file_after_rename(cow_file);
        Ok(())
    }

    async fn run<T>(
        &self,
        operation: &'static str,
        f: impl FnOnce(&mut CowLayer) -> Result<T> + Send + 'static,
    ) -> Result<T>
    where
        T: Send + 'static,
    {
        let permit = self
            .inner
            .operation_slot
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| closed_error(operation))?;
        let inner = self.inner.clone();

        match tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let mut cow = lock_cow(&inner, operation)?;
            f(&mut cow)
        })
        .await
        {
            Ok(result) => result,
            Err(e) if e.is_panic() => std::panic::resume_unwind(e.into_panic()),
            Err(e) => Err(NbdCowError::Io(std::io::Error::other(format!(
                "COW I/O {operation} task was cancelled: {e}",
            )))),
        }
    }
}

fn lock_cow<'a>(inner: &'a CowIoInner, operation: &str) -> Result<MutexGuard<'a, CowLayer>> {
    inner.cow.lock().map_err(|_| {
        NbdCowError::Io(std::io::Error::other(format!(
            "COW layer mutex poisoned during {operation}",
        )))
    })
}

fn closed_error(operation: &str) -> NbdCowError {
    NbdCowError::Io(std::io::Error::other(format!(
        "COW I/O operation slot closed before {operation}",
    )))
}

#[cfg(test)]
mod tests;
