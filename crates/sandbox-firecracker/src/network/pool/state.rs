use std::collections::{HashSet, VecDeque};
#[cfg(test)]
use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use futures_util::future::join_all;
use tokio::sync::watch;
use tracing::{error, info, warn};

use crate::paths::LockPaths;

use super::super::error::{NetworkError, Result};
#[cfg(test)]
use super::super::readiness::DnsReadinessError;
use super::super::readiness::{
    DNS_READINESS_OPERATION_TIMEOUT, DnsReadinessProbe, production_dns_readiness_probe,
    run_dns_readiness_probe,
};
use super::completion::{
    CreationCompletion, CreationCompletionCoordinator, CreationNotifier, NetnsKind, PendingId,
    PreparedCreationWait, spawn_creation_worker,
};
use super::firewall::setup_dns_input_filter;
#[cfg(test)]
use super::host::ConntrackFlushOutcome;
use super::host::{
    NetnsLifecycleOps, PoolIndexLock, acquire_pool_lock, create_single_namespace,
    enable_host_ip_forwarding, get_default_interface, reconcile_orphan_namespaces,
};
use super::naming::{MAX_NAMESPACES, format_hex_index, make_host_device_dnsmasq_pattern};
use super::types::{
    CheckedNetnsPoolConfig, NamespaceDeleteOutcome, NetnsInfo, NetnsLease, NetnsPoolConfig,
    NetnsReleaseOutcome,
};

const BUFFER_SIZE: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DnsReadinessState {
    NotRequired,
    Pending,
    Activating,
    Ready,
}

struct DnsActivationPlan {
    candidates: Vec<NetnsInfo>,
    probe: DnsReadinessProbe,
    timeout: Duration,
    ops: NetnsLifecycleOps,
}

/// Monotonic in-process identity for [`NetnsPool`] instances.
static NEXT_NETNS_POOL_INSTANCE_ID: AtomicU64 = AtomicU64::new(1);

fn next_pool_instance_id() -> u64 {
    NEXT_NETNS_POOL_INSTANCE_ID.fetch_add(1, Ordering::Relaxed)
}

#[derive(Clone)]
struct NetnsPoolInner {
    state: Arc<tokio::sync::Mutex<NetnsPoolState>>,
}

/// Pre-warmed pool of network namespaces for Firecracker VMs.
///
/// `BUFFER_SIZE` is the warm/refill target for the active queue selected by
/// [`NetnsPoolConfig`]. Without a proxy port, the active queue is the plain
/// queue; with a proxy port, it is the proxy queue. After each
/// [`acquire`](Self::acquire), the pool spawns background tasks as needed to
/// replenish the active queue.
///
/// The active queue is intentionally a bounded high-water cache, not a strict
/// idle cap. Namespaces returned via [`release`](Self::release) are recycled
/// only when they remain safe to reuse; otherwise release attempts to delete
/// them. A successful release therefore does not necessarily restore warm
/// capacity. Safe recycling and completed background creation can both add
/// ready entries after a burst, so the queue may exceed `BUFFER_SIZE` until
/// pool cleanup/shutdown or until the entries are acquired again.
/// `MAX_NAMESPACES` remains the hard per-pool allocation bound; namespace
/// indexes are allocated monotonically and are not returned to a reusable pool.
pub struct NetnsPool {
    inner: NetnsPoolInner,
}

#[derive(Clone)]
pub(crate) struct NetnsPoolHandle {
    inner: NetnsPoolInner,
}

enum AcquirePlan {
    Ready(NetnsLease),
    Delete(Vec<NetnsInfo>, NetnsLifecycleOps),
    Wait(watch::Receiver<()>),
}

struct ReleasePlan {
    info: NetnsInfo,
    kind: NetnsKind,
    reusable_at_prepare: bool,
    ops: NetnsLifecycleOps,
}

struct CleanupPlan {
    namespaces: Vec<NetnsInfo>,
    ops: NetnsLifecycleOps,
    wait_for_pending: Option<watch::Receiver<()>>,
    dns_input_filter_comment: Option<String>,
    done: bool,
}

// ---------------------------------------------------------------------------
// NetnsPool
// ---------------------------------------------------------------------------

/// Mutable state behind the namespace pool lifecycle.
struct NetnsPoolState {
    active: bool,
    plain_queue: VecDeque<NetnsInfo>,
    proxy_queue: VecDeque<NetnsInfo>,
    /// In-flight background namespace creation tasks (plain).
    pending_plain: HashSet<PendingId>,
    /// In-flight background namespace creation tasks (proxy).
    pending_proxy: HashSet<PendingId>,
    completion: CreationCompletionCoordinator,
    /// Namespaces checked out from this pool instance.
    in_flight: HashSet<String>,
    /// In-flight namespaces that must be deleted instead of reused.
    non_reusable: HashSet<String>,
    instance_id: u64,
    next_pending_id: u64,
    next_ns_index: u32,
    pool_index: u32,
    proxy_port: Option<u16>,
    dns_port: Option<u16>,
    dns_readiness_state: DnsReadinessState,
    dns_readiness_probe: DnsReadinessProbe,
    dns_readiness_timeout: Duration,
    /// Comment shared by the pool-wide IPv4/IPv6 DNS INPUT rules.
    ///
    /// Cleanup keeps this ownership marker until the bounded firewall delete
    /// completes so cancellation cannot silently orphan the rules.
    dns_input_filter_comment: Option<String>,
    /// Background creation failure retained until no ready entry can satisfy an acquire.
    creation_failure: Option<NetworkError>,
    default_iface: String,
    ops: NetnsLifecycleOps,
    #[cfg(test)]
    acquire_waiting_notify: Option<Arc<tokio::sync::Notify>>,
    /// Shared with creation workers and reporters until their cleanup finishes.
    index_lock: Arc<PoolIndexLock>,
}

impl NetnsPoolState {
    #[cfg(test)]
    pub(crate) fn inactive_for_test() -> Self {
        let file = tempfile::tempfile().expect("create test netns pool lock file");
        let lock = match PoolIndexLock::try_lock(file) {
            Ok(lock) => lock,
            Err((_, errno)) => panic!("lock test netns pool file: {errno}"),
        };
        Self {
            active: false,
            plain_queue: VecDeque::new(),
            proxy_queue: VecDeque::new(),
            pending_plain: HashSet::new(),
            pending_proxy: HashSet::new(),
            completion: CreationCompletionCoordinator::new(),
            in_flight: HashSet::new(),
            non_reusable: HashSet::new(),
            instance_id: next_pool_instance_id(),
            next_pending_id: 0,
            next_ns_index: 0,
            pool_index: 0,
            proxy_port: None,
            dns_port: None,
            dns_readiness_state: DnsReadinessState::NotRequired,
            dns_readiness_probe: production_dns_readiness_probe(),
            dns_readiness_timeout: DNS_READINESS_OPERATION_TIMEOUT,
            dns_input_filter_comment: None,
            creation_failure: None,
            default_iface: "test0".into(),
            ops: NetnsLifecycleOps::trusted_for_test(),
            acquire_waiting_notify: None,
            index_lock: Arc::new(lock),
        }
    }

    #[cfg(test)]
    pub(crate) fn track_lease_for_test(&mut self, lease: &NetnsLease) {
        self.in_flight.insert(lease.name().to_string());
    }

    #[cfg(test)]
    pub(crate) fn lease_for_test(&self, name: &str) -> NetnsLease {
        NetnsLease::new(
            NetnsInfo::new(name.into(), "test-ve".into(), "10.200.0.2".into()),
            self.instance_id,
        )
    }

    async fn create_checked(config: CheckedNetnsPoolConfig) -> Result<Self> {
        let CheckedNetnsPoolConfig { inner: config } = config;
        let lock_paths = LockPaths::new();
        let (index, lock) = acquire_pool_lock(&lock_paths)?;

        info!(index, buffer = BUFFER_SIZE, "initializing namespace pool");

        // Enable host-level IP forwarding (idempotent, needed once per host).
        enable_host_ip_forwarding().await?;

        // Reconcile orphans from our own index and any idle pool index.
        // This is the correctness guarantee for kernel-side cleanup —
        // `NetnsPool::cleanup` is best-effort and cannot survive SIGKILL,
        // panic, OOM, or aborted in-flight creation tasks (issue #10625).
        reconcile_orphan_namespaces(&lock_paths, index, &lock).await;

        let default_iface = get_default_interface().await?;
        let dns_input_filter_comment = match config.dns_port {
            Some(dns_port) => Some(setup_dns_input_filter(index, dns_port).await?),
            None => None,
        };
        let mut pool = Self {
            active: true,
            plain_queue: VecDeque::with_capacity(BUFFER_SIZE),
            proxy_queue: VecDeque::with_capacity(if config.proxy_port.is_some() {
                BUFFER_SIZE
            } else {
                0
            }),
            pending_plain: HashSet::new(),
            pending_proxy: HashSet::new(),
            completion: CreationCompletionCoordinator::new(),
            in_flight: HashSet::new(),
            non_reusable: HashSet::new(),
            instance_id: next_pool_instance_id(),
            next_pending_id: 0,
            next_ns_index: 0,
            pool_index: index,
            proxy_port: config.proxy_port,
            dns_port: config.dns_port,
            dns_readiness_state: if config.dns_port.is_some() && config.proxy_port.is_some() {
                DnsReadinessState::Pending
            } else {
                DnsReadinessState::NotRequired
            },
            dns_readiness_probe: production_dns_readiness_probe(),
            dns_readiness_timeout: DNS_READINESS_OPERATION_TIMEOUT,
            dns_input_filter_comment,
            creation_failure: None,
            default_iface,
            ops: NetnsLifecycleOps::default(),
            #[cfg(test)]
            acquire_waiting_notify: None,
            index_lock: Arc::new(lock),
        };

        // Pre-warm the buffer. Warm-up starts at ns_index 0, so
        // `reconcile_orphan_namespaces` above MUST have finished
        // synchronously — otherwise `vm0-ns-{own}-00` may still exist from
        // a previous runner and `ip netns add` will fail with EEXIST.
        pool.spawn_initial_warmup();
        pool.drain_initial_warmup().await;

        info!(
            plain = pool.plain_queue.len(),
            proxy = pool.proxy_queue.len(),
            buffer = BUFFER_SIZE,
            "namespace pool initialized"
        );
        Ok(pool)
    }

    fn reserve_ns_index(&mut self) -> Result<u32> {
        let ns_index = self.next_ns_index;
        if ns_index >= MAX_NAMESPACES {
            return Err(NetworkError::NamespaceLimitReached {
                max: MAX_NAMESPACES,
            });
        }
        self.next_ns_index += 1;
        Ok(ns_index)
    }

    fn reserve_pending_id(&mut self) -> PendingId {
        let id = PendingId(self.next_pending_id);
        self.next_pending_id += 1;
        id
    }

    fn host_device_pattern(&self) -> String {
        let pool_idx = format_hex_index(self.pool_index);
        make_host_device_dnsmasq_pattern(&pool_idx)
    }

    fn creation_notifier(&self) -> CreationNotifier {
        self.completion.notifier(self.ops.clone())
    }

    fn spawn_plain_creation(&mut self) -> Result<()> {
        self.spawn_creation(NetnsKind::Plain)
    }

    fn spawn_proxy_creation(&mut self) -> Result<()> {
        self.spawn_creation(NetnsKind::Proxy)
    }

    fn spawn_creation_for_kind(&mut self, kind: NetnsKind) -> Result<()> {
        match kind {
            NetnsKind::Plain => self.spawn_plain_creation(),
            NetnsKind::Proxy => self.spawn_proxy_creation(),
        }
    }

    fn spawn_initial_warmup(&mut self) {
        if BUFFER_SIZE == 0 {
            return;
        }

        // Plain namespaces (connectivity only). Only needed when proxy
        // is disabled; with proxy configured, `acquire()` always routes
        // to the proxy queue, so plain entries would be unreachable
        // until `cleanup()`.
        if self.proxy_port.is_none() {
            for _ in 0..BUFFER_SIZE {
                if let Err(e) = self.spawn_plain_creation() {
                    warn!(error = %e, "failed to start initial namespace creation");
                    break;
                }
            }
        }

        // Proxy namespaces (connectivity + REDIRECT rules).
        if self.proxy_port.is_some() {
            for _ in 0..BUFFER_SIZE {
                if let Err(e) = self.spawn_proxy_creation() {
                    warn!(error = %e, "failed to start initial proxy namespace creation");
                    break;
                }
            }
        }
    }

    async fn drain_initial_warmup(&mut self) {
        loop {
            let (delete, mut waiter) =
                if self.pending_plain.is_empty() && self.pending_proxy.is_empty() {
                    (self.drain_completed(true), None)
                } else {
                    let (delete, waiter) = self.prepare_completion_wait(true);
                    (delete, Some(waiter))
                };
            if !delete.is_empty() {
                delete_namespaces_with_ops(self.ops.clone(), delete).await;
            }
            if self.pending_plain.is_empty() && self.pending_proxy.is_empty() {
                return;
            }

            let Some(waiter) = waiter.as_mut() else {
                continue;
            };
            if waiter.changed().await.is_err() {
                warn!("namespace creation notifier closed during initial warmup");
                return;
            }
        }
    }

    fn prepare_dns_activation(&mut self) -> Result<Option<DnsActivationPlan>> {
        if !self.active {
            return Err(NetworkError::PoolNotActive);
        }
        match self.dns_readiness_state {
            DnsReadinessState::NotRequired | DnsReadinessState::Ready => Ok(None),
            DnsReadinessState::Activating => Err(NetworkError::PoolDnsNotReady),
            DnsReadinessState::Pending => {
                self.dns_readiness_state = DnsReadinessState::Activating;
                Ok(Some(DnsActivationPlan {
                    candidates: self.proxy_queue.iter().cloned().collect(),
                    probe: Arc::clone(&self.dns_readiness_probe),
                    timeout: self.dns_readiness_timeout,
                    ops: self.ops.clone(),
                }))
            }
        }
    }

    fn commit_dns_activation(
        &mut self,
        failed_names: &HashSet<String>,
        successful: usize,
    ) -> Result<()> {
        if !self.active {
            return Err(NetworkError::PoolNotActive);
        }
        if !matches!(self.dns_readiness_state, DnsReadinessState::Activating) {
            return Err(NetworkError::PoolDnsNotReady);
        }

        self.remove_queued_namespaces(failed_names);
        if successful == 0 {
            self.dns_readiness_state = DnsReadinessState::Pending;
            return Err(NetworkError::NoDnsReadyNamespaces);
        }

        self.dns_readiness_state = DnsReadinessState::Ready;
        self.creation_failure = None;
        self.maybe_replenish_kind(NetnsKind::Proxy);
        Ok(())
    }

