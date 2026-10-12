//! Control input limits are applied to owned IO before HTTP buffering and again
//! before JSON collection. A successful registration can release only its raw
//! startup limit; later map frames retain their own independent limits.

use std::{
    io,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    task::{Context, Poll},
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, ReadBuf};

use super::Failure;

pub(super) struct LimitedIo<Io> {
    io: Io,
    read: usize,
    maximum: usize,
    released: Arc<AtomicBool>,
}

impl<Io> LimitedIo<Io> {
    pub(super) fn new(io: Io, maximum: usize) -> (Self, Arc<AtomicBool>) {
        let released = Arc::new(AtomicBool::new(false));
        (
            Self {
                io,
                read: 0,
                maximum,
                released: Arc::clone(&released),
            },
            released,
        )
    }
}

pub(super) async fn collect(
    mut input: impl AsyncRead + Unpin,
    maximum: usize,
) -> Result<Vec<u8>, Failure> {
    let mut body = Vec::new();
    let mut chunk = [0; 4096];
    loop {
        // One byte detects a body exceeding the cap without growing the owned
        // collection. The raw IO limit also bounds HTTP prefetch and headers.
        let count = chunk.len().min(maximum - body.len() + 1);
        let count = input
            .read(chunk.get_mut(..count).ok_or(Failure::DomainFailed)?)
            .await
            .map_err(|_| Failure::DomainFailed)?;
        if count == 0 {
            return Ok(body);
        }
        if count > maximum - body.len() {
            return Err(Failure::DomainFailed);
        }
        body.extend_from_slice(chunk.get(..count).ok_or(Failure::DomainFailed)?);
    }
}

impl<Io: AsyncRead + Unpin> AsyncRead for LimitedIo<Io> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        out: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.released.load(Ordering::Acquire) || out.remaining() == 0 {
            return Pin::new(&mut self.io).poll_read(cx, out);
        }
        if self.read >= self.maximum {
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "native control input limit",
            )));
        }
        let count = out.remaining().min(self.maximum - self.read);
        let mut part = ReadBuf::new(out.initialize_unfilled_to(count));
        match Pin::new(&mut self.io).poll_read(cx, &mut part) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Err(error)) => Poll::Ready(Err(error)),
            Poll::Ready(Ok(())) => {
                let count = part.filled().len();
                self.read += count;
                out.advance(count);
                Poll::Ready(Ok(()))
            }
        }
    }
}

impl<Io: AsyncWrite + Unpin> AsyncWrite for LimitedIo<Io> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.io).poll_write(cx, bytes)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.io).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.io).poll_shutdown(cx)
    }
}
