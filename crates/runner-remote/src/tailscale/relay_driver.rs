//! One retained bidirectional SDK relay, with finite queues and owned replacement.
//! Reconnection never replays an accepted packet, TCP stream or SSH operation.

use super::{Failure, peers::Outbound, relay::Relay};
use std::{
    future::Future,
    sync::Arc,
    task::{Context, Poll},
    time::Duration,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc, oneshot};
use tokio_util::sync::CancellationToken;
use ts_http_util::Upgraded;
use ts_keys::NodePublicKey;
use ts_packet::PacketMut;

const QUEUE: usize = 64;
pub(super) trait Connector {
    fn connect(&mut self) -> impl Future<Output = Result<Relay<Upgraded>, Failure>>;
}

pub(super) struct Port {
    outgoing: mpsc::Sender<Outbound>,
    incoming: mpsc::Receiver<Incoming>,
    pub(super) ready: Option<oneshot::Receiver<()>>,
}

pub(super) struct Incoming {
    source: NodePublicKey,
    packet: PacketMut,
    _capacity: OwnedSemaphorePermit,
}

impl Incoming {
    fn take(self) -> (NodePublicKey, PacketMut) {
        (self.source, self.packet)
    }
}

impl Port {
    pub(super) fn send(&self, packet: Outbound) -> Result<(), Failure> {
        let permit = self.outgoing.try_reserve().map_err(|error| match error {
            mpsc::error::TrySendError::Full(_) => Failure::ResourceExhausted,
            mpsc::error::TrySendError::Closed(_) => Failure::Cancelled,
        })?;
        packet.stamp.observe(super::evidence::Flow::RelayQueued);
        permit.send(packet);
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn receive(&mut self) -> Result<Option<(NodePublicKey, PacketMut)>, Failure> {
        match self.incoming.try_recv() {
            Ok(packet) => Ok(Some(packet.take())),
            Err(mpsc::error::TryRecvError::Empty) => Ok(None),
            Err(mpsc::error::TryRecvError::Disconnected) => Err(Failure::Cancelled),
        }
    }

    pub(super) fn poll_receive(
        &mut self,
        cx: &mut Context<'_>,
    ) -> Poll<Result<(NodePublicKey, PacketMut), Failure>> {
        self.incoming
            .poll_recv(cx)
            .map(|packet| packet.map(Incoming::take).ok_or(Failure::Cancelled))
    }
}

pub(super) struct Driver {
    pub(super) outgoing: mpsc::Receiver<Outbound>,
    pub(super) incoming: mpsc::Sender<Incoming>,
    pub(super) receive_budget: Arc<Semaphore>,
    cancelled: CancellationToken,
    pub(super) ready: Option<oneshot::Sender<()>>,
}

impl Driver {
    pub(super) fn new(cancelled: CancellationToken) -> (Self, Port) {
        let (outgoing, receive_outgoing) = mpsc::channel(QUEUE);
        let (send_incoming, incoming) = mpsc::channel(QUEUE);
        let (ready, ready_receiver) = oneshot::channel();
        (
            Self {
                outgoing: receive_outgoing,
                incoming: send_incoming,
                receive_budget: Arc::new(Semaphore::new(QUEUE)),
                cancelled,
                ready: Some(ready),
            },
            Port {
                outgoing,
                incoming,
                ready: Some(ready_receiver),
            },
        )
    }

    pub(super) fn regional(
        cancelled: CancellationToken,
        incoming: mpsc::Sender<Incoming>,
        receive_budget: Arc<Semaphore>,
    ) -> (Self, mpsc::Sender<Outbound>, oneshot::Receiver<()>) {
        let (outgoing, receive_outgoing) = mpsc::channel(QUEUE);
        let (ready, receiver) = oneshot::channel();
        (
            Self {
                outgoing: receive_outgoing,
                incoming,
                receive_budget,
                cancelled,
                ready: Some(ready),
            },
            outgoing,
            receiver,
        )
    }

    pub(super) async fn run(mut self, mut connector: impl Connector) -> Result<(), Failure> {
        if !super::diagnostics::in_domain() {
            return Err(Failure::DomainFailed);
        }
        let mut failures = 0usize;
        loop {
            let connected = tokio::select! { biased;
                _ = self.cancelled.cancelled() => return Err(Failure::Cancelled),
                result = connector.connect() => result,
            };
            if let Ok(relay) = connected {
                failures = 0;
                if let Some(ready) = self.ready.take() {
                    let _ = ready.send(());
                }
                let result = self.transport(&relay).await;
                // Both reader/writer futures ended before actual SDK codec/TLS/
                // raw IO disposal. Capacity remains held until that full Drop.
                drop(relay);
                if self.cancelled.is_cancelled()
                    || self.incoming.is_closed()
                    || self.outgoing.is_closed()
                {
                    return Err(Failure::Cancelled);
                }
                if result == Err(Failure::ResourceExhausted) {
                    return result;
                }
            } else {
                failures += 1;
                if failures >= 3 {
                    return Err(Failure::DomainFailed);
                }
            }
            // Rate-limit replacement under this root; no detached timers or
            // unbounded overlapping attempts, and no retained packet replay.
            tokio::select! { biased;
                _ = self.cancelled.cancelled() => return Err(Failure::Cancelled),
                _ = tokio::time::sleep(Duration::from_millis(100)) => {}
            }
        }
    }

    async fn transport(&mut self, relay: &Relay<Upgraded>) -> Result<(), Failure> {
        let receiving = async {
            loop {
                // All regional readers share this bound, including a decoded
                // packet waiting behind the queue. Reserve before SDK allocation.
                let capacity = Arc::clone(&self.receive_budget)
                    .acquire_owned()
                    .await
                    .map_err(|_| Failure::Cancelled)?;
                let packet =
                    super::evidence::observe(super::evidence::Stage::RelayRead, relay.receive())
                        .await?;
                // One bounded current SDK packet can wait behind the finite
                // receive queue. Stop reading before any next allocation.
                self.incoming
                    .send(Incoming {
                        source: packet.0,
                        packet: packet.1,
                        _capacity: capacity,
                    })
                    .await
                    .map_err(|_| Failure::Cancelled)?;
            }
        };
        let sending = async {
            while let Some(packet) = self.outgoing.recv().await {
                if !packet.stamp.current() {
                    continue;
                }
                let result = super::evidence::observe(
                    super::evidence::Stage::RelayWrite,
                    relay.send(packet),
                )
                .await;
                if result.is_err() && relay.poisoned() {
                    return result;
                }
                // A frame refused before encoding is discarded. Only SDK TCP
                // and WireGuard may generate their own protocol retransmission.
            }
            Err(Failure::Cancelled)
        };
        tokio::select! { biased;
            _ = self.cancelled.cancelled() => Err(Failure::Cancelled),
            result = receiving => result,
            result = sending => result,
        }
    }
}
