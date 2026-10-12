//! The public SDK owns DERP framing/crypto. A final raw IO fence owns admission
//! through TLS and codec buffering, and holds packet capacity through disposal.

use super::{
    Failure,
    control_io::LimitedIo,
    peers::{FrameStamp, Outbound},
};
use std::{
    future::Future,
    io,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    sync::{Notify, OwnedSemaphorePermit},
};
use tokio_util::sync::CancellationToken;
use ts_keys::{NodeKeyPair, NodePublicKey};

enum Phase {
    Startup,
    Idle,
    Packet(FrameStamp),
    Control {
        remaining: usize,
        deadline: [Pin<Box<tokio::time::Sleep>>; 2],
    },
    Poisoned,
}

struct State {
    phase: Phase,
    permit: Option<OwnedSemaphorePermit>,
}

struct Gate {
    state: Mutex<State>,
    cancelled: CancellationToken,
    idle: Notify,
}

impl Gate {
    fn check(&self, cx: Option<(&mut Context<'_>, bool)>) -> io::Result<()> {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let retired = match (cx, &mut state.phase) {
            (Some((cx, writing)), Phase::Packet(stamp)) => !stamp.poll_current(cx, writing),
            (Some((cx, writing)), Phase::Control { deadline, .. }) => {
                let [reading, writer] = deadline;
                let deadline = if writing { writer } else { reading };
                deadline.as_mut().poll(cx).is_ready()
            }
            _ => false,
        };
        if retired
            || !super::diagnostics::in_domain()
            || self.cancelled.is_cancelled()
            || matches!(&state.phase, Phase::Poisoned)
            || matches!(&state.phase, Phase::Packet(stamp) if !stamp.current())
        {
            state.phase = Phase::Poisoned;
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "native relay retired",
            ));
        }
        Ok(())
    }

    fn poison(&self) {
        self.state.lock().unwrap_or_else(|p| p.into_inner()).phase = Phase::Poisoned;
        self.idle.notify_waiters();
    }
}

// The SDK receive path answers Ping inline with the same writer. Bound that
// sole control frame and retain its buffer on cancellation just like packets.
struct SdkIo<Io> {
    io: super::derp_reader::Reader<Io>,
    gate: Arc<Gate>,
}

impl<Io: AsyncRead + Unpin> AsyncRead for SdkIo<Io> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        out: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        self.gate.check(Some((cx, false)))?;
        Pin::new(&mut self.io).poll_read(cx, out)
    }
}

impl<Io: AsyncWrite + Unpin> AsyncWrite for SdkIo<Io> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        self.gate.check(Some((cx, true)))?;
        {
            let mut state = self.gate.state.lock().unwrap_or_else(|p| p.into_inner());
            if matches!(state.phase, Phase::Idle) {
                let valid = ts_derp::frame::RawFrame::parse(bytes).is_ok_and(|(frame, rest)| {
                    rest.is_empty()
                        && frame
                            .as_type::<ts_derp::frame::Pong>()
                            .is_some_and(|(_, extra)| extra.is_empty())
                });
                if !valid {
                    state.phase = Phase::Poisoned;
                    return Poll::Ready(Err(io::ErrorKind::InvalidData.into()));
                }
                let at = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
                state.phase = Phase::Control {
                    remaining: bytes.len(),
                    deadline: [
                        Box::pin(tokio::time::sleep_until(at)),
                        Box::pin(tokio::time::sleep_until(at)),
                    ],
                };
            }
            if matches!(&state.phase, Phase::Control { remaining, .. } if bytes.len() > *remaining)
            {
                state.phase = Phase::Poisoned;
                return Poll::Ready(Err(io::ErrorKind::InvalidData.into()));
            }
        }
        let result = Pin::new(&mut self.io).poll_write(cx, bytes);
        if let Poll::Ready(Ok(count)) = result {
            let mut state = self.gate.state.lock().unwrap_or_else(|p| p.into_inner());
            if let Phase::Control { remaining, .. } = &mut state.phase {
                *remaining -= count;
            }
        }
        result
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.gate.check(Some((cx, true)))?;
        let result = Pin::new(&mut self.io).poll_flush(cx);
        if let Poll::Ready(Ok(())) = result {
            let mut state = self.gate.state.lock().unwrap_or_else(|p| p.into_inner());
            if matches!(state.phase, Phase::Control { remaining: 0, .. }) {
                state.phase = Phase::Idle;
                self.gate.idle.notify_waiters();
            }
        }
        result
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.gate.check(Some((cx, true)))?;
        Pin::new(&mut self.io).poll_shutdown(cx)
    }
}

struct Receiving {
    gate: Arc<Gate>,
}
impl Drop for Receiving {
    fn drop(&mut self) {
        let mut state = self.gate.state.lock().unwrap_or_else(|p| p.into_inner());
        if matches!(state.phase, Phase::Control { .. }) {
            state.phase = Phase::Poisoned;
        }
        self.gate.idle.notify_waiters();
    }
}

pub(super) struct GatedIo<Io> {
    io: Io,
    gate: Arc<Gate>,
}

impl<Io: AsyncRead + Unpin> AsyncRead for GatedIo<Io> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        out: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if let Err(error) = self.gate.check(Some((cx, false))) {
            return Poll::Ready(Err(error));
        }
        Pin::new(&mut self.io).poll_read(cx, out)
    }
}

