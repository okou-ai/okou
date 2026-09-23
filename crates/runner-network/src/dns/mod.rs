//! DNS proxy for runner sandboxes using dnsmasq.
//!
//! Spawns a dnsmasq process that serves as the DNS resolver for all sandboxes.
//! DNS queries are intercepted via iptables REDIRECT (PREROUTING chain)
//! and forwarded to upstream resolvers (8.8.8.8, 8.8.4.4).
//!
//! Defense-in-depth:
//! - Layer 1: iptables REDIRECT → dnsmasq port (working path, preserves source IP)
//! - Layer 2: iptables DROP external UDP/TCP 53 and TCP 853 (bypass prevention)
//! - Layer 3: IPv4/IPv6 INPUT filters reject direct access to dnsmasq's wildcard
//!   port from interfaces outside the runner's netns pool
//! - Layer 4: dnsmasq validates each request against the runner's sandbox-facing
//!   veth interface pattern (listener access control)
//!
//! VM resolv.conf points to an external nameserver (e.g. 8.8.8.8) as a dummy
//! target. The REDIRECT rules in PREROUTING intercept UDP and TCP 53 from the
//! VM subnet and redirect to dnsmasq before packets reach FORWARD/POSTROUTING.
//!
//! Log format: dnsmasq `--log-queries=extra` outputs to stderr, parsed by a background
//! async task that submits per-sandbox network JSON rows through `NetworkLogManager`.

mod log;
mod port;
mod proxy;

pub use log::{DnsReadinessLogObservation, inspect_readiness_log_segment};
pub use port::{DnsPortReservation, reserve_port};
pub use proxy::{DnsProxy, start_on_reserved_port};
