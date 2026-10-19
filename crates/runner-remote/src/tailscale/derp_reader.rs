//! Withhold DERP lengths and fixed-body shape before the public SDK codec.
//! Framing, message decoding, handshake and cryptography remain SDK-owned.

use super::evidence::Trace;
use std::{
    io,
    pin::Pin,
    task::{Context, Poll},
};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use ts_derp::frame::{self, FrameType, Header};

#[cfg(test)]
mod tests;

pub(super) struct Reader<Io> {
    io: Io,
    header: [u8; Header::LEN_BYTES],
    captured: usize,
    released: usize,
    remaining: usize,
    rejected: bool,
    polls: usize,
    observer: Option<Box<Observer>>,
}

struct Observer {
    trace: Trace,
    body: [u8; std::mem::size_of::<frame::PeerGone>()],
    captured: usize,
}

impl Observer {
    // Servers still send this SDK-supported legacy control frame.
    #[allow(deprecated)]
    fn complete(&self, header: &[u8; Header::LEN_BYTES]) {
        let [typ, ..] = *header;
        match FrameType::try_from(typ) {
            Ok(FrameType::KeepAlive) => self.trace.relay_control(false),
            Ok(FrameType::Ping) => self.trace.relay_control(true),
            Ok(FrameType::PeerGone) => {
                if let Ok(header) = Header::new(FrameType::PeerGone, self.captured as u32)
                    && let Some(raw_body) = self.body.get(..self.captured)
                {
                    let raw = frame::RawFrame { header, raw_body };
                    if let Some((gone, _)) = raw.as_type::<frame::PeerGone>()
                        && let Ok(reason) = gone.reason()
                    {
                        self.trace.peer_gone(gone.key, reason);
                    }
                }
            }
            _ => {}
        }
    }
}

impl<Io> Reader<Io> {
    pub(super) fn new(io: Io) -> Self {
        let trace = Trace::current();
        Self {
            io,
            header: [0; Header::LEN_BYTES],
            captured: 0,
            released: 0,
            remaining: 0,
            rejected: false,
            polls: 0,
            observer: trace.enabled().then(|| {
                Box::new(Observer {
                    trace,
                    body: [0; std::mem::size_of::<frame::PeerGone>()],
                    captured: 0,
                })
            }),
        }
    }
}

fn body_length(header: &[u8; Header::LEN_BYTES]) -> usize {
    let [_, a, b, c, d] = *header;
    u32::from_be_bytes([a, b, c, d]) as usize
}

fn valid(header: &[u8; Header::LEN_BYTES]) -> bool {
    let [typ, ..] = *header;
    let length = body_length(header);
    let Ok(typ) = FrameType::try_from(typ) else {
        return false;
    };
    if Header::new(typ, length as u32).is_err() {
        return false;
    }
    #[allow(deprecated)]
    match typ {
        FrameType::ServerKey => length == std::mem::size_of::<frame::ServerKey>(),
        FrameType::ServerInfo => {
            (std::mem::size_of::<frame::ServerInfo>() + 16..=4096).contains(&length)
        }
        FrameType::RecvPacket => (std::mem::size_of::<frame::RecvPacket>()
            ..=std::mem::size_of::<frame::RecvPacket>() + 2048)
            .contains(&length),
        FrameType::PeerGone => length == std::mem::size_of::<frame::PeerGone>(),
        FrameType::Ping => length == std::mem::size_of::<frame::Ping>(),
        FrameType::KeepAlive => length == 0,
        _ => false,
    }
}

impl<Io: AsyncRead + Unpin> AsyncRead for Reader<Io> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        out: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if out.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        if this.rejected {
            return Poll::Ready(Err(io::ErrorKind::InvalidData.into()));
        }
        // SDK recv_one can consume arbitrarily many KeepAlive/Ping frames
        // before yielding a packet. Keep that public decoder cooperative even
        // when the underlying reader always has bytes immediately available.
        if this.polls == 64 {
            this.polls = 0;
            cx.waker().wake_by_ref();
            return Poll::Pending;
        }
        this.polls += 1;
        loop {
            while this.captured < Header::LEN_BYTES {
                let bytes = this
                    .header
                    .get_mut(this.captured..)
                    .ok_or(io::ErrorKind::InvalidData)?;
                let mut buffer = ReadBuf::new(bytes);
                match Pin::new(&mut this.io).poll_read(cx, &mut buffer) {
                    Poll::Pending => return Poll::Pending,
                    Poll::Ready(Err(error)) => return Poll::Ready(Err(error)),
                    Poll::Ready(Ok(())) if buffer.filled().is_empty() => {
                        return if this.captured == 0 {
                            Poll::Ready(Ok(()))
                        } else {
                            Poll::Ready(Err(io::ErrorKind::UnexpectedEof.into()))
                        };
                    }
                    Poll::Ready(Ok(())) => this.captured += buffer.filled().len(),
                }
            }
            if this.released == 0 {
                if !valid(&this.header) {
                    this.rejected = true;
                    return Poll::Ready(Err(io::ErrorKind::InvalidData.into()));
                }
                this.remaining = body_length(&this.header);
                if let Some(observer) = &mut this.observer {
                    observer.captured = 0;
                }
            }
            if this.released < Header::LEN_BYTES {
                let count = out.remaining().min(Header::LEN_BYTES - this.released);
                out.put_slice(
                    this.header
                        .get(this.released..this.released + count)
                        .ok_or(io::ErrorKind::InvalidData)?,
                );
                this.released += count;
                if this.released == Header::LEN_BYTES
                    && this.remaining == 0
                    && let Some(observer) = &this.observer
                {
                    observer.complete(&this.header);
                }
                return Poll::Ready(Ok(()));
            }
            if this.remaining != 0 {
                // No prefetch across a frame boundary, even if the SDK's read
                // buffer is large. A fixed stack chunk also bounds each read.
                let mut bytes = [0; 4096];
                let count = out.remaining().min(this.remaining).min(bytes.len());
                let mut buffer =
                    ReadBuf::new(bytes.get_mut(..count).ok_or(io::ErrorKind::InvalidData)?);
                return match Pin::new(&mut this.io).poll_read(cx, &mut buffer) {
                    Poll::Pending => Poll::Pending,
                    Poll::Ready(Err(error)) => Poll::Ready(Err(error)),
                    Poll::Ready(Ok(())) if buffer.filled().is_empty() => {
                        Poll::Ready(Err(io::ErrorKind::UnexpectedEof.into()))
                    }
                    Poll::Ready(Ok(())) => {
                        this.remaining -= buffer.filled().len();
                        out.put_slice(buffer.filled());
                        if let Some(observer) = &mut this.observer {
                            if this.header.first() == Some(&(FrameType::PeerGone as u8)) {
                                let end = observer.captured + buffer.filled().len();
                                if let Some(target) = observer.body.get_mut(observer.captured..end)
                                {
                                    target.copy_from_slice(buffer.filled());
                                    observer.captured = end;
                                }
                            }
                            if this.remaining == 0 {
                                observer.complete(&this.header);
                            }
                        }
                        Poll::Ready(Ok(()))
                    }
                };
            }
            this.captured = 0;
            this.released = 0;
        }
    }
}

impl<Io: AsyncWrite + Unpin> AsyncWrite for Reader<Io> {
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
