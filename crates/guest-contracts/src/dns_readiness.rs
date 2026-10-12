//! Fixed identity shared by guest DNS readiness probes and the host DNS proxy.

use std::net::Ipv4Addr;

/// Local-only hostname used to validate a namespace's DNS redirect path.
pub const DNS_READINESS_HOSTNAME: &str = "vm0-readiness.invalid";

/// TEST-NET address returned for the readiness hostname.
pub const DNS_READINESS_IPV4: Ipv4Addr = Ipv4Addr::new(192, 0, 2, 1);
