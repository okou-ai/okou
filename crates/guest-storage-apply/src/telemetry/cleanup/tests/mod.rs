use super::*;

#[test]
fn cpu_measurement_distinguishes_zero_from_unavailable_or_backwards_samples() {
    let start = Some(Duration::from_millis(7));
    assert_eq!(cpu_elapsed(start, start), Some(Duration::ZERO));
    assert_eq!(
        cpu_elapsed(start, Some(Duration::from_millis(12))),
        Some(Duration::from_millis(5))
    );
    assert_eq!(cpu_elapsed(start, None), None);
    assert_eq!(cpu_elapsed(None, start), None);
    assert_eq!(cpu_elapsed(start, Some(Duration::from_millis(6))), None);
}

#[test]
fn requested_entry_dimensions_have_fixed_bucket_boundaries() {
    for (values, expected) in [
        (&[0][..], "requested_0"),
        (&[1][..], "requested_1"),
        (&[2][..], "requested_2"),
        (&[3, 4][..], "requested_3_4"),
        (&[5, 8][..], "requested_5_8"),
        (&[9, 16][..], "requested_9_16"),
        (&[17, usize::MAX][..], "requested_17_plus"),
    ] {
        for &count in values {
            assert_eq!(requested_bucket(count), expected);
        }
    }
}
