use super::super::super::ResourceFailureKind;
use super::super::super::diagnostics::parse_agent_abnormal_exit_resource_diagnostics;

#[test]
fn abnormal_exit_resource_diagnostics_classifies_production_rootfs_full_sample() {
    let diagnostics = parse_agent_abnormal_exit_resource_diagnostics(
        r#"
/dev/root       7.8G  7.4G   20K 100% /
/dev/vdb         16G   24K   15G   1% /home/user/workspace
Mem:            3934        3310         255           0         552         624
Swap:              0           0           0
"#,
    )
    .expect("resource diagnostics should parse production sample");

    assert_eq!(
        diagnostics.failure_kind,
        Some(ResourceFailureKind::GuestRootFilesystemFull)
    );
    assert_eq!(diagnostics.guest_root_fs_used_percent, Some(100));
    assert_eq!(diagnostics.guest_root_fs_available_kb, Some(20));
    assert_eq!(diagnostics.guest_root_fs_inode_used_percent, None);
    assert_eq!(diagnostics.guest_root_fs_available_inodes, None);
    assert_eq!(diagnostics.guest_workspace_fs_used_percent, Some(1));
    assert_eq!(diagnostics.guest_memory_available_mb, Some(624));
}

#[test]
fn abnormal_exit_resource_diagnostics_classifies_rootfs_inode_exhaustion() {
    let diagnostics = parse_agent_abnormal_exit_resource_diagnostics(
        r#"
VM0_DF_BLOCKS_V1
Filesystem     1024-blocks    Used Available Capacity Mounted on
/dev/root          8388608 4194304   4194304      50% /
/dev/vdb          16777216      24  16777192       1% /home/user/workspace
VM0_DF_INODES_V1
Filesystem       Inodes   IUsed   IFree IUse% Mounted on
/dev/root        524288  524288       0  100% /
/dev/vdb        1048576      32 1048544    1% /home/user/workspace
"#,
    )
    .expect("inode diagnostics should parse");

    assert_eq!(
        diagnostics.failure_kind,
        Some(ResourceFailureKind::GuestRootFilesystemFull)
    );
    assert_eq!(diagnostics.guest_root_fs_used_percent, Some(50));
    assert_eq!(diagnostics.guest_root_fs_available_kb, Some(4_194_304));
    assert_eq!(diagnostics.guest_root_fs_inode_used_percent, Some(100));
    assert_eq!(diagnostics.guest_root_fs_available_inodes, Some(0));
}

#[test]
fn abnormal_exit_resource_diagnostics_keeps_sections_before_later_failure_output() {
    let diagnostics = parse_agent_abnormal_exit_resource_diagnostics(
        r#"
VM0_DF_BLOCKS_V1
/dev/root 8388608 8388608 0 100% /
VM0_DF_INODES_V1
/dev/root 524288 524280 8 100% /
/home/user: du timed out or failed
"#,
    )
    .expect("valid resource sections should survive later helper failure output");

    assert_eq!(
        diagnostics.failure_kind,
        Some(ResourceFailureKind::GuestRootFilesystemFull)
    );
    assert_eq!(diagnostics.guest_root_fs_available_kb, Some(0));
    assert_eq!(diagnostics.guest_root_fs_available_inodes, Some(8));
}

#[test]
fn abnormal_exit_resource_diagnostics_does_not_classify_workspace_full_as_rootfs_full() {
    let diagnostics = parse_agent_abnormal_exit_resource_diagnostics(
        r#"
/dev/root       16G  4.0G   12G  25% /
/dev/vdb        16G   16G     0 100% /home/user/workspace
Mem:          4096  1024  2048  0 1024  3072
"#,
    )
    .expect("resource diagnostics should parse workspace sample");

    assert_eq!(diagnostics.failure_kind, None);
    assert_eq!(diagnostics.guest_root_fs_used_percent, Some(25));
    assert_eq!(diagnostics.guest_workspace_fs_used_percent, Some(100));
    assert_eq!(diagnostics.guest_memory_available_mb, Some(3072));
}

#[test]
fn abnormal_exit_resource_diagnostics_does_not_classify_normal_parseable_df_output() {
    let diagnostics = parse_agent_abnormal_exit_resource_diagnostics(
        r#"
Filesystem     1024-blocks    Used Available Capacity Mounted on
/dev/root         16447660 4194304  12253356      26% /
/dev/vdb          16447660      24  16447636       1% /home/user/workspace
MemAvailable:    1048576 kB
"#,
    )
    .expect("resource diagnostics should parse parseable df output");

    assert_eq!(diagnostics.failure_kind, None);
    assert_eq!(diagnostics.guest_root_fs_used_percent, Some(26));
    assert_eq!(diagnostics.guest_root_fs_available_kb, Some(12_253_356));
    assert_eq!(diagnostics.guest_workspace_fs_used_percent, Some(1));
    assert_eq!(diagnostics.guest_memory_available_mb, Some(1024));
}

#[test]
fn abnormal_exit_resource_diagnostics_ignores_malformed_output() {
    let diagnostics = parse_agent_abnormal_exit_resource_diagnostics(
        r#"
df: unavailable
Mem: not numeric
/dev/root missing columns
"#,
    );

    assert_eq!(diagnostics, None);
}

#[test]
fn abnormal_exit_resource_diagnostics_ignores_invalid_available_values() {
    let diagnostics = parse_agent_abnormal_exit_resource_diagnostics(
        r#"
/dev/root       16G  4.0G   NaNK  25% /
/dev/vdb        16G   24K    -1K   1% /home/user/workspace
"#,
    )
    .expect("resource diagnostics should keep valid percentages");

    assert_eq!(diagnostics.failure_kind, None);
    assert_eq!(diagnostics.guest_root_fs_used_percent, Some(25));
    assert_eq!(diagnostics.guest_root_fs_available_kb, None);
    assert_eq!(diagnostics.guest_workspace_fs_used_percent, Some(1));
}
