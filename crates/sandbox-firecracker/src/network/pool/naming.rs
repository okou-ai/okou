/// Namespace name prefix.
pub(super) const NS_PREFIX: &str = "vm0-ns-";
/// Host-side device name prefix.
const HOST_PREFIX: &str = "vm0-ve-";
/// First two octets shared by all veth IP addresses.
const IP_PREFIX: &str = "10.200";

/// Maximum pool index (0x00–0x3f), ensuring IPs stay within `10.200.0.0/16`.
pub(super) const MAX_POOLS: u32 = 64;
/// Maximum namespaces a single pool can own (index 0x00–0xff).
pub(super) const MAX_NAMESPACES: u32 = 256;

// Compile-time check: all /30 subnets fit within `10.200.0.0/16`.
// 64 pools × 256 ns × 4 addresses per /30 = 65536 = exactly 2^16.
const _: () = assert!(MAX_POOLS * MAX_NAMESPACES * 4 <= 65536);

/// Parsed Firecracker network namespace name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParsedNetnsName {
    /// Network namespace pool index.
    pub pool_index: u32,
    /// Namespace index within the pool.
    pub namespace_index: u32,
}

pub(super) fn format_hex_index(index: u32) -> String {
    format!("{index:02x}")
}

pub(super) fn make_ns_name(pool_idx: &str, ns_idx: &str) -> String {
    format!("{NS_PREFIX}{pool_idx}-{ns_idx}")
}

pub(super) fn make_host_device(pool_idx: &str, ns_idx: &str) -> String {
    format!("{HOST_PREFIX}{pool_idx}-{ns_idx}")
}

pub(super) fn make_host_device_dnsmasq_pattern(pool_idx: &str) -> String {
    format!("{HOST_PREFIX}{pool_idx}-*")
}

pub(super) fn make_host_device_iptables_pattern(pool_idx: &str) -> String {
    format!("{HOST_PREFIX}{pool_idx}-+")
}

pub(crate) fn make_pool_dns_filter_comment(pool_index: u32) -> String {
    format!("{NS_PREFIX}{}-dns", format_hex_index(pool_index))
}

/// Generate a unique /30 IP pair for a veth link.
///
/// Each namespace gets a /30 subnet from the `10.200.0.0/16` range:
///
/// ```text
///   octet3     = pool_idx × 4 + ns_idx / 64
///   octet4_base = (ns_idx % 64) × 4
///   host_ip    = 10.200.{octet3}.{octet4_base + 1}
///   peer_ip    = 10.200.{octet3}.{octet4_base + 2}
/// ```
///
/// | pool | ns  | host_ip          | peer_ip          |
/// |------|-----|------------------|------------------|
/// | 0    | 0   | `10.200.0.1`     | `10.200.0.2`     |
/// | 0    | 1   | `10.200.0.5`     | `10.200.0.6`     |
/// | 0    | 64  | `10.200.1.1`     | `10.200.1.2`     |
/// | 1    | 0   | `10.200.4.1`     | `10.200.4.2`     |
/// | 63   | 255 | `10.200.255.253` | `10.200.255.254` |
///
/// Capacity: 64 pools × 256 ns × 4 addr = 65536 = `10.200.0.0/16`.
pub(super) fn generate_veth_ip_pair(pool_idx: u32, ns_idx: u32) -> (String, String) {
    // 64 /30 subnets per octet3 value (64 × 4 = 256 addresses)
    let octet3 = pool_idx * 4 + ns_idx / 64;
    let octet4_base = (ns_idx % 64) * 4;
    let host_ip = format!("{IP_PREFIX}.{octet3}.{}", octet4_base + 1);
    let peer_ip = format!("{IP_PREFIX}.{octet3}.{}", octet4_base + 2);
    (host_ip, peer_ip)
}

/// Parse a Firecracker network namespace name.
///
/// Returns `None` if the name doesn't match the expected format
/// `vm0-ns-{xx}-{xx}` where each index is exactly 2 lowercase hex
/// characters, or if either index is outside the supported bounds.
pub fn parse_netns_name(name: &str) -> Option<ParsedNetnsName> {
    let suffix = name.strip_prefix(NS_PREFIX)?;
    let (pool_hex, namespace_hex) = suffix.split_once('-')?;
    if !is_lower_hex2(pool_hex) || !is_lower_hex2(namespace_hex) {
        return None;
    }

    let pool_index = u32::from_str_radix(pool_hex, 16).ok()?;
    let namespace_index = u32::from_str_radix(namespace_hex, 16).ok()?;
    if pool_index >= MAX_POOLS || namespace_index >= MAX_NAMESPACES {
        return None;
    }

    Some(ParsedNetnsName {
        pool_index,
        namespace_index,
    })
}

/// Check that a string is exactly 2 lowercase hex characters.
fn is_lower_hex2(s: &str) -> bool {
    s.len() == 2
        && s.bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

#[cfg(test)]
mod tests;
