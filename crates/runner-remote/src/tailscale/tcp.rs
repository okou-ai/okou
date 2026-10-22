//! One private SDK Netstack and bounded byte bridge per exact TCP binding.
//! This owner is polled by the native resource domain; SDK sockets/channels never
//! escape into the caller runtime. Retiring it destroys all its private queues.

#[cfg(test)]
mod tests;

use std::{
    collections::VecDeque,
    future::Future,
    io,
    pin::Pin,
    sync::{Arc, Weak},
    task::{Context, Poll},
    time::Instant,
};
use tokio::io::{AsyncRead, AsyncWrite, DuplexStream, ReadBuf};
use ts_netstack_smoltcp_core::{Config, HasChannel, Netstack, Request, smoltcp};
use ts_netstack_smoltcp_socket::{CreateSocket, TcpStream};
use ts_packet::PacketMut;

use super::{Failure, peers::Binding};

const BYTE_CAPACITY: usize = 64 * 1024;
const FRAME_CAPACITY: usize = 64;
const MTU: usize = 1280;
type Connect = Pin<Box<dyn Future<Output = Result<TcpStream, ts_netstack_smoltcp_core::Error>>>>;
type Bridge = Pin<Box<dyn Future<Output = io::Result<(u64, u64)>>>>;
type Command = Pin<Box<dyn Future<Output = Option<Request>>>>;

pub(super) struct Connection {
    binding: Arc<Binding>,
    core: Option<Netstack>,
    device: Device,
    connecting: Option<Connect>,
    bridge: Option<Bridge>,
    command: Option<Command>,
    cancellation: Pin<Box<tokio_util::sync::WaitForCancellationFutureOwned>>,
    epoch: Instant,
    lease: Option<super::Lease>,
    trace: super::evidence::Trace,
}

impl Connection {
    pub(super) fn new(binding: Arc<Binding>, lease: Option<super::Lease>) -> Result<Self, Failure> {
        if !binding.live() {
            return Err(Failure::Cancelled);
        }
        let mut core = Netstack::new(
            Config {
                command_channel_capacity: Some(4),
                tcp_buffer_size: BYTE_CAPACITY,
                loopback: false,
                mtu: MTU,
                ..Config::default()
            },
            smoltcp::time::Instant::from_millis(0),
        );
        if !core.direct_set_ips([binding.local().ip()]) {
            return Err(Failure::DomainFailed);
        }
        let channel = core.command_channel();
        let local = binding.local();
        let remote = binding.remote();
        let command = Box::pin(core.wait_for_cmd());
        let cancellation = Box::pin(binding.cancelled().cancelled_owned());
        let trace = super::evidence::Trace::current();
        trace
            .clone()
            .with_role(super::evidence::Role::PrivateTcp)
            .endpoint(remote);
        trace.set(
            super::evidence::Stage::PrivateTcp,
            super::evidence::Status::Running,
            super::evidence::Detail::NotExposed,
        );
        Ok(Self {
            binding,
            core: Some(core),
            device: Default::default(),
            connecting: Some(Box::pin(
                async move { channel.tcp_connect(local, remote).await },
            )),
            bridge: None,
            command: Some(command),
            cancellation,
            epoch: Instant::now(),
            lease,
            trace,
        })
    }

