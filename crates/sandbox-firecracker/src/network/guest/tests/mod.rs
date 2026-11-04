use super::*;

#[test]
fn guest_network_boot_args_format() {
    let args = generate_guest_network_boot_args();
    assert_eq!(
        args,
        "ip=192.168.241.2::192.168.241.1:255.255.255.248:vm0-guest:eth0:off"
    );
}

#[test]
fn boot_args_contains_root_device() {
    let args = generate_boot_args();
    assert!(
        args.contains("root=/dev/vda rootfstype=ext4 rw"),
        "boot args must specify root device: {args}"
    );
    let init_arg = format!("init={}", guest_contracts::guest_binary::INIT_PATH);
    assert!(
        args.contains(&init_arg),
        "boot args must specify init: {args}"
    );
}

#[test]
fn guest_network_prefix_len_matches_netmask() {
    // /29 = 255.255.255.248 (8 addresses, 6 usable)
    assert_eq!(GUEST_NETWORK.prefix_len, 29);
    assert_eq!(GUEST_NETWORK.netmask, "255.255.255.248");
}
