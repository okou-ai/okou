use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;

use tracing::{info, warn};

use crate::command::{CommandError, exec_status_with_timeout, exec_with_timeout};

use super::super::error::{NetworkError, Result};
use super::HOST_NETWORK_COMMAND_TIMEOUT;
use super::naming::{
    MAX_POOLS, NS_PREFIX, format_hex_index, make_host_device_iptables_pattern,
    make_pool_dns_filter_comment, parse_netns_name,
};
use super::types::NamespaceDeleteOutcome;

/// Configuration for one namespace's host firewall transaction.
#[derive(Clone, Copy)]
pub(super) struct NamespaceFirewallConfig<'a> {
    pub(super) default_iface: &'a str,
    pub(super) proxy_port: Option<u16>,
    pub(super) dns_port: Option<u16>,
}

/// Captured host firewall state reused across orphan reconciliation.
#[derive(Debug)]
pub(super) struct FirewallSnapshot {
    ipv4: Ipv4FirewallSnapshot,
    ipv6_filter: FirewallTableSnapshot,
}

/// Observe and restrict the runner-managed DNS port by pool-facing interface.
///
/// dnsmasq's default socket mode avoids per-address listener churn by using
/// wildcard sockets. These INPUT rules preserve the old kernel-level listener
/// isolation: public, management, and other runners' interfaces see the port as
/// unreachable, while REDIRECT traffic arriving on this pool's veths increments
/// a counter-only rule and continues to dnsmasq under the later INPUT policy.
/// Both address families are covered because dnsmasq can create IPv4 and IPv6
/// wildcard sockets.
pub(super) async fn setup_dns_input_filter(pool_index: u32, dns_port: u16) -> Result<String> {
    let pool_idx = format_hex_index(pool_index);
    let interface = make_host_device_iptables_pattern(&pool_idx);
    let comment = make_pool_dns_filter_comment(pool_index);
    let firewall = vec![FirewallRestoreTable {
        table: "filter",
        rules: ["udp", "tcp"]
            .into_iter()
            .flat_map(|protocol| {
                [
                    format!(
                        "-I INPUT 1 -i {interface} -p {protocol} --dport {dns_port} -m comment --comment {comment}"
                    ),
                    format!(
                        "-I INPUT 1 ! -i {interface} -p {protocol} --dport {dns_port} -m comment --comment {comment} -j REJECT"
                    ),
                ]
            })
            .collect(),
    }];
    let (ipv4, ipv6) = tokio::join!(
        apply_firewall_rules_with_restore("iptables-restore", &firewall),
        apply_firewall_rules_with_restore("ip6tables-restore", &firewall),
    );
    if let Err(error) = ipv4.and(ipv6) {
        if matches!(
            delete_pool_firewall_rules_by_comment(&comment).await,
            NamespaceDeleteOutcome::Abandoned
        ) {
            warn!(
                comment,
                "failed to roll back partial DNS input filter; startup orphan reconciliation will retry"
            );
        }
        return Err(error);
    }

    info!(dns_port, interface, comment, "DNS input filter installed");
    Ok(comment)
}

/// Add the namespace-local masquerade rule with the shared xtables wait policy.
pub(super) async fn setup_namespace_masquerade(
    name: &str,
    source: &str,
    peer_device: &str,
) -> Result<()> {
    let mut args = vec!["netns", "exec", name, "iptables"];
    args.extend(xtables_args(&[
        "-t",
        "nat",
        "-A",
        "POSTROUTING",
        "-s",
        source,
        "-o",
        peer_device,
        "-j",
        "MASQUERADE",
    ]));
    exec_status_with_timeout("ip", &args, HOST_NETWORK_COMMAND_TIMEOUT).await?;
    Ok(())
}

/// Apply the complete host firewall transaction for one namespace.
pub(super) async fn apply_namespace_rules(
    name: &str,
    host_device: &str,
    peer_ip: &str,
    config: NamespaceFirewallConfig<'_>,
) -> Result<()> {
    let firewall = namespace_firewall_restore_tables(name, host_device, peer_ip, config);
    apply_firewall_rules_with_restore("iptables-restore", &firewall).await
}