    fn spawn_creation(&mut self, kind: NetnsKind) -> Result<()> {
        let ns_index = self.reserve_ns_index()?;
        let pool_index = self.pool_index;
        let default_iface = self.default_iface.clone();
        let (proxy_port, dns_port) = match kind {
            NetnsKind::Plain => (None, None),
            NetnsKind::Proxy => {
                let Some(proxy_port) = self.proxy_port else {
                    return Err(NetworkError::Prerequisite(
                        "proxy namespace requested without proxy port".into(),
                    ));
                };
                (Some(proxy_port), self.dns_port)
            }
        };
        let id = self.reserve_pending_id();
        self.pending_set_mut(kind).insert(id);
        let readiness = if matches!(kind, NetnsKind::Proxy)
            && matches!(self.dns_readiness_state, DnsReadinessState::Ready)
        {
            Some((
                Arc::clone(&self.dns_readiness_probe),
                self.dns_readiness_timeout,
            ))
        } else {
            None
        };
        let ops = self.ops.clone();
        spawn_creation_worker(
            id,
            kind,
            Arc::clone(&self.index_lock),
            self.creation_notifier(),
            create_namespace_with_readiness(
                create_single_namespace(pool_index, ns_index, default_iface, proxy_port, dns_port),
                readiness,
                ops,
            ),
        );
        Ok(())
    }

    #[cfg(test)]
    fn spawn_plain_creation_for_test<F>(&mut self, future: F)
    where
        F: Future<Output = Result<NetnsInfo>> + Send + 'static,
    {
        let id = self.reserve_pending_id();
        self.pending_plain.insert(id);
        spawn_creation_worker(
            id,
            NetnsKind::Plain,
            Arc::clone(&self.index_lock),
            self.creation_notifier(),
            future,
        );
    }

    #[cfg(test)]
    fn spawn_proxy_creation_for_test<F>(&mut self, future: F)
    where
        F: Future<Output = Result<NetnsInfo>> + Send + 'static,
    {
        let id = self.reserve_pending_id();
        self.pending_proxy.insert(id);
        let readiness = if matches!(self.dns_readiness_state, DnsReadinessState::Ready) {
            Some((
                Arc::clone(&self.dns_readiness_probe),
                self.dns_readiness_timeout,
            ))
        } else {
            None
        };
        spawn_creation_worker(
            id,
            NetnsKind::Proxy,
            Arc::clone(&self.index_lock),
            self.creation_notifier(),
            create_namespace_with_readiness(future, readiness, self.ops.clone()),
        );
    }

    #[cfg(test)]
    fn reserve_pending_creation_for_test(&mut self, kind: NetnsKind) -> Result<()> {
        self.reserve_ns_index()?;
        let id = self.reserve_pending_id();
        self.pending_set_mut(kind).insert(id);
        Ok(())
    }

    fn checkout_or_requeue(&mut self, info: NetnsInfo, kind: NetnsKind) -> Result<NetnsLease> {
        let name = info.name.clone();
        match self.checkout(info) {
            Ok(lease) => Ok(lease),
            Err(info) => {
                warn!(
                    name = %name,
                    has_proxy = matches!(kind, NetnsKind::Proxy),
                    "namespace is already checked out; returning metadata to queue"
                );
                self.target_queue_mut(kind).push_front(info);
                Err(NetworkError::InvalidLease(format!(
                    "namespace {name} is already checked out"
                )))
            }
        }
    }

    fn checkout(&mut self, info: NetnsInfo) -> std::result::Result<NetnsLease, NetnsInfo> {
        if !self.in_flight.insert(info.name.clone()) {
            return Err(info);
        }
        Ok(NetnsLease::new(info, self.instance_id))
    }

    fn drain_completed(&mut self, queue_when_inactive: bool) -> Vec<NetnsInfo> {
        let mut delete = Vec::new();
        while let Some(completion) = self.completion.try_recv() {
            self.apply_completion(completion, queue_when_inactive, &mut delete);
        }
        delete
    }

    fn prepare_completion_wait(
        &mut self,
        queue_when_inactive: bool,
    ) -> (Vec<NetnsInfo>, watch::Receiver<()>) {
        let PreparedCreationWait {
            completions,
            receiver,
        } = self.completion.prepare_wait();
        (
            self.apply_completions(completions, queue_when_inactive),
            receiver,
        )
    }

    fn apply_completions(
        &mut self,
        completions: Vec<CreationCompletion>,
        queue_when_inactive: bool,
    ) -> Vec<NetnsInfo> {
        let mut delete = Vec::new();
        for completion in completions {
            self.apply_completion(completion, queue_when_inactive, &mut delete);
        }
        delete
    }

    fn apply_completion(
        &mut self,
        completion: CreationCompletion,
        queue_when_inactive: bool,
        delete: &mut Vec<NetnsInfo>,
    ) {
        if !self.pending_set_mut(completion.kind).remove(&completion.id) {
            warn!(
                id = completion.id.0,
                kind = ?completion.kind,
                "ignoring completion for unknown namespace creation task"
            );
            if let Ok(ns) = completion.result {
                delete.push(ns);
            }
            return;
        }

        match completion.result {
            Ok(ns) if self.active || queue_when_inactive => {
                self.target_queue_mut(completion.kind).push_back(ns);
            }
            Ok(ns) => delete.push(ns),
            Err(e) => {
                error!(
                    id = completion.id.0,
                    kind = ?completion.kind,
                    error = %e,
                    "background namespace creation failed"
                );
                if !queue_when_inactive {
                    self.creation_failure = Some(e);
                }
            }
        }
    }

    fn prepare_acquire(&mut self) -> Result<AcquirePlan> {
        self.prepare_acquire_with(Self::spawn_creation_for_kind)
    }

    fn prepare_acquire_with(
        &mut self,
        mut spawn: impl FnMut(&mut Self, NetnsKind) -> Result<()>,
    ) -> Result<AcquirePlan> {
        loop {
            if !self.active {
                return Err(NetworkError::PoolNotActive);
            }
            if matches!(
                self.dns_readiness_state,
                DnsReadinessState::Pending | DnsReadinessState::Activating
            ) {
                return Err(NetworkError::PoolDnsNotReady);
            }
            let delete = self.drain_completed(false);
            if !delete.is_empty() {
                return Ok(AcquirePlan::Delete(delete, self.ops.clone()));
            }
            if let Some(lease) = self.try_checkout_ready()? {
                return Ok(AcquirePlan::Ready(lease));
            }
            if let Some(error) = self.creation_failure.take() {
                return Err(error);
            }

            let kind = self.active_kind();
            if self.pending_set(kind).is_empty() {
                spawn(self, kind)?;
            }

            let (delete, waiter) = self.prepare_completion_wait(false);
            if !delete.is_empty() {
                return Ok(AcquirePlan::Delete(delete, self.ops.clone()));
            }
            if !self.active {
                return Err(NetworkError::PoolNotActive);
            }
            if let Some(lease) = self.try_checkout_ready()? {
                return Ok(AcquirePlan::Ready(lease));
            }
            if let Some(error) = self.creation_failure.take() {
                return Err(error);
            }
            if self.pending_set(kind).is_empty() {
                continue;
            }

            #[cfg(test)]
            if let Some(notify) = &self.acquire_waiting_notify {
                notify.notify_one();
            }

            return Ok(AcquirePlan::Wait(waiter));
        }
    }

    fn try_checkout_ready(&mut self) -> Result<Option<NetnsLease>> {
        let kind = self.active_kind();
        let (pooled, queue_len_after_pop) = {
            let queue = self.target_queue_mut(kind);
            let pooled = queue.pop_front();
            (pooled, queue.len())
        };
        let Some(pooled) = pooled else {
            return Ok(None);
        };

        info!(
            name = %pooled.name,
            remaining = queue_len_after_pop,
            has_proxy = matches!(kind, NetnsKind::Proxy),
            "acquired namespace"
        );
        let lease = self.checkout_or_requeue(pooled, kind)?;
        self.maybe_replenish_kind(kind);
        Ok(Some(lease))
    }

    fn active_kind(&self) -> NetnsKind {
        if self.proxy_port.is_some() {
            NetnsKind::Proxy
        } else {
            NetnsKind::Plain
        }
    }

    fn maybe_replenish_kind(&mut self, kind: NetnsKind) {
        self.replenish_kind_with(kind, Self::spawn_creation_for_kind);
    }

    fn replenish_kind_with(
        &mut self,
        kind: NetnsKind,
        mut spawn: impl FnMut(&mut Self, NetnsKind) -> Result<()>,
    ) {
        if matches!(kind, NetnsKind::Proxy) && self.proxy_port.is_none() {
            return;
        }
        while self.target_queue(kind).len() + self.pending_set(kind).len() < BUFFER_SIZE {
            if self.next_ns_index >= MAX_NAMESPACES {
                return;
            }
            if let Err(e) = spawn(self, kind) {
                warn!(kind = ?kind, error = %e, "failed to replenish namespace pool");
                return;
            }
        }
    }

    fn prepare_release(
        &self,
        lease: &Option<NetnsLease>,
    ) -> std::result::Result<ReleasePlan, String> {
        let Some(active_lease) = lease.as_ref() else {
            return Err("missing netns lease".into());
        };
        if active_lease.pool_instance_id() != self.instance_id {
            warn!(
                name = %active_lease.name(),
                lease_pool_instance_id = active_lease.pool_instance_id(),
                pool_instance_id = self.instance_id,
                "refusing to release netns lease from a different pool instance"
            );
            return Err(format!(
                "namespace {} belongs to pool instance {}, not {}",
                active_lease.name(),
                active_lease.pool_instance_id(),
                self.instance_id
            ));
        }
        if !self.in_flight.contains(active_lease.name()) {
            warn!(
                name = %active_lease.name(),
                pool_instance_id = self.instance_id,
                "refusing to release netns lease that is not in flight"
            );
            return Err(format!(
                "namespace {} is not checked out",
                active_lease.name()
            ));
        }

        let kind = self.active_kind();
        let reusable = self.active
            && active_lease.reuse_eligible()
            && !self.non_reusable.contains(active_lease.name());
        if reusable
            && self
                .target_queue(kind)
                .iter()
                .any(|r| r.name == active_lease.name())
        {
            warn!(
                name = %active_lease.name(),
                "refusing to release netns lease already queued in pool"
            );
            return Err(format!(
                "namespace {} is already queued",
                active_lease.name()
            ));
        }

        Ok(ReleasePlan {
            info: active_lease.info().clone(),
            kind,
            reusable_at_prepare: reusable,
            ops: self.ops.clone(),
        })
    }

    fn mark_non_reusable(&mut self, plan: &ReleasePlan) {
        if self.in_flight.contains(&plan.info.name) {
            self.non_reusable.insert(plan.info.name.clone());
        }
    }

    fn commit_release_requeue(
        &mut self,
        lease: &mut Option<NetnsLease>,
        plan: &ReleasePlan,
    ) -> NetnsReleaseOutcome {
        let Some(lease) = lease.take() else {
            return NetnsReleaseOutcome::InvalidLease("validated netns lease disappeared".into());
        };
        self.in_flight.remove(lease.name());
        self.non_reusable.remove(lease.name());
        let ns = lease.into_info();

        let kind = plan.kind;
        let target_queue = self.target_queue_mut(kind);

        info!(
            name = %ns.name,
            available = target_queue.len() + 1,
            has_proxy = matches!(kind, NetnsKind::Proxy),
            "namespace released"
        );
        target_queue.push_back(ns);
        NetnsReleaseOutcome::Released
    }

    fn commit_release_delete(
        &mut self,
        lease: &mut Option<NetnsLease>,
        _plan: &ReleasePlan,
        delete: NamespaceDeleteOutcome,
    ) -> NetnsReleaseOutcome {
        let Some(lease) = lease.take() else {
            return NetnsReleaseOutcome::InvalidLease("validated netns lease disappeared".into());
        };
        self.in_flight.remove(lease.name());
        self.non_reusable.remove(lease.name());
        let ns = lease.into_info();
        match delete {
            NamespaceDeleteOutcome::Deleted => {
                info!(name = %ns.name, "namespace lease deleted instead of requeued");
                NetnsReleaseOutcome::Deleted
            }
            NamespaceDeleteOutcome::Abandoned => {
                warn!(
                    name = %ns.name,
                    host_device = %ns.host_device,
                    "namespace release abandoned after cleanup failure; startup orphan reconciliation will retry"
                );
                NetnsReleaseOutcome::Abandoned
            }
        }
    }

    fn target_queue(&self, kind: NetnsKind) -> &VecDeque<NetnsInfo> {
        match kind {
            NetnsKind::Plain => &self.plain_queue,
            NetnsKind::Proxy => &self.proxy_queue,
        }
    }

    fn target_queue_mut(&mut self, kind: NetnsKind) -> &mut VecDeque<NetnsInfo> {
        match kind {
            NetnsKind::Plain => &mut self.plain_queue,
            NetnsKind::Proxy => &mut self.proxy_queue,
        }
    }

    fn pending_set(&self, kind: NetnsKind) -> &HashSet<PendingId> {
        match kind {
            NetnsKind::Plain => &self.pending_plain,
            NetnsKind::Proxy => &self.pending_proxy,
        }
    }

    fn pending_set_mut(&mut self, kind: NetnsKind) -> &mut HashSet<PendingId> {
        match kind {
            NetnsKind::Plain => &mut self.pending_plain,
            NetnsKind::Proxy => &mut self.pending_proxy,
        }
    }

    fn prepare_cleanup(&mut self) -> CleanupPlan {
        self.active = false;
        self.creation_failure = None;
        if !self.in_flight.is_empty() {
            warn!(
                in_flight = self.in_flight.len(),
                "namespace pool cleanup with outstanding leases"
            );
        }

        let mut namespaces = self.drain_completed(true);
        let mut wait_for_pending = if self.pending_plain.is_empty() && self.pending_proxy.is_empty()
        {
            namespaces.extend(self.drain_completed(true));
            None
        } else {
            let (completed, waiter) = self.prepare_completion_wait(true);
            namespaces.extend(completed);
            Some(waiter)
        };
        if self.pending_plain.is_empty() && self.pending_proxy.is_empty() {
            wait_for_pending = None;
        }

        namespaces.extend(
            self.plain_queue
                .iter()
                .chain(self.proxy_queue.iter())
                .cloned(),
        );
        let dns_input_filter_comment = if wait_for_pending.is_none() {
            self.dns_input_filter_comment.clone()
        } else {
            None
        };
        CleanupPlan {
            done: namespaces.is_empty()
                && wait_for_pending.is_none()
                && dns_input_filter_comment.is_none(),
            namespaces,
            ops: self.ops.clone(),
            wait_for_pending,
            dns_input_filter_comment,
        }
    }

