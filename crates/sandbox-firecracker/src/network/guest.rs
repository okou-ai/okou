/// Fixed guest-facing network configuration inside each namespace.
///
/// Every namespace uses the same values — isolation guarantees no conflicts.
/// These must match the Firecracker VM's network configuration.
pub(crate) struct GuestNetwork {
    /// TAP device name inside namespace (must match Firecracker config).
    pub tap_name: &'static str,
    /// Fixed MAC for the TAP device (host-side, locally administered).
    ///
    /// Must be deterministic so that guest ARP cache entries baked into a
    /// snapshot remain valid after restore in a different network namespace.
    pub tap_mac: &'static str,
    /// Guest MAC address (locally administered, fixed for all VMs).
    pub guest_mac: &'static str,
    /// Guest IP inside the VM.
    pub guest_ip: &'static str,
    /// Gateway IP (TAP device in namespace).
    pub gateway_ip: &'static str,
    /// Netmask for /29 subnet (dotted decimal for kernel boot args).
    pub netmask: &'static str,
    /// CIDR prefix length (for ip commands).
    pub prefix_len: u8,
}

/// Canonical guest-facing network values for Firecracker VM namespaces.
///
/// Boot arguments, Firecracker network configuration, and namespace TAP setup
/// all read these values. Keep them compatible with the guest network state
/// baked into snapshots, including deterministic MAC addresses and IPs.
pub(crate) const GUEST_NETWORK: GuestNetwork = GuestNetwork {
    tap_name: "vm0-tap",
    tap_mac: "02:00:00:00:00:02",
    guest_mac: "02:00:00:00:00:01",
    guest_ip: "192.168.241.2",
    gateway_ip: "192.168.241.1",
    netmask: "255.255.255.248",
    prefix_len: 29,
};

/// Generate kernel boot args for guest network configuration.
pub(crate) fn generate_guest_network_boot_args() -> String {
    format!(
        "ip={}::{}:{}:vm0-guest:eth0:off",
        GUEST_NETWORK.guest_ip, GUEST_NETWORK.gateway_ip, GUEST_NETWORK.netmask,
    )
}

/// Generate the full kernel boot args string (base flags + network config).
pub(crate) fn generate_boot_args() -> String {
    format!(
        "console=ttyS0 reboot=k panic=1 pci=off nomodules random.trust_cpu=on \
         quiet loglevel=0 nokaslr audit=0 numa=off mitigations=off noresume \
         root=/dev/vda rootfstype=ext4 rw init={} {}",
        guest_contracts::guest_binary::INIT_PATH,
        generate_guest_network_boot_args(),
    )
}

#[cfg(test)]
mod tests;