/// Delete IPv4 firewall rules with the exact `comment`.
pub(super) async fn delete_ipv4_rules_by_comment(comment: &str) -> NamespaceDeleteOutcome {
    Ipv4FirewallSnapshot::capture()
        .await
        .delete_rules_with_comments(&BTreeSet::from([comment.to_string()]))
        .await
}

/// Delete pool-scoped IPv4 and IPv6 firewall rules with the exact `comment`.
async fn delete_pool_firewall_rules_by_comment(comment: &str) -> NamespaceDeleteOutcome {
    FirewallSnapshot::capture()
        .await
        .delete_rules_with_comments(&BTreeSet::from([comment.to_string()]))
        .await
}

/// Capture once and delete every firewall rule matching `comments`.
pub(super) async fn delete_rules_with_comments(
    comments: &BTreeSet<String>,
    includes_ipv6: bool,
) -> NamespaceDeleteOutcome {
    if includes_ipv6 {
        FirewallSnapshot::capture()
            .await
            .delete_rules_with_comments(comments)
            .await
    } else {
        Ipv4FirewallSnapshot::capture()
            .await
            .delete_rules_with_comments(comments)
            .await
    }
}

impl FirewallSnapshot {
    pub(super) async fn capture() -> Self {
        let (ipv4, ipv6_filter) = tokio::join!(
            Ipv4FirewallSnapshot::capture(),
            capture_firewall_table("ip6tables-save", "filter"),
        );
        Self { ipv4, ipv6_filter }
    }

    pub(super) fn extend_candidate_pool_indexes(&self, indexes: &mut BTreeSet<u32>) {
        self.ipv4.extend_candidate_pool_indexes(indexes);
        extend_candidate_pool_indexes(&self.ipv6_filter, indexes);
    }

    pub(super) async fn delete_pool_rules(&self, pool_index: u32) -> NamespaceDeleteOutcome {
        let ipv6 = firewall_restore_tables_for_pool([&self.ipv6_filter], pool_index);
        let (ipv4, ipv6_filter) = tokio::join!(
            self.ipv4.delete_pool_rules(pool_index),
            delete_firewall_restore_selection("ip6tables-restore", ipv6),
        );
        NamespaceDeleteOutcome::combine([ipv4, ipv6_filter])
    }

    async fn delete_rules_with_comments(
        &self,
        comments: &BTreeSet<String>,
    ) -> NamespaceDeleteOutcome {
        let ipv6 = firewall_restore_tables_with_comments([&self.ipv6_filter], comments);
        let (ipv4, ipv6_filter) = tokio::join!(
            self.ipv4.delete_rules_with_comments(comments),
            delete_firewall_restore_selection("ip6tables-restore", ipv6),
        );
        NamespaceDeleteOutcome::combine([ipv4, ipv6_filter])
    }
}

/// Prepend an unbounded xtables lock wait to a mutating firewall command.
///
/// The surrounding command timeout remains the sole deadline so an exhausted
/// wait is classified as a timeout instead of a completed non-zero exit.
fn xtables_args<'a>(args: &[&'a str]) -> Vec<&'a str> {
    let mut waited_args = Vec::with_capacity(args.len() + 1);
    waited_args.push("--wait");
    waited_args.extend_from_slice(args);
    waited_args
}

async fn exec_xtables_status_with_timeout(
    program: &str,
    args: &[&str],
    timeout: std::time::Duration,
) -> std::result::Result<(), CommandError> {
    let args = xtables_args(args);
    exec_status_with_timeout(program, &args, timeout).await
}