    fn commit_dns_input_filter_cleanup(&mut self, comment: &str) {
        if self.dns_input_filter_comment.as_deref() == Some(comment) {
            self.dns_input_filter_comment = None;
        }
    }

    fn remove_queued_namespaces(&mut self, names: &HashSet<String>) {
        self.plain_queue.retain(|ns| !names.contains(&ns.name));
        self.proxy_queue.retain(|ns| !names.contains(&ns.name));
    }

    #[cfg(test)]
    async fn delete_queued_namespaces_with<F, Fut>(queue: &mut VecDeque<NetnsInfo>, mut delete: F)
    where
        F: FnMut(NetnsInfo) -> Fut,
        Fut: std::future::Future<Output = ()>,
    {
        while let Some(ns) = queue.front().cloned() {
            delete(ns).await;
            queue.pop_front();
        }
    }
}

impl Drop for NetnsPoolState {
    fn drop(&mut self) {
        let queued = self.plain_queue.len() + self.proxy_queue.len();
        let pending = self.pending_plain.len() + self.pending_proxy.len();
        if self.active
            || queued != 0
            || pending != 0
            || !self.in_flight.is_empty()
            || self.dns_input_filter_comment.is_some()
        {
            warn!(
                active = self.active,
                queued,
                pending,
                in_flight = self.in_flight.len(),
                dns_input_filter = self.dns_input_filter_comment.is_some(),
                "NetnsPool dropped without calling cleanup()"
            );
        }
    }
}

impl NetnsPoolInner {
    fn new(state: NetnsPoolState) -> Self {
        Self {
            state: Arc::new(tokio::sync::Mutex::new(state)),
        }
    }

    async fn acquire(&self) -> Result<NetnsLease> {
        loop {
            let plan = {
                let mut state = self.state.lock().await;
                state.prepare_acquire()?
            };
            match plan {
                AcquirePlan::Ready(lease) => return Ok(lease),
                AcquirePlan::Delete(namespaces, ops) => {
                    delete_namespaces_with_ops(ops, namespaces).await;
                }
                AcquirePlan::Wait(mut waiter) => {
                    if waiter.changed().await.is_err() {
                        return Err(NetworkError::Prerequisite(
                            "namespace creation notifier closed".into(),
                        ));
                    }
                }
            }
        }
    }

    async fn activate_dns_readiness(&self) -> Result<()> {
        let Some(plan) = ({
            let mut state = self.state.lock().await;
            state.prepare_dns_activation()?
        }) else {
            return Ok(());
        };

        let results = join_all(plan.candidates.iter().cloned().map(|namespace| {
            let probe = Arc::clone(&plan.probe);
            async move {
                let result =
                    run_dns_readiness_probe(namespace.name.clone(), probe, plan.timeout).await;
                (namespace, result)
            }
        }))
        .await;

        let mut failed = Vec::new();
        let mut successful = 0;
        for (namespace, result) in results {
            if result.is_ok() {
                successful += 1;
            } else {
                failed.push(namespace);
            }
        }

        let failed_names = cleanup_namespace_names(&failed);
        delete_namespaces_with_ops(plan.ops, failed).await;
        let mut state = self.state.lock().await;
        state.commit_dns_activation(&failed_names, successful)?;
        info!(
            successful,
            failed = failed_names.len(),
            "namespace DNS readiness activated"
        );
        Ok(())
    }

    async fn release_outcome(&self, lease: &mut Option<NetnsLease>) -> NetnsReleaseOutcome {
        let plan = {
            let mut state = self.state.lock().await;
            let plan = match state.prepare_release(lease) {
                Ok(plan) => plan,
                Err(message) => return NetnsReleaseOutcome::InvalidLease(message),
            };
            if plan.reusable_at_prepare {
                state.mark_non_reusable(&plan);
            }
            plan
        };

        let can_requeue = if plan.reusable_at_prepare {
            (plan.ops.flush_conntrack)(plan.info.peer_ip.clone())
                .await
                .is_trusted()
        } else {
            false
        };

        if can_requeue {
            {
                let mut state = self.state.lock().await;
                if state.active {
                    return state.commit_release_requeue(lease, &plan);
                }
            }
        }

        let delete = plan
            .ops
            .delete_network_resources(vec![plan.info.clone()], None)
            .await;
        let mut state = self.state.lock().await;
        state.commit_release_delete(lease, &plan, delete)
    }

    async fn cleanup(&self) -> Result<()> {
        loop {
            let plan = {
                let mut state = self.state.lock().await;
                state.prepare_cleanup()
            };
            if plan.done {
                info!("namespace pool cleanup complete");
                return Ok(());
            }

            let names = cleanup_namespace_names(&plan.namespaces);
            let dns_input_filter_comment = plan.dns_input_filter_comment;
            let outcome = delete_network_resources_with_ops(
                plan.ops,
                plan.namespaces,
                dns_input_filter_comment.clone(),
            )
            .await;
            if let Some(comment) = &dns_input_filter_comment
                && matches!(outcome, NamespaceDeleteOutcome::Abandoned)
            {
                warn!(
                    comment,
                    "DNS input filter cleanup did not complete cleanly; startup orphan reconciliation will retry"
                );
            }
            {
                let mut state = self.state.lock().await;
                state.remove_queued_namespaces(&names);
                if let Some(comment) = &dns_input_filter_comment {
                    state.commit_dns_input_filter_cleanup(comment);
                }
            }

            if let Some(mut waiter) = plan.wait_for_pending
                && waiter.changed().await.is_err()
            {
                return Err(NetworkError::Prerequisite(
                    "namespace creation notifier closed".into(),
                ));
            }
        }
    }

    async fn host_device_pattern(&self) -> String {
        let state = self.state.lock().await;
        state.host_device_pattern()
    }

    #[cfg(test)]
    fn with_state_for_test<R>(&self, f: impl FnOnce(&mut NetnsPoolState) -> R) -> R {
        let mut state = self
            .state
            .try_lock()
            .expect("netns pool state lock should be available in test setup");
        f(&mut state)
    }
}

impl NetnsPool {
    /// Create a new pool with a pre-warmed namespace target.
    ///
    /// Pre-warms toward `BUFFER_SIZE` namespaces for the active queue at
    /// startup. Without a proxy port, this is the plain queue; with a proxy
    /// port, this is the proxy queue. After each [`acquire`](Self::acquire),
    /// the pool replenishes the same active queue toward that target.
    /// Namespaces that [`release`](Self::release) determines are safe to reuse
    /// return to that queue, so `BUFFER_SIZE` is not a strict idle cap.
    ///
    /// Automatically acquires a unique pool index (0–63) via flock. Enables
    /// host IP forwarding and reconciles orphaned resources from any idle
    /// pool index before creating new namespaces.
    /// Cancelling initialization keeps the index reserved until outstanding
    /// creation tasks and their cleanup finish.
    ///
    /// A pool configured with both proxy and DNS ports remains non-acquirable
    /// until [`Self::activate_dns_readiness`] succeeds after the DNS service
    /// starts listening.
    pub async fn create(config: NetnsPoolConfig) -> Result<Self> {
        let config = config
            .into_checked()
            .await
            .map_err(|e| NetworkError::Prerequisite(e.to_string()))?;
        Self::create_checked(config).await
    }

    pub(crate) async fn create_checked(config: CheckedNetnsPoolConfig) -> Result<Self> {
        Ok(Self {
            inner: NetnsPoolInner::new(NetnsPoolState::create_checked(config).await?),
        })
    }

    /// Acquire a namespace from the pool, or create one on-demand if empty.
    pub async fn acquire(&mut self) -> Result<NetnsLease> {
        self.inner.acquire().await
    }

    /// Validate and admit namespaces that redirect DNS to runner-managed DNS.
    ///
    /// Call this after the DNS service is listening and before the first
    /// [`Self::acquire`] when both proxy and DNS ports are configured. Pools
    /// without DNS redirect return immediately.
    pub async fn activate_dns_readiness(&self) -> Result<()> {
        self.inner.activate_dns_readiness().await
    }

    /// Release a checked-out namespace.
    ///
    /// Release requeues the namespace only when the pool is active, the lease
    /// has not been made non-reusable by an earlier cancelled release, and the
    /// conntrack flush is trusted. It attempts to delete the namespace when
    /// the pool is inactive, cleanup wins a race before commit, the conntrack
    /// flush is untrusted, or an earlier release was cancelled after cleanup
    /// began. A deletion that cannot complete is left for startup orphan
    /// reconciliation.
    ///
    /// `Ok(())` means the lease was accepted and consumed. The namespace may
    /// have been requeued, deleted, or left for orphan reconciliation after an
    /// abandoned deletion; success does not guarantee restored warm capacity
    /// or immediate deletion. An invalid lease returns an error without being
    /// consumed.
    ///
    /// The caller keeps the lease in `Some` while this future awaits. Release
    /// only takes and disarms the lease at the final no-await commit point, so
    /// cancelling this future before success leaves cleanup ownership with the
    /// caller. Once cleanup has begun, cancellation also makes the lease
    /// non-reusable, so a later release attempt deletes it instead of risking
    /// reuse.
    pub async fn release(&mut self, lease: &mut Option<NetnsLease>) -> Result<()> {
        match self.inner.release_outcome(lease).await {
            NetnsReleaseOutcome::Released
            | NetnsReleaseOutcome::Deleted
            | NetnsReleaseOutcome::Abandoned => Ok(()),
            NetnsReleaseOutcome::InvalidLease(message) => Err(NetworkError::InvalidLease(message)),
        }
    }

    /// Delete all namespaces currently in the pool queue and wait for
    /// in-flight background creation tasks so their resources can be deleted.
    ///
    /// Namespaces that have been acquired but not yet released are **not**
    /// cleaned up here — they will be caught by orphan cleanup on the next
    /// [`NetnsPool::create`] call with the same index.
    pub async fn cleanup(&mut self) -> Result<()> {
        self.inner.cleanup().await
    }

    #[cfg(test)]
    pub(crate) fn active_for_test() -> Self {
        let mut state = NetnsPoolState::inactive_for_test();
        state.active = true;
        Self::from_state_for_test(state)
    }

    #[cfg(test)]
    pub(crate) fn active_at_capacity_for_test() -> Self {
        let mut state = NetnsPoolState::inactive_for_test();
        state.active = true;
        // Acquisition can observe recycled leases without creating host netns.
        state.next_ns_index = MAX_NAMESPACES;
        Self::from_state_for_test(state)
    }

    #[cfg(test)]
    pub(crate) fn inactive_for_test() -> Self {
        Self::from_state_for_test(NetnsPoolState::inactive_for_test())
    }

    #[cfg(test)]
    fn from_state_for_test(state: NetnsPoolState) -> Self {
        Self {
            inner: NetnsPoolInner::new(state),
        }
    }

    #[cfg(test)]
    pub(crate) fn track_lease_for_test(&mut self, lease: &NetnsLease) {
        self.inner
            .with_state_for_test(|state| state.track_lease_for_test(lease));
    }

    #[cfg(test)]
    pub(crate) fn lease_for_test(&self, name: &str) -> NetnsLease {
        self.inner
            .with_state_for_test(|state| state.lease_for_test(name))
    }
}

impl NetnsPoolHandle {
    pub(crate) async fn create_checked(config: CheckedNetnsPoolConfig) -> Result<Self> {
        Ok(Self::new(NetnsPool::create_checked(config).await?))
    }

    pub(crate) fn new(pool: NetnsPool) -> Self {
        Self { inner: pool.inner }
    }

    #[cfg(test)]
    pub(crate) fn new_for_test(pool: NetnsPool) -> Self {
        Self::new(pool)
    }

    #[cfg(test)]
    pub(crate) async fn is_active_for_test(&self) -> bool {
        self.inner.state.lock().await.active
    }

    #[cfg(test)]
    fn from_state_for_test(state: NetnsPoolState) -> Self {
        Self {
            inner: NetnsPoolInner::new(state),
        }
    }

    pub(crate) async fn acquire(&self) -> Result<NetnsLease> {
        self.inner.acquire().await
    }

    pub(crate) async fn activate_dns_readiness(&self) -> Result<()> {
        self.inner.activate_dns_readiness().await
    }

    pub(crate) async fn release(&self, lease: &mut Option<NetnsLease>) -> NetnsReleaseOutcome {
        self.inner.release_outcome(lease).await
    }

    pub(crate) async fn cleanup(&self) -> Result<()> {
        self.inner.cleanup().await
    }

    pub(crate) async fn host_device_pattern(&self) -> String {
        self.inner.host_device_pattern().await
    }
}

async fn create_namespace_with_readiness<F>(
    create: F,
    readiness: Option<(DnsReadinessProbe, Duration)>,
    ops: NetnsLifecycleOps,
) -> Result<NetnsInfo>
where
    F: Future<Output = Result<NetnsInfo>>,
{
    let namespace = create.await?;

    // Pool locking and the reserved namespace index give this new namespace
    // exclusive current ownership of its peer IP. Clear leftovers before the
    // readiness probe or a restored guest can reuse a tuple that still points
    // at a previous runner's REDIRECT port.
    if !(ops.flush_conntrack)(namespace.peer_ip.clone())
        .await
        .is_trusted()
    {
        let error = NetworkError::ConntrackReset {
            namespace: namespace.name.clone(),
            peer_ip: namespace.peer_ip.clone(),
        };
        delete_namespaces_with_ops(ops, vec![namespace]).await;
        return Err(error);
    }
    let Some((probe, timeout)) = readiness else {
        return Ok(namespace);
    };

    if let Err(error) = run_dns_readiness_probe(namespace.name.clone(), probe, timeout).await {
        delete_namespaces_with_ops(ops, vec![namespace]).await;
        return Err(NetworkError::DnsReadiness(error));
    }
    Ok(namespace)
}

async fn delete_namespaces_with_ops(ops: NetnsLifecycleOps, namespaces: Vec<NetnsInfo>) {
    delete_network_resources_with_ops(ops, namespaces, None).await;
}

