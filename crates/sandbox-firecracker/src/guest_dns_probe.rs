//! Fixed identity shared by guest DNS emission and readiness.

use std::net::Ipv4Addr;

pub use guest_contracts::dns_readiness::{DNS_READINESS_HOSTNAME, DNS_READINESS_IPV4};

/// Dummy external resolver written to guest configuration and intercepted by the DNS proxy.
pub const DNS_PROBE_RESOLVER_IPV4: Ipv4Addr = Ipv4Addr::new(8, 8, 8, 8);
pub(crate) const DNS_PROBE_DESTINATION_PORT: u16 = 53;
