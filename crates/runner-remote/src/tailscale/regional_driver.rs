//! At most eight retained regional relay owners and one aggregate receive bound.

use std::{
    cell::RefCell,
    collections::{BTreeMap, HashMap, HashSet},
    future::Future,
    pin::Pin,
    rc::Rc,
    sync::Arc,
};

use futures_util::{StreamExt, stream::FuturesUnordered};
use tokio::sync::{Notify, Semaphore, mpsc, oneshot};
use tokio_util::sync::CancellationToken;
use ts_control::{DerpMap, DerpRegion};
use ts_derp::RegionId;
use ts_keys::{NodeKeyPair, NodePublicKey};

use super::{
    Failure,
    peers::Outbound,
    regional_relay::{Dial, Regional},
    relay_driver::{Driver, Incoming, Port},
};

const OWNERS: usize = 8;
type Completing =
    Pin<Box<dyn Future<Output = (RegionId, Result<(), Failure>, super::evidence::Trace)>>>;

struct State {
    home: RegionId,
    map: DerpMap,
    peers: HashMap<NodePublicKey, RegionId>,
    active: BTreeMap<RegionId, CancellationToken>,
    failed: HashSet<RegionId>,
    evidence: BTreeMap<RegionId, super::evidence::Trace>,
    changed: Rc<Notify>,
}

#[derive(Clone)]
pub(super) struct Routes(Rc<RefCell<State>>);

impl Routes {
    pub(super) fn evidence(&self, id: RegionId) -> super::evidence::Trace {
        let current = super::evidence::Trace::current();
        if current.id().is_none() {
            return current;
        }
        self.0
            .borrow_mut()
            .evidence
            .entry(id)
            .or_insert_with(|| {
                let trace = current.fork();
                trace.region(id.0.get());
                trace
            })
            .clone()
    }
    pub(super) fn changed(&self) -> Rc<Notify> {
        Rc::clone(&self.0.borrow().changed)
    }

    pub(super) fn available(&self) -> Vec<RegionId> {
        let state = self.0.borrow();
        state
            .map
            .keys()
            .filter(|id| !state.failed.contains(id))
            .copied()
            .collect()
    }

    pub(super) fn update(
        &self,
        map: Option<DerpMap>,
        peers: Vec<(NodePublicKey, Option<RegionId>)>,
    ) -> Result<(), Failure> {
        let mut state = self.0.borrow_mut();
        if let Some(map) = map {
            validate(&map)?;
            if !eligible_home(map.get(&state.home)) {
                return Err(Failure::DomainFailed);
            }
            // Seal actual old IO synchronously before publishing replacement
            // server authority. Its task/queues still count until physical Drop.
            for (id, cancelled) in &state.active {
                if state.map.get(id) != map.get(id) {
                    cancelled.cancel();
                }
            }
            let changed = state
                .failed
                .iter()
                .copied()
                .filter(|id| state.map.get(id) != map.get(id))
                .collect::<Vec<_>>();
            for id in changed {
                state.failed.remove(&id);
            }
            state.failed.retain(|id| map.contains_key(id));
            state.map = map;
        }
        if peers.len() > 256 {
            return Err(Failure::DomainFailed);
        }
        state.peers.clear();
        for (key, region) in peers {
            if let Some(region) = region
                && (!state.map.contains_key(&region) || state.peers.insert(key, region).is_some())
            {
                return Err(Failure::DomainFailed);
            }
        }
        for (id, cancelled) in &state.active {
            if *id != state.home && !state.peers.values().any(|region| region == id) {
                cancelled.cancel();
            }
        }
        if !state.evidence.is_empty() {
            let needed: HashSet<_> = state
                .active
                .keys()
                .copied()
                .chain(state.peers.values().copied())
                .chain(std::iter::once(state.home))
                .collect();
            state.evidence.retain(|id, _| needed.contains(id));
        }
        Ok(())
    }
}

fn eligible_home(region: Option<&DerpRegion>) -> bool {
    region.is_some_and(|region| {
        !region.info.no_measure_no_home
            && region.servers.iter().any(|server| {
                !server.stun_only
                    && (server.ipv4 != ts_derp::IpUsage::Disable
                        || server.ipv6 != ts_derp::IpUsage::Disable)
            })
    })
}

fn validate(map: &DerpMap) -> Result<(), Failure> {
    if map.is_empty()
        || map.len() > 128
        || map.values().any(|region| {
            region.servers.len() > 8 || region.info.name.len() > 128 || region.info.code.len() > 32
        })
    {
        return Err(Failure::DomainFailed);
    }
    for server in map.values().flat_map(|region| &region.servers) {
        let ts_derp::TlsValidationConfig::CommonName { common_name } =
            &server.tls_validation_config
        else {
            return Err(Failure::DomainFailed);
        };
        if !super::region_map::hostname(&server.hostname)
            || !super::region_map::hostname(common_name)
            || server.https_port == 0
        {
            return Err(Failure::DomainFailed);
        }
    }
    Ok(())
}

