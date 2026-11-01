use super::{PausedTcp, WriteGate};
use crate::tailscale::tests::fixture::bounded;
use futures_util::FutureExt;
use std::{
    io,
    panic::{AssertUnwindSafe, catch_unwind},
    pin::Pin,
    sync::{Arc, TryLockError, mpsc},
    task::{Context, Poll, Waker},
    thread,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

#[tokio::test]
async fn malformed_tls_handshake_still_fails_the_derp_fixture() {
    let server = super::Server::secure().await;
    let mut socket = bounded(TcpStream::connect(server.address)).await.unwrap();
    bounded(socket.write_all(b"invalid tls client hello"))
        .await
        .unwrap();
    assert!(matches!(bounded(server.task).await, Err(error) if error.is_panic()));
}

struct BeforeWrite<F> {
    socket: TcpStream,
    before: Option<F>,
}

impl<F: FnOnce() + Unpin> AsyncWrite for BeforeWrite<F> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        if let Some(before) = self.before.take() {
            before();
        }
        Pin::new(&mut self.socket).poll_write(cx, bytes)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.socket).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.socket).poll_shutdown(cx)
    }
}

async fn sockets() -> (TcpStream, TcpStream) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (socket, peer) = bounded(async {
        tokio::join!(
            TcpStream::connect(listener.local_addr().unwrap()),
            listener.accept()
        )
    })
    .await;
    let socket = socket.unwrap();
    bounded(socket.writable()).await.unwrap();
    (socket, peer.unwrap().0)
}

async fn reset_during_write(initial: usize) {
    let (socket, mut peer) = sockets().await;
    let gate = WriteGate::new();
    gate.pause_after(initial);
    let resetting = Arc::clone(&gate);
    let (controller_tx, controller_rx) = mpsc::channel();
    let socket = BeforeWrite {
        socket,
        before: Some(move || {
            let (entered_tx, entered_rx) = mpsc::channel();
            let controller = thread::spawn(move || {
                // Force the old authorization/accounting gap when it exists.
                // With a guarded socket poll, signal contention first so the
                // write can finish before pause_after acquires that same lock.
                let unlocked = match resetting.state.try_lock() {
                    Ok(state) => {
                        drop(state);
                        true
                    }
                    Err(TryLockError::WouldBlock) => false,
                    Err(TryLockError::Poisoned(error)) => panic!("{error}"),
                };
                if unlocked {
                    resetting.pause_after(12);
                }
                entered_tx.send(()).unwrap();
                if !unlocked {
                    resetting.pause_after(12);
                }
            });
            controller_tx.send(controller).unwrap();
            entered_rx.recv_timeout(Duration::from_secs(15)).unwrap();
        }),
    };
    let mut socket = PausedTcp::new(socket, Arc::clone(&gate));
    let original = b"write-authorized-before-the-pause";
    bounded(socket.write_all(original)).await.unwrap();
    controller_rx
        .recv_timeout(Duration::from_secs(15))
        .unwrap()
        .join()
        .unwrap();
    let mut received = vec![0; original.len()];
    bounded(peer.read_exact(&mut received)).await.unwrap();
    assert_eq!(received, original);

    let next = b"exact-partial-tls-record-after-pause";
    assert_eq!(bounded(socket.write(next)).await.unwrap(), 12);
    let mut prefix = [0; 12];
    bounded(peer.read_exact(&mut prefix)).await.unwrap();
    assert_eq!(prefix, next[..12]);
    {
        let mut writing = std::pin::pin!(socket.write_all(&next[12..]));
        assert!(writing.as_mut().now_or_never().is_none());
        bounded(gate.pending()).await;
    }
    drop(socket);
    bounded(gate.destroyed()).await;
    let mut extra = [0];
    assert_eq!(bounded(peer.read(&mut extra)).await.unwrap(), 0);
}

#[tokio::test]
async fn concurrent_pause_during_unlimited_socket_write_preserves_exact_new_budget() {
    reset_during_write(usize::MAX).await;
}

#[tokio::test]
async fn concurrent_pause_during_finite_socket_write_preserves_exact_new_budget() {
    reset_during_write(64).await;
}

#[tokio::test]
async fn socket_poll_panic_preserves_original_failure_and_closes_poisoned_io() {
    let (socket, mut peer) = sockets().await;
    let gate = WriteGate::new();
    let failure = catch_unwind(AssertUnwindSafe(|| {
        let mut socket = PausedTcp::new(
            BeforeWrite {
                socket,
                before: Some(|| panic!("controlled socket write failure")),
            },
            Arc::clone(&gate),
        );
        let mut cx = Context::from_waker(Waker::noop());
        let _ = Pin::new(&mut socket).poll_write(&mut cx, b"original failure");
    }));
    let failure = failure.unwrap_err();
    assert_eq!(
        failure.downcast_ref::<&str>(),
        Some(&"controlled socket write failure")
    );
    let mut extra = [0];
    assert_eq!(bounded(peer.read(&mut extra)).await.unwrap(), 0);
    assert!(gate.state.is_poisoned());
    assert!(catch_unwind(AssertUnwindSafe(|| gate.pause_after(12))).is_err());
}
