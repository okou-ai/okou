use super::*;
use std::collections::HashSet;

#[test]
fn input_action_schema_is_exact_and_unique() {
    let actual = [
        InputPhase::StaleCleanup.action(),
        InputPhase::Read.action(),
        InputPhase::Frame.action(),
        InputPhase::Parse.action(),
        InputPhase::DecodeValidate.action(),
        InputPhase::Bindings.action(),
        payload_size_action(None),
        payload_size_action(Some(0)),
        payload_size_action(Some(1)),
        payload_size_action(Some(65_536)),
        payload_size_action(Some(262_144)),
        payload_size_action(Some(1_048_576)),
        payload_size_action(Some(4_194_304)),
        payload_size_action(Some(16_777_216)),
        payload_size_action(Some(67_108_864)),
    ];
    assert_eq!(
        actual,
        [
            "guest_storage_apply_input_stale_cleanup",
            "guest_storage_apply_input_read",
            "guest_storage_apply_input_frame",
            "guest_storage_apply_input_parse",
            "guest_storage_apply_input_decode_validate",
            "guest_storage_apply_input_bindings",
            "guest_storage_apply_input_payload_bytes_unavailable_or_inconsistent",
            "guest_storage_apply_input_payload_bytes_zero",
            "guest_storage_apply_input_payload_bytes_lt_64_kib",
            "guest_storage_apply_input_payload_bytes_64_kib_to_256_kib",
            "guest_storage_apply_input_payload_bytes_256_kib_to_1_mib",
            "guest_storage_apply_input_payload_bytes_1_mib_to_4_mib",
            "guest_storage_apply_input_payload_bytes_4_mib_to_16_mib",
            "guest_storage_apply_input_payload_bytes_16_mib_to_64_mib",
            "guest_storage_apply_input_payload_bytes_64_mib_plus",
        ]
    );
    assert_eq!(
        actual.len(),
        actual.into_iter().collect::<HashSet<_>>().len()
    );
}

#[test]
fn payload_bucket_boundaries_are_half_open() {
    for (below, at, expected_below, expected_at) in [
        (0, 1, "zero", "lt_64_kib"),
        (65_535, 65_536, "lt_64_kib", "64_kib_to_256_kib"),
        (262_143, 262_144, "64_kib_to_256_kib", "256_kib_to_1_mib"),
        (1_048_575, 1_048_576, "256_kib_to_1_mib", "1_mib_to_4_mib"),
        (4_194_303, 4_194_304, "1_mib_to_4_mib", "4_mib_to_16_mib"),
        (
            16_777_215,
            16_777_216,
            "4_mib_to_16_mib",
            "16_mib_to_64_mib",
        ),
    ] {
        assert!(payload_size_action(Some(below)).ends_with(expected_below));
        assert!(payload_size_action(Some(at)).ends_with(expected_at));
    }
    assert!(payload_size_action(Some(15 * 1_048_576)).ends_with("4_mib_to_16_mib"));
    assert!(payload_size_action(None).ends_with("unavailable_or_inconsistent"));
}