pub(super) struct RegionalDriver<D> {
    routes: Routes,
    outgoing: mpsc::Receiver<Outbound>,
    incoming: mpsc::Sender<Incoming>,
    receive_budget: Arc<Semaphore>,
    sending: BTreeMap<RegionId, mpsc::Sender<Outbound>>,
    jobs: FuturesUnordered<Completing>,
    keys: NodeKeyPair,
    cancelled: CancellationToken,
    ready: Option<oneshot::Sender<()>>,
    dial: D,
}

impl<D: Dial> RegionalDriver<D> {
    pub(super) fn new(
        keys: NodeKeyPair,
        cancelled: CancellationToken,
        map: DerpMap,
        preferred: Option<RegionId>,
        dial: D,
    ) -> Result<(Self, Port, Routes, RegionId), Failure> {
        if !super::diagnostics::in_domain() {
            return Err(Failure::DomainFailed);
        }
        validate(&map)?;
        let home = preferred
            .filter(|id| eligible_home(map.get(id)))
            .or_else(|| {
                map.iter()
                    .find(|(_, region)| eligible_home(Some(region)))
                    .map(|(id, _)| *id)
            })
            .ok_or(Failure::DomainFailed)?;
        let routes = Routes(Rc::new(RefCell::new(State {
            home,
            map,
            peers: HashMap::new(),
            active: BTreeMap::new(),
            failed: HashSet::new(),
            evidence: BTreeMap::new(),
            changed: Rc::new(Notify::new()),
        })));
        let (driver, port) = Driver::new(cancelled.clone());
        let Driver {
            outgoing,
            incoming,
            receive_budget,
            ready,
            ..
        } = driver;
        Ok((
            Self {
                routes: routes.clone(),
                outgoing,
                incoming,
                receive_budget,
                sending: BTreeMap::new(),
                jobs: FuturesUnordered::new(),
                keys,
                cancelled,
                ready,
                dial,
            },
            port,
            routes,
            home,
        ))
    }

    fn ensure(&mut self, id: RegionId) -> Result<bool, Failure> {
        let trace = self.routes.evidence(id);
        let mut state = self.routes.0.borrow_mut();
        if state.failed.contains(&id) {
            return Ok(false);
        }
        if let Some(cancelled) = state.active.get(&id) {
            return Ok(!cancelled.is_cancelled());
        }
        if self.jobs.len() >= OWNERS {
            return Err(Failure::ResourceExhausted);
        }
        let region = state.map.get(&id).ok_or(Failure::DomainFailed)?;
        let servers = region.servers.clone();
        let cancelled = self.cancelled.child_token();
        let connector = Regional {
            servers,
            keys: self.keys.clone(),
            cancelled: cancelled.clone(),
            dial: self.dial.clone(),
        };
        let (driver, sender, ready) = Driver::regional(
            cancelled.clone(),
            self.incoming.clone(),
            Arc::clone(&self.receive_budget),
        );
        let announce = if id == state.home {
            self.ready.take()
        } else {
            None
        };
        state.active.insert(id, cancelled);
        self.sending.insert(id, sender);
        trace.replace(&trace.fork());
        trace.region(id.0.get());
        self.jobs.push(Box::pin(async move {
            let result = trace
                .clone()
                .scope(async move {
                    let run = driver.run(connector);
                    tokio::pin!(run);
                    if let Some(announce) = announce {
                        tokio::select! { biased;
                            result = &mut run => return result,
                            connected = ready => {
                                if connected.is_err() { return Err(Failure::DomainFailed); }
                                let _ = announce.send(());
                            }
                        }
                    }
                    run.await
                })
                .await;
            (id, result, trace)
        }));
        Ok(true)
    }

    pub(super) async fn run(mut self) -> Result<(), Failure> {
        loop {
            let home = self.routes.0.borrow().home;
            self.ensure(home)?;
            tokio::select! { biased;
                _ = self.cancelled.cancelled() => return Err(Failure::Cancelled),
                outcome = self.jobs.next(), if !self.jobs.is_empty() => {
                    let (id, result, trace) = outcome.ok_or(Failure::DomainFailed)?;
                    let cancelled = self.routes.0.borrow_mut().active.remove(&id).ok_or(Failure::DomainFailed)?;
                    self.sending.remove(&id);
                    // Old SDK client/TLS/raw socket have been dropped within
                    // this completed job before its regional slot is reused.
                    if !cancelled.is_cancelled() {
                        if id == home { super::evidence::Trace::current().adopt(&trace); return result.and(Err(Failure::DomainFailed)); }
                        let mut state = self.routes.0.borrow_mut();
                        state.failed.insert(id);
                        state.changed.notify_one();
                    }
                }
                packet = self.outgoing.recv() => {
                    let packet = packet.ok_or(Failure::Cancelled)?;
                    if !packet.stamp.current() { continue; }
                    let id = self.routes.0.borrow().peers.get(&packet.destination).copied().ok_or(Failure::DomainFailed)?;
                    if !self.ensure(id)? { continue; }
                    self.sending.get(&id).ok_or(Failure::DomainFailed)?.try_send(packet).map_err(|error| match error {
                        mpsc::error::TrySendError::Full(_) => Failure::ResourceExhausted,
                        mpsc::error::TrySendError::Closed(_) => Failure::Cancelled,
                    })?;
                }
            }
        }
    }
}
