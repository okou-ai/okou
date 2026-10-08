//! Owned RSA-AES authenticated records; lengths are AAD, not RFB messages.
use crate::Error;
use aes::{Aes128, Aes256};
use eax::{AeadInOut, Eax, KeyInit, Nonce, Tag, cipher::consts::U16};
use std::{
    io,
    pin::Pin,
    task::{Context, Poll},
};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use zeroize::{Zeroize, Zeroizing};

const MAX_PAYLOAD: usize = u16::MAX as usize;
const MAX_RECORDS: u128 = 1 << 32;
const IO_BUDGET: usize = 8;

fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid RSA-AES record")
}

struct Direction {
    key: Zeroizing<Vec<u8>>,
    nonce: u128,
}
impl Direction {
    fn encrypt(&mut self, header: &[u8; 2], data: &mut [u8]) -> io::Result<[u8; 16]> {
        if self.nonce >= MAX_RECORDS {
            return Err(invalid());
        }
        let nonce: Nonce<U16> = self.nonce.to_le_bytes().into();
        let tag = match self.key.len() {
            16 => Eax::<Aes128>::new_from_slice(&self.key)
                .map_err(|_| invalid())?
                .encrypt_inout_detached(&nonce, header, data.into()),
            32 => Eax::<Aes256>::new_from_slice(&self.key)
                .map_err(|_| invalid())?
                .encrypt_inout_detached(&nonce, header, data.into()),
            _ => return Err(invalid()),
        }
        .map_err(|_| invalid())?;
        self.nonce = self.nonce.checked_add(1).ok_or_else(invalid)?;
        Ok(tag.into())
    }
    fn decrypt(&mut self, header: &[u8; 2], data: &mut [u8], tag: [u8; 16]) -> io::Result<()> {
        if self.nonce >= MAX_RECORDS {
            return Err(invalid());
        }
        let nonce: Nonce<U16> = self.nonce.to_le_bytes().into();
        let tag: Tag<U16> = tag.into();
        match self.key.len() {
            16 => Eax::<Aes128>::new_from_slice(&self.key)
                .map_err(|_| invalid())?
                .decrypt_inout_detached(&nonce, header, data.into(), &tag),
            32 => Eax::<Aes256>::new_from_slice(&self.key)
                .map_err(|_| invalid())?
                .decrypt_inout_detached(&nonce, header, data.into(), &tag),
            _ => return Err(invalid()),
        }
        .map_err(|_| invalid())?;
        self.nonce = self.nonce.checked_add(1).ok_or_else(invalid)?;
        Ok(())
    }
}

/// Neither CPU library calls nor their temporary key copies outlive this operation.
/// The long-lived directional key allocations belong to this zeroizing owner.
pub(crate) struct Records<S> {
    inner: S,
    tx: Direction,
    rx: Direction,
    header: [u8; 2],
    header_read: usize,
    reading_body: bool,
    body: Zeroizing<Vec<u8>>,
    body_read: usize,
    plain_at: usize,
    plain_ready: bool,
    pending: Zeroizing<Vec<u8>>,
    pending_at: usize,
    empty: usize,
    failed: bool,
}

impl<S> Records<S> {
    pub(super) fn new(inner: S, tx: Zeroizing<Vec<u8>>, rx: Zeroizing<Vec<u8>>) -> Self {
        Self {
            inner,
            tx: Direction { key: tx, nonce: 0 },
            rx: Direction { key: rx, nonce: 0 },
            header: [0; 2],
            header_read: 0,
            reading_body: false,
            body: Zeroizing::new(Vec::new()),
            body_read: 0,
            plain_at: 0,
            plain_ready: false,
            pending: Zeroizing::new(Vec::new()),
            pending_at: 0,
            empty: 0,
            failed: false,
        }
    }
    fn reset_read(&mut self) {
        self.body.zeroize();
        self.body_read = 0;
        self.header_read = 0;
        self.reading_body = false;
        self.plain_at = 0;
        self.plain_ready = false;
    }
    pub(super) fn into_raw(self) -> Result<S, Error> {
        if self.failed
            || self.header_read != 0
            || self.reading_body
            || self.plain_ready
            || !self.pending.is_empty()
        {
            return Err(Error::InvalidRsaAesExchange);
        }
        Ok(self.inner)
    }
}