fn namespace_firewall_restore_tables(
    name: &str,
    host_device: &str,
    peer_ip: &str,
    config: NamespaceFirewallConfig<'_>,
) -> Vec<FirewallRestoreTable> {
    let NamespaceFirewallConfig {
        default_iface,
        proxy_port,
        dns_port,
    } = config;
    let peer = format!("{peer_ip}/32");

    // Reject forged source addresses before conntrack and NAT attribute them
    // to this namespace. This remains independent of host rp_filter settings.
    let raw = vec![format!(
        "-I PREROUTING 1 -i {host_device} ! -s {peer} -m comment --comment {name} -j DROP"
    )];

    // Establish the base outbound and return paths before inserting the
    // optional logging and DNS guards ahead of the terminating ACCEPT rules.
    let mut nat = vec![format!(
        "-A POSTROUTING -s {peer} -o {default_iface} -j MASQUERADE -m comment --comment {name}"
    )];
    let mut filter = vec![
        format!(
            "-A FORWARD -i {host_device} -s {peer} -o {default_iface} -j ACCEPT -m comment --comment {name}"
        ),
        format!(
            "-A FORWARD -i {default_iface} -o {host_device} -d {peer} -m state --state RELATED,ESTABLISHED -j ACCEPT -m comment --comment {name}"
        ),
    ];

    if let Some(port) = proxy_port {
        // The dedicated DNS rules own ports 53 and 853 when DNS proxying is
        // enabled; otherwise all outbound TCP keeps the proxy behavior.
        let dns_exclusions = if dns_port.is_some() {
            " -m multiport ! --dports 53,853"
        } else {
            ""
        };
        nat.push(format!(
            "-A PREROUTING -i {host_device} -s {peer} -p tcp{dns_exclusions} -j REDIRECT --to-port {port} -m comment --comment {name}"
        ));
        // LOG is non-terminating and must precede the ACCEPT rules.
        filter.push(format!(
            "-I FORWARD 1 -i {host_device} -s {peer} ! -p tcp -m limit --limit 10/sec --limit-burst 50 -j LOG --log-prefix VM0:{peer_ip}: --log-level 4 -m comment --comment {name}"
        ));
    }

    if let Some(port) = dns_port {
        // Redirect standard DNS to dnsmasq, then block attempts to bypass it
        // over external DNS and DNS-over-TLS forwarding paths.
        for protocol in ["udp", "tcp"] {
            nat.push(format!(
                "-A PREROUTING -i {host_device} -s {peer} -p {protocol} --dport 53 -j REDIRECT --to-port {port} -m comment --comment {name}"
            ));
        }
        for (protocol, port) in [("udp", "53"), ("tcp", "53"), ("tcp", "853")] {
            filter.push(format!(
                "-I FORWARD 1 -i {host_device} -s {peer} -p {protocol} --dport {port} -j DROP -m comment --comment {name}"
            ));
        }
    }

    vec![
        FirewallRestoreTable {
            table: "raw",
            rules: raw,
        },
        FirewallRestoreTable {
            table: "nat",
            rules: nat,
        },
        FirewallRestoreTable {
            table: "filter",
            rules: filter,
        },
    ]
}

#[derive(Debug)]
enum SnapshotSource<T> {
    Captured(T),
    Abandoned,
}

#[derive(Debug)]
struct FirewallTableSnapshot {
    table: &'static str,
    rules_by_pool: SnapshotSource<BTreeMap<u32, Vec<String>>>,
}

#[derive(Clone, Debug)]
struct FirewallRestoreTable {
    table: &'static str,
    rules: Vec<String>,
}

struct FirewallRestoreSelection {
    tables: Vec<FirewallRestoreTable>,
    source_outcome: NamespaceDeleteOutcome,
}

#[derive(Clone, Copy)]
enum FirewallRestoreMode {
    Apply,
    Delete,
}

#[derive(Debug)]
struct Ipv4FirewallSnapshot {
    raw: FirewallTableSnapshot,
    nat: FirewallTableSnapshot,
    filter: FirewallTableSnapshot,
}

impl Ipv4FirewallSnapshot {
    async fn capture() -> Self {
        let (raw, nat, filter) = tokio::join!(
            capture_firewall_table("iptables-save", "raw"),
            capture_firewall_table("iptables-save", "nat"),
            capture_firewall_table("iptables-save", "filter"),
        );
        Self { raw, nat, filter }
    }

    fn extend_candidate_pool_indexes(&self, indexes: &mut BTreeSet<u32>) {
        for table in [&self.raw, &self.nat, &self.filter] {
            extend_candidate_pool_indexes(table, indexes);
        }
    }

