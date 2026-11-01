use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs::File;
use std::future::Future;
use std::os::fd::AsRawFd;
use std::pin::Pin;
use std::sync::Arc;
#[cfg(test)]
use std::sync::atomic::Ordering;
#[cfg(test)]
use std::time::Duration;

use nix::errno::Errno;
use nix::fcntl::{Flock, FlockArg};
use tracing::{error, info, warn};

use crate::command::{
    CommandError, IgnoredCommandOutcome, exec_ignore_errors_with_timeout, exec_status_with_timeout,
    exec_with_timeout,
};
use crate::paths::LockPaths;

use super::super::error::{NetworkError, Result};
use super::super::{GUEST_NETWORK, GuestNetwork};
use super::HOST_NETWORK_COMMAND_TIMEOUT;
use super::firewall::{
    FirewallSnapshot, NamespaceFirewallConfig, apply_namespace_rules, delete_ipv4_rules_by_comment,
    delete_rules_with_comments, setup_namespace_masquerade,
};
use super::naming::{
    MAX_NAMESPACES, MAX_POOLS, format_hex_index, generate_veth_ip_pair, make_host_device,
    make_ns_name, parse_netns_name,
};
use super::types::{NamespaceDeleteOutcome, NetnsInfo};

// Each namespace starts two `ip` children concurrently. A 16-wide window caps
// that fanout at 32 processes. At the 256-namespace hard limit, sixteen
// 10-second waves leave room inside the runner's 300-second systemd stop
// budget for firewall cleanup and the other teardown phases.
const NAMESPACE_DELETE_CONCURRENCY: usize = 16;
const CONNTRACK_ZERO_DELETE_PREFIX: &str = "conntrack v";
const CONNTRACK_ZERO_DELETE_SUFFIX: &str = " (conntrack-tools): 0 flow entries have been deleted.";

/// Peer-side device name inside namespaces (fixed).
const PEER_DEVICE: &str = "veth0";

type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;
type DeleteNetworkResourcesFn =
    dyn Fn(Vec<NetnsInfo>, Option<String>) -> BoxFuture<NamespaceDeleteOutcome> + Send + Sync;

#[derive(Clone)]
pub(super) struct NetnsLifecycleOps {
    pub(super) flush_conntrack:
        Arc<dyn Fn(String) -> BoxFuture<ConntrackFlushOutcome> + Send + Sync>,
    pub(super) delete_network_resources: Arc<DeleteNetworkResourcesFn>,
}

impl Default for NetnsLifecycleOps {
    fn default() -> Self {
        Self {
            flush_conntrack: Arc::new(|peer_ip| {
                Box::pin(async move { flush_conntrack(&peer_ip).await })
            }),
            delete_network_resources: Arc::new(|namespaces, dns_input_filter_comment| {
                Box::pin(async move {
                    delete_network_resources(namespaces, dns_input_filter_comment).await
                })
            }),
        }
    }
}

impl NetnsLifecycleOps {
    pub(super) async fn delete_network_resources(
        &self,
        namespaces: Vec<NetnsInfo>,
        dns_input_filter_comment: Option<String>,
    ) -> NamespaceDeleteOutcome {
        (self.delete_network_resources)(namespaces, dns_input_filter_comment).await
    }
}

