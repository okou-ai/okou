use super::human_bytes;

#[test]
fn human_bytes_formatting() {
    const MIB: u64 = 1024 * 1024;
    const GIB: u64 = MIB * 1024;
    let cases: &[(u64, &str)] = &[
        (0, "0 B"),
        (1, "1 B"),
        (1023, "1023 B"),
        (1024, "1.0 KiB"),
        (1025, "1.0 KiB"),
        (1536, "1.5 KiB"),
        (MIB - 1, "1024.0 KiB"),
        (MIB, "1.0 MiB"),
        (MIB + 1, "1.0 MiB"),
        (10 * MIB, "10.0 MiB"),
        (GIB - 1, "1024.0 MiB"),
        (GIB, "1.0 GiB"),
        (GIB + 1, "1.0 GiB"),
        (2 * GIB + GIB / 2, "2.5 GiB"),
        (u64::MAX, "17179869184.0 GiB"),
    ];
    for &(input, expected) in cases {
        assert_eq!(human_bytes(input), expected, "human_bytes({input})");
    }
}