    async fn delete_pool_rules(&self, pool_index: u32) -> NamespaceDeleteOutcome {
        delete_firewall_restore_selection(
            "iptables-restore",
            firewall_restore_tables_for_pool([&self.raw, &self.nat, &self.filter], pool_index),
        )
        .await
    }

    async fn delete_rules_with_comments(
        &self,
        comments: &BTreeSet<String>,
    ) -> NamespaceDeleteOutcome {
        delete_firewall_restore_selection(
            "iptables-restore",
            firewall_restore_tables_with_comments([&self.raw, &self.nat, &self.filter], comments),
        )
        .await
    }
}

async fn capture_firewall_table(
    save_command: &'static str,
    table: &'static str,
) -> FirewallTableSnapshot {
    let rules_by_pool =
        match exec_with_timeout(save_command, &["-t", table], HOST_NETWORK_COMMAND_TIMEOUT).await {
            Ok(output) => {
                let mut rules_by_pool: BTreeMap<u32, Vec<String>> = BTreeMap::new();
                for line in output.lines() {
                    if let Some(pool_index) = firewall_rule_pool_index(line) {
                        rules_by_pool
                            .entry(pool_index)
                            .or_default()
                            .push(line.to_string());
                    }
                }
                SnapshotSource::Captured(rules_by_pool)
            }
            Err(error) => {
                warn!(save_command, table, %error, "failed to capture firewall rules for cleanup");
                SnapshotSource::Abandoned
            }
        };
    FirewallTableSnapshot {
        table,
        rules_by_pool,
    }
}

fn firewall_rule_pool_index(line: &str) -> Option<u32> {
    firewall_rule_comment(line).and_then(pool_index_from_comment)
}

fn firewall_rule_comment(line: &str) -> Option<&str> {
    if !line.starts_with("-A ") {
        return None;
    }

    let mut tokens = line.split_whitespace();
    while let Some(token) = tokens.next() {
        if token == "--comment" {
            return tokens.next().map(|comment| comment.trim_matches('"'));
        }
    }
    None
}

fn pool_index_from_comment(comment: &str) -> Option<u32> {
    if let Some(parsed) = parse_netns_name(comment) {
        return Some(parsed.pool_index);
    }

    let suffix = comment.strip_prefix(NS_PREFIX)?;
    let pool_hex = suffix.strip_suffix("-dns")?;
    let pool_index = u32::from_str_radix(pool_hex, 16).ok()?;
    (pool_index < MAX_POOLS && format_hex_index(pool_index) == pool_hex).then_some(pool_index)
}

fn extend_candidate_pool_indexes(snapshot: &FirewallTableSnapshot, indexes: &mut BTreeSet<u32>) {
    if let SnapshotSource::Captured(rules_by_pool) = &snapshot.rules_by_pool {
        indexes.extend(rules_by_pool.keys().copied());
    }
}

fn firewall_restore_tables_for_pool<'a>(
    snapshots: impl IntoIterator<Item = &'a FirewallTableSnapshot>,
    pool_index: u32,
) -> FirewallRestoreSelection {
    select_firewall_restore_tables(snapshots, |rules_by_pool| {
        rules_by_pool
            .get(&pool_index)
            .into_iter()
            .flatten()
            .cloned()
            .collect()
    })
}

fn firewall_restore_tables_with_comments<'a>(
    snapshots: impl IntoIterator<Item = &'a FirewallTableSnapshot>,
    comments: &BTreeSet<String>,
) -> FirewallRestoreSelection {
    select_firewall_restore_tables(snapshots, |rules_by_pool| {
        rules_by_pool
            .values()
            .flatten()
            .filter(|line| {
                firewall_rule_comment(line).is_some_and(|comment| comments.contains(comment))
            })
            .cloned()
            .collect()
    })
}