async fn delete_network_resources_with_ops(
    ops: NetnsLifecycleOps,
    namespaces: Vec<NetnsInfo>,
    dns_input_filter_comment: Option<String>,
) -> NamespaceDeleteOutcome {
    let count = namespaces.len();
    if count > 0 {
        info!(count, "cleaning up namespace pool entries");
    }
    let outcome = ops
        .delete_network_resources(namespaces, dns_input_filter_comment)
        .await;
    if matches!(outcome, NamespaceDeleteOutcome::Abandoned) {
        warn!(
            namespace_count = count,
            "network resource batch cleanup was abandoned; startup orphan reconciliation will retry"
        );
    }
    outcome
}

fn cleanup_namespace_names(namespaces: &[NetnsInfo]) -> HashSet<String> {
    namespaces.iter().map(|ns| ns.name.clone()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    const TEST_SYNC_TIMEOUT: Duration = Duration::from_secs(5);

    async fn wait_for_sync<T>(phase: &'static str, future: impl Future<Output = T>) -> T {
        match tokio::time::timeout(TEST_SYNC_TIMEOUT, future).await {
            Ok(value) => value,
            Err(_) => panic!("test synchronization timed out waiting for {phase}"),
        }
    }

    async fn wait_for_pool_index_reuse(locks: &LockPaths, expected: u32) -> PoolIndexLock {
        wait_for_sync("pool index to become reusable", async {
            loop {
                let (index, lock) = acquire_pool_lock(locks).unwrap();
                if index == expected {
                    return lock;
                }
                drop(lock);
                // Close-only flocks can briefly survive in unrelated fork/exec children.
                tokio::task::yield_now().await;
            }
        })
        .await
    }

    async fn blocking_plain_creation(
        name: &'static str,
        entered: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    ) -> Result<NetnsInfo> {
        entered.notify_one();
        release.notified().await;
        Ok(test_info(name))
    }

    fn test_info(name: &str) -> NetnsInfo {
        NetnsInfo::new(name.into(), "test-ve".into(), "10.200.0.2".into())
    }

    fn probe_for_test<F, Fut>(probe: F) -> DnsReadinessProbe
    where
        F: Fn(String) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = std::result::Result<u16, DnsReadinessError>> + Send + 'static,
    {
        Arc::new(move |namespace| Box::pin(probe(namespace)))
    }

    fn dns_pending_state(names: &[&str], ops: NetnsLifecycleOps) -> NetnsPoolState {
        let mut state = NetnsPoolState::inactive_for_test();
        state.active = true;
        state.proxy_port = Some(8080);
        state.dns_port = Some(5353);
        state.dns_readiness_state = DnsReadinessState::Pending;
        state.next_ns_index = MAX_NAMESPACES;
        state.ops = ops;
        state.proxy_queue = names.iter().map(|name| test_info(name)).collect();
        state
    }

    struct CountedLifecycle {
        ops: NetnsLifecycleOps,
        flush_count: Arc<AtomicUsize>,
        delete_count: Arc<AtomicUsize>,
    }

    struct BlockingFlushLifecycle {
        ops: NetnsLifecycleOps,
        entered: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    }

    struct BlockingFlushWithDeleteLifecycle {
        ops: NetnsLifecycleOps,
        entered: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
        delete_count: Arc<AtomicUsize>,
    }

    struct FirstFlushBlocksLifecycle {
        ops: NetnsLifecycleOps,
        entered: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
        flush_count: Arc<AtomicUsize>,
        delete_count: Arc<AtomicUsize>,
    }

    struct BlockingDeleteLifecycle {
        ops: NetnsLifecycleOps,
        entered: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
        delete_count: Arc<AtomicUsize>,
    }

    struct FirstDeleteBlocksLifecycle {
        ops: NetnsLifecycleOps,
        entered: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
        flush_count: Arc<AtomicUsize>,
        delete_count: Arc<AtomicUsize>,
    }

    fn counted_deleted_lifecycle() -> CountedLifecycle {
        counted_delete_lifecycle_with(
            ConntrackFlushOutcome::Trusted,
            NamespaceDeleteOutcome::Deleted,
        )
    }

    fn untrusted_flush_counted_deleted_lifecycle() -> CountedLifecycle {
        counted_delete_lifecycle_with(
            ConntrackFlushOutcome::Untrusted,
            NamespaceDeleteOutcome::Deleted,
        )
    }

    fn trusted_flush_counted_abandoned_delete_lifecycle() -> CountedLifecycle {
        counted_delete_lifecycle_with(
            ConntrackFlushOutcome::Trusted,
            NamespaceDeleteOutcome::Abandoned,
        )
    }

    fn untrusted_flush_counted_abandoned_delete_lifecycle() -> CountedLifecycle {
        counted_delete_lifecycle_with(
            ConntrackFlushOutcome::Untrusted,
            NamespaceDeleteOutcome::Abandoned,
        )
    }

    fn counted_delete_lifecycle_with(
        flush_outcome: ConntrackFlushOutcome,
        delete_outcome: NamespaceDeleteOutcome,
    ) -> CountedLifecycle {
        let flush_count = Arc::new(AtomicUsize::new(0));
        let delete_count = Arc::new(AtomicUsize::new(0));
        let flush_count_for_ops = Arc::clone(&flush_count);
        let delete_count_for_ops = Arc::clone(&delete_count);
        CountedLifecycle {
            ops: NetnsLifecycleOps {
                flush_conntrack: Arc::new(move |_| {
                    let flush_count = Arc::clone(&flush_count_for_ops);
                    Box::pin(async move {
                        flush_count.fetch_add(1, Ordering::SeqCst);
                        flush_outcome
                    })
                }),
                delete_network_resources: Arc::new(move |namespaces, _| {
                    let delete_count = Arc::clone(&delete_count_for_ops);
                    let count = namespaces.len();
                    Box::pin(async move {
                        delete_count.fetch_add(count, Ordering::SeqCst);
                        delete_outcome
                    })
                }),
            },
            flush_count,
            delete_count,
        }
    }

    #[tokio::test]
    async fn new_namespace_resets_conntrack_before_dns_readiness() {
        let phase = Arc::new(AtomicUsize::new(0));
        let phase_for_flush = Arc::clone(&phase);
        let phase_for_probe = Arc::clone(&phase);
        let ops = NetnsLifecycleOps {
            flush_conntrack: Arc::new(move |peer_ip| {
                let phase = Arc::clone(&phase_for_flush);
                Box::pin(async move {
                    assert_eq!(peer_ip, "10.200.0.2");
                    assert_eq!(phase.fetch_add(1, Ordering::SeqCst), 0);
                    ConntrackFlushOutcome::Trusted
                })
            }),
            delete_network_resources: Arc::new(|_, _| {
                Box::pin(async { NamespaceDeleteOutcome::Deleted })
            }),
        };
        let probe = probe_for_test(move |namespace| {
            let phase = Arc::clone(&phase_for_probe);
            async move {
                assert_eq!(namespace, "vm0-ns-test-00");
                assert_eq!(phase.fetch_add(1, Ordering::SeqCst), 1);
                Ok(1)
            }
        });

        let namespace = create_namespace_with_readiness(
            async { Ok(test_info("vm0-ns-test-00")) },
            Some((probe, Duration::from_secs(1))),
            ops,
        )
        .await
        .unwrap();

        assert_eq!(namespace.name, "vm0-ns-test-00");
        assert_eq!(phase.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn untrusted_creation_conntrack_reset_deletes_namespace_before_readiness() {
        let lifecycle = untrusted_flush_counted_deleted_lifecycle();
        let probe_count = Arc::new(AtomicUsize::new(0));
        let probe_count_for_probe = Arc::clone(&probe_count);
        let probe = probe_for_test(move |_| {
            let probe_count = Arc::clone(&probe_count_for_probe);
            async move {
                probe_count.fetch_add(1, Ordering::SeqCst);
                Ok(1)
            }
        });

        let error = create_namespace_with_readiness(
            async { Ok(test_info("vm0-ns-test-00")) },
            Some((probe, Duration::from_secs(1))),
            lifecycle.ops,
        )
        .await
        .unwrap_err();

        assert!(matches!(
            error,
            NetworkError::ConntrackReset {
                namespace,
                peer_ip,
            } if namespace == "vm0-ns-test-00" && peer_ip == "10.200.0.2"
        ));
        assert_eq!(lifecycle.flush_count.load(Ordering::SeqCst), 1);
        assert_eq!(lifecycle.delete_count.load(Ordering::SeqCst), 1);
        assert_eq!(probe_count.load(Ordering::SeqCst), 0);
    }

    fn blocking_trusted_flush_lifecycle() -> BlockingFlushLifecycle {
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let entered_for_ops = Arc::clone(&entered);
        let release_for_ops = Arc::clone(&release);
        BlockingFlushLifecycle {
            ops: NetnsLifecycleOps {
                flush_conntrack: Arc::new(move |_| {
                    let entered = Arc::clone(&entered_for_ops);
                    let release = Arc::clone(&release_for_ops);
                    Box::pin(async move {
                        entered.notify_one();
                        release.notified().await;
                        ConntrackFlushOutcome::Trusted
                    })
                }),
                delete_network_resources: Arc::new(|_, _| {
                    Box::pin(async { NamespaceDeleteOutcome::Deleted })
                }),
            },
            entered,
            release,
        }
    }

    fn blocking_trusted_flush_counted_delete_lifecycle() -> BlockingFlushWithDeleteLifecycle {
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let delete_count = Arc::new(AtomicUsize::new(0));
        let entered_for_ops = Arc::clone(&entered);
        let release_for_ops = Arc::clone(&release);
        let delete_count_for_ops = Arc::clone(&delete_count);
        BlockingFlushWithDeleteLifecycle {
            ops: NetnsLifecycleOps {
                flush_conntrack: Arc::new(move |_| {
                    let entered = Arc::clone(&entered_for_ops);
                    let release = Arc::clone(&release_for_ops);
                    Box::pin(async move {
                        entered.notify_one();
                        release.notified().await;
                        ConntrackFlushOutcome::Trusted
                    })
                }),
                delete_network_resources: Arc::new(move |namespaces, _| {
                    let delete_count = Arc::clone(&delete_count_for_ops);
                    let count = namespaces.len();
                    Box::pin(async move {
                        delete_count.fetch_add(count, Ordering::SeqCst);
                        NamespaceDeleteOutcome::Deleted
                    })
                }),
            },
            entered,
            release,
            delete_count,
        }
    }

    fn first_flush_blocks_then_trusted_lifecycle() -> FirstFlushBlocksLifecycle {
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let flush_count = Arc::new(AtomicUsize::new(0));
        let delete_count = Arc::new(AtomicUsize::new(0));
        let entered_for_ops = Arc::clone(&entered);
        let release_for_ops = Arc::clone(&release);
        let flush_count_for_ops = Arc::clone(&flush_count);
        let delete_count_for_ops = Arc::clone(&delete_count);
        FirstFlushBlocksLifecycle {
            ops: NetnsLifecycleOps {
                flush_conntrack: Arc::new(move |_| {
                    let entered = Arc::clone(&entered_for_ops);
                    let release = Arc::clone(&release_for_ops);
                    let flush_count = Arc::clone(&flush_count_for_ops);
                    Box::pin(async move {
                        let attempt = flush_count.fetch_add(1, Ordering::SeqCst);
                        if attempt == 0 {
                            entered.notify_one();
                            release.notified().await;
                        }
                        ConntrackFlushOutcome::Trusted
                    })
                }),
                delete_network_resources: Arc::new(move |namespaces, _| {
                    let delete_count = Arc::clone(&delete_count_for_ops);
                    let count = namespaces.len();
                    Box::pin(async move {
                        delete_count.fetch_add(count, Ordering::SeqCst);
                        NamespaceDeleteOutcome::Deleted
                    })
                }),
            },
            entered,
            release,
            flush_count,
            delete_count,
        }
    }

    fn first_delete_blocks_lifecycle() -> BlockingDeleteLifecycle {
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let delete_count = Arc::new(AtomicUsize::new(0));
        let entered_for_ops = Arc::clone(&entered);
        let release_for_ops = Arc::clone(&release);
        let delete_count_for_ops = Arc::clone(&delete_count);
        BlockingDeleteLifecycle {
            ops: NetnsLifecycleOps {
                flush_conntrack: Arc::new(|_| Box::pin(async { ConntrackFlushOutcome::Trusted })),
                delete_network_resources: Arc::new(move |namespaces, _| {
                    let entered = Arc::clone(&entered_for_ops);
                    let release = Arc::clone(&release_for_ops);
                    let delete_count = Arc::clone(&delete_count_for_ops);
                    let count = namespaces.len();
                    Box::pin(async move {
                        let attempt = delete_count.fetch_add(count, Ordering::SeqCst);
                        if attempt == 0 {
                            entered.notify_one();
                            release.notified().await;
                        }
                        NamespaceDeleteOutcome::Deleted
                    })
                }),
            },
            entered,
            release,
            delete_count,
        }
    }

    fn first_untrusted_delete_blocks_then_deleted_lifecycle() -> FirstDeleteBlocksLifecycle {
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let flush_count = Arc::new(AtomicUsize::new(0));
        let delete_count = Arc::new(AtomicUsize::new(0));
        let flush_count_for_ops = Arc::clone(&flush_count);
        let delete_count_for_ops = Arc::clone(&delete_count);
        let entered_for_ops = Arc::clone(&entered);
        let release_for_ops = Arc::clone(&release);
        FirstDeleteBlocksLifecycle {
            ops: NetnsLifecycleOps {
                flush_conntrack: Arc::new(move |_| {
                    let flush_count = Arc::clone(&flush_count_for_ops);
                    Box::pin(async move {
                        flush_count.fetch_add(1, Ordering::SeqCst);
                        ConntrackFlushOutcome::Untrusted
                    })
                }),
                delete_network_resources: Arc::new(move |namespaces, _| {
                    let delete_count = Arc::clone(&delete_count_for_ops);
                    let entered = Arc::clone(&entered_for_ops);
                    let release = Arc::clone(&release_for_ops);
                    let count = namespaces.len();
                    Box::pin(async move {
                        let attempt = delete_count.fetch_add(count, Ordering::SeqCst);
                        if attempt == 0 {
                            entered.notify_one();
                            release.notified().await;
                        }
                        NamespaceDeleteOutcome::Deleted
                    })
                }),
            },
            entered,
            release,
            flush_count,
            delete_count,
        }
    }

    #[tokio::test]
    async fn dns_pending_pool_rejects_acquire_without_removing_ready_entry() {
        let state = dns_pending_state(&["vm0-ns-test-00"], NetnsLifecycleOps::trusted_for_test());
        let mut pool = NetnsPool::from_state_for_test(state);

        let error = pool.acquire().await.unwrap_err();

        assert!(matches!(error, NetworkError::PoolDnsNotReady));
        assert_eq!(
            pool.inner
                .with_state_for_test(|state| state.proxy_queue.len()),
            1
        );
        pool.cleanup().await.unwrap();
    }

    #[tokio::test]
    async fn dns_activation_admits_successfully_probed_initial_namespaces() {
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_for_probe = Arc::clone(&calls);
        let mut state = dns_pending_state(
            &[
                "vm0-ns-test-00",
                "vm0-ns-test-01",
                "vm0-ns-test-02",
                "vm0-ns-test-03",
            ],
            NetnsLifecycleOps::trusted_for_test(),
        );
        state.dns_readiness_probe = probe_for_test(move |_| {
            let calls = Arc::clone(&calls_for_probe);
            async move {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(1)
            }
        });
        let mut pool = NetnsPool::from_state_for_test(state);

        pool.activate_dns_readiness().await.unwrap();

        assert_eq!(calls.load(Ordering::SeqCst), 4);
        assert!(pool.inner.with_state_for_test(|state| matches!(
            state.dns_readiness_state,
            DnsReadinessState::Ready
        )));
        let mut lease = Some(pool.acquire().await.unwrap());
        pool.release(&mut lease).await.unwrap();
        pool.cleanup().await.unwrap();
    }

    #[tokio::test]
    async fn dns_activation_deletes_only_failed_initial_namespaces() {
        let lifecycle = counted_deleted_lifecycle();
        let mut state = dns_pending_state(
            &[
                "vm0-ns-test-00",
                "vm0-ns-test-01",
                "vm0-ns-test-02",
                "vm0-ns-test-03",
            ],
            lifecycle.ops,
        );
        state.dns_readiness_probe = probe_for_test(|namespace| async move {
            if namespace.ends_with("-02") {
                Err(DnsReadinessError::timeout())
            } else {
                Ok(1)
            }
        });
        let mut pool = NetnsPool::from_state_for_test(state);

        pool.activate_dns_readiness().await.unwrap();

        assert_eq!(lifecycle.delete_count.load(Ordering::SeqCst), 1);
        let names = pool.inner.with_state_for_test(|state| {
            state
                .proxy_queue
                .iter()
                .map(|namespace| namespace.name.clone())
                .collect::<Vec<_>>()
        });
        assert_eq!(names.len(), 3);
        assert!(!names.iter().any(|name| name.ends_with("-02")));
        pool.cleanup().await.unwrap();
    }

    #[tokio::test]
    async fn dns_activation_fails_when_every_initial_probe_times_out() {
        let lifecycle = counted_deleted_lifecycle();
        let mut state = dns_pending_state(&["vm0-ns-test-00", "vm0-ns-test-01"], lifecycle.ops);
        state.dns_readiness_timeout = Duration::from_millis(10);
        state.dns_readiness_probe = probe_for_test(|_| async {
            std::future::pending::<std::result::Result<u16, DnsReadinessError>>().await
        });
        let mut pool = NetnsPool::from_state_for_test(state);

        let error = pool.activate_dns_readiness().await.unwrap_err();

        assert!(matches!(error, NetworkError::NoDnsReadyNamespaces));
        assert_eq!(lifecycle.delete_count.load(Ordering::SeqCst), 2);
        assert!(pool.inner.with_state_for_test(|state| {
            state.proxy_queue.is_empty()
                && matches!(state.dns_readiness_state, DnsReadinessState::Pending)
        }));
        pool.cleanup().await.unwrap();
    }

    #[tokio::test]
    async fn cancelled_dns_activation_leaves_initial_entries_owned_by_pool() {
        let lifecycle = counted_deleted_lifecycle();
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let entered_for_probe = Arc::clone(&entered);
        let release_for_probe = Arc::clone(&release);
        let mut state = dns_pending_state(&["vm0-ns-test-00"], lifecycle.ops);
        state.dns_readiness_probe = probe_for_test(move |_| {
            let entered = Arc::clone(&entered_for_probe);
            let release = Arc::clone(&release_for_probe);
            async move {
                entered.notify_one();
                release.notified().await;
                Ok(1)
            }
        });
        let mut pool = NetnsPool::from_state_for_test(state);
        let inner = pool.inner.clone();
        let activation = tokio::spawn(async move { inner.activate_dns_readiness().await });
        wait_for_sync("DNS readiness probe to start", entered.notified()).await;

        activation.abort();
        assert!(activation.await.unwrap_err().is_cancelled());
        assert!(pool.inner.with_state_for_test(|state| {
            state.proxy_queue.len() == 1
                && matches!(state.dns_readiness_state, DnsReadinessState::Activating)
        }));
        pool.cleanup().await.unwrap();
        assert_eq!(lifecycle.delete_count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn post_activation_creation_is_probed_before_acquire() {
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_for_probe = Arc::clone(&calls);
        let mut state = dns_pending_state(&[], NetnsLifecycleOps::trusted_for_test());
        state.dns_readiness_state = DnsReadinessState::Ready;
        state.dns_readiness_probe = probe_for_test(move |_| {
            let calls = Arc::clone(&calls_for_probe);
            async move {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(1)
            }
        });
        state.spawn_proxy_creation_for_test(async { Ok(test_info("vm0-ns-test-04")) });
        let mut pool = NetnsPool::from_state_for_test(state);

        let mut lease = Some(pool.acquire().await.unwrap());

        assert_eq!(lease.as_ref().unwrap().name(), "vm0-ns-test-04");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        pool.release(&mut lease).await.unwrap();
        pool.cleanup().await.unwrap();
    }

    #[tokio::test]
    async fn failed_post_activation_probe_is_deleted_and_returned_to_acquire() {
        let lifecycle = counted_deleted_lifecycle();
        let mut state = dns_pending_state(&[], lifecycle.ops);
        state.next_ns_index = 7;
        state.dns_readiness_state = DnsReadinessState::Ready;
        state.dns_readiness_probe = probe_for_test(|_| async { Err(DnsReadinessError::timeout()) });
        state.spawn_proxy_creation_for_test(async { Ok(test_info("vm0-ns-test-04")) });
        let mut pool = NetnsPool::from_state_for_test(state);

        let error = pool.acquire().await.unwrap_err();

        assert!(matches!(error, NetworkError::DnsReadiness(_)));
        assert_eq!(lifecycle.delete_count.load(Ordering::SeqCst), 1);
        assert!(pool.inner.with_state_for_test(|state| {
            state.proxy_queue.is_empty()
                && state.pending_proxy.is_empty()
                && state.next_ns_index == 7
        }));
        pool.cleanup().await.unwrap();
    }

    #[test]
    fn not_required_acquire_returns_creation_failure_without_retrying() {
        let mut state = NetnsPoolState::inactive_for_test();
        state.active = true;
        state.next_ns_index = 7;
        let mut attempts = 0;

        let error = match state.prepare_acquire_with(|state, kind| {
            assert_eq!(kind, NetnsKind::Plain);
            state.reserve_ns_index()?;
            attempts += 1;
            let id = state.reserve_pending_id();
            state.pending_set_mut(kind).insert(id);
            state.completion.enqueue_for_test(CreationCompletion {
                id,
                kind,
                result: Err(NetworkError::Prerequisite(
                    "injected plain namespace creation failure".into(),
                )),
            });
            Ok(())
        }) {
            Ok(_) => panic!("acquire planning should return the creation failure"),
            Err(error) => error,
        };

        assert!(matches!(
            error,
            NetworkError::Prerequisite(message)
                if message == "injected plain namespace creation failure"
        ));
        assert_eq!(attempts, 1);
        assert_eq!(state.next_ns_index, 8);
        assert!(state.pending_plain.is_empty());
        assert!(state.pending_proxy.is_empty());
        assert!(state.plain_queue.is_empty());
        assert!(state.proxy_queue.is_empty());
    }

    #[tokio::test]
    async fn healthy_entry_wins_over_parallel_readiness_failure() {
        let lifecycle = counted_deleted_lifecycle();
        let mut state = dns_pending_state(&["vm0-ns-test-good"], lifecycle.ops);
        state.dns_readiness_state = DnsReadinessState::Ready;
        state.dns_readiness_probe = probe_for_test(|_| async { Err(DnsReadinessError::timeout()) });
        let prepared = state.completion.prepare_wait();
        assert!(prepared.completions.is_empty());
        let mut completion = prepared.receiver;
        state.spawn_proxy_creation_for_test(async { Ok(test_info("vm0-ns-test-bad")) });
        let mut pool = NetnsPool::from_state_for_test(state);
        wait_for_sync(
            "parallel proxy namespace creation to complete",
            completion.changed(),
        )
        .await
        .unwrap();

        let mut lease = Some(pool.acquire().await.unwrap());

        assert_eq!(lease.as_ref().unwrap().name(), "vm0-ns-test-good");
        assert!(pool.inner.with_state_for_test(|state| {
            state.creation_failure.is_some() && state.proxy_queue.is_empty()
        }));
        assert_eq!(lifecycle.delete_count.load(Ordering::SeqCst), 1);
        pool.release(&mut lease).await.unwrap();
        pool.cleanup().await.unwrap();
    }

    #[tokio::test]
    async fn host_device_pattern_scopes_to_pool_index() {
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.pool_index = 10;
        let handle = NetnsPoolHandle::from_state_for_test(pool);

        assert_eq!(handle.host_device_pattern().await, "vm0-ve-0a-*");
    }

    #[test]
    fn runtime_replenish_fills_pending_to_buffer_with_existing_pending() {
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.reserve_pending_creation_for_test(NetnsKind::Plain)
            .unwrap();

        pool.replenish_kind_with(
            NetnsKind::Plain,
            NetnsPoolState::reserve_pending_creation_for_test,
        );

        assert_eq!(pool.plain_queue.len(), 0);
        assert_eq!(pool.pending_plain.len(), BUFFER_SIZE);
        assert!(pool.pending_proxy.is_empty());
        assert_eq!(usize::try_from(pool.next_ns_index), Ok(BUFFER_SIZE));
        pool.pending_plain.clear();
    }

    #[test]
    fn runtime_replenish_stops_at_namespace_limit() {
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.next_ns_index = MAX_NAMESPACES - 1;

        pool.replenish_kind_with(
            NetnsKind::Plain,
            NetnsPoolState::reserve_pending_creation_for_test,
        );

        assert_eq!(pool.pending_plain.len(), 1);
        assert_eq!(pool.next_ns_index, MAX_NAMESPACES);

        pool.replenish_kind_with(
            NetnsKind::Plain,
            NetnsPoolState::reserve_pending_creation_for_test,
        );

        assert_eq!(pool.pending_plain.len(), 1);
        assert_eq!(pool.next_ns_index, MAX_NAMESPACES);
        pool.pending_plain.clear();
    }

    #[test]
    fn runtime_replenish_uses_proxy_queue_in_proxy_mode() {
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.proxy_port = Some(8080);
        pool.proxy_queue.push_back(test_info("ready-proxy"));

        pool.replenish_kind_with(
            NetnsKind::Proxy,
            NetnsPoolState::reserve_pending_creation_for_test,
        );

        assert_eq!(pool.proxy_queue.len(), 1);
        assert_eq!(pool.pending_proxy.len(), BUFFER_SIZE - 1);
        assert!(pool.pending_plain.is_empty());
        assert_eq!(usize::try_from(pool.next_ns_index), Ok(BUFFER_SIZE - 1));
        pool.pending_proxy.clear();
    }

    #[test]
    fn runtime_replenish_keeps_high_water_until_below_buffer() {
        for (kind, proxy_port) in [(NetnsKind::Plain, None), (NetnsKind::Proxy, Some(8080))] {
            let mut pool = NetnsPoolState::inactive_for_test();
            pool.proxy_port = proxy_port;
            for index in 0..BUFFER_SIZE + 2 {
                pool.target_queue_mut(kind)
                    .push_back(test_info(&format!("ready-ns-{index}")));
            }

            pool.replenish_kind_with(kind, NetnsPoolState::reserve_pending_creation_for_test);

            assert!(pool.pending_set(kind).is_empty());
            assert_eq!(pool.next_ns_index, 0);

            for _ in 0..2 {
                let _ = pool.target_queue_mut(kind).pop_front().unwrap();
            }
            pool.replenish_kind_with(kind, NetnsPoolState::reserve_pending_creation_for_test);

            assert_eq!(pool.target_queue(kind).len(), BUFFER_SIZE);
            assert!(pool.pending_set(kind).is_empty());
            assert_eq!(pool.next_ns_index, 0);

            let _ = pool.target_queue_mut(kind).pop_front().unwrap();
            pool.replenish_kind_with(kind, NetnsPoolState::reserve_pending_creation_for_test);

            assert_eq!(pool.target_queue(kind).len(), BUFFER_SIZE - 1);
            assert_eq!(pool.pending_set(kind).len(), 1);
            assert_eq!(pool.next_ns_index, 1);
            pool.pending_set_mut(kind).clear();
            pool.target_queue_mut(kind).clear();
        }
    }

    #[test]
    fn runtime_replenish_ignores_proxy_kind_when_proxy_disabled() {
        let mut pool = NetnsPoolState::inactive_for_test();

        pool.replenish_kind_with(
            NetnsKind::Proxy,
            NetnsPoolState::reserve_pending_creation_for_test,
        );

        assert!(pool.pending_plain.is_empty());
        assert!(pool.pending_proxy.is_empty());
        assert_eq!(pool.next_ns_index, 0);
    }

    #[tokio::test]
    async fn shared_acquire_does_not_hold_mutex_while_creation_is_pending() {
        let waiting = Arc::new(tokio::sync::Notify::new());
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        pool.next_ns_index = MAX_NAMESPACES;
        pool.acquire_waiting_notify = Some(Arc::clone(&waiting));
        pool.spawn_plain_creation_for_test(blocking_plain_creation(
            "test-ns",
            Arc::clone(&entered),
            Arc::clone(&release),
        ));
        let handle = NetnsPoolHandle::from_state_for_test(pool);

        let acquire = tokio::spawn({
            let handle = handle.clone();
            async move { handle.acquire().await }
        });
        wait_for_sync("plain namespace creation to start", entered.notified()).await;
        wait_for_sync(
            "shared acquire to wait for namespace creation",
            waiting.notified(),
        )
        .await;

        let guard = handle
            .inner
            .state
            .try_lock()
            .expect("shared acquire must not hold netns pool mutex while waiting");
        drop(guard);

        release.notify_one();
        let mut lease = Some(acquire.await.unwrap().unwrap());
        assert_eq!(lease.as_ref().unwrap().name(), "test-ns");
        let outcome = handle.release(&mut lease).await;
        assert!(matches!(outcome, NetnsReleaseOutcome::Released));
        handle.cleanup().await.unwrap();
    }

    #[tokio::test]
    async fn shared_acquire_cancellation_preserves_completed_creation() {
        let waiting = Arc::new(tokio::sync::Notify::new());
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        pool.next_ns_index = MAX_NAMESPACES;
        pool.acquire_waiting_notify = Some(Arc::clone(&waiting));
        pool.spawn_plain_creation_for_test(blocking_plain_creation(
            "test-ns",
            Arc::clone(&entered),
            Arc::clone(&release),
        ));
        let handle = NetnsPoolHandle::from_state_for_test(pool);

        let acquire = tokio::spawn({
            let handle = handle.clone();
            async move { handle.acquire().await }
        });
        wait_for_sync(
            "plain namespace creation to start before acquire cancellation",
            entered.notified(),
        )
        .await;
        wait_for_sync(
            "shared acquire to wait before cancellation",
            waiting.notified(),
        )
        .await;
        acquire.abort();
        let _ = acquire.await;

        release.notify_one();
        let mut lease = Some(handle.acquire().await.unwrap());
        assert_eq!(lease.as_ref().unwrap().name(), "test-ns");

        let outcome = handle.release(&mut lease).await;
        assert!(matches!(outcome, NetnsReleaseOutcome::Released));
        handle.cleanup().await.unwrap();
    }

    #[tokio::test]
    async fn creation_worker_panic_clears_pending_during_cleanup() {
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        pool.spawn_plain_creation_for_test(async {
            panic!("creation panic for test");
            #[allow(unreachable_code)]
            Ok(test_info("never"))
        });
        let handle = NetnsPoolHandle::from_state_for_test(pool);

        handle.cleanup().await.unwrap();

        let pool = handle.inner.state.lock().await;
        assert!(pool.pending_plain.is_empty());
        assert!(pool.plain_queue.is_empty());
    }

    #[tokio::test]
    async fn completion_send_failure_deletes_created_namespace() {
        let CountedLifecycle {
            ops,
            delete_count: deleted,
            ..
        } = counted_deleted_lifecycle();
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.ops = ops;
        let notifier = pool.creation_notifier();
        drop(pool);

        notifier
            .send(CreationCompletion {
                id: PendingId(0),
                kind: NetnsKind::Plain,
                result: Ok(test_info("orphan-ns")),
            })
            .await;

        assert_eq!(deleted.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn cleanup_deletes_unknown_completed_namespace() {
        let CountedLifecycle {
            ops,
            delete_count: deleted,
            ..
        } = counted_deleted_lifecycle();
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        pool.ops = ops;
        pool.completion.enqueue_for_test(CreationCompletion {
            id: PendingId(999),
            kind: NetnsKind::Plain,
            result: Ok(test_info("unknown-ns")),
        });

        let mut pool = NetnsPool::from_state_for_test(pool);
        pool.cleanup().await.unwrap();

        assert_eq!(deleted.load(Ordering::SeqCst), 1);
        let pool = pool.inner.state.lock().await;
        assert!(pool.plain_queue.is_empty());
        assert!(pool.proxy_queue.is_empty());
    }

    #[test]
    fn netns_high_water_completion_retains_ready_entries_above_buffer() {
        for (kind, proxy_port) in [(NetnsKind::Plain, None), (NetnsKind::Proxy, Some(8080))] {
            let mut pool = NetnsPoolState::inactive_for_test();
            pool.active = true;
            pool.proxy_port = proxy_port;
            for index in 0..BUFFER_SIZE {
                pool.target_queue_mut(kind)
                    .push_back(test_info(&format!("ready-ns-{index}")));
            }
            pool.reserve_pending_creation_for_test(kind).unwrap();
            pool.reserve_pending_creation_for_test(kind).unwrap();
            let pending_ids: Vec<PendingId> = pool.pending_set(kind).iter().copied().collect();
            assert_eq!(pending_ids.len(), 2);

            pool.completion.enqueue_for_test(CreationCompletion {
                id: pending_ids[0],
                kind,
                result: Ok(test_info("completed-ns-0")),
            });
            pool.completion.enqueue_for_test(CreationCompletion {
                id: pending_ids[1],
                kind,
                result: Ok(test_info("completed-ns-1")),
            });

            let delete = pool.drain_completed(false);
            let queue = pool.target_queue(kind);

            assert!(delete.is_empty());
            assert!(pool.pending_set(kind).is_empty());
            assert_eq!(queue.len(), BUFFER_SIZE + 2);
            assert!(queue.iter().any(|ns| ns.name == "completed-ns-0"));
            assert!(queue.iter().any(|ns| ns.name == "completed-ns-1"));
            pool.active = false;
            pool.target_queue_mut(kind).clear();
        }
    }

    #[tokio::test]
    async fn cancelled_warmup_retains_pool_index_through_late_cleanup() {
        for kind in [NetnsKind::Plain, NetnsKind::Proxy] {
            let dir = tempfile::tempdir().unwrap();
            let locks = LockPaths::with_dir(dir.path().to_path_buf());
            let (index, lock) = acquire_pool_lock(&locks).unwrap();
            let entered = Arc::new(tokio::sync::Notify::new());
            let release = Arc::new(tokio::sync::Notify::new());
            let BlockingDeleteLifecycle {
                ops,
                entered: cleanup_entered,
                release: cleanup_release,
                delete_count,
            } = first_delete_blocks_lifecycle();
            let mut pool = NetnsPoolState::inactive_for_test();
            pool.pool_index = index;
            pool.index_lock = Arc::new(lock);
            pool.ops = ops;
            let creation =
                blocking_plain_creation("late-ns", Arc::clone(&entered), Arc::clone(&release));
            match kind {
                NetnsKind::Plain => pool.spawn_plain_creation_for_test(creation),
                NetnsKind::Proxy => pool.spawn_proxy_creation_for_test(creation),
            }
            {
                let warmup = async move { pool.drain_initial_warmup().await };
                tokio::pin!(warmup);
                tokio::select! {
                    biased;
                    _ = &mut warmup => panic!("warmup finished before creation was released"),
                    _ = wait_for_sync("warmup creation to start", entered.notified()) => {}
                }
                let (other_index, _other_lock) = acquire_pool_lock(&locks).unwrap();
                assert_ne!(other_index, index);
                // Cancelling the constructor drops its local pool state.
            }

            let (replacement_index, _replacement_lock) = acquire_pool_lock(&locks).unwrap();
            assert_ne!(replacement_index, index, "creation still owns this index");
            release.notify_one();
            wait_for_sync(
                "late completion cleanup to start",
                cleanup_entered.notified(),
            )
            .await;
            let (during_cleanup_index, _during_cleanup_lock) = acquire_pool_lock(&locks).unwrap();
            assert_ne!(
                during_cleanup_index, index,
                "late cleanup still owns this index"
            );

            cleanup_release.notify_one();
            let _reused_lock = wait_for_pool_index_reuse(&locks, index).await;
            assert_eq!(delete_count.load(Ordering::SeqCst), 1);
        }
    }

    #[tokio::test]
    async fn dropped_pool_retains_pool_index_through_creation_error_cleanup() {
        let dir = tempfile::tempdir().unwrap();
        let locks = LockPaths::with_dir(dir.path().to_path_buf());
        let (index, lock) = acquire_pool_lock(&locks).unwrap();
        let FirstDeleteBlocksLifecycle {
            ops,
            entered,
            release,
            flush_count,
            delete_count,
        } = first_untrusted_delete_blocks_then_deleted_lifecycle();
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.pool_index = index;
        pool.index_lock = Arc::new(lock);
        pool.ops = ops;
        // The real creation wrapper deletes after a failed conntrack reset,
        // before the worker returns its error to the completion reporter.
        pool.spawn_proxy_creation_for_test(async { Ok(test_info("failed-ns")) });
        let pool = NetnsPoolHandle::from_state_for_test(pool);
        let last_handle = pool.clone();
        drop(pool);
        wait_for_sync("creation error cleanup to start", entered.notified()).await;
        drop(last_handle);

        let (replacement_index, _replacement_lock) = acquire_pool_lock(&locks).unwrap();
        assert_ne!(
            replacement_index, index,
            "worker cleanup still owns this index"
        );
        release.notify_one();
        let _reused_lock = wait_for_pool_index_reuse(&locks, index).await;
        assert_eq!(flush_count.load(Ordering::SeqCst), 1);
        assert_eq!(delete_count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn dropped_pool_releases_pool_index_after_creation_panic() {
        let dir = tempfile::tempdir().unwrap();
        let locks = LockPaths::with_dir(dir.path().to_path_buf());
        let (index, lock) = acquire_pool_lock(&locks).unwrap();
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.pool_index = index;
        pool.index_lock = Arc::new(lock);
        pool.spawn_plain_creation_for_test({
            let entered = Arc::clone(&entered);
            let release = Arc::clone(&release);
            async move {
                entered.notify_one();
                release.notified().await;
                panic!("synthetic namespace creation panic");
            }
        });
        wait_for_sync("panicking creation to start", entered.notified()).await;
        drop(NetnsPoolHandle::from_state_for_test(pool));

        let (replacement_index, _replacement_lock) = acquire_pool_lock(&locks).unwrap();
        assert_ne!(replacement_index, index, "creation has not panicked yet");
        release.notify_one();
        let _reused_lock = wait_for_pool_index_reuse(&locks, index).await;
    }

    #[tokio::test]
    async fn cancelled_reporter_keeps_pool_index_while_worker_cleans_up() {
        let dir = tempfile::tempdir().unwrap();
        let locks = LockPaths::with_dir(dir.path().to_path_buf());
        let (index, lock) = acquire_pool_lock(&locks).unwrap();
        let FirstDeleteBlocksLifecycle {
            ops,
            entered,
            release,
            delete_count,
            ..
        } = first_untrusted_delete_blocks_then_deleted_lifecycle();
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.pool_index = index;
        pool.index_lock = Arc::new(lock);
        let reporter = spawn_creation_worker(
            PendingId(0),
            NetnsKind::Proxy,
            Arc::clone(&pool.index_lock),
            pool.creation_notifier(),
            create_namespace_with_readiness(async { Ok(test_info("failed-ns")) }, None, ops),
        );
        wait_for_sync(
            "worker cleanup before reporter cancellation",
            entered.notified(),
        )
        .await;
        reporter.abort();
        let error = wait_for_sync("reporter cancellation", reporter)
            .await
            .unwrap_err();
        assert!(error.is_cancelled());
        drop(pool);

        let (replacement_index, _replacement_lock) = acquire_pool_lock(&locks).unwrap();
        assert_ne!(
            replacement_index, index,
            "detached worker still owns this index"
        );
        release.notify_one();
        let _reused_lock = wait_for_pool_index_reuse(&locks, index).await;
        assert_eq!(delete_count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn cleanup_rejects_acquire_and_deletes_late_completion() {
        let release = Arc::new(tokio::sync::Notify::new());
        let CountedLifecycle {
            ops, delete_count, ..
        } = counted_deleted_lifecycle();
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        pool.ops = ops;
        pool.spawn_plain_creation_for_test({
            let release = Arc::clone(&release);
            async move {
                release.notified().await;
                Ok(test_info("late-ns"))
            }
        });
        let handle = NetnsPoolHandle::from_state_for_test(pool);

        let cleanup = tokio::spawn({
            let handle = handle.clone();
            async move { handle.cleanup().await }
        });
        wait_for_sync("cleanup to mark namespace pool inactive", async {
            loop {
                if !handle.inner.state.lock().await.active {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await;

        let err = handle.acquire().await.unwrap_err();
        assert!(matches!(err, NetworkError::PoolNotActive));

        release.notify_one();
        cleanup.await.unwrap().unwrap();
        let pool = handle.inner.state.lock().await;
        assert!(pool.pending_plain.is_empty());
        assert!(pool.plain_queue.is_empty());
        assert_eq!(delete_count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn shared_release_does_not_hold_mutex_while_flush_blocks() {
        let BlockingFlushLifecycle {
            ops,
            entered: flush_entered,
            release: flush_release,
        } = blocking_trusted_flush_lifecycle();
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        pool.ops = ops;
        let lease = Some(pool.checkout(test_info("test-ns")).unwrap());
        let handle = NetnsPoolHandle::from_state_for_test(pool);

        let release_task = tokio::spawn({
            let handle = handle.clone();
            async move {
                let mut lease = lease;
                let outcome = handle.release(&mut lease).await;
                (outcome, lease)
            }
        });
        wait_for_sync(
            "shared release conntrack flush to start",
            flush_entered.notified(),
        )
        .await;

        let guard = handle
            .inner
            .state
            .try_lock()
            .expect("shared release must not hold netns pool mutex while flushing conntrack");
        drop(guard);

        flush_release.notify_one();
        let (outcome, lease) = release_task.await.unwrap();
        assert!(matches!(outcome, NetnsReleaseOutcome::Released));
        assert!(lease.is_none());
        handle.cleanup().await.unwrap();
    }

    #[tokio::test]
    async fn shared_release_deletes_when_cleanup_races_after_flush_started() {
        let BlockingFlushWithDeleteLifecycle {
            ops,
            entered: flush_entered,
            release: flush_release,
            delete_count,
        } = blocking_trusted_flush_counted_delete_lifecycle();
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        pool.ops = ops;
        let lease = Some(pool.checkout(test_info("test-ns")).unwrap());
        let handle = NetnsPoolHandle::from_state_for_test(pool);

        let release_task = tokio::spawn({
            let handle = handle.clone();
            async move {
                let mut lease = lease;
                let outcome = handle.release(&mut lease).await;
                (outcome, lease)
            }
        });
        wait_for_sync(
            "shared release conntrack flush to start before cleanup",
            flush_entered.notified(),
        )
        .await;

        handle.cleanup().await.unwrap();
        flush_release.notify_one();
        let (outcome, lease) = release_task.await.unwrap();

        assert!(matches!(outcome, NetnsReleaseOutcome::Deleted));
        assert!(lease.is_none());
        assert_eq!(delete_count.load(Ordering::SeqCst), 1);
        let pool = handle.inner.state.lock().await;
        assert!(!pool.active);
        assert!(pool.in_flight.is_empty());
        assert!(pool.plain_queue.is_empty());
    }

    #[tokio::test]
    async fn cancelled_release_during_flush_marks_namespace_non_reusable_for_retry() {
        let FirstFlushBlocksLifecycle {
            ops,
            entered: flush_entered,
            release: first_flush_release,
            flush_count,
            delete_count,
        } = first_flush_blocks_then_trusted_lifecycle();
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        pool.ops = ops;
        let mut lease = Some(pool.checkout(test_info("test-ns")).unwrap());
        let handle = NetnsPoolHandle::from_state_for_test(pool);

        {
            let release = handle.release(&mut lease);
            tokio::pin!(release);
            tokio::select! {
                outcome = &mut release => panic!("release completed before flush was cancelled: {outcome:?}"),
                _ = wait_for_sync(
                    "release conntrack flush to start before cancellation",
                    flush_entered.notified(),
                ) => {}
            }
        }

        assert!(lease.is_some());
        assert_eq!(flush_count.load(Ordering::SeqCst), 1);
        {
            let pool = handle.inner.state.lock().await;
            assert!(pool.non_reusable.contains("test-ns"));
        }

        first_flush_release.notify_one();
        let outcome = handle.release(&mut lease).await;

        assert!(matches!(outcome, NetnsReleaseOutcome::Deleted));
        assert!(lease.is_none());
        assert_eq!(
            flush_count.load(Ordering::SeqCst),
            1,
            "cancelled flush must taint the namespace before retry"
        );
        assert_eq!(delete_count.load(Ordering::SeqCst), 1);
        let pool = handle.inner.state.lock().await;
        assert!(pool.non_reusable.is_empty());
        assert!(pool.plain_queue.is_empty());
    }

    #[tokio::test]
    async fn release_cancelled_after_trusted_flush_before_commit_deletes_on_retry() {
        let FirstFlushBlocksLifecycle {
            ops,
            entered: flush_entered,
            release: first_flush_release,
            flush_count,
            delete_count,
        } = first_flush_blocks_then_trusted_lifecycle();
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        pool.ops = ops;
        let mut lease = Some(pool.checkout(test_info("test-ns")).unwrap());
        let handle = NetnsPoolHandle::from_state_for_test(pool);

        let mut release = Box::pin(handle.release(&mut lease));
        tokio::select! {
            outcome = &mut release => panic!("release completed before flush finished: {outcome:?}"),
            _ = wait_for_sync(
                "trusted release conntrack flush to start",
                flush_entered.notified(),
            ) => {}
        }
        let guard = handle.inner.state.lock().await;
        first_flush_release.notify_one();
        tokio::select! {
            outcome = &mut release => panic!("release completed while pool lock was held: {outcome:?}"),
            _ = tokio::task::yield_now() => {}
        }
        assert!(guard.non_reusable.contains("test-ns"));
        drop(release);

        assert!(lease.is_some());
        assert_eq!(flush_count.load(Ordering::SeqCst), 1);
        drop(guard);

        let outcome = handle.release(&mut lease).await;

        assert!(matches!(outcome, NetnsReleaseOutcome::Deleted));
        assert!(lease.is_none());
        assert_eq!(
            flush_count.load(Ordering::SeqCst),
            1,
            "cancelled post-flush commit must not flush/requeue on retry"
        );
        assert_eq!(delete_count.load(Ordering::SeqCst), 1);
        let pool = handle.inner.state.lock().await;
        assert!(pool.non_reusable.is_empty());
        assert!(pool.in_flight.is_empty());
        assert!(pool.plain_queue.is_empty());
    }

    #[tokio::test]
    async fn direct_release_cancelled_during_flush_marks_namespace_non_reusable_for_retry() {
        let FirstFlushBlocksLifecycle {
            ops,
            entered: flush_entered,
            release: first_flush_release,
            flush_count,
            delete_count,
        } = first_flush_blocks_then_trusted_lifecycle();
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        pool.ops = ops;
        let mut lease = Some(pool.checkout(test_info("test-ns")).unwrap());
        let mut pool = NetnsPool::from_state_for_test(pool);

        {
            let release = pool.release(&mut lease);
            tokio::pin!(release);
            tokio::select! {
                result = &mut release => panic!("release completed before flush was cancelled: {result:?}"),
                _ = wait_for_sync(
                    "direct release conntrack flush to start before cancellation",
                    flush_entered.notified(),
                ) => {}
            }
        }

        assert!(lease.is_some());
        assert_eq!(flush_count.load(Ordering::SeqCst), 1);
        {
            let pool = pool.inner.state.lock().await;
            assert!(pool.non_reusable.contains("test-ns"));
        }

        first_flush_release.notify_one();
        pool.release(&mut lease).await.unwrap();

        assert!(lease.is_none());
        assert_eq!(
            flush_count.load(Ordering::SeqCst),
            1,
            "direct cancelled flush must taint the namespace before retry"
        );
        assert_eq!(delete_count.load(Ordering::SeqCst), 1);
        let pool = pool.inner.state.lock().await;
        assert!(pool.non_reusable.is_empty());
        assert!(pool.plain_queue.is_empty());
    }

    #[tokio::test]
    async fn untrusted_conntrack_flush_deletes_without_requeue() {
        let CountedLifecycle {
            ops, delete_count, ..
        } = untrusted_flush_counted_deleted_lifecycle();
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        pool.ops = ops;
        let mut lease = Some(pool.checkout(test_info("test-ns")).unwrap());
        let handle = NetnsPoolHandle::from_state_for_test(pool);

        let outcome = handle.release(&mut lease).await;

        assert!(matches!(outcome, NetnsReleaseOutcome::Deleted));
        assert!(lease.is_none());
        assert_eq!(delete_count.load(Ordering::SeqCst), 1);
        let pool = handle.inner.state.lock().await;
        assert!(pool.in_flight.is_empty());
        assert!(pool.plain_queue.is_empty());
    }

    #[tokio::test]
    async fn attachment_marked_non_reusable_is_deleted_without_conntrack_flush() {
        let CountedLifecycle {
            ops,
            flush_count,
            delete_count,
        } = counted_deleted_lifecycle();
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        pool.ops = ops;
        let mut lease = pool.checkout(test_info("failed-ns")).unwrap();
        lease.mark_non_reusable();
        let mut lease = Some(lease);
        let handle = NetnsPoolHandle::from_state_for_test(pool);

        let outcome = handle.release(&mut lease).await;

        assert!(matches!(outcome, NetnsReleaseOutcome::Deleted));
        assert!(lease.is_none());
        assert_eq!(flush_count.load(Ordering::SeqCst), 0);
        assert_eq!(delete_count.load(Ordering::SeqCst), 1);
        let pool = handle.inner.state.lock().await;
        assert!(pool.in_flight.is_empty());
        assert!(pool.plain_queue.is_empty());
    }

    #[tokio::test]
    async fn attachment_reapproved_after_readiness_uses_normal_release_path() {
        let CountedLifecycle {
            ops,
            flush_count,
            delete_count,
        } = counted_deleted_lifecycle();
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        pool.ops = ops;
        let mut lease = pool.checkout(test_info("ready-ns")).unwrap();
        lease.mark_non_reusable();
        lease.mark_reusable();
        let mut lease = Some(lease);
        let handle = NetnsPoolHandle::from_state_for_test(pool);

        let outcome = handle.release(&mut lease).await;

        assert!(matches!(outcome, NetnsReleaseOutcome::Released));
        assert!(lease.is_none());
        assert_eq!(flush_count.load(Ordering::SeqCst), 1);
        assert_eq!(delete_count.load(Ordering::SeqCst), 0);
        let pool = handle.inner.state.lock().await;
        assert!(pool.in_flight.is_empty());
        assert_eq!(pool.plain_queue.len(), 1);
        assert_eq!(pool.plain_queue.front().unwrap().name(), "ready-ns");
    }

    #[tokio::test]
    async fn cancelled_untrusted_release_marks_namespace_non_reusable_for_retry() {
        let FirstDeleteBlocksLifecycle {
            ops,
            entered: delete_entered,
            release: first_delete_release,
            flush_count,
            delete_count,
        } = first_untrusted_delete_blocks_then_deleted_lifecycle();
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        pool.ops = ops;
        let mut lease = Some(pool.checkout(test_info("test-ns")).unwrap());
        let handle = NetnsPoolHandle::from_state_for_test(pool);

        {
            let release = handle.release(&mut lease);
            tokio::pin!(release);
            tokio::select! {
                outcome = &mut release => panic!("release completed before delete was cancelled: {outcome:?}"),
                _ = wait_for_sync(
                    "untrusted release namespace deletion to start",
                    delete_entered.notified(),
                ) => {}
            }
        }

        assert!(lease.is_some());
        assert_eq!(flush_count.load(Ordering::SeqCst), 1);
        assert_eq!(delete_count.load(Ordering::SeqCst), 1);
        {
            let pool = handle.inner.state.lock().await;
            assert!(pool.non_reusable.contains("test-ns"));
        }

        first_delete_release.notify_one();
        let outcome = handle.release(&mut lease).await;

        assert!(matches!(outcome, NetnsReleaseOutcome::Deleted));
        assert!(lease.is_none());
        assert_eq!(
            flush_count.load(Ordering::SeqCst),
            1,
            "tainted retry must not flush and requeue"
        );
        assert_eq!(delete_count.load(Ordering::SeqCst), 2);
        let pool = handle.inner.state.lock().await;
        assert!(pool.non_reusable.is_empty());
        assert!(pool.plain_queue.is_empty());
    }

    #[tokio::test]
    async fn release_cancelled_after_delete_before_commit_retries_delete_without_flush() {
        let FirstDeleteBlocksLifecycle {
            ops,
            entered: delete_entered,
            release: first_delete_release,
            flush_count,
            delete_count,
        } = first_untrusted_delete_blocks_then_deleted_lifecycle();
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        pool.ops = ops;
        let mut lease = Some(pool.checkout(test_info("test-ns")).unwrap());
        let handle = NetnsPoolHandle::from_state_for_test(pool);

        let mut release = Box::pin(handle.release(&mut lease));
        tokio::select! {
            outcome = &mut release => panic!("release completed before delete finished: {outcome:?}"),
            _ = wait_for_sync(
                "namespace deletion to start before release commit",
                delete_entered.notified(),
            ) => {}
        }
        let guard = handle.inner.state.lock().await;
        first_delete_release.notify_one();
        tokio::select! {
            outcome = &mut release => panic!("release completed while pool lock was held: {outcome:?}"),
            _ = tokio::task::yield_now() => {}
        }
        assert!(guard.non_reusable.contains("test-ns"));
        drop(release);

        assert!(lease.is_some());
        assert_eq!(flush_count.load(Ordering::SeqCst), 1);
        assert_eq!(delete_count.load(Ordering::SeqCst), 1);
        drop(guard);

        let outcome = handle.release(&mut lease).await;

        assert!(matches!(outcome, NetnsReleaseOutcome::Deleted));
        assert!(lease.is_none());
        assert_eq!(
            flush_count.load(Ordering::SeqCst),
            1,
            "tainted post-delete retry must not flush/requeue"
        );
        assert_eq!(delete_count.load(Ordering::SeqCst), 2);
        let pool = handle.inner.state.lock().await;
        assert!(pool.non_reusable.is_empty());
        assert!(pool.in_flight.is_empty());
        assert!(pool.plain_queue.is_empty());
    }

    #[tokio::test]
    async fn shared_cleanup_does_not_hold_mutex_while_delete_blocks() {
        let BlockingDeleteLifecycle {
            ops,
            entered: delete_entered,
            release: delete_release,
            ..
        } = first_delete_blocks_lifecycle();
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        pool.plain_queue.push_back(test_info("test-ns"));
        pool.ops = ops;
        let handle = NetnsPoolHandle::from_state_for_test(pool);

        let cleanup = tokio::spawn({
            let handle = handle.clone();
            async move { handle.cleanup().await }
        });
        wait_for_sync(
            "shared cleanup namespace deletion to start",
            delete_entered.notified(),
        )
        .await;

        let guard = handle
            .inner
            .state
            .try_lock()
            .expect("shared cleanup must not hold netns pool mutex while deleting namespace");
        drop(guard);

        delete_release.notify_one();
        cleanup.await.unwrap().unwrap();
        let pool = handle.inner.state.lock().await;
        assert!(pool.plain_queue.is_empty());
    }

    #[tokio::test]
    async fn shared_cleanup_retry_keeps_queue_when_cancelled_during_delete() {
        let BlockingDeleteLifecycle {
            ops,
            entered: delete_entered,
            release: delete_release,
            delete_count,
        } = first_delete_blocks_lifecycle();
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        pool.plain_queue.push_back(test_info("test-ns"));
        pool.ops = ops;
        let handle = NetnsPoolHandle::from_state_for_test(pool);

        let cleanup = tokio::spawn({
            let handle = handle.clone();
            async move { handle.cleanup().await }
        });
        wait_for_sync(
            "cleanup namespace deletion to start before cancellation",
            delete_entered.notified(),
        )
        .await;
        cleanup.abort();
        let _ = cleanup.await;

        {
            let pool = handle.inner.state.lock().await;
            assert!(!pool.active);
            assert_eq!(pool.plain_queue.len(), 1);
            assert_eq!(pool.plain_queue.front().unwrap().name(), "test-ns");
        }

        delete_release.notify_one();
        handle.cleanup().await.unwrap();
        let pool = handle.inner.state.lock().await;
        assert!(pool.plain_queue.is_empty());
        assert_eq!(delete_count.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn release_disarms_lease_and_returns_info_to_queue() {
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        let info = test_info("test-ns");
        let mut lease = Some(pool.checkout(info).unwrap());
        let mut pool = NetnsPool::from_state_for_test(pool);

        pool.release(&mut lease).await.unwrap();

        assert!(lease.is_none());
        {
            let pool = pool.inner.state.lock().await;
            assert!(pool.in_flight.is_empty());
            assert_eq!(pool.plain_queue.len(), 1);
            assert_eq!(pool.plain_queue.front().unwrap().name(), "test-ns");
        }

        pool.cleanup().await.unwrap();
    }

    #[tokio::test]
    async fn netns_high_water_release_retains_ready_entries_above_buffer() {
        for (kind, proxy_port) in [(NetnsKind::Plain, None), (NetnsKind::Proxy, Some(8080))] {
            let mut state = NetnsPoolState::inactive_for_test();
            state.active = true;
            state.proxy_port = proxy_port;
            let mut leases: Vec<Option<NetnsLease>> = (0..BUFFER_SIZE + 2)
                .map(|index| {
                    Some(
                        state
                            .checkout(test_info(&format!("released-ns-{index}")))
                            .unwrap(),
                    )
                })
                .collect();
            let mut pool = NetnsPool::from_state_for_test(state);

            for lease in &mut leases {
                pool.release(lease).await.unwrap();
            }

            assert!(leases.iter().all(Option::is_none));
            {
                let state = pool.inner.state.lock().await;
                let queue = state.target_queue(kind);
                let last_released_name = format!("released-ns-{}", BUFFER_SIZE + 1);
                assert!(state.in_flight.is_empty());
                assert_eq!(queue.len(), BUFFER_SIZE + 2);
                assert!(queue.iter().any(|ns| ns.name == "released-ns-0"));
                assert!(queue.iter().any(|ns| ns.name == last_released_name));
            }

            pool.cleanup().await.unwrap();
        }
    }

    #[tokio::test]
    async fn proxy_release_disarms_lease_and_returns_info_to_proxy_queue() {
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        pool.proxy_port = Some(8080);
        let info = test_info("test-ns");
        let mut lease = Some(pool.checkout(info).unwrap());
        let mut pool = NetnsPool::from_state_for_test(pool);

        pool.release(&mut lease).await.unwrap();

        assert!(lease.is_none());
        {
            let pool = pool.inner.state.lock().await;
            assert!(pool.in_flight.is_empty());
            assert!(pool.plain_queue.is_empty());
            assert_eq!(pool.proxy_queue.len(), 1);
            assert_eq!(pool.proxy_queue.front().unwrap().name(), "test-ns");
        }

        pool.cleanup().await.unwrap();
    }

    #[tokio::test]
    async fn release_after_cleanup_deletes_outstanding_lease_without_requeueing() {
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        let info = test_info("test-ns");
        let mut lease = Some(pool.checkout(info).unwrap());
        let mut pool = NetnsPool::from_state_for_test(pool);

        pool.cleanup().await.unwrap();

        assert!(lease.is_some());
        {
            let pool = pool.inner.state.lock().await;
            assert!(!pool.active);
            assert!(pool.in_flight.contains("test-ns"));
        }

        pool.release(&mut lease).await.unwrap();

        assert!(lease.is_none());
        {
            let pool = pool.inner.state.lock().await;
            assert!(pool.in_flight.is_empty());
            assert!(pool.plain_queue.is_empty());
            assert!(pool.proxy_queue.is_empty());
        }
        pool.cleanup().await.unwrap();
    }

    #[tokio::test]
    async fn release_abandoned_delete_consumes_lease_and_clears_tracking() {
        let CountedLifecycle {
            ops, delete_count, ..
        } = untrusted_flush_counted_abandoned_delete_lifecycle();
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        pool.ops = ops;
        let mut lease = Some(pool.checkout(test_info("test-ns")).unwrap());
        let pool = NetnsPool::from_state_for_test(pool);

        let outcome = pool.inner.release_outcome(&mut lease).await;

        assert!(matches!(outcome, NetnsReleaseOutcome::Abandoned));
        assert!(lease.is_none());
        assert_eq!(delete_count.load(Ordering::SeqCst), 1);
        let pool = pool.inner.state.lock().await;
        assert!(pool.in_flight.is_empty());
        assert!(pool.non_reusable.is_empty());
        assert!(pool.plain_queue.is_empty());
    }

    #[tokio::test]
    async fn cleanup_retry_drains_pending_creation_after_cancel() {
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        let entered = std::sync::Arc::new(tokio::sync::Notify::new());
        let release = std::sync::Arc::new(tokio::sync::Notify::new());
        let entered_task = std::sync::Arc::clone(&entered);
        let release_task = std::sync::Arc::clone(&release);
        pool.spawn_plain_creation_for_test(async move {
            entered_task.notify_one();
            release_task.notified().await;
            Ok(test_info("test-ns"))
        });
        let mut pool = NetnsPool::from_state_for_test(pool);

        {
            let cleanup = pool.cleanup();
            tokio::pin!(cleanup);
            tokio::select! {
                result = &mut cleanup => panic!("cleanup completed before pending task was released: {result:?}"),
                _ = wait_for_sync(
                    "pending namespace creation to start before cleanup cancellation",
                    entered.notified(),
                ) => {}
            }
        }

        {
            let pool = pool.inner.state.lock().await;
            assert!(!pool.active);
            assert_eq!(pool.pending_plain.len(), 1);
        }

        release.notify_one();
        pool.cleanup().await.unwrap();

        let pool = pool.inner.state.lock().await;
        assert!(!pool.active);
        assert!(pool.pending_plain.is_empty());
        assert!(pool.plain_queue.is_empty());
    }

    #[tokio::test]
    async fn acquire_cancellation_keeps_pending_creation_for_cleanup() {
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        let entered = std::sync::Arc::new(tokio::sync::Notify::new());
        let release = std::sync::Arc::new(tokio::sync::Notify::new());
        let entered_task = std::sync::Arc::clone(&entered);
        let release_task = std::sync::Arc::clone(&release);
        pool.spawn_plain_creation_for_test(async move {
            entered_task.notify_one();
            release_task.notified().await;
            Ok(test_info("test-ns"))
        });
        let mut pool = NetnsPool::from_state_for_test(pool);

        {
            let acquire = pool.acquire();
            tokio::pin!(acquire);
            tokio::select! {
                result = &mut acquire => panic!("acquire completed before pending task was released: {result:?}"),
                _ = wait_for_sync(
                    "pending namespace creation to start before acquire cancellation",
                    entered.notified(),
                ) => {}
            }
        }

        {
            let pool = pool.inner.state.lock().await;
            assert!(pool.in_flight.is_empty());
            assert_eq!(pool.pending_plain.len(), 1);
        }

        release.notify_one();
        pool.cleanup().await.unwrap();

        let pool = pool.inner.state.lock().await;
        assert!(!pool.active);
        assert!(pool.pending_plain.is_empty());
        assert!(pool.plain_queue.is_empty());
    }

    #[tokio::test]
    async fn delete_queued_namespaces_keeps_front_entry_when_cancelled() {
        let mut queue = VecDeque::from([test_info("test-ns")]);
        let entered = std::sync::Arc::new(tokio::sync::Notify::new());
        let release = std::sync::Arc::new(tokio::sync::Notify::new());

        let delete = {
            let entered = std::sync::Arc::clone(&entered);
            let release = std::sync::Arc::clone(&release);
            move |ns: NetnsInfo| {
                assert_eq!(ns.name(), "test-ns");
                let entered = std::sync::Arc::clone(&entered);
                let release = std::sync::Arc::clone(&release);
                async move {
                    entered.notify_one();
                    release.notified().await;
                }
            }
        };
        {
            let deletion = NetnsPoolState::delete_queued_namespaces_with(&mut queue, delete);
            tokio::pin!(deletion);
            tokio::select! {
                _ = &mut deletion => panic!("delete completed before test released it"),
                _ = wait_for_sync(
                    "queued namespace deletion to start before cancellation",
                    entered.notified(),
                ) => {}
            }
        }

        assert_eq!(queue.len(), 1);
        assert_eq!(queue.front().unwrap().name(), "test-ns");

        release.notify_one();
        NetnsPoolState::delete_queued_namespaces_with(&mut queue, |_| async {}).await;
        assert!(queue.is_empty());
    }

    #[tokio::test]
    async fn cleanup_retries_when_pool_is_inactive_but_not_drained() {
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.plain_queue.push_back(test_info("test-ns"));
        let mut pool = NetnsPool::from_state_for_test(pool);

        pool.cleanup().await.unwrap();

        let pool = pool.inner.state.lock().await;
        assert!(!pool.active);
        assert!(pool.plain_queue.is_empty());
    }

    #[tokio::test]
    async fn cleanup_batches_queued_namespaces_and_dns_filter() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let calls_for_ops = Arc::clone(&calls);
        let ops = NetnsLifecycleOps {
            flush_conntrack: Arc::new(|_| Box::pin(async { ConntrackFlushOutcome::Trusted })),
            delete_network_resources: Arc::new(move |namespaces, dns_comment| {
                let calls = Arc::clone(&calls_for_ops);
                Box::pin(async move {
                    calls.lock().unwrap().push((
                        namespaces
                            .into_iter()
                            .map(|namespace| namespace.name)
                            .collect::<Vec<_>>(),
                        dns_comment,
                    ));
                    NamespaceDeleteOutcome::Deleted
                })
            }),
        };
        let mut state = NetnsPoolState::inactive_for_test();
        state.active = true;
        state.plain_queue.push_back(test_info("plain-ns"));
        state.proxy_queue.push_back(test_info("proxy-ns"));
        state.dns_input_filter_comment = Some("vm0-ns-00-dns".into());
        state.ops = ops;
        let mut pool = NetnsPool::from_state_for_test(state);

        pool.cleanup().await.unwrap();

        let calls = calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, ["plain-ns", "proxy-ns"]);
        assert_eq!(calls[0].1.as_deref(), Some("vm0-ns-00-dns"));
    }

    #[tokio::test]
    async fn cleanup_removes_queued_namespace_after_abandoned_delete() {
        let CountedLifecycle {
            ops, delete_count, ..
        } = trusted_flush_counted_abandoned_delete_lifecycle();
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        pool.plain_queue.push_back(test_info("test-ns"));
        pool.ops = ops;
        let mut pool = NetnsPool::from_state_for_test(pool);

        pool.cleanup().await.unwrap();

        assert_eq!(delete_count.load(Ordering::SeqCst), 1);
        let pool = pool.inner.state.lock().await;
        assert!(!pool.active);
        assert!(pool.plain_queue.is_empty());
    }

    #[tokio::test]
    async fn acquire_rejects_inactive_pool() {
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.plain_queue.push_back(test_info("test-ns"));
        let mut pool = NetnsPool::from_state_for_test(pool);

        let err = pool.acquire().await.unwrap_err();

        assert!(matches!(err, NetworkError::PoolNotActive));
        {
            let pool = pool.inner.state.lock().await;
            assert_eq!(pool.plain_queue.len(), 1);
            assert!(pool.in_flight.is_empty());
        }
        pool.cleanup().await.unwrap();
    }

    #[tokio::test]
    async fn acquire_requeues_namespace_when_checkout_detects_in_flight_duplicate() {
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        pool.in_flight.insert("test-ns".into());
        pool.plain_queue.push_back(test_info("test-ns"));
        let mut pool = NetnsPool::from_state_for_test(pool);

        let err = pool.acquire().await.unwrap_err();

        assert!(matches!(err, NetworkError::InvalidLease(_)));
        {
            let mut pool = pool.inner.state.lock().await;
            assert_eq!(pool.plain_queue.len(), 1);
            assert_eq!(pool.plain_queue.front().unwrap().name(), "test-ns");
            assert!(pool.pending_plain.is_empty());
            assert_eq!(pool.next_ns_index, 0);

            pool.in_flight.clear();
        }
        pool.cleanup().await.unwrap();
    }

    #[tokio::test]
    async fn proxy_acquire_requeues_namespace_when_checkout_detects_in_flight_duplicate() {
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        pool.proxy_port = Some(8080);
        pool.in_flight.insert("test-ns".into());
        pool.proxy_queue.push_back(test_info("test-ns"));
        let mut pool = NetnsPool::from_state_for_test(pool);

        let err = pool.acquire().await.unwrap_err();

        assert!(matches!(err, NetworkError::InvalidLease(_)));
        {
            let mut pool = pool.inner.state.lock().await;
            assert!(pool.plain_queue.is_empty());
            assert_eq!(pool.proxy_queue.len(), 1);
            assert_eq!(pool.proxy_queue.front().unwrap().name(), "test-ns");
            assert!(pool.pending_proxy.is_empty());
            assert_eq!(pool.next_ns_index, 0);

            pool.in_flight.clear();
            pool.proxy_queue.clear();
        }
        pool.cleanup().await.unwrap();
    }

    #[tokio::test]
    async fn release_keeps_lease_when_namespace_already_queued() {
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        let info = test_info("test-ns");
        let mut lease = Some(pool.checkout(info.clone()).unwrap());
        pool.plain_queue.push_back(info);
        let mut pool = NetnsPool::from_state_for_test(pool);

        let err = pool.release(&mut lease).await.unwrap_err();

        assert!(matches!(err, NetworkError::InvalidLease(_)));
        assert!(lease.is_some());
        {
            let pool = pool.inner.state.lock().await;
            assert_eq!(pool.plain_queue.len(), 1);
            assert_eq!(pool.plain_queue.front().unwrap().name(), "test-ns");
        }

        let _ = lease.take().unwrap().into_info_for_test();
        {
            let mut pool = pool.inner.state.lock().await;
            pool.in_flight.clear();
            pool.plain_queue.clear();
        }
        pool.cleanup().await.unwrap();
    }

    #[tokio::test]
    async fn proxy_release_keeps_lease_when_namespace_already_queued() {
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        pool.proxy_port = Some(8080);
        let info = test_info("test-ns");
        let mut lease = Some(pool.checkout(info.clone()).unwrap());
        pool.proxy_queue.push_back(info);
        let mut pool = NetnsPool::from_state_for_test(pool);

        let err = pool.release(&mut lease).await.unwrap_err();

        assert!(matches!(err, NetworkError::InvalidLease(_)));
        assert!(lease.is_some());
        {
            let pool = pool.inner.state.lock().await;
            assert!(pool.plain_queue.is_empty());
            assert_eq!(pool.proxy_queue.len(), 1);
            assert_eq!(pool.proxy_queue.front().unwrap().name(), "test-ns");
        }

        let _ = lease.take().unwrap().into_info_for_test();
        {
            let mut pool = pool.inner.state.lock().await;
            pool.in_flight.clear();
            pool.proxy_queue.clear();
        }
        pool.cleanup().await.unwrap();
    }

    #[tokio::test]
    async fn release_keeps_lease_on_wrong_pool_instance() {
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        let info = test_info("test-ns");
        let mut lease = Some(NetnsLease::new(info, pool.instance_id + 1));
        let mut pool = NetnsPool::from_state_for_test(pool);

        let err = pool.release(&mut lease).await.unwrap_err();

        assert!(matches!(err, NetworkError::InvalidLease(_)));
        assert!(lease.is_some());
        let _ = lease.take().unwrap().into_info_for_test();

        pool.cleanup().await.unwrap();
    }

    #[tokio::test]
    async fn release_keeps_lease_when_not_in_flight() {
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        let info = test_info("test-ns");
        let mut lease = Some(NetnsLease::new(info, pool.instance_id));
        let mut pool = NetnsPool::from_state_for_test(pool);

        let err = pool.release(&mut lease).await.unwrap_err();

        assert!(matches!(err, NetworkError::InvalidLease(_)));
        assert!(lease.is_some());
        let _ = lease.take().unwrap().into_info_for_test();

        pool.cleanup().await.unwrap();
    }
}
