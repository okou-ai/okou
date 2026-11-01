use super::*;

fn entropy() -> [u8; GUEST_STATE_RESTORE_ENTROPY_BYTES] {
    std::array::from_fn(|index| index as u8)
}

#[test]
fn request_round_trip_preserves_fixed_inputs() {
    for timezone in [
        GuestStateRestoreTimezone::None,
        GuestStateRestoreTimezone::BestEffort("Asia/Shanghai"),
        GuestStateRestoreTimezone::Required("Etc/GMT+1"),
    ] {
        let entropy = entropy();
        let payload = encode_guest_state_restore_request(
            300_000,
            1_778_000_000,
            123_000_000,
            &entropy,
            timezone,
        )
        .unwrap();

        let decoded = decode_guest_state_restore_request(&payload).unwrap();

        assert_eq!(decoded.timeout_ms, 300_000);
        assert_eq!(decoded.unix_seconds, 1_778_000_000);
        assert_eq!(decoded.unix_nanoseconds, 123_000_000);
        assert_eq!(decoded.entropy, entropy);
        assert_eq!(decoded.timezone, timezone);
    }
}

#[test]
fn request_debug_redacts_entropy_contents() {
    let entropy = [222; GUEST_STATE_RESTORE_ENTROPY_BYTES];
    let payload =
        encode_guest_state_restore_request(1, 1, 0, &entropy, GuestStateRestoreTimezone::None)
            .unwrap();
    let decoded = decode_guest_state_restore_request(&payload).unwrap();

    let debug = format!("{decoded:?}");
    assert!(debug.contains("entropy_len: 256"), "debug={debug}");
    assert!(!debug.contains("222, 222"), "debug={debug}");
}

#[test]
fn request_rejects_invalid_fixed_inputs() {
    let entropy = entropy();
    assert!(
        encode_guest_state_restore_request(0, 1, 0, &entropy, GuestStateRestoreTimezone::None)
            .is_err()
    );
    assert!(
        encode_guest_state_restore_request(
            1,
            i64::MAX as u64 + 1,
            0,
            &entropy,
            GuestStateRestoreTimezone::None
        )
        .is_err()
    );
    assert!(
        encode_guest_state_restore_request(
            1,
            1,
            1_000_000_000,
            &entropy,
            GuestStateRestoreTimezone::None
        )
        .is_err()
    );
    assert!(
        encode_guest_state_restore_request(
            1,
            1,
            0,
            &entropy[..255],
            GuestStateRestoreTimezone::None
        )
        .is_err()
    );
    assert!(
        encode_guest_state_restore_request(
            1,
            1,
            0,
            &entropy,
            GuestStateRestoreTimezone::Required("../UTC")
        )
        .is_err()
    );
    let oversized_timezone = "A".repeat(GUEST_STATE_RESTORE_MAX_TIMEZONE_BYTES + 1);
    assert!(
        encode_guest_state_restore_request(
            1,
            1,
            0,
            &entropy,
            GuestStateRestoreTimezone::Required(&oversized_timezone)
        )
        .is_err()
    );
}

#[test]
fn request_decoder_rejects_bad_mode_length_and_trailing_bytes() {
    let entropy = entropy();
    let mut payload =
        encode_guest_state_restore_request(1, 1, 0, &entropy, GuestStateRestoreTimezone::None)
            .unwrap();
    payload[16] = TIMEZONE_REQUIRED;
    assert!(decode_guest_state_restore_request(&payload).is_err());

    let mut invalid_mode =
        encode_guest_state_restore_request(1, 1, 0, &entropy, GuestStateRestoreTimezone::None)
            .unwrap();
    invalid_mode[16] = u8::MAX;
    assert!(decode_guest_state_restore_request(&invalid_mode).is_err());

    let mut none_with_name = encode_guest_state_restore_request(
        1,
        1,
        0,
        &entropy,
        GuestStateRestoreTimezone::BestEffort("UTC"),
    )
    .unwrap();
    none_with_name[16] = TIMEZONE_NONE;
    assert!(decode_guest_state_restore_request(&none_with_name).is_err());

    let mut invalid_utf8 = encode_guest_state_restore_request(
        1,
        1,
        0,
        &entropy,
        GuestStateRestoreTimezone::Required("A"),
    )
    .unwrap();
    invalid_utf8[19] = u8::MAX;
    assert!(decode_guest_state_restore_request(&invalid_utf8).is_err());

    let mut truncated = payload;
    truncated.pop();
    assert!(decode_guest_state_restore_request(&truncated).is_err());

    let mut trailing =
        encode_guest_state_restore_request(1, 1, 0, &entropy, GuestStateRestoreTimezone::None)
            .unwrap();
    trailing.push(0);
    assert!(decode_guest_state_restore_request(&trailing).is_err());
}

#[test]
fn result_round_trip_requires_empty_stdout_and_bounded_stderr() {
    let stderr = ExecCapturedOutput::Captured {
        bytes: b"guest-state-restore failed",
        truncated: false,
    };
    let payload = encode_guest_state_restore_result(
        ExecTermination::Exited { exit_code: 1 },
        17,
        stderr,
        "diagnostic",
    )
    .unwrap();

    let decoded = decode_guest_state_restore_result(&payload).unwrap();
    assert_eq!(
        decoded.termination,
        ExecTermination::Exited { exit_code: 1 }
    );
    assert_eq!(decoded.duration_ms, 17);
    assert_eq!(
        decoded.stdout,
        ExecCapturedOutput::Captured {
            bytes: &[],
            truncated: false
        }
    );
    assert_eq!(decoded.stderr, stderr);
    assert_eq!(decoded.diagnostic, "diagnostic");

    assert!(
        encode_guest_state_restore_result(
            ExecTermination::WaitFailed,
            0,
            ExecCapturedOutput::Discarded,
            ""
        )
        .is_err()
    );
}