    /// One connect, then one read and one write producer. A channel capacity alone
    /// would not bound the SDK's blocked-command list; no raw channel is exposed.
    pub(super) fn poll(&mut self, cx: &mut Context<'_>) -> Result<Option<Stream>, Failure> {
        if self.cancellation.as_mut().poll(cx).is_ready()
            || !self.binding.live()
            || self.core.is_none()
        {
            self.retire();
            return Err(Failure::Cancelled);
        }
        let core = self.core.as_mut().ok_or(Failure::Cancelled)?;
        if let Some(command) = self.command.as_mut()
            && let Poll::Ready(request) = command.as_mut().poll(cx)
        {
            let request = request.ok_or(Failure::Cancelled)?;
            core.process_one_cmd(request);
            self.command = Some(Box::pin(core.wait_for_cmd()));
            cx.waker().wake_by_ref();
        }
        core.poll_device_io(
            smoltcp::time::Instant::from_millis(self.epoch.elapsed().as_millis() as i64),
            &mut self.device,
        );
        let mut client = None;
        if let Some(connect) = self.connecting.as_mut() {
            match connect.as_mut().poll(cx) {
                Poll::Pending => {}
                Poll::Ready(Err(error)) => {
                    self.trace.set(
                        super::evidence::Stage::PrivateTcp,
                        super::evidence::Status::Failed,
                        super::evidence::Detail::netstack(error),
                    );
                    self.trace.seal();
                    self.retire();
                    return Err(Failure::DomainFailed);
                }
                Poll::Ready(Ok(mut tcp)) => {
                    self.trace.set(
                        super::evidence::Stage::PrivateTcp,
                        super::evidence::Status::Passed,
                        super::evidence::Detail::NotExposed,
                    );
                    self.connecting.take();
                    let (mut owner, io) = tokio::io::duplex(BYTE_CAPACITY);
                    let cancelled = self.binding.cancelled();
                    self.bridge = Some(Box::pin(async move {
                        tokio::select! {
                            biased;
                            _ = cancelled.cancelled() => Err(closed()),
                            result = tokio::io::copy_bidirectional_with_sizes(&mut owner, &mut tcp, 4096, 4096) => result,
                        }
                    }));
                    client = Some(Stream {
                        binding: Arc::clone(&self.binding),
                        cancellation: Box::pin(self.binding.cancelled().cancelled_owned()),
                        io,
                        #[cfg(test)]
                        trace: self.trace.clone(),
                    });
                }
            }
        }
        if let Some(bridge) = self.bridge.as_mut()
            && let Poll::Ready(result) = bridge.as_mut().poll(cx)
        {
            self.trace.set(
                super::evidence::Stage::PrivateStream,
                super::evidence::Status::Unknown,
                if result.is_ok() {
                    super::evidence::Detail::EndOfStream
                } else {
                    super::evidence::Detail::Io
                },
            );
            self.trace.seal();
            self.retire();
            return Err(Failure::Cancelled);
        }
        Ok(client)
    }

    pub(super) fn receive(
        &mut self,
        binding: &Arc<Binding>,
        packet: PacketMut,
    ) -> Result<(), Failure> {
        if !Arc::ptr_eq(&self.binding, binding) || !self.binding.live() || self.core.is_none() {
            return Err(Failure::Cancelled);
        }
        if packet.len() > MTU || self.device.incoming.len() >= FRAME_CAPACITY {
            return Err(Failure::ResourceExhausted);
        }
        self.trace.tcp_packet(packet.as_ref(), true);
        self.device.incoming.push_back(packet);
        Ok(())
    }

    pub(super) fn outgoing(&mut self) -> Result<Vec<PacketMut>, Failure> {
        if !self.binding.live() || self.core.is_none() {
            self.retire();
            return Err(Failure::Cancelled);
        }
        let packets: Vec<PacketMut> = self.device.outgoing.drain(..).collect();
        if self.trace.enabled() {
            for packet in &packets {
                self.trace.tcp_packet(packet.as_ref(), false);
            }
        }
        Ok(packets)
    }

    pub(super) fn retire(&mut self) {
        self.binding.cancelled().cancel();
        self.bridge.take();
        self.connecting.take();
        self.command.take();
        self.core.take();
        self.device.incoming.clear();
        self.device.outgoing.clear();
        // Capacity belongs to physical SDK work, including pending commands
        // and bridge buffers, rather than to the caller's byte-stream waiter.
        self.lease.take();
    }

    pub(super) fn next_delay(&mut self) -> Option<std::time::Duration> {
        let now = smoltcp::time::Instant::from_millis(self.epoch.elapsed().as_millis() as i64);
        self.core.as_mut()?.poll_delay(now)
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        self.retire();
    }
}

/// Caller-facing IO is a bounded byte bridge with identity cancellation checks.
/// Holding it also conservatively reserves the tuple after native destruction.
pub(crate) struct Stream {
    binding: Arc<Binding>,
    cancellation: Pin<Box<tokio_util::sync::WaitForCancellationFutureOwned>>,
    io: DuplexStream,
    #[cfg(test)]
    trace: super::evidence::Trace,
}

/// Opaque liveness of the actual authenticated peer/address/TCP binding.
/// Higher protocol layers retain this to fence their own decrypted buffers.
/// Observing it must not extend the physical TCP tuple's reservation.
#[derive(Clone)]
pub(crate) struct StreamGuard(Weak<Binding>);

