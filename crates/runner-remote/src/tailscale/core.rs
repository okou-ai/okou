//! One serialized map/data-plane owner with private complete TCP connection owners.
//! The retained native root polls this core alongside the owned relay driver.

use super::{
    Failure,
    peers::{Binding, Frames, Peers},
    relay_driver::Port,
    tcp::{Connection, Stream},
};
use std::{
    future::Future,
    net::IpAddr,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::Duration,
};
use tokio::sync::{OwnedSemaphorePermit, oneshot};
use ts_control::{Node, StateUpdate};
use ts_keys::NodeKeyPair;
use ts_transport::{DynEndpoint, UnderlayTransportId};

struct Active {
    binding: Arc<Binding>,
    connection: Connection,
    opening: Option<oneshot::Sender<Result<Stream, Failure>>>,
}

impl Active {
    fn finish_opening(&mut self, result: Result<Stream, Failure>) {
        if let Some(opening) = self.opening.take() {
            let _ = opening.send(result);
        }
    }
}

type Capacity =
    Pin<Box<dyn Future<Output = Result<OwnedSemaphorePermit, tokio::sync::AcquireError>> + Send>>;

pub(super) struct Core {
    peers: Peers,
    port: Port,
    active: Vec<Active>,
    next_port: Option<u16>,
    cursor: usize,
    work: u8,
    capacity: Option<Capacity>,
    regions: Option<(ts_derp::RegionId, Vec<ts_derp::RegionId>)>,
    relays: Option<super::regional_driver::Routes>,
}

impl Core {
    pub(super) fn new(keys: NodeKeyPair, local: Node, port: Port) -> Result<Self, Failure> {
        if !super::diagnostics::in_domain() {
            return Err(Failure::DomainFailed);
        }
        Ok(Self {
            peers: Peers::new(keys, local)?,
            port,
            active: Vec::new(),
            next_port: Some(49152),
            cursor: 0,
            work: 0,
            capacity: None,
            regions: None,
            relays: None,
        })
    }

    pub(super) fn update(&mut self, update: StateUpdate) -> Result<(), Failure> {
        self.peers.update(update)?;
        if let Some(routes) = &self.relays {
            for active in &self.active {
                if active.binding.live()
                    && let Some(region) = self.peers.region(&active.binding)
                {
                    let trace = active.binding.trace();
                    trace.region(region.0.get());
                    trace.relay(routes.evidence(region), active.binding.peer_key());
                }
            }
        }
        self.retire_regions();
        self.retire();
        Ok(())
    }

    pub(super) fn relay_peers(&self) -> Vec<(ts_keys::NodePublicKey, Option<ts_derp::RegionId>)> {
        #[cfg(test)]
        let _projection = super::tests::relay_projection::Projection::start();

        self.peers
            .relay_peers()
            .into_iter()
            .filter(|(key, _)| {
                self.active
                    .iter()
                    // Unrelated peers must not read this binding's cancellation state.
                    .any(|active| active.binding.peer_key() == *key && active.binding.live())
            })
            .collect()
    }

    pub(super) fn set_regions(&mut self, home: ts_derp::RegionId, regions: Vec<ts_derp::RegionId>) {
        self.regions = Some((home, regions));
        self.retire_regions();
        self.retire();
    }

    pub(super) fn observe_relays(&mut self, routes: super::regional_driver::Routes) {
        self.relays = super::evidence::Trace::current()
            .enabled()
            .then_some(routes);
    }

    fn retire_regions(&mut self) {
        let Some((_, regions)) = &self.regions else {
            return;
        };
        for active in &self.active {
            if self
                .peers
                .region(&active.binding)
                .is_none_or(|region| !regions.contains(&region))
            {
                active.binding.cancelled().cancel();
            }
        }
    }

