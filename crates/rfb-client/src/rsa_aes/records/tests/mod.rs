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
async fn cancelled_partial_record_read_resumes_after_a_large_record() {
    for key_len in [16, 32] {
        let (mut peer, stream) = tokio::io::duplex(MAX_PAYLOAD + 32);
        let key = vec![7; key_len];
        let mut receiver = Records::new(
            stream,
            Zeroizing::new(key.clone()),
            Zeroizing::new(key.clone()),
        );
        let mut direction = Direction {
            key: Zeroizing::new(key),
            nonce: 0,
        };
        let mut large = vec![0x5a; MAX_PAYLOAD];
        let header = u16::MAX.to_be_bytes();
        let tag = direction.encrypt(&header, &mut large).unwrap();
        peer.write_all(&header).await.unwrap();
        peer.write_all(&large).await.unwrap();
        peer.write_all(&tag).await.unwrap();
        let mut got = vec![0; MAX_PAYLOAD];
        receiver.read_exact(&mut got).await.unwrap();
        assert_eq!(got, vec![0x5a; MAX_PAYLOAD]);

        // Cancel at a partial header, ciphertext, and authentication tag.
        for prefix_len in [1, 5, 2 + 1024 + 7] {
            let expected = vec![prefix_len as u8; 1024];
            let mut data = expected.clone();
            let header = 1024_u16.to_be_bytes();
            let tag = direction.encrypt(&header, &mut data).unwrap();
            let mut frame = header.to_vec();
            frame.extend_from_slice(&data);
            frame.extend_from_slice(&tag);
            peer.write_all(&frame[..prefix_len]).await.unwrap();
            let mut out = vec![0xa5; 1024];
            let mut waiting = Box::pin(receiver.read_exact(&mut out));
            let mut cx = Context::from_waker(std::task::Waker::noop());
            assert!(std::future::Future::poll(waiting.as_mut(), &mut cx).is_pending());
            drop(waiting);
            assert_eq!(out, vec![0xa5; 1024]);

            peer.write_all(&frame[prefix_len..]).await.unwrap();
            receiver.read_exact(&mut out).await.unwrap();
            assert_eq!(out, expected);
        }
        // A fully consumed record still permits the authenticated-to-raw boundary.
        let mut raw = receiver.into_raw().unwrap();
        peer.write_all(b"raw").await.unwrap();
        let mut out = [0; 3];
        raw.read_exact(&mut out).await.unwrap();
        assert_eq!(&out, b"raw");
        drop(raw);
        assert_eq!(peer.read(&mut [0]).await.unwrap(), 0);
    }
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
    let mut receiver = Records::new(b, Zeroizing::new(vec![1; 16]), Zeroizing::new(vec![1; 16]));
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
    let mut receiver = Records::new(b, Zeroizing::new(vec![4; 16]), Zeroizing::new(vec![4; 16]));
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

enum WriteFault {
    Prefix,
    Error,
    Recovered,
}

struct PartialWriteFailsOnce<S> {
    inner: S,
    fault: WriteFault,
}

impl<S: AsyncRead + Unpin> AsyncRead for PartialWriteFailsOnce<S> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        out: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_read(cx, out)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for PartialWriteFailsOnce<S> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        input: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        if input.is_empty() {
            return Poll::Ready(Ok(0));
        }
        match this.fault {
            WriteFault::Prefix => {
                let result = Pin::new(&mut this.inner).poll_write(cx, input.get(..1).unwrap());
                if matches!(result, Poll::Ready(Ok(1))) {
                    this.fault = WriteFault::Error;
                }
                result
            }
            WriteFault::Error => {
                this.fault = WriteFault::Recovered;
                Poll::Ready(Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "synthetic one-shot write failure",
                )))
            }
            WriteFault::Recovered => Pin::new(&mut this.inner).poll_write(cx, input),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}

#[tokio::test]
async fn one_shot_partial_write_error_permanently_rejects_records_and_raw_transition() {
    // Keep enough capacity for a complete record if the failure guard regresses.
    let (a, mut peer) = tokio::io::duplex(128);
    let mut writer = Records::new(
        PartialWriteFailsOnce {
            inner: a,
            fault: WriteFault::Prefix,
        },
        Zeroizing::new(vec![3; 16]),
        Zeroizing::new(vec![3; 16]),
    );
    writer.write_all(b"payload").await.unwrap();
    assert_eq!(
        writer.flush().await.unwrap_err().kind(),
        io::ErrorKind::TimedOut
    );
    for _ in 0..2 {
        assert_eq!(
            writer.flush().await.unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(
            writer.write_all(b"new").await.unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }
    let mut plaintext = [9];
    let mut read = ReadBuf::new(&mut plaintext);
    let mut cx = Context::from_waker(std::task::Waker::noop());
    assert!(matches!(
        Pin::new(&mut writer).poll_read(&mut cx, &mut read),
        Poll::Ready(Err(error)) if error.kind() == io::ErrorKind::InvalidData
    ));
    assert!(read.filled().is_empty());
    assert_eq!(plaintext, [9]);
    assert!(writer.into_raw().is_err());

    // Rejected conversion drops the writer, giving the live peer a deterministic EOF.
    let mut wire = Vec::new();
    peer.read_to_end(&mut wire).await.unwrap();
    assert_eq!(wire, [0]);
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
