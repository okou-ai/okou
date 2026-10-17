use super::*;
use runner_lifecycle::active_runs::ActiveRunReuseState;
use runner_remote::guest_duplex::ChannelCancellation;
use sandbox::SandboxId;
use std::{
    future::Future,
    pin::Pin,
    task::{Context as TaskContext, Poll},
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    sync::watch,
    time::{Instant, Sleep},
};

pub(super) struct Fence<'a> {
    pub context: &'a Context,
    pub run: RunId,
    pub sandbox: SandboxId,
    pub live: &'a mut watch::Receiver<ActiveRunReuseState>,
    pub stop: &'a CancellationToken,
    pub guest: Option<&'a ChannelCancellation>,
}

pub(super) async fn while_live<T>(
    future: impl Future<Output = io::Result<T>>,
    fence: Fence<'_>,
) -> io::Result<T> {
    let Fence {
        context,
        run,
        sandbox,
        live,
        stop,
        guest,
    } = fence;
    tokio::pin!(future);
    let mut check = tokio::time::interval(Duration::from_millis(250));
    loop {
        if *live.borrow() == ActiveRunReuseState::Released {
            return Err(unavailable());
        }
        tokio::select! {
            biased;
            () = stop.cancelled() => return Err(unavailable()),
            () = async { match guest { Some(guest) => guest.cancelled().await, None => std::future::pending().await } } => return Err(unavailable()),
            changed = live.changed() => if changed.is_err() { return Err(unavailable()); },
            _ = check.tick() => {
                let current = tokio::select! {
                    biased;
                    () = stop.cancelled() => return Err(unavailable()),
                    changed = live.changed() => { let _ = changed; continue; },
                    result = context.status.running_sandbox(run) => result,
                };
                if current != Some(sandbox) { return Err(unavailable()); }
            }
            result = &mut future => return result,
        }
    }
}

pub(super) async fn produce(
    mut reader: FileReader,
    sender: tokio::sync::mpsc::Sender<Bytes>,
    context: Context,
    run: RunId,
    sandbox: SandboxId,
    mut live: watch::Receiver<ActiveRunReuseState>,
    stop: CancellationToken,
) {
    let cancelled = reader.cancellation();
    let transfer = async {
        while let Some(bytes) = reader.next_chunk().await? {
            tokio::time::timeout(Duration::from_secs(30), sender.send(Bytes::from(bytes)))
                .await
                .map_err(|_| unavailable())?
                .map_err(|_| unavailable())?;
        }
        // Keep the live assignment fence through Hyper's final physical write.
        // Closing the sender completes the body; the owner cancels us only
        // after the HTTP connection has flushed or failed.
        drop(sender);
        stop.cancelled().await;
        Ok(())
    };
    if while_live(
        transfer,
        Fence {
            context: &context,
            run,
            sandbox,
            live: &mut live,
            stop: &stop,
            guest: Some(&cancelled),
        },
    )
    .await
    .is_err()
    {
        // Closing the HTTP connection leaves an incomplete Content-Length body.
        // Never append an error document or a successful shortened EOF.
        stop.cancel();
    }
}

/// A stalled physical socket write has an idle deadline, independent of body polling.
pub(super) struct WriteDeadline {
    stream: UnixStream,
    deadline: Pin<Box<Sleep>>,
}
impl WriteDeadline {
    pub fn new(stream: UnixStream) -> Self {
        Self {
            stream,
            deadline: Box::pin(tokio::time::sleep(Duration::from_secs(30))),
        }
    }
    fn progress(&mut self) {
        self.deadline
            .as_mut()
            .reset(Instant::now() + Duration::from_secs(30));
    }
    fn stalled(&mut self, cx: &mut TaskContext<'_>) -> Poll<io::Result<usize>> {
        if self.deadline.as_mut().poll(cx).is_ready() {
            Poll::Ready(Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "download write stalled",
            )))
        } else {
            Poll::Pending
        }
    }
}
impl AsyncRead for WriteDeadline {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_read(cx, buffer)
    }
}
impl AsyncWrite for WriteDeadline {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        match Pin::new(&mut self.stream).poll_write(cx, bytes) {
            Poll::Ready(Ok(count)) => {
                if count > 0 {
                    self.progress();
                }
                Poll::Ready(Ok(count))
            }
            Poll::Pending => self.stalled(cx),
            result => result,
        }
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_shutdown(cx)
    }
}
