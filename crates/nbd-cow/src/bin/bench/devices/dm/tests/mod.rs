use super::*;

#[test]
fn bench_dm_owner_pid_parses_pid_from_bench_mapping_name() {
    assert_eq!(
        bench_dm_owner_pid("bench-cow-1234-nbd-cow-bench-abcd"),
        Some(1234)
    );
    assert_eq!(bench_dm_owner_pid("bench-cow-1234"), Some(1234));
}

#[test]
fn bench_dm_owner_pid_rejects_non_bench_or_invalid_names() {
    assert_eq!(bench_dm_owner_pid("other-1234-nbd-cow-bench-abcd"), None);
    assert_eq!(bench_dm_owner_pid("bench-cow-nbd-cow-bench-abcd"), None);
    assert_eq!(bench_dm_owner_pid("bench-cow-"), None);
}