impl<Io: AsyncWrite + Unpin> AsyncWrite for GatedIo<Io> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        if let Err(error) = self.gate.check(Some((cx, true))) {
            return Poll::Ready(Err(error));
        }
        Pin::new(&mut self.io).poll_write(cx, bytes)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        if let Err(error) = self.gate.check(Some((cx, true))) {
            return Poll::Ready(Err(error));
        }
        Pin::new(&mut self.io).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        if let Err(error) = self.gate.check(Some((cx, true))) {
            return Poll::Ready(Err(error));
        }
        Pin::new(&mut self.io).poll_shutdown(cx)
    }
}

// Cancellation of a send future cannot let a later SDK flush release its
// retained old frame. Keep its permit until the complete SDK client is dropped.
struct Attempt {
    gate: Arc<Gate>,
    finished: bool,
}
impl Drop for Attempt {
    fn drop(&mut self) {
        if !self.finished {
            self.gate.poison();
        }
    }
}

pub(super) struct Relay<Io> {
    client: Option<ts_derp::Client<SdkIo<Io>>>,
    gate: Arc<Gate>,
    node: NodePublicKey,
}

impl<Io> Relay<Io>
where
    Io: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    /// `authenticate` composes verified TLS and public SDK HTTP upgrade inside
    /// the retained domain. The raw fence precedes all those buffering layers.
    pub(super) async fn connect<Raw, Authenticate, Connecting>(
        raw: Raw,
        keys: &NodeKeyPair,
        cancelled: CancellationToken,
        authenticate: Authenticate,
    ) -> Result<Self, Failure>
    where
        Raw: AsyncRead + AsyncWrite + Unpin + Send + 'static,
        Authenticate: FnOnce(LimitedIo<GatedIo<Raw>>) -> Connecting,
        Connecting: Future<Output = Result<Io, Failure>>,
    {
        if !super::diagnostics::in_domain() || cancelled.is_cancelled() {
            return Err(Failure::Cancelled);
        }
        let gate = Arc::new(Gate {
            state: Mutex::new(State {
                phase: Phase::Startup,
                permit: None,
            }),
            cancelled,
            idle: Notify::new(),
        });
        let (io, limit) = LimitedIo::new(
            GatedIo {
                io: raw,
                gate: Arc::clone(&gate),
            },
            1024 * 1024,
        );
        let io = authenticate(io).await?;
        let client = ts_derp::Client::handshake(
            SdkIo {
                io: super::derp_reader::Reader::new(io),
                gate: Arc::clone(&gate),
            },
            keys,
        )
        .await
        .map_err(|_| Failure::DomainFailed)?;
        gate.check(None).map_err(|_| Failure::Cancelled)?;
        gate.state.lock().unwrap_or_else(|p| p.into_inner()).phase = Phase::Idle;
        limit.store(true, std::sync::atomic::Ordering::Release);
        Ok(Self {
            client: Some(client),
            gate,
            node: keys.public,
        })
    }

    pub(super) fn poisoned(&self) -> bool {
        self.gate.cancelled.is_cancelled()
            || matches!(
                self.gate
                    .state
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .phase,
                Phase::Poisoned
            )
    }

    pub(super) async fn receive(&self) -> Result<(NodePublicKey, ts_packet::PacketMut), Failure> {
        if !super::diagnostics::in_domain() || self.poisoned() {
            return Err(Failure::Cancelled);
        }
        let _receiving = Receiving {
            gate: Arc::clone(&self.gate),
        };
        let result = self
            .client
            .as_ref()
            .ok_or(Failure::DomainFailed)?
            .recv_one()
            .await;
        match result {
            Ok(packet) if !self.poisoned() => Ok(packet),
            _ => {
                self.gate.poison();
                Err(Failure::DomainFailed)
            }
        }
    }

    pub(super) async fn send(&self, packet: Outbound) -> Result<(), Failure> {
        if !super::diagnostics::in_domain()
            || packet.stamp.node != self.node
            || packet.destination != packet.stamp.peer
            || !packet.stamp.current()
        {
            return Err(Failure::Cancelled);
        }
        let Outbound {
            destination,
            bytes,
            stamp,
            permit,
        } = packet;
        loop {
            let idle = self.gate.idle.notified();
            tokio::pin!(idle);
            idle.as_mut().enable();
            {
                let mut state = self.gate.state.lock().unwrap_or_else(|p| p.into_inner());
                if self.gate.cancelled.is_cancelled() || !stamp.current() {
                    return Err(Failure::Cancelled);
                }
                match &state.phase {
                    Phase::Idle => {
                        state.phase = Phase::Packet(stamp);
                        state.permit = Some(permit);
                        break;
                    }
                    Phase::Control { .. } => {}
                    _ => return Err(Failure::Cancelled),
                }
            }
            idle.await;
        }
        let mut attempt = Attempt {
            gate: Arc::clone(&self.gate),
            finished: false,
        };
        let result = self
            .client
            .as_ref()
            .ok_or(Failure::DomainFailed)?
            .send_one(destination, bytes.as_ref())
            .await;
        drop(bytes);
        // A successful SDK send includes flush. A failed or abandoned attempt
        // may retain encoded buffers; poison it and retain capacity until Drop.
        if result.is_err() {
            return Err(Failure::DomainFailed);
        }
        self.gate.check(None).map_err(|_| Failure::Cancelled)?;
        let mut state = self.gate.state.lock().unwrap_or_else(|p| p.into_inner());
        state.phase = Phase::Idle;
        state.permit.take();
        attempt.finished = true;
        Ok(())
    }
}

impl<Io> Drop for Relay<Io> {
    fn drop(&mut self) {
        self.gate.poison();
        // Dispose SDK codec buffers and both real IO halves before the permit.
        drop(self.client.take());
        self.gate
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .permit
            .take();
    }
}