impl StreamGuard {
    pub(crate) fn is_live(&self) -> bool {
        self.0.upgrade().is_some_and(|binding| binding.live())
    }
    pub(crate) async fn retired(&self) {
        let cancellation = self.0.upgrade().map(|binding| binding.cancelled());
        if let Some(cancellation) = cancellation {
            cancellation.cancelled().await;
        }
    }
}

impl Stream {
    pub(crate) fn guard(&self) -> StreamGuard {
        StreamGuard(Arc::downgrade(&self.binding))
    }
    /// This stream can only be created by the exact authenticated peer/tuple dial.
    pub(crate) fn is_live(&self) -> bool {
        self.binding.live()
    }
    #[cfg(test)]
    pub(super) fn evidence(&self) -> Option<super::evidence::Snapshot> {
        self.trace.snapshot()
    }
    pub(crate) fn cancelled(&self) -> tokio_util::sync::CancellationToken {
        self.binding.cancelled()
    }
    fn check(&mut self, cx: &mut Context<'_>) -> io::Result<()> {
        if self.cancellation.as_mut().poll(cx).is_ready() || !self.binding.live() {
            Err(closed())
        } else {
            Ok(())
        }
    }
}

impl AsyncRead for Stream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        out: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        self.check(cx)?;
        if out.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        // Do not fill caller memory before rechecking a completed read. Bytes
        // already buffered in the duplex are discarded on identity retirement.
        let mut bytes = [0; 4096];
        let count = out.remaining().min(bytes.len());
        let mut buffer = ReadBuf::new(bytes.get_mut(..count).ok_or_else(closed)?);
        match Pin::new(&mut self.io).poll_read(cx, &mut buffer) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Err(_)) => Poll::Ready(Err(closed())),
            Poll::Ready(Ok(())) => {
                self.check(cx)?;
                out.put_slice(buffer.filled());
                Poll::Ready(Ok(()))
            }
        }
    }
}

impl AsyncWrite for Stream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        self.check(cx)?;
        Pin::new(&mut self.io).poll_write(cx, bytes)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.check(cx)?;
        Pin::new(&mut self.io).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.check(cx)?;
        Pin::new(&mut self.io).poll_shutdown(cx)
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        self.binding.cancelled().cancel();
    }
}

fn closed() -> io::Error {
    io::Error::new(
        io::ErrorKind::ConnectionAborted,
        "native Tailscale connection retired",
    )
}

#[derive(Default)]
struct Device {
    incoming: VecDeque<PacketMut>,
    outgoing: VecDeque<PacketMut>,
}
struct Receive(PacketMut);
struct Transmit<'a>(&'a mut VecDeque<PacketMut>);

impl smoltcp::phy::RxToken for Receive {
    fn consume<R, F: FnOnce(&[u8]) -> R>(self, function: F) -> R {
        function(self.0.as_ref())
    }
}
impl smoltcp::phy::TxToken for Transmit<'_> {
    fn consume<R, F: FnOnce(&mut [u8]) -> R>(self, length: usize, function: F) -> R {
        // The SDK must obey the published MTU; the single owner already reserved
        // a queue slot in Device::transmit/receive. Violations fail this domain.
        assert!(
            length <= MTU && self.0.len() < FRAME_CAPACITY,
            "native frame bound"
        );
        let mut packet = PacketMut::new(length);
        let result = function(packet.as_mut());
        self.0.push_back(packet);
        result
    }
}
impl smoltcp::phy::Device for Device {
    type RxToken<'a> = Receive;
    type TxToken<'a> = Transmit<'a>;
    fn receive(
        &mut self,
        _: smoltcp::time::Instant,
    ) -> Option<(Self::RxToken<'_>, Self::TxToken<'_>)> {
        if self.outgoing.len() >= FRAME_CAPACITY {
            return None;
        }
        Some((
            Receive(self.incoming.pop_front()?),
            Transmit(&mut self.outgoing),
        ))
    }
    fn transmit(&mut self, _: smoltcp::time::Instant) -> Option<Self::TxToken<'_>> {
        (self.outgoing.len() < FRAME_CAPACITY).then_some(Transmit(&mut self.outgoing))
    }
    fn capabilities(&self) -> smoltcp::phy::DeviceCapabilities {
        let mut cap = smoltcp::phy::DeviceCapabilities::default();
        cap.medium = smoltcp::phy::Medium::Ip;
        cap.max_transmission_unit = MTU;
        cap
    }
}