fn select_firewall_restore_tables<'a>(
    snapshots: impl IntoIterator<Item = &'a FirewallTableSnapshot>,
    select_rules: impl Fn(&BTreeMap<u32, Vec<String>>) -> Vec<String>,
) -> FirewallRestoreSelection {
    let mut selection = FirewallRestoreSelection {
        tables: Vec::new(),
        source_outcome: NamespaceDeleteOutcome::Deleted,
    };
    for snapshot in snapshots {
        match &snapshot.rules_by_pool {
            SnapshotSource::Captured(rules_by_pool) => {
                selection.tables.push(FirewallRestoreTable {
                    table: snapshot.table,
                    rules: select_rules(rules_by_pool),
                });
            }
            SnapshotSource::Abandoned => {
                selection.source_outcome = NamespaceDeleteOutcome::Abandoned;
            }
        }
    }
    selection
}

fn firewall_restore_payload(
    tables: &[FirewallRestoreTable],
    mode: FirewallRestoreMode,
) -> std::result::Result<String, &'static str> {
    let mut payload = String::new();
    for table in tables {
        if table.rules.is_empty() {
            continue;
        }
        payload.push('*');
        payload.push_str(table.table);
        payload.push('\n');
        for rule in &table.rules {
            match mode {
                FirewallRestoreMode::Apply => payload.push_str(rule),
                FirewallRestoreMode::Delete => {
                    payload.push_str("-D ");
                    payload.push_str(
                        rule.strip_prefix("-A ")
                            .ok_or("captured firewall rule has an invalid append form")?,
                    );
                }
            }
            payload.push('\n');
        }
        payload.push_str("COMMIT\n");
    }
    Ok(payload)
}

async fn delete_firewall_restore_selection(
    command: &str,
    selection: FirewallRestoreSelection,
) -> NamespaceDeleteOutcome {
    let outcome = delete_firewall_rules_with_restore(command, selection.tables).await;
    NamespaceDeleteOutcome::combine([outcome, selection.source_outcome])
}

async fn delete_firewall_rules_with_restore(
    command: &str,
    tables: Vec<FirewallRestoreTable>,
) -> NamespaceDeleteOutcome {
    let payload = match firewall_restore_payload(&tables, FirewallRestoreMode::Delete) {
        Ok(payload) => payload,
        Err(error) => {
            warn!(command, error, "failed to build firewall restore input");
            return NamespaceDeleteOutcome::Abandoned;
        }
    };
    if payload.is_empty() {
        return NamespaceDeleteOutcome::Deleted;
    }

    match run_firewall_restore(command, &payload).await {
        Ok(()) => NamespaceDeleteOutcome::Deleted,
        Err(error) => {
            warn!(command, %error, "firewall restore did not complete cleanly");
            NamespaceDeleteOutcome::Abandoned
        }
    }
}

async fn apply_firewall_rules_with_restore(
    command: &str,
    tables: &[FirewallRestoreTable],
) -> Result<()> {
    let payload = firewall_restore_payload(tables, FirewallRestoreMode::Apply)
        .map_err(|error| NetworkError::Prerequisite(error.into()))?;
    if payload.is_empty() {
        return Ok(());
    }
    run_firewall_restore(command, &payload).await?;
    Ok(())
}

async fn run_firewall_restore(
    command: &str,
    payload: &str,
) -> std::result::Result<(), CommandError> {
    let mut file = match tempfile::NamedTempFile::new() {
        Ok(file) => file,
        Err(error) => {
            return Err(CommandError {
                command: command.to_string(),
                exit_code: None,
                detail: format!("failed to create firewall restore input: {error}"),
            });
        }
    };
    if let Err(error) = file.write_all(payload.as_bytes()) {
        return Err(CommandError {
            command: command.to_string(),
            exit_code: None,
            detail: format!("failed to write firewall restore input: {error}"),
        });
    }
    let Some(path) = file.path().to_str() else {
        return Err(CommandError {
            command: command.to_string(),
            exit_code: None,
            detail: format!(
                "firewall restore input path is not UTF-8: {}",
                file.path().display()
            ),
        });
    };

    exec_xtables_status_with_timeout(command, &["--noflush", path], HOST_NETWORK_COMMAND_TIMEOUT)
        .await
}

#[cfg(test)]
mod tests;
