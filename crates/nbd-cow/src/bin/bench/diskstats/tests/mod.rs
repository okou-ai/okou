use super::*;

#[test]
fn diskstats_total_ios_saturates() {
    let stats = DiskStats {
        reads_completed: u64::MAX,
        writes_completed: 1,
    };

    assert_eq!(stats.total_ios(), u64::MAX);
}

#[test]
fn calculate_host_disk_iops_rejects_counter_resets_and_invalid_time() {
    let before = DiskStats {
        reads_completed: 100,
        writes_completed: 50,
    };
    let after = DiskStats {
        reads_completed: 125,
        writes_completed: 75,
    };

    assert_eq!(calculate_host_disk_iops(&before, &after, 2.0).unwrap(), 25);
    assert_eq!(calculate_host_disk_iops(&before, &after, 0.0).unwrap(), 0);
    assert!(calculate_host_disk_iops(&after, &before, 2.0).is_err());
    assert!(calculate_host_disk_iops(&before, &after, f64::NAN).is_err());
}

#[test]
fn parse_diskstats_reads_matching_device() {
    let stats = parse_diskstats(
        "8 0 sda 1 0 0 0 2 0 0 0\n259 0 nvme0n1 12 0 0 0 34 0 0 0\n",
        "nvme0n1",
    )
    .unwrap();

    assert_eq!(stats.reads_completed, 12);
    assert_eq!(stats.writes_completed, 34);
    assert_eq!(stats.total_ios(), 46);
}

#[test]
fn parse_diskstats_rejects_short_matching_line() {
    let err = parse_diskstats("259 0 nvme0n1 12 0 0 0\n", "nvme0n1").unwrap_err();

    assert!(err.contains("too few fields"), "{err}");
}

#[test]
fn parse_diskstats_rejects_invalid_matching_counts() {
    let invalid_reads =
        parse_diskstats("259 0 nvme0n1 not-a-number 0 0 0 34\n", "nvme0n1").unwrap_err();
    assert!(
        invalid_reads.contains("invalid read count"),
        "{invalid_reads}"
    );

    let invalid_writes =
        parse_diskstats("259 0 nvme0n1 12 0 0 0 not-a-number\n", "nvme0n1").unwrap_err();
    assert!(
        invalid_writes.contains("invalid write count"),
        "{invalid_writes}"
    );
}

#[test]
fn diskstats_contains_device_requires_exact_name_match() {
    let stats = "259 10 nvme0n10 1 0 0 0 2 0 0 0\n";

    assert!(!diskstats_contains_device(stats, "nvme0n1"));
    assert!(diskstats_contains_device(stats, "nvme0n10"));
}

#[test]
fn host_disk_from_df_device_validates_diskstats_device() {
    let stats = "259 0 nvme0n1 1 0 0 0 2 0 0 0\n8 0 sda 3 0 0 0 4 0 0 0\n";

    assert_eq!(
        host_disk_from_df_device("/dev/nvme0n1p1", stats),
        Some("nvme0n1".to_string())
    );
    assert_eq!(
        host_disk_from_df_device("/dev/root", stats),
        Some("nvme0n1".to_string())
    );
    assert_eq!(host_disk_from_df_device("overlay", stats), None);
    assert_eq!(
        host_disk_from_df_device("/dev/does-not-exist1", stats),
        None
    );
}

#[test]
fn known_host_disk_candidate_accepts_non_default_whole_disks() {
    let stats = "259 1 nvme1n1p1 1 0 0 0 2 0 0 0\n259 0 nvme1n1 3 0 0 0 4 0 0 0\n";

    assert_eq!(
        known_host_disk_candidate(stats),
        Some("nvme1n1".to_string())
    );
}

#[test]
fn diskstats_device_name_strips_partition_suffixes() {
    assert_eq!(diskstats_device_name("/dev/nvme0n1p1"), "nvme0n1");
    assert_eq!(diskstats_device_name("/dev/mmcblk0p2"), "mmcblk0");
    assert_eq!(diskstats_device_name("/dev/nbd12p3"), "nbd12");
    assert_eq!(diskstats_device_name("/dev/sda1"), "sda");
    assert_eq!(diskstats_device_name("/dev/vda2"), "vda");
    assert_eq!(diskstats_device_name("/dev/xvdf12"), "xvdf");
}

#[test]
fn diskstats_device_name_preserves_whole_disk_names() {
    assert_eq!(diskstats_device_name("/dev/nvme0n1"), "nvme0n1");
    assert_eq!(diskstats_device_name("/dev/mmcblk0"), "mmcblk0");
    assert_eq!(diskstats_device_name("/dev/nbd12"), "nbd12");
    assert_eq!(diskstats_device_name("/dev/loop0"), "loop0");
    assert_eq!(diskstats_device_name("/dev/sda"), "sda");
    assert_eq!(diskstats_device_name("vda"), "vda");
}