fn fill<S: AsyncRead + Unpin>(
    stream: &mut S,
    cx: &mut Context<'_>,
    bytes: &mut [u8],
    at: &mut usize,
) -> Poll<io::Result<bool>> {
    for _ in 0..IO_BUDGET {
        if *at == bytes.len() {
            return Poll::Ready(Ok(true));
        }
        let mut read = ReadBuf::new(bytes.get_mut(*at..).ok_or_else(invalid)?);
        match Pin::new(&mut *stream).poll_read(cx, &mut read) {
            Poll::Pending => return Poll::Pending,
            Poll::Ready(Err(error)) => return Poll::Ready(Err(error)),
            Poll::Ready(Ok(())) => {
                if read.filled().is_empty() {
                    return Poll::Ready(Ok(false));
                }
                *at += read.filled().len();
            }
        }
    }
    cx.waker().wake_by_ref();
    Poll::Pending
}

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncRead for Records<S> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        out: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if this.failed {
            return Poll::Ready(Err(invalid()));
        }
        if out.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        for _ in 0..IO_BUDGET {
            if this.plain_ready {
                let amount = out.remaining().min(this.body.len() - this.plain_at);
                out.put_slice(
                    this.body
                        .get(this.plain_at..this.plain_at + amount)
                        .ok_or_else(invalid)?,
                );
                this.plain_at += amount;
                if this.plain_at == this.body.len() {
                    this.reset_read();
                }
                return Poll::Ready(Ok(()));
            }
            match fill(&mut this.inner, cx, &mut this.header, &mut this.header_read) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Err(error)) => {
                    this.failed = true;
                    return Poll::Ready(Err(error));
                }
                Poll::Ready(Ok(false)) if this.header_read == 0 => return Poll::Ready(Ok(())),
                Poll::Ready(Ok(false)) => {
                    this.failed = true;
                    return Poll::Ready(Err(io::ErrorKind::UnexpectedEof.into()));
                }
                Poll::Ready(Ok(true)) => {}
            }
            if !this.reading_body {
                let len = usize::from(u16::from_be_bytes(this.header));
                this.body.resize(len + 16, 0);
                this.body_read = 0;
                this.reading_body = true;
            }
            match fill(&mut this.inner, cx, &mut this.body, &mut this.body_read) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Err(error)) => {
                    this.failed = true;
                    return Poll::Ready(Err(error));
                }
                Poll::Ready(Ok(false)) => {
                    this.failed = true;
                    return Poll::Ready(Err(io::ErrorKind::UnexpectedEof.into()));
                }
                Poll::Ready(Ok(true)) => {}
            }
            let len = this.body.len().checked_sub(16).ok_or_else(invalid)?;
            let (data, encoded_tag) = this.body.split_at_mut_checked(len).ok_or_else(invalid)?;
            let tag: [u8; 16] = encoded_tag.try_into().map_err(|_| invalid())?;
            if let Err(error) = this.rx.decrypt(&this.header, data, tag) {
                this.failed = true;
                return Poll::Ready(Err(error));
            }
            this.body.truncate(len);
            if len == 0 {
                this.empty += 1;
                this.reset_read();
                if this.empty > 32 {
                    this.failed = true;
                    return Poll::Ready(Err(invalid()));
                }
            } else {
                this.empty = 0;
                this.plain_ready = true;
            }
        }
        cx.waker().wake_by_ref();
        Poll::Pending
    }
}