    pub(super) fn dial(
        &mut self,
        target: &str,
        port: u16,
        cancelled: tokio_util::sync::CancellationToken,
        lease: Option<super::Lease>,
    ) -> Result<oneshot::Receiver<Result<Stream, Failure>>, Failure> {
        let observation =
            super::evidence::Observation::start(super::evidence::Stage::PeerSelection);
        let result = self.dial_owned(target, port, cancelled, lease);
        observation.finish(result.is_ok());
        result
    }

    fn dial_owned(
        &mut self,
        target: &str,
        port: u16,
        cancelled: tokio_util::sync::CancellationToken,
        lease: Option<super::Lease>,
    ) -> Result<oneshot::Receiver<Result<Stream, Failure>>, Failure> {
        self.peers.maintain()?;
        self.retire();
        let local_port = self.next_port.ok_or(Failure::ResourceExhausted)?;
        let ipv6 = target.parse::<IpAddr>().is_ok_and(|ip| ip.is_ipv6());
        let binding = self.peers.bind_cancellable(
            target,
            port,
            self.peers.local_address(ipv6, local_port),
            // Failed adoption drops the temporary binding. Its retirement
            // must not cancel the opening's answer before its business reason
            // (for example regional capacity) reaches the original caller.
            cancelled.child_token(),
        )?;
        if let Some((home, regions)) = &self.regions {
            let region = self
                .peers
                .region(&binding)
                .filter(|region| regions.contains(region))
                .ok_or(Failure::DomainFailed)?;
            let mut needed = self
                .relay_peers()
                .into_iter()
                .filter_map(|(_, region)| region)
                .collect::<std::collections::HashSet<_>>();
            needed.insert(*home);
            needed.insert(region);
            if needed.len() > 8 {
                return Err(Failure::ResourceExhausted);
            }
        }
        self.next_port = local_port.checked_add(1);
        if let Some(region) = self.peers.region(&binding) {
            let trace = super::evidence::Trace::current();
            trace.region(region.0.get());
            if let Some(routes) = &self.relays {
                trace.relay(routes.evidence(region), binding.peer_key());
            }
        }
        self.peers.endpoint(
            &binding,
            UnderlayTransportId(1),
            DynEndpoint::derp(binding.peer_key()),
        )?;
        let connection = Connection::new(Arc::clone(&binding), lease)?;
        let (opening, response) = oneshot::channel();
        self.active.push(Active {
            binding,
            connection,
            opening: Some(opening),
        });
        Ok(response)
    }

    fn retire(&mut self) {
        self.active.retain_mut(|active| {
            if !active.binding.live()
                || active
                    .opening
                    .as_ref()
                    .is_some_and(oneshot::Sender::is_closed)
            {
                active.connection.retire();
                active.finish_opening(Err(Failure::Cancelled));
                return false;
            }
            true
        });
    }

    fn emit(&mut self, mut frames: Frames) -> Result<(), Failure> {
        loop {
            match self.peers.prepare_derp(&mut frames) {
                Ok(Some(packet)) => self.port.send(packet)?,
                Ok(None) => return Ok(()),
                Err(Failure::Cancelled) => {
                    // Caller retirement can invalidate the batch after SDK
                    // production. prepare_derp clears it and releases its
                    // capacity; discard those bytes without ending siblings.
                    // Failed or expired node authority must still terminate.
                    self.peers.maintain()?;
                    return Ok(());
                }
                Err(failure) => return Err(failure),
            }
        }
    }

    fn receive(&mut self, cx: &mut Context<'_>) -> Result<bool, Failure> {
        let Poll::Ready(packet) = self.port.poll_receive(cx) else {
            return Ok(false);
        };
        let (source, packet) = packet?;
        let Some((frames, delivered)) = self.peers.incoming_derp(source, packet)? else {
            return Ok(true);
        };
        let active = &mut self.active;
        self.peers.deliver(delivered, |binding, packet| {
            if let Some(active) = active
                .iter_mut()
                .find(|active| Arc::ptr_eq(binding, &active.binding))
            {
                match active.connection.receive(binding, packet) {
                    // The caller can close this stream after Peers checked its
                    // binding. Retire only that connection, keeping siblings.
                    Err(Failure::Cancelled) => active.connection.retire(),
                    result => result?,
                }
            }
            Ok(())
        })?;
        self.emit(frames)?;
        Ok(true)
    }

