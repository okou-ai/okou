//! A single retained native map, dial, TCP and relay composition.
//! All SDK futures are polled inside the same physical domain and dropped there.

use super::evidence::{self, Detail, Root as Boundary, Stage, Trace};
use super::registration::Registration;
#[cfg(test)]
use super::relay_driver::{Connector, Driver};
use super::{Failure, core::Core, domain::Control, tcp::Stream};
use futures_util::{Stream as MapStream, StreamExt, stream::FuturesUnordered};
use std::{
    future::Future,
    pin::Pin,
    task::{Context, Poll},
};
#[cfg(test)]
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;
use ts_control::StateUpdate;
use ts_http_util::{BytesBody, Http2};
#[cfg(test)]
use ts_keys::NodeKeyPair;

const COMMANDS: usize = 4;
const CONNECTIONS: usize = 24;
type Answer = oneshot::Sender<Result<Stream, Failure>>;
type Completing = Pin<Box<dyn Future<Output = ()>>>;

struct RelaySignals<'a> {
    ready: oneshot::Receiver<()>,
    changed: Option<&'a tokio::sync::Notify>,
    trace: Trace,
}

struct Dial {
    target: String,
    port: u16,
    answer: Answer,
    cancelled: CancellationToken,
    lease: Option<super::Lease>,
    trace: super::evidence::Trace,
}

pub(super) struct Opening {
    response: oneshot::Receiver<Result<Stream, Failure>>,
    cancelled: Option<CancellationToken>,
    cancellation: Pin<Box<tokio_util::sync::WaitForCancellationFutureOwned>>,
}

impl Future for Opening {
    type Output = Result<Stream, Failure>;
    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        if self.cancellation.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Err(Failure::Cancelled));
        }
        match Pin::new(&mut self.response).poll(cx) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(result) => {
                let result = result.unwrap_or(Err(Failure::Cancelled));
                if result.is_ok() {
                    self.cancelled.take();
                }
                Poll::Ready(result)
            }
        }
    }
}

impl Drop for Opening {
    fn drop(&mut self) {
        if let Some(cancelled) = self.cancelled.take() {
            cancelled.cancel();
        }
    }
}

#[derive(Clone)]
pub(super) struct Client {
    commands: mpsc::Sender<Dial>,
    cancelled: CancellationToken,
}

impl Client {
    #[cfg(test)]
    pub(super) fn dial(&self, target: &str, port: u16) -> Result<Opening, Failure> {
        self.dial_retained(target, port, None, super::evidence::Trace::default())
    }

    pub(super) fn dial_retained(
        &self,
        target: &str,
        port: u16,
        lease: Option<super::Lease>,
        trace: super::evidence::Trace,
    ) -> Result<Opening, Failure> {
        if self.cancelled.is_cancelled() {
            return Err(Failure::Cancelled);
        }
        if target.is_empty() || target.len() > 253 || !target.is_ascii() || port == 0 {
            return Err(Failure::DomainFailed);
        }
        let (answer, response) = oneshot::channel();
        let cancelled = self.cancelled.child_token();
        self.commands
            .try_send(Dial {
                target: target.to_owned(),
                port,
                answer,
                cancelled: cancelled.clone(),
                lease,
                trace,
            })
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => Failure::ResourceExhausted,
                mpsc::error::TrySendError::Closed(_) => Failure::Cancelled,
            })?;
        Ok(Opening {
            response,
            cancellation: Box::pin(cancelled.clone().cancelled_owned()),
            cancelled: Some(cancelled),
        })
    }
}

pub(super) struct Root {
    commands: mpsc::Receiver<Dial>,
    cancelled: CancellationToken,
}

impl Root {
    /// Construct before startup IO is first awaited. Only the sealed byte bridge
    /// and finite dial channel may cross out of the owning native runtime.
    pub(super) fn new(cancelled: CancellationToken) -> (Self, Client) {
        let (commands, receive) = mpsc::channel(COMMANDS);
        (
            Self {
                commands: receive,
                cancelled: cancelled.clone(),
            },
            Client {
                commands,
                cancelled,
            },
        )
    }

