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

    fn retire_release_lease(&mut self, lease: &mut Option<NetnsLease>) -> Option<NetnsInfo> {
        let lease = lease.take()?;
        self.in_flight.remove(lease.name());
        self.non_reusable.remove(lease.name());
        Some(lease.into_info())
    }

    fn commit_release_requeue(
        &mut self,
        lease: &mut Option<NetnsLease>,
        plan: &ReleasePlan,
    ) -> NetnsReleaseOutcome {
        let Some(ns) = self.retire_release_lease(lease) else {
            return NetnsReleaseOutcome::InvalidLease("validated netns lease disappeared".into());
        };

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
        let Some(ns) = self.retire_release_lease(lease) else {
            return NetnsReleaseOutcome::InvalidLease("validated netns lease disappeared".into());
        };
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
    ///
    /// # Cancellation and recovery
    ///
    /// Dropping this future before activation starts leaves readiness unchanged.
    /// Once activation changes `Pending` to `Activating`, dropping the future
    /// before its final commit leaves the pool in `Activating`. While the pool
    /// remains active, both another activation attempt and [`Self::acquire`]
    /// return `PoolDnsNotReady`; DNS becoming healthy does not finish the
    /// abandoned activation.
    ///
    /// To retain the pool, preserve the original future and poll it to completion.
    /// After dropping an in-progress activation future, await [`Self::cleanup`]
    /// according to its best-effort cleanup contract, then discard the pool and
    /// use [`Self::create`] to create a replacement.
    ///
    /// Probe failures handled to completion differ from cancellation: if no
    /// initial namespace passes its probe, activation removes the failed entries,
    /// restores `Pending`, and returns `NoDnsReadyNamespaces`. A returned error
    /// does not guarantee that retrying the same pool can succeed.
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

    /// Clean up queued namespaces and firewall rules on a best-effort basis,
    /// waiting for in-flight background creation tasks so their resources can
    /// also be cleaned up.
    ///
    /// `Ok(())` means the pool has finished processing its tracked cleanup
    /// work; it does not guarantee that all kernel resources have been removed.
    /// Entries are removed from tracking even when namespace or firewall
    /// deletion is abandoned, so another cleanup call on the same instance
    /// does not retry those entries. Remaining resources are left for later
    /// startup orphan reconciliation.
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
mod tests;
