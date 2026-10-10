use super::super::super::ResourceFailureKind;
use super::super::super::diagnostics::parse_agent_abnormal_exit_resource_diagnostics;

#[test]
fn abnormal_exit_resource_diagnostics_classifies_production_rootfs_full_sample() {
    let diagnostics = parse_agent_abnormal_exit_resource_diagnostics(
        "/dev/root 7.8G 7.4G 20K 100% /\n/dev/vdb 24G 24K 23G 1% /home/user\nMem: 3934 3310 255 0 552 624\nSwap: 0 0 0\n",
    ).unwrap();
    assert_eq!(
        diagnostics.failure_kind,
        Some(ResourceFailureKind::GuestRootFilesystemFull)
    );
    assert_eq!(diagnostics.guest_root_fs_used_percent, Some(100));
    assert_eq!(diagnostics.guest_root_fs_available_kb, Some(20));
    assert_eq!(diagnostics.guest_root_fs_inode_used_percent, None);
    assert_eq!(diagnostics.guest_root_fs_available_inodes, None);
    assert_eq!(diagnostics.guest_home_fs_used_percent, Some(1));
    assert_eq!(
        diagnostics.guest_home_fs_available_kb,
        Some(23 * 1024 * 1024)
    );
    assert_eq!(diagnostics.guest_memory_available_mb, Some(624));
}

#[test]
fn abnormal_exit_resource_diagnostics_classifies_rootfs_inode_exhaustion() {
    let diagnostics = parse_agent_abnormal_exit_resource_diagnostics(
        "VM0_DF_BLOCKS_V1\nFilesystem 1024-blocks Used Available Capacity Mounted on\n/dev/root 8388608 4194304 4194304 50% /\n/dev/vdb 25165824 24 25165800 1% /home/user\nVM0_DF_INODES_V1\n/dev/root 524288 524288 0 100% /\n/dev/vdb 1048576 32 1048544 1% /home/user\n",
    ).unwrap();
    assert_eq!(
        diagnostics.failure_kind,
        Some(ResourceFailureKind::GuestRootFilesystemFull)
    );
    assert_eq!(diagnostics.guest_root_fs_used_percent, Some(50));
    assert_eq!(diagnostics.guest_root_fs_available_kb, Some(4_194_304));
    assert_eq!(diagnostics.guest_root_fs_inode_used_percent, Some(100));
    assert_eq!(diagnostics.guest_root_fs_available_inodes, Some(0));
    assert_eq!(diagnostics.guest_home_fs_available_inodes, Some(1_048_544));
}

#[test]
fn abnormal_exit_resource_diagnostics_keeps_sections_before_later_failure_output() {
    let diagnostics = parse_agent_abnormal_exit_resource_diagnostics(
        "VM0_DF_BLOCKS_V1\n/dev/root 8388608 8388608 0 100% /\nVM0_DF_INODES_V1\n/dev/root 524288 524280 8 100% /\n/home/user: du timed out or failed\n",
    ).unwrap();
    assert_eq!(
        diagnostics.failure_kind,
        Some(ResourceFailureKind::GuestRootFilesystemFull)
    );
    assert_eq!(diagnostics.guest_root_fs_available_kb, Some(0));
    assert_eq!(diagnostics.guest_root_fs_available_inodes, Some(8));
}

#[test]
fn abnormal_exit_resource_diagnostics_classifies_home_full_independently() {
    let diagnostics = parse_agent_abnormal_exit_resource_diagnostics(
        "/dev/root 12G 4G 8G 33% /\n/dev/vdb 24G 24G 0 100% /home/user\nMem: 4096 1024 2048 0 1024 3072\n",
    ).unwrap();
    assert_eq!(
        diagnostics.failure_kind,
        Some(ResourceFailureKind::GuestHomeFilesystemFull)
    );
    assert_eq!(diagnostics.guest_root_fs_used_percent, Some(33));
    assert_eq!(diagnostics.guest_home_fs_used_percent, Some(100));
    assert_eq!(diagnostics.guest_home_fs_available_kb, Some(0));
    assert_eq!(diagnostics.guest_memory_available_mb, Some(3072));
}

#[test]
fn abnormal_exit_resource_diagnostics_does_not_classify_normal_parseable_df_output() {
    let diagnostics = parse_agent_abnormal_exit_resource_diagnostics(
        "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/root 16447660 4194304 12253356 26% /\n/dev/vdb 25165824 24 25165800 1% /home/user\nMemAvailable: 1048576 kB\n",
    ).unwrap();
    assert_eq!(diagnostics.failure_kind, None);
    assert_eq!(diagnostics.guest_root_fs_used_percent, Some(26));
    assert_eq!(diagnostics.guest_root_fs_available_kb, Some(12_253_356));
    assert_eq!(diagnostics.guest_home_fs_used_percent, Some(1));
    assert_eq!(diagnostics.guest_memory_available_mb, Some(1024));
}

#[test]
fn abnormal_exit_resource_diagnostics_ignores_malformed_output() {
    assert_eq!(
        parse_agent_abnormal_exit_resource_diagnostics(
            "df: unavailable\nMem: not numeric\n/dev/root missing columns\n"
        ),
        None
    );
}

#[test]
fn abnormal_exit_resource_diagnostics_ignores_invalid_available_values() {
    let diagnostics = parse_agent_abnormal_exit_resource_diagnostics(
        "/dev/root 12G 4G NaNK 25% /\n/dev/vdb 24G 24K -1K 1% /home/user\n",
    )
    .unwrap();
    assert_eq!(diagnostics.failure_kind, None);
    assert_eq!(diagnostics.guest_root_fs_used_percent, Some(25));
    assert_eq!(diagnostics.guest_root_fs_available_kb, None);
    assert_eq!(diagnostics.guest_home_fs_used_percent, Some(1));
    assert_eq!(diagnostics.guest_home_fs_available_kb, None);
}

#[test]
fn home_inode_exhaustion_is_not_rootfs_full_and_rootfs_has_precedence() {
    let diagnostics = parse_agent_abnormal_exit_resource_diagnostics(
        "VM0_DF_BLOCKS_V1\n/dev/root 10000 100 9900 1% /\n/dev/vdb 20000 100 19900 1% /home/user\nVM0_DF_INODES_V1\n/dev/vdb 100 100 0 100% /home/user\n",
    ).unwrap();
    assert_eq!(
        diagnostics.failure_kind,
        Some(ResourceFailureKind::GuestHomeFilesystemFull)
    );
    assert_eq!(diagnostics.guest_home_fs_inode_used_percent, Some(100));
    assert_eq!(diagnostics.guest_home_fs_available_inodes, Some(0));
    let both = parse_agent_abnormal_exit_resource_diagnostics(
        "VM0_DF_BLOCKS_V1\n/dev/root 10000 10000 0 100% /\n/dev/vdb 20000 20000 0 100% /home/user\n",
    ).unwrap();
    assert_eq!(
        both.failure_kind,
        Some(ResourceFailureKind::GuestRootFilesystemFull)
    );
}

#[test]
fn missing_home_mount_does_not_create_home_evidence() {
    let diagnostics = parse_agent_abnormal_exit_resource_diagnostics(
        "VM0_DF_BLOCKS_V1\n/dev/root 10000 100 9900 1% /\n/dev/root 10000 100 9900 1% /\n",
    )
    .unwrap();
    assert_eq!(diagnostics.guest_home_fs_used_percent, None);
    assert_eq!(diagnostics.guest_home_fs_available_kb, None);
    assert_eq!(diagnostics.failure_kind, None);
}
