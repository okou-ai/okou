//! Framed stream ownership and direction-local cancellation after exact-run admission.

use std::io;
use std::sync::Arc;

use sandbox::GuestDuplexStream;
use tokio::io::{AsyncReadExt, AsyncWriteExt, ReadHalf, WriteHalf};
use tokio::sync::OwnedSemaphorePermit;
use tokio_util::sync::CancellationToken;

use super::{MAX_FRAME_BYTES, unavailable};

/// Framed opaque duplex channel with independent direction ownership.
pub struct Channel {
    rx: Receiver,
    tx: Sender,
}
impl Channel {
    pub(super) fn new(
        stream: Box<dyn GuestDuplexStream>,
        permit: OwnedSemaphorePermit,
        run_cancelled: CancellationToken,
        assignment_cancelled: CancellationToken,
    ) -> Self {
        let (read, write) = tokio::io::split(stream);
        let lease = Arc::new(permit);
        let broken = CancellationToken::new();
        Self {
            rx: Receiver {
                read,
                run_cancelled: run_cancelled.clone(),
                assignment_cancelled: assignment_cancelled.clone(),
                broken: broken.clone(),
                _lease: Arc::clone(&lease),
            },
            tx: Sender {
                write,
                run_cancelled,
                assignment_cancelled,
                broken,
                finished: false,
                _lease: lease,
            },
        }
    }

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
    /// Retain this observer before splitting the two independently owned halves.
    /// The WSS owner must select it even when both directions await client I/O.
    pub fn cancellation(&self) -> ChannelCancellation {
        ChannelCancellation {
            run_cancelled: self.tx.run_cancelled.clone(),
            assignment_cancelled: self.tx.assignment_cancelled.clone(),
            broken: self.tx.broken.clone(),
        }
    }

    pub async fn cancelled(&self) {
        self.cancellation().cancelled().await;
    }
}

/// Cloneable terminal signal for the owning listener, independent of split IO.
#[derive(Clone)]
pub struct ChannelCancellation {
    run_cancelled: CancellationToken,
    assignment_cancelled: CancellationToken,
    broken: CancellationToken,
}
impl ChannelCancellation {
    pub async fn cancelled(&self) {
        tokio::select! {
            () = self.run_cancelled.cancelled() => (),
            () = self.assignment_cancelled.cancelled() => (),
            () = self.broken.cancelled() => (),
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