    #[cfg(test)]
    pub(super) async fn start<KeyIo, ControlIo, C: Connector>(
        self,
        registration: Registration,
        key_io: KeyIo,
        control_io: ControlIo,
        derived_key: &str,
        connector: impl FnOnce(NodeKeyPair, CancellationToken) -> C,
        control: &Control,
    ) -> Result<(), Failure>
    where
        KeyIo: AsyncRead + AsyncWrite + Unpin + Send + 'static,
        ControlIo: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let client = registration
            .connect(key_io, control_io, derived_key)
            .await?;
        self.connected(registration, client, connector, control)
            .await
    }

    #[cfg(test)]
    pub(super) async fn start_provisioned<KeyIo, ControlIo, C: Connector>(
        self,
        registration: Registration,
        key_io: KeyIo,
        control_io: ControlIo,
        key: &super::provisioning::Key,
        connector: impl FnOnce(NodeKeyPair, CancellationToken) -> C,
        control: &Control,
    ) -> Result<(), Failure>
    where
        KeyIo: AsyncRead + AsyncWrite + Unpin + Send + 'static,
        ControlIo: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let client = registration
            .connect_provisioned(key_io, control_io, key)
            .await?;
        self.connected(registration, client, connector, control)
            .await
    }

    #[cfg(test)]
    pub(super) async fn start_using<KeyIo, ControlIo, C: Connector>(
        self,
        registration: Registration,
        io: (KeyIo, ControlIo),
        derived_key: &str,
        tls: &impl super::registration::Tls,
        connector: impl FnOnce(NodeKeyPair, CancellationToken) -> C,
        control: &Control,
    ) -> Result<(), Failure>
    where
        KeyIo: AsyncRead + AsyncWrite + Unpin + Send + 'static,
        ControlIo: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let (key_io, control_io) = io;
        let client = registration
            .connect_using(key_io, control_io, derived_key, tls)
            .await?;
        self.connected(registration, client, connector, control)
            .await
    }

    #[cfg(test)]
    async fn connected<C: Connector>(
        self,
        registration: Registration,
        client: Http2<BytesBody>,
        connector: impl FnOnce(NodeKeyPair, CancellationToken) -> C,
        control: &Control,
    ) -> Result<(), Failure> {
        let keys = registration.keys().node_keys.clone();
        let connector = connector(keys.clone(), self.cancelled.clone());
        let maps = registration.maps(&client).await?;
        self.run(keys, maps, connector, control).await
    }

    #[cfg(test)]
    pub(super) async fn run(
        self,
        keys: NodeKeyPair,
        maps: impl MapStream<Item = StateUpdate>,
        connector: impl Connector,
        control: &Control,
    ) -> Result<(), Failure> {
        if !super::diagnostics::in_domain() {
            return Err(Failure::DomainFailed);
        }
        tokio::pin!(maps);
        let mut first = tokio::select! { biased;
            _ = self.cancelled.cancelled() => return Err(Failure::Cancelled),
            update = maps.next() => update.ok_or(Failure::DomainFailed)?,
        };
        if first.pop_browser_url.is_some() {
            return Err(Failure::DomainFailed);
        }
        let local = first.node.take().ok_or(Failure::DomainFailed)?;
        let (driver, mut port) = Driver::new(self.cancelled.clone());
        let ready = port.ready.take().ok_or(Failure::DomainFailed)?;
        let mut core = Core::new(keys, local, port)?;
        core.update(first)?;
        let trace = Trace::current().fork();
        let driver = trace.clone().scope(driver.run(connector));
        self.serve(
            core,
            maps,
            driver,
            RelaySignals {
                ready,
                changed: None,
                trace,
            },
            control,
            |core, update| update.map_or(Ok(()), |update| core.update(update)),
        )
        .await
    }

    pub(super) async fn registered<D: super::regional_relay::Dial>(
        self,
        registration: Registration,
        client: Http2<BytesBody>,
        dial: D,
        control: &Control,
    ) -> Result<(), Failure> {
        if !super::diagnostics::in_domain() {
            return Err(Failure::DomainFailed);
        }
        let maps = registration.maps(&client).await?;
        tokio::pin!(maps);
        super::diagnostics::Stage::MapResponse.record();
        let mut first = evidence::observe(Stage::MapRead, async {
            maps.next().await.ok_or(Failure::DomainFailed)
        })
        .await?;
        Trace::current().set(
            Stage::MapDecode,
            evidence::Status::Passed,
            Detail::NotExposed,
        );
        if first.pop_browser_url.is_some() {
            evidence::failed(Stage::MapAuthority, Detail::AuthenticationRequired);
            return Err(Failure::DomainFailed);
        }
        let local = evidence::check(Stage::LocalNode, || {
            first.node.take().ok_or(Failure::DomainFailed)
        })?;
        let keys = registration.keys().node_keys.clone();
        super::diagnostics::Stage::DerpMap.record();
        let map = evidence::check(Stage::DerpMap, || {
            first.derp.take().ok_or(Failure::DomainFailed)
        })?;
        let regions = map.keys().copied().collect();
        let (driver, mut port, routes, home) = evidence::check(Stage::DerpMap, || {
            super::regional_driver::RegionalDriver::new(
                keys.clone(),
                self.cancelled.clone(),
                map,
                local.derp_region,
                dial,
            )
        })?;
        let ready = port.ready.take().ok_or(Failure::DomainFailed)?;
        super::diagnostics::Stage::LocalNode.record();
        let mut core = evidence::check(Stage::LocalNode, || Core::new(keys, local, port))?;
        core.set_regions(home, regions);
        super::diagnostics::Stage::Peers.record();
        evidence::check(Stage::Peers, || core.update(first))?;
        evidence::check(Stage::Peers, || routes.update(None, core.relay_peers()))?;
        registration.announce_home(&client, home).await?;
        let changed = routes.changed();
        super::diagnostics::Stage::Relay.record();
        let trace = Trace::current().fork();
        self.serve(
            core,
            maps,
            trace.clone().scope(driver.run()),
            RelaySignals {
                ready,
                changed: Some(&changed),
                trace,
            },
            control,
            move |core, update| {
                let map = if let Some(mut update) = update {
                    let map = update.derp.take();
                    evidence::check(Stage::Peers, || core.update(update))?;
                    map
                } else {
                    None
                };
                evidence::check(Stage::DerpMap, || routes.update(map, core.relay_peers()))?;
                core.set_regions(home, routes.available());
                routes.update(None, core.relay_peers())
            },
        )
        .await
    }

    async fn serve(
        mut self,
        mut core: Core,
        maps: impl MapStream<Item = StateUpdate>,
        driver: impl Future<Output = Result<(), Failure>>,
        signals: RelaySignals<'_>,
        control: &Control,
        mut update_core: impl FnMut(&mut Core, Option<StateUpdate>) -> Result<(), Failure>,
    ) -> Result<(), Failure> {
        tokio::pin!(maps);
        tokio::pin!(driver);
        let RelaySignals {
            mut ready,
            changed,
            trace,
        } = signals;
        let source = Trace::current();
        let mut announced = false;
        let mut completing = FuturesUnordered::<Completing>::new();
        let result = async {
            loop {
                if self.cancelled.is_cancelled() {
                    return Err(Failure::Cancelled);
                }
                // No branch awaits work that requires another branch to progress.
                // Map changes and cancellation remain live during relay/bridge IO.
                tokio::select! {
                    _ = self.cancelled.cancelled() => return Err(Failure::Cancelled),
                    result = &mut driver => {
                        if result.is_err() { source.adopt(&trace); source.root(Boundary::Relay); }
                        return result;
                    },
                    _ = async {
                        if let Some(changed) = changed { changed.notified().await; }
                        else { std::future::pending::<()>().await; }
                    } => {},
                    result = &mut ready, if !announced => {
                        result.map_err(|_| { source.root(Boundary::Readiness); Failure::DomainFailed })?;
                        announced = true;
                        // Carrier readiness precedes each host's SSH trust and login.
                        super::diagnostics::Stage::Ready.record();
                        control.ready();
                    }
                    update = maps.next() => {
                        let update = update.ok_or_else(|| { source.root(Boundary::MapStream); evidence::failed(Stage::MapRead, Detail::NotExposed); Failure::DomainFailed })?;
                        source.set(Stage::MapRead, evidence::Status::Passed, Detail::NotExposed);
                        source.set(Stage::MapDecode, evidence::Status::Passed, Detail::NotExposed);
                        if update.pop_browser_url.is_some() { source.root(Boundary::MapStream); evidence::failed(Stage::MapAuthority, Detail::AuthenticationRequired); return Err(Failure::DomainFailed); }
                        update_core(&mut core, Some(update)).inspect_err(|_| source.root(Boundary::MapStream))?;
                    }
                    command = self.commands.recv(), if completing.len() < CONNECTIONS => {
                        let mut command = command.ok_or(Failure::Cancelled)?;
                        if command.answer.is_closed() || command.cancelled.is_cancelled() {
                            command.cancelled.cancel();
                        } else { match command.trace.sync(|| core.dial(&command.target, command.port, command.cancelled.clone(), command.lease.take())) {
                            Err(failure) => { let _ = command.answer.send(Err(failure)); }
                            Ok(response) => {
                                completing.push(Box::pin(async move {
                                    tokio::select! { biased;
                                        _ = command.answer.closed() => {},
                                        result = response => {
                                            let _ = command.answer.send(result.unwrap_or(Err(Failure::Cancelled)));
                                        }
                                    }
                                }));
                            }
                        }
                        }
                    }
                    _ = completing.next(), if !completing.is_empty() => {},
                    result = core.wait() => { result.inspect_err(|_| source.root(Boundary::DataPlane))?; },
                }
                update_core(&mut core, None).inspect_err(|_| source.root(Boundary::DataPlane))?;
                // Public synchronous SDK work and immediately ready map/dial work
                // must return control to the runtime between bounded owner turns.
                tokio::task::yield_now().await;
            }
        }
        .await;
        if let Err(failure) = result {
            // Keep source publication ahead of Core Drop: retiring a binding
            // can otherwise retire VNC consumers and disable their observers.
            control.record_failure(failure);
        }
        result
    }
}
