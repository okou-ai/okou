use super::*;

#[test]
fn get_default_profile() {
    let def = get("vm0/default").unwrap();
    assert_eq!(def.vcpu, 2);
    assert_eq!(def.memory_mb, 4096);
    assert_eq!(def.rootfs_disk_mb, 12288);
    assert_eq!(def.home_disk_mb, 24576);
}

#[test]
fn get_unknown_profile_fails() {
    assert!(get("unknown").is_err());
}

#[test]
fn validate_or_err_passes_for_valid_name() {
    assert!(validate_or_err("vm0/default").is_ok());
}

#[test]
fn validate_or_err_carries_offending_name_in_message() {
    let err = validate_or_err("/etc").unwrap_err();
    assert_eq!(
        err.to_string(),
        "config error: invalid profile name: /etc (must be org/name format, lowercase alphanumeric + hyphens)"
    );
}