impl<S: AsyncWrite + Unpin> Records<S> {
    fn drain(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        for _ in 0..IO_BUDGET {
            if self.pending_at == self.pending.len() {
                self.pending.zeroize();
                self.pending_at = 0;
                return Poll::Ready(Ok(()));
            }
            match Pin::new(&mut self.inner)
                .poll_write(cx, self.pending.get(self.pending_at..).ok_or_else(invalid)?)
            {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Ok(0)) => {
                    self.failed = true;
                    return Poll::Ready(Err(io::ErrorKind::WriteZero.into()));
                }
                Poll::Ready(Err(error)) => {
                    self.failed = true;
                    return Poll::Ready(Err(error));
                }
                Poll::Ready(Ok(amount)) => self.pending_at += amount,
            }
        }
        cx.waker().wake_by_ref();
        Poll::Pending
    }
}
impl<S: AsyncRead + AsyncWrite + Unpin> AsyncWrite for Records<S> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        input: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        if this.failed {
            return Poll::Ready(Err(invalid()));
        }
        if input.is_empty() {
            return Poll::Ready(Ok(0));
        }
        match this.drain(cx) {
            Poll::Pending => return Poll::Pending,
            Poll::Ready(Err(e)) => return Poll::Ready(Err(e)),
            Poll::Ready(Ok(())) => {}
        }
        let len = input.len().min(MAX_PAYLOAD);
        let header = (len as u16).to_be_bytes();
        this.pending.extend_from_slice(&header);
        this.pending
            .extend_from_slice(input.get(..len).ok_or_else(invalid)?);
        let tag = match this
            .tx
            .encrypt(&header, this.pending.get_mut(2..).ok_or_else(invalid)?)
        {
            Ok(tag) => tag,
            Err(error) => {
                this.failed = true;
                return Poll::Ready(Err(error));
            }
        };
        this.pending.extend_from_slice(&tag);
        // Buffered acceptance is irrevocable. flush/next write drains exactly this frame;
        // cancellation of the owning protocol/session drops it, never replays it.
        Poll::Ready(Ok(len))
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if this.failed {
            return Poll::Ready(Err(invalid()));
        }
        match this.drain(cx) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Err(e)) => Poll::Ready(Err(e)),
            Poll::Ready(Ok(())) => match Pin::new(&mut this.inner).poll_flush(cx) {
                Poll::Ready(Err(error)) => {
                    this.failed = true;
                    Poll::Ready(Err(error))
                }
                result => result,
            },
        }
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if this.failed {
            return Pin::new(&mut this.inner).poll_shutdown(cx);
        }
        match this.drain(cx) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Err(e)) => Poll::Ready(Err(e)),
            Poll::Ready(Ok(())) => match Pin::new(&mut this.inner).poll_shutdown(cx) {
                Poll::Ready(Err(error)) => {
                    this.failed = true;
                    Poll::Ready(Err(error))
                }
                result => result,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    #[tokio::test]
    async fn fragments_large_writes_and_coalesces_authenticated_plaintext() {
        let (a, b) = tokio::io::duplex(37);
        let key = vec![7; 32];
        let mut sender = Records::new(a, Zeroizing::new(key.clone()), Zeroizing::new(key.clone()));
        let mut receiver = Records::new(b, Zeroizing::new(key.clone()), Zeroizing::new(key));
        let message = vec![42; 65538];
        let expected = message.clone();
        let send = tokio::spawn(async move {
            sender.write_all(&message).await.unwrap();
            sender.flush().await.unwrap();
        });
        let mut got = vec![0; expected.len()];
        receiver.read_exact(&mut got).await.unwrap();
        send.await.unwrap();
        assert_eq!(got, expected);
    }
    #[tokio::test]
    async fn bad_tag_never_releases_plaintext_and_raw_transition_rejects_unread_data() {
        let (mut a, b) = tokio::io::duplex(100);
        let mut direction = Direction {
            key: Zeroizing::new(vec![1; 16]),
            nonce: 0,
        };
        let mut data = b"canary".to_vec();
        let header = [0, 6];
        let mut tag = direction.encrypt(&header, &mut data).unwrap();
        tag[0] ^= 1;
        a.write_all(&header).await.unwrap();
        a.write_all(&data).await.unwrap();
        a.write_all(&tag).await.unwrap();
        let mut receiver =
            Records::new(b, Zeroizing::new(vec![1; 16]), Zeroizing::new(vec![1; 16]));
        let mut out = [9; 6];
        assert!(receiver.read_exact(&mut out).await.is_err());
        assert_eq!(out, [9; 6]);
        assert!(receiver.into_raw().is_err());
    }
    #[tokio::test]
    async fn replayed_record_cannot_release_second_plaintext() {
        let (mut a, b) = tokio::io::duplex(100);
        let mut direction = Direction {
            key: Zeroizing::new(vec![4; 16]),
            nonce: 0,
        };
        let mut data = vec![42];
        let tag = direction.encrypt(&[0, 1], &mut data).unwrap();
        let mut frame = vec![0, 1];
        frame.extend_from_slice(&data);
        frame.extend_from_slice(&tag);
        a.write_all(&frame).await.unwrap();
        a.write_all(&frame).await.unwrap();
        let mut receiver =
            Records::new(b, Zeroizing::new(vec![4; 16]), Zeroizing::new(vec![4; 16]));
        let mut first = [0];
        receiver.read_exact(&mut first).await.unwrap();
        assert_eq!(first, [42]);
        let mut second = [9];
        assert!(receiver.read_exact(&mut second).await.is_err());
        assert_eq!(second, [9]);
    }

    #[tokio::test]
    async fn failure_after_partial_flush_is_not_replayed() {
        let (a, mut b) = tokio::io::duplex(1);
        let mut writer = Records::new(a, Zeroizing::new(vec![3; 16]), Zeroizing::new(vec![3; 16]));
        writer.write_all(b"payload").await.unwrap();
        let mut flush = Box::pin(writer.flush());
        let mut first = [0];
        tokio::select! { result = &mut flush => panic!("unexpected full delivery {}", result.is_ok()), result = b.read_exact(&mut first) => { result.unwrap(); } }
        drop(flush);
        drop(b);
        assert!(writer.flush().await.is_err());
        assert!(writer.write_all(b"new").await.is_err());
    }

    struct CompletionFails<S>(S, bool);

    impl<S: AsyncRead + Unpin> AsyncRead for CompletionFails<S> {
        fn poll_read(
            self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            out: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            Pin::new(&mut self.get_mut().0).poll_read(cx, out)
        }
    }

    impl<S: AsyncWrite + Unpin> AsyncWrite for CompletionFails<S> {
        fn poll_write(
            self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            input: &[u8],
        ) -> Poll<io::Result<usize>> {
            Pin::new(&mut self.get_mut().0).poll_write(cx, input)
        }

        fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            let this = self.get_mut();
            if this.1 {
                Poll::Ready(Err(io::Error::other("synthetic transport flush failure")))
            } else {
                Pin::new(&mut this.0).poll_flush(cx)
            }
        }

        fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            let this = self.get_mut();
            if this.1 {
                Pin::new(&mut this.0).poll_shutdown(cx)
            } else {
                Poll::Ready(Err(io::Error::other(
                    "synthetic transport shutdown failure",
                )))
            }
        }
    }

    #[tokio::test]
    async fn failed_transport_completion_rejects_further_records_and_raw_transition() {
        for flush in [true, false] {
            let (a, _peer) = tokio::io::duplex(128);
            let mut writer = Records::new(
                CompletionFails(a, flush),
                Zeroizing::new(vec![3; 16]),
                Zeroizing::new(vec![3; 16]),
            );
            writer.write_all(b"payload").await.unwrap();
            let completed = if flush {
                writer.flush().await
            } else {
                writer.shutdown().await
            };
            assert!(completed.is_err());
            assert!(writer.write_all(b"new").await.is_err());
            assert!(writer.into_raw().is_err());
        }
    }

    #[test]
    fn nonce_budget_does_not_wrap_or_reuse() {
        let mut d = Direction {
            key: Zeroizing::new(vec![0; 16]),
            nonce: MAX_RECORDS,
        };
        assert!(d.encrypt(&[0, 0], &mut []).is_err());
        assert_eq!(d.nonce, MAX_RECORDS);
    }
}