    fn events(&mut self) -> Result<bool, Failure> {
        let frames = self.peers.events()?;
        let progress = !frames.is_empty();
        self.emit(frames)?;
        Ok(progress)
    }

    pub(super) fn poll(&mut self, cx: &mut Context<'_>) -> Result<bool, Failure> {
        self.retire();
        self.peers.maintain()?;
        // One complete SDK batch can contain 64 frames. Do not consume more
        // plaintext or ciphertext while that physical writer capacity is held.
        // Map/retirement processing above remains independent of backpressure.
        if !self.peers.writable() {
            let capacity = self
                .capacity
                .get_or_insert_with(|| Box::pin(self.peers.wait_writable()));
            if capacity.as_mut().poll(cx).is_ready() {
                self.capacity.take();
                cx.waker().wake_by_ref();
            }
            return Ok(false);
        }
        self.capacity.take();
        let work = self.work;
        self.work = (work + 1) % 3;
        if (work == 1 && self.receive(cx)?) || (work == 2 && self.events()?) {
            return Ok(true);
        }
        let count = self.active.len();
        for _ in 0..count {
            if self.active.is_empty() {
                break;
            }
            let index = self.cursor % self.active.len();
            self.cursor = index + 1;
            let active = self.active.get_mut(index).ok_or(Failure::DomainFailed)?;
            match active.connection.poll(cx) {
                Ok(Some(stream)) => {
                    active.finish_opening(Ok(stream));
                }
                Ok(None) => {}
                Err(failure) => {
                    active.finish_opening(Err(failure));
                    self.active.swap_remove(index);
                    self.peers.maintain()?;
                    continue;
                }
            }
            // Caller cancellation can race either check after poll returned.
            // A retired binding must not terminate the shared native root.
            let frames = active.connection.outgoing().and_then(|packets| {
                if packets.is_empty() {
                    Ok(None)
                } else {
                    self.peers.outgoing(&active.binding, packets).map(Some)
                }
            });
            match frames {
                Ok(Some(frames)) => {
                    self.emit(frames)?;
                    return Ok(true);
                }
                Ok(None) => {}
                Err(Failure::Cancelled) => {
                    active.connection.retire();
                    active.finish_opening(Err(Failure::Cancelled));
                    self.active.swap_remove(index);
                    self.peers.maintain()?;
                }
                Err(failure) => return Err(failure),
            }
        }
        if self.receive(cx)? {
            return Ok(true);
        }
        self.events()
    }

    fn next_delay(&mut self) -> Option<Duration> {
        let peer = self.peers.next_delay();
        if !self.peers.writable() {
            return peer.filter(|delay| !delay.is_zero());
        }
        self.active
            .iter_mut()
            .filter_map(|active| active.connection.next_delay())
            .chain(peer)
            .min()
    }

    pub(super) async fn wait(&mut self) -> Result<(), Failure> {
        let mut timer: Option<Pin<Box<tokio::time::Sleep>>> = None;
        std::future::poll_fn(|cx| {
            if self.poll(cx)? {
                return Poll::Ready(Ok(()));
            }
            if let Some(delay) = self.next_delay() {
                let at = tokio::time::Instant::now() + delay;
                let sleep = timer.get_or_insert_with(|| Box::pin(tokio::time::sleep_until(at)));
                // Never postpone an already registered SDK deadline on an
                // unrelated wakeup. A completed timer causes a fresh owner turn.
                if at < sleep.deadline() {
                    sleep.as_mut().reset(at);
                }
                if sleep.as_mut().poll(cx).is_ready() {
                    return Poll::Ready(Ok(()));
                }
            }
            Poll::Pending
        })
        .await
    }
}