#[cfg(test)]
impl NetnsLifecycleOps {
    pub(super) fn trusted_for_test() -> Self {
        Self {
            flush_conntrack: Arc::new(|_| Box::pin(async { ConntrackFlushOutcome::Trusted })),
            delete_network_resources: Arc::new(|_, _| {
                Box::pin(async { NamespaceDeleteOutcome::Deleted })
            }),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ConntrackFlushOutcome {
    Trusted,
    Untrusted,
}

impl ConntrackFlushOutcome {
    pub(super) fn is_trusted(self) -> bool {
        matches!(self, Self::Trusted)
    }
}

fn namespace_delete_outcome_from_best_effort(
    outcomes: impl IntoIterator<Item = IgnoredCommandOutcome>,
) -> NamespaceDeleteOutcome {
    if outcomes
        .into_iter()
        .all(|outcome| outcome.completed_without_timeout())
    {
        NamespaceDeleteOutcome::Deleted
    } else {
        NamespaceDeleteOutcome::Abandoned
    }
}

/// Shorthand: run `ip <args>`, discard stdout.
async fn exec_ip(args: &[&str]) -> Result<()> {
    exec_status_with_timeout("ip", args, HOST_NETWORK_COMMAND_TIMEOUT).await?;
    Ok(())
}

pub(super) async fn enable_host_ip_forwarding() -> Result<()> {
    exec_status_with_timeout(
        "sysctl",
        &["-w", "net.ipv4.ip_forward=1"],
        HOST_NETWORK_COMMAND_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Create a network namespace with a TAP device.
async fn create_netns_with_tap(
    ns_name: &str,
    tap_name: &str,
    tap_mac: &str,
    gateway_ip_with_prefix: &str,
) -> Result<()> {
    exec_ip(&["netns", "add", ns_name]).await?;
    exec_ip(&[
        "netns", "exec", ns_name, "ip", "tuntap", "add", tap_name, "mode", "tap",
    ])
    .await?;
    // Set a fixed MAC so guest ARP cache from snapshots stays valid after restore.
    exec_ip(&[
        "netns", "exec", ns_name, "ip", "link", "set", tap_name, "address", tap_mac,
    ])
    .await?;
    exec_ip(&[
        "netns",
        "exec",
        ns_name,
        "ip",
        "addr",
        "add",
        gateway_ip_with_prefix,
        "dev",
        tap_name,
    ])
    .await?;
    exec_ip(&[
        "netns", "exec", ns_name, "ip", "link", "set", tap_name, "up",
    ])
    .await?;
    exec_ip(&["netns", "exec", ns_name, "ip", "link", "set", "lo", "up"]).await?;
    Ok(())
}

/// Add a veth pair connecting the namespace to the host.
async fn setup_veth_pair(
    name: &str,
    host_device: &str,
    host_mac: &str,
    host_ip: &str,
    peer_ip: &str,
) -> Result<()> {
    let peer_cidr = format!("{peer_ip}/30");
    let host_cidr = format!("{host_ip}/30");
    exec_ip(&[
        "link",
        "add",
        host_device,
        "address",
        host_mac,
        "type",
        "veth",
        "peer",
        "name",
        PEER_DEVICE,
        "netns",
        name,
    ])
    .await?;
    exec_ip(&[
        "netns",
        "exec",
        name,
        "ip",
        "addr",
        "add",
        &peer_cidr,
        "dev",
        PEER_DEVICE,
    ])
    .await?;
    exec_ip(&[
        "netns",
        "exec",
        name,
        "ip",
        "link",
        "set",
        PEER_DEVICE,
        "up",
    ])
    .await?;
    exec_ip(&["addr", "add", &host_cidr, "dev", host_device]).await?;
    exec_ip(&["link", "set", host_device, "up"]).await?;
    Ok(())
}

/// Configure routing, NAT, and IP forwarding inside the namespace.
async fn setup_namespace_routing(
    name: &str,
    host_ip: &str,
    gateway_ip: &str,
    prefix_len: u8,
) -> Result<()> {
    let src = format!("{gateway_ip}/{prefix_len}");
    exec_ip(&[
        "netns", "exec", name, "ip", "route", "add", "default", "via", host_ip,
    ])
    .await?;
    setup_namespace_masquerade(name, &src, PEER_DEVICE).await?;
    exec_ip(&[
        "netns",
        "exec",
        name,
        "sysctl",
        "-w",
        "net.ipv4.ip_forward=1",
    ])
    .await?;
    Ok(())
}

pub(super) async fn get_default_interface() -> Result<String> {
    let result = exec_with_timeout(
        "ip",
        &["route", "get", "8.8.8.8"],
        HOST_NETWORK_COMMAND_TIMEOUT,
    )
    .await?;
    let iface = result
        .split_whitespace()
        .skip_while(|&w| w != "dev")
        .nth(1)
        .map(String::from)
        .ok_or(NetworkError::NoDefaultInterface(result))?;
    Ok(iface)
}

/// Delete a namespace's network resources (iptables, veth, netns).
async fn delete_namespace_resources(ns_name: &str, host_device: &str) -> NamespaceDeleteOutcome {
    info!(name = %ns_name, "deleting namespace");
    let iptables = delete_ipv4_rules_by_comment(ns_name).await;
    let outcome = delete_namespace_link_and_netns(ns_name, host_device).await;
    if matches!(iptables, NamespaceDeleteOutcome::Deleted)
        && matches!(outcome, NamespaceDeleteOutcome::Deleted)
    {
        info!(name = %ns_name, "namespace deleted");
        NamespaceDeleteOutcome::Deleted
    } else {
        warn!(
            name = %ns_name,
            host_device,
            "namespace cleanup did not complete cleanly; startup orphan reconciliation will retry"
        );
        NamespaceDeleteOutcome::Abandoned
    }
}

/// Delete a known batch of namespace resources from one firewall snapshot.
///
/// Pool shutdown reaches this path with every currently queued namespace, so
/// reading each complete firewall table once avoids multiplying host-wide
/// discovery by the pool size. The optional DNS comment is captured and
/// deleted in the same pass once no namespace creation remains pending.
async fn delete_network_resources(
    namespaces: Vec<NetnsInfo>,
    dns_input_filter_comment: Option<String>,
) -> NamespaceDeleteOutcome {
    if namespaces.is_empty() && dns_input_filter_comment.is_none() {
        return NamespaceDeleteOutcome::Deleted;
    }

    let mut comments: BTreeSet<String> = namespaces
        .iter()
        .map(|namespace| namespace.name.clone())
        .collect();
    let includes_ipv6 = dns_input_filter_comment.is_some();
    if let Some(comment) = dns_input_filter_comment {
        comments.insert(comment);
    }

    let firewall = delete_rules_with_comments(&comments, includes_ipv6).await;

    let namespace_outcome = delete_namespace_resources_bounded(
        namespaces
            .into_iter()
            .map(NamespaceResources::from)
            .collect(),
    )
    .await;
    NamespaceDeleteOutcome::combine([firewall, namespace_outcome])
}

async fn delete_namespace_resources_bounded(
    namespaces: Vec<NamespaceResources>,
) -> NamespaceDeleteOutcome {
    delete_namespace_resources_bounded_with(namespaces, |name, host_device| async move {
        delete_namespace_link_and_netns(&name, &host_device).await
    })
    .await
}

async fn delete_namespace_resources_bounded_with<F, Fut>(
    namespaces: Vec<NamespaceResources>,
    delete: F,
) -> NamespaceDeleteOutcome
where
    F: Fn(String, String) -> Fut + Clone + Send + 'static,
    Fut: Future<Output = NamespaceDeleteOutcome> + Send + 'static,
{
    let count = namespaces.len();
    if count == 0 {
        return NamespaceDeleteOutcome::Deleted;
    }

    info!(
        count,
        concurrency = NAMESPACE_DELETE_CONCURRENCY,
        "deleting namespace resource batch"
    );
    let mut pending = namespaces.into_iter();
    let mut tasks = tokio::task::JoinSet::new();
    let mut in_flight = HashMap::new();

    while tasks.len() < NAMESPACE_DELETE_CONCURRENCY {
        let Some(namespace) = pending.next() else {
            break;
        };
        spawn_namespace_resource_delete(&mut tasks, &mut in_flight, namespace, delete.clone());
    }

    let mut outcome = NamespaceDeleteOutcome::Deleted;
    let mut failed = 0_usize;
    while let Some(result) = tasks.join_next_with_id().await {
        let task_id = match &result {
            Ok((task_id, _)) => *task_id,
            Err(error) => error.id(),
        };
        let namespace = in_flight.remove(&task_id);

        match (namespace, result) {
            (Some(_), Ok((_, NamespaceDeleteOutcome::Deleted))) => {}
            (Some(namespace), Ok((_, NamespaceDeleteOutcome::Abandoned))) => {
                warn!(
                    name = %namespace.name,
                    host_device = %namespace.host_device,
                    "namespace cleanup did not complete cleanly; startup orphan reconciliation will retry"
                );
                outcome = NamespaceDeleteOutcome::Abandoned;
                failed += 1;
            }
            (Some(namespace), Err(error)) => {
                warn!(
                    name = %namespace.name,
                    host_device = %namespace.host_device,
                    %error,
                    "namespace cleanup task did not complete cleanly; startup orphan reconciliation will retry"
                );
                outcome = NamespaceDeleteOutcome::Abandoned;
                failed += 1;
            }
            (None, result) => {
                warn!(
                    task_id = %task_id,
                    result = ?result,
                    "namespace cleanup task lost its resource metadata; startup orphan reconciliation will retry"
                );
                outcome = NamespaceDeleteOutcome::Abandoned;
                failed += 1;
            }
        }

        if let Some(namespace) = pending.next() {
            spawn_namespace_resource_delete(&mut tasks, &mut in_flight, namespace, delete.clone());
        }
    }

    for (_, namespace) in in_flight {
        warn!(
            name = %namespace.name,
            host_device = %namespace.host_device,
            "namespace cleanup task was not joined; startup orphan reconciliation will retry"
        );
        outcome = NamespaceDeleteOutcome::Abandoned;
        failed += 1;
    }

    if matches!(outcome, NamespaceDeleteOutcome::Deleted) {
        info!(count, "namespace resource batch deleted");
    } else {
        warn!(
            count,
            failed,
            "namespace resource batch cleanup was abandoned; startup orphan reconciliation will retry"
        );
    }
    outcome
}

fn spawn_namespace_resource_delete<F, Fut>(
    tasks: &mut tokio::task::JoinSet<NamespaceDeleteOutcome>,
    in_flight: &mut HashMap<tokio::task::Id, NamespaceResources>,
    namespace: NamespaceResources,
    delete: F,
) where
    F: Fn(String, String) -> Fut + Send + 'static,
    Fut: Future<Output = NamespaceDeleteOutcome> + Send + 'static,
{
    let name = namespace.name.clone();
    let host_device = namespace.host_device.clone();
    let task = tasks.spawn(async move { delete(name, host_device).await });
    let replaced = in_flight.insert(task.id(), namespace);
    debug_assert!(replaced.is_none());
}

/// Delete the host veth and netns only; callers handle host iptables separately.
async fn delete_namespace_link_and_netns(
    ns_name: &str,
    host_device: &str,
) -> NamespaceDeleteOutcome {
    let del_link_args = ["link", "del", host_device];
    let del_ns_args = ["netns", "del", ns_name];
    let (link, netns) = tokio::join!(
        exec_ignore_errors_with_timeout("ip", &del_link_args, HOST_NETWORK_COMMAND_TIMEOUT),
        exec_ignore_errors_with_timeout("ip", &del_ns_args, HOST_NETWORK_COMMAND_TIMEOUT),
    );
    namespace_delete_outcome_from_best_effort([link, netns])
}

/// Flush conntrack entries for a given IP address.
///
/// Peer IPs are reused across VM attachments and runner lifecycles. Without
/// flushing, stale conntrack entries from a previous owner can cause the
/// stateful iptables rule (`-m state --state RELATED,ESTABLISHED`) or a NAT
/// redirect to misroute or silently drop packets for the next owner.
async fn flush_conntrack(peer_ip: &str) -> ConntrackFlushOutcome {
    let src_args = ["-D", "-s", peer_ip];
    let dst_args = ["-D", "-d", peer_ip];
    let (src, dst) = tokio::join!(
        exec_status_with_timeout("conntrack", &src_args, HOST_NETWORK_COMMAND_TIMEOUT),
        exec_status_with_timeout("conntrack", &dst_args, HOST_NETWORK_COMMAND_TIMEOUT),
    );
    if conntrack_flush_is_trusted(&src, &dst) {
        ConntrackFlushOutcome::Trusted
    } else {
        warn!(
            peer_ip,
            src = ?src,
            dst = ?dst,
            "conntrack reset failed or timed out; peer network state is untrusted"
        );
        ConntrackFlushOutcome::Untrusted
    }
}

fn conntrack_flush_is_trusted(
    src: &std::result::Result<(), CommandError>,
    dst: &std::result::Result<(), CommandError>,
) -> bool {
    conntrack_delete_is_trusted(src) && conntrack_delete_is_trusted(dst)
}

/// `conntrack -D` exits 1 both when no flows match and for operational errors.
/// Only its standard zero-delete summary proves the former case.
fn conntrack_delete_is_trusted(result: &std::result::Result<(), CommandError>) -> bool {
    let Err(error) = result else {
        return true;
    };
    if error.exit_code != Some(1) {
        return false;
    }
    let Some(version) = error
        .detail
        .strip_prefix(CONNTRACK_ZERO_DELETE_PREFIX)
        .and_then(|detail| detail.strip_suffix(CONNTRACK_ZERO_DELETE_SUFFIX))
    else {
        return false;
    };
    !version.is_empty() && !version.chars().any(char::is_whitespace)
}

// ---------------------------------------------------------------------------
// Pool index lock
// ---------------------------------------------------------------------------

/// Exclusive pool-index flock released when the final file descriptor closes.
///
/// Unlike [`Flock`], this guard does not issue an explicit `LOCK_UN` on drop.
/// That lets a privileged integration test duplicate the open file description
/// and retain ownership while it verifies shutdown cleanup.
#[derive(Debug)]
pub(super) struct PoolIndexLock {
    _file: File,
}

impl PoolIndexLock {
    pub(super) fn try_lock(file: File) -> std::result::Result<Self, (File, Errno)> {
        // SAFETY: `file` owns a valid descriptor for the duration of the call.
        let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if result == 0 {
            Ok(Self { _file: file })
        } else {
            Err((file, Errno::last()))
        }
    }
}

/// Try to acquire an exclusive flock on a pool index file (0..MAX_POOLS).
///
/// Returns the first successfully locked `(index, PoolIndexLock)`. The lock is
/// held until the final descriptor for its open file description closes.
pub(super) fn acquire_pool_lock(locks: &LockPaths) -> Result<(u32, PoolIndexLock)> {
    for index in 0..MAX_POOLS {
        let path = locks.netns_pool(index);
        // Open for writing without O_CREAT first, fall back to create.
        // This avoids EACCES from fs.protected_regular=2 on sticky-bit
        // directories (/var/lock) when the file is owned by another user.
        let file = match File::options().write(true).open(&path).or_else(|_| {
            File::options()
                .write(true)
                .create(true)
                .truncate(false)
                .open(&path)
        }) {
            Ok(f) => f,
            Err(e) => {
                // Skip indices whose lock file is inaccessible (e.g. owned by
                // another user under fs.protected_regular=2).
                warn!(index, %e, "cannot open pool lock, skipping index");
                continue;
            }
        };
        match PoolIndexLock::try_lock(file) {
            Ok(lock) => {
                info!(index, "acquired pool index lock");
                return Ok((index, lock));
            }
            Err((_, errno)) => {
                if errno != nix::errno::Errno::EWOULDBLOCK {
                    warn!(index, %errno, "unexpected flock error, skipping index");
                }
                continue;
            }
        }
    }

    Err(NetworkError::NoPoolIndexAvailable)
}

// ---------------------------------------------------------------------------
// Namespace creation
// ---------------------------------------------------------------------------

/// Create a single namespace with full connectivity, optionally adding a proxy
/// REDIRECT rule for outbound TCP traffic.
///
/// When DNS proxying is enabled, the general proxy redirect excludes TCP 53
/// and 853: TCP 53 is redirected to the DNS proxy, while TCP 853 is blocked.
///
/// This is a free function (no `&self`) so it can be spawned on a `JoinSet`.
pub(super) async fn create_single_namespace(
    pool_index: u32,
    ns_index: u32,
    default_iface: String,
    proxy_port: Option<u16>,
    dns_port: Option<u16>,
) -> Result<NetnsInfo> {
    if ns_index >= MAX_NAMESPACES {
        return Err(NetworkError::NamespaceLimitReached {
            max: MAX_NAMESPACES,
        });
    }

    let pool_idx_str = format_hex_index(pool_index);
    let ns_idx_str = format_hex_index(ns_index);
    let ns_name = make_ns_name(&pool_idx_str, &ns_idx_str);
    let host_device = make_host_device(&pool_idx_str, &ns_idx_str);
    // Pool and namespace bytes keep the root-veth MAC unique on this host.
    // Supplying it in RTM_NEWLINK prevents a later udev rewrite after neighbor learning.
    let host_mac = format!("02:56:4d:{pool_idx_str}:{ns_idx_str}:01");
    let (host_ip, peer_ip) = generate_veth_ip_pair(pool_index, ns_index);

    info!(name = %ns_name, proxy = proxy_port.is_some(), "creating namespace");

    let sn = &GUEST_NETWORK;
    let result = create_namespace_inner(
        &ns_name,
        &host_device,
        &host_mac,
        &host_ip,
        &peer_ip,
        sn,
        NamespaceFirewallConfig {
            default_iface: &default_iface,
            proxy_port,
            dns_port,
        },
    )
    .await;

    match result {
        Ok(()) => {
            info!(name = %ns_name, "namespace created");
            Ok(NetnsInfo::new(ns_name, host_device, peer_ip))
        }
        Err(e) => {
            error!(name = %ns_name, error = %e, "failed to create namespace, cleaning up");
            delete_namespace_resources(&ns_name, &host_device).await;
            Err(e)
        }
    }
}

/// Inner namespace creation — orchestrates TAP, veth, routing, and iptables setup.
async fn create_namespace_inner(
    name: &str,
    host_device: &str,
    host_mac: &str,
    host_ip: &str,
    peer_ip: &str,
    sn: &GuestNetwork,
    firewall_config: NamespaceFirewallConfig<'_>,
) -> Result<()> {
    let gw_with_prefix = format!("{}/{}", sn.gateway_ip, sn.prefix_len);
    create_netns_with_tap(name, sn.tap_name, sn.tap_mac, &gw_with_prefix).await?;
    setup_veth_pair(name, host_device, host_mac, host_ip, peer_ip).await?;
    setup_namespace_routing(name, host_ip, sn.gateway_ip, sn.prefix_len).await?;
    apply_namespace_rules(name, host_device, peer_ip, firewall_config).await?;

    Ok(())
}

#[derive(Debug)]
enum SnapshotSource<T> {
    Captured(T),
    Abandoned,
}

#[derive(Clone, Debug)]
struct NamespaceResources {
    name: String,
    host_device: String,
}

impl From<NetnsInfo> for NamespaceResources {
    fn from(namespace: NetnsInfo) -> Self {
        Self {
            name: namespace.name,
            host_device: namespace.host_device,
        }
    }
}

#[derive(Debug)]
struct ReconciliationSnapshot {
    firewall: FirewallSnapshot,
    namespaces_by_pool: SnapshotSource<BTreeMap<u32, Vec<NamespaceResources>>>,
}

impl ReconciliationSnapshot {
    async fn capture() -> Self {
        let (firewall, namespaces) =
            tokio::join!(FirewallSnapshot::capture(), capture_namespaces());
        Self {
            firewall,
            namespaces_by_pool: namespaces,
        }
    }

    fn candidate_pool_indexes(&self, own_index: u32) -> BTreeSet<u32> {
        let mut indexes = BTreeSet::from([own_index]);
        self.firewall.extend_candidate_pool_indexes(&mut indexes);
        if let SnapshotSource::Captured(namespaces_by_pool) = &self.namespaces_by_pool {
            indexes.extend(namespaces_by_pool.keys().copied());
        }
        indexes
    }
}

async fn capture_namespaces() -> SnapshotSource<BTreeMap<u32, Vec<NamespaceResources>>> {
    let output =
        match exec_with_timeout("ip", &["netns", "list"], HOST_NETWORK_COMMAND_TIMEOUT).await {
            Ok(output) => output,
            Err(error) => {
                error!(%error, "failed to capture namespaces for startup reconciliation");
                return SnapshotSource::Abandoned;
            }
        };

    let mut namespaces_by_pool: BTreeMap<u32, Vec<NamespaceResources>> = BTreeMap::new();
    for name in output
        .lines()
        .filter_map(|line| line.split_whitespace().next())
    {
        let Some(parsed) = parse_netns_name(name) else {
            continue;
        };
        let pool_idx = format_hex_index(parsed.pool_index);
        let ns_idx = format_hex_index(parsed.namespace_index);
        namespaces_by_pool
            .entry(parsed.pool_index)
            .or_default()
            .push(NamespaceResources {
                name: name.to_string(),
                host_device: make_host_device(&pool_idx, &ns_idx),
            });
    }
    SnapshotSource::Captured(namespaces_by_pool)
}

/// Clean up all captured resources matching a given pool index.
///
/// Deletes orphaned host firewall rules first, then deletes captured
/// namespaces and their veth devices. An abandoned snapshot remains abandoned;
/// cleanup never expands one failed host read into per-namespace table scans.
async fn cleanup_namespaces_from_snapshot(
    snapshot: &ReconciliationSnapshot,
    index: u32,
) -> NamespaceDeleteOutcome {
    let firewall = snapshot.firewall.delete_pool_rules(index).await;
    let SnapshotSource::Captured(namespaces_by_pool) = &snapshot.namespaces_by_pool else {
        return NamespaceDeleteOutcome::Abandoned;
    };
    let Some(namespaces) = namespaces_by_pool.get(&index) else {
        return firewall;
    };

    let idx_str = format_hex_index(index);
    info!(count = namespaces.len(), index = %idx_str, "cleaning up orphaned namespaces");
    let namespace_outcome = delete_namespace_resources_bounded(namespaces.clone()).await;
    NamespaceDeleteOutcome::combine([firewall, namespace_outcome])
}

/// Clean orphans from `own_index` and captured pool indexes with no active
/// owner.
///
/// `NetnsPool::cleanup` is best-effort — SIGKILL, panic, OOM, power loss,
/// and aborted in-flight creation tasks can all leave kernel resources
/// alive after a runner exits. This function is the correctness guarantee for
/// `own_index`: every startup captures host resources once and cleans the
/// acquired index before reuse. Captured resources under other indexes are
/// deleted only after their flock proves that they have no active owner.
///
/// `_own_lock` is a borrow witness — taking it proves the caller holds a
/// pool-index flock, which is the permission required to do kernel-side
/// cleanup on `own_index` without first re-flocking it.
pub(super) async fn reconcile_orphan_namespaces(
    locks: &LockPaths,
    own_index: u32,
    _own_lock: &PoolIndexLock,
) {
    let snapshot = ReconciliationSnapshot::capture().await;
    let candidate_indexes = snapshot.candidate_pool_indexes(own_index);
    let candidate_count = candidate_indexes.len();

    // Own index: critical-path cleanup. Warm-up immediately afterwards
    // starts at ns_index 0 and will collide with any surviving orphan.
    // Cleanup remains best-effort. If it is abandoned, the EEXIST that
    // warm-up's `ip netns add` produces is the diagnostic, chronologically
    // paired with the warning at the cleanup site. See #10826 for the full
    // analysis (closed as won't-fix).
    let own_outcome = cleanup_namespaces_from_snapshot(&snapshot, own_index).await;

    // Other captured indexes: advisory cleanup for arbitrary prior runners.
    // The snapshot only discovers candidates; a current flock remains the
    // authority to mutate resources for an index. A missed or failed cleanup
    // is retried when a future runner directly acquires that index.
    let mut reconciled = 1_usize;
    let mut skipped = 0_usize;
    let mut abandoned = usize::from(matches!(own_outcome, NamespaceDeleteOutcome::Abandoned));
    for index in candidate_indexes {
        if index == own_index {
            continue;
        }
        let Some(_guard) = try_claim_idle_pool_lock(locks, index) else {
            skipped += 1;
            continue;
        };
        info!(index, "reconciling orphaned namespaces from idle pool");
        let outcome = cleanup_namespaces_from_snapshot(&snapshot, index).await;
        reconciled += 1;
        abandoned += usize::from(matches!(outcome, NamespaceDeleteOutcome::Abandoned));
        // `_guard` drops here, releasing the lock before the next iteration
        // so a concurrently-starting runner can immediately claim the index.
    }
    info!(
        own_index,
        candidate_count,
        reconciled,
        skipped,
        abandoned,
        "startup namespace reconciliation complete"
    );
}

/// Try to acquire a non-blocking flock on an existing pool lock file.
///
/// Returns `None` when the file is missing (index never used, no orphans
/// possible) or when the lock is held by another runner (active owner,
/// off-limits). Returns `Some(guard)` otherwise; dropping the guard
/// releases the lock.
fn try_claim_idle_pool_lock(locks: &LockPaths, index: u32) -> Option<Flock<File>> {
    let path = locks.netns_pool(index);
    // Do NOT create the file — a missing lock file means this index was
    // never used, so there is nothing to reconcile.
    let file = File::options().write(true).open(&path).ok()?;
    Flock::lock(file, FlockArg::LockExclusiveNonblock).ok()
}

#[cfg(test)]
mod tests;
