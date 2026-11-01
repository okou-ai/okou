use super::*;

#[test]
fn request_roundtrips() {
    let payload = encode_guest_dns_readiness_request(1_100, "vm0-readiness.invalid").unwrap();
    assert_eq!(
        decode_guest_dns_readiness_request(&payload).unwrap(),
        DecodedGuestDnsReadinessRequest {
            timeout_ms: 1_100,
            hostname: "vm0-readiness.invalid",
        }
    );
}

#[test]
fn request_frame_matches_payload_encoding() {
    let payload = encode_guest_dns_readiness_request(1_100, "example.invalid").unwrap();
    let expected = crate::encode(MSG_GUEST_DNS_READINESS, 42, &payload).unwrap();
    let mut frame = Vec::new();
    encode_guest_dns_readiness_request_frame_into(&mut frame, 42, 1_100, "example.invalid")
        .unwrap();
    assert_eq!(frame, expected);
}

#[test]
fn request_rejects_invalid_values_and_shape() {
    assert!(encode_guest_dns_readiness_request(0, "example.invalid").is_err());
    assert!(encode_guest_dns_readiness_request(1, "").is_err());
    assert!(encode_guest_dns_readiness_request(1, &"x".repeat(254)).is_err());
    assert!(encode_guest_dns_readiness_request(1, "bad\0name").is_err());

    let valid = encode_guest_dns_readiness_request(1, "example.invalid").unwrap();
    for malformed in [valid[..5].to_vec(), [&valid[..], &[0]].concat()] {
        assert!(decode_guest_dns_readiness_request(&malformed).is_err());
    }
}

#[test]
fn result_roundtrips_each_termination() {
    for termination in [
        GuestDnsReadinessTermination::Exited { exit_code: 0 },
        GuestDnsReadinessTermination::Exited { exit_code: 2 },
        GuestDnsReadinessTermination::TimedOut,
        GuestDnsReadinessTermination::Cancelled,
        GuestDnsReadinessTermination::StartFailed,
        GuestDnsReadinessTermination::WaitFailed,
    ] {
        let payload = encode_guest_dns_readiness_result(
            termination,
            17,
            b"192.0.2.1 STREAM\n",
            true,
            "diagnostic",
        )
        .unwrap();
        assert_eq!(
            decode_guest_dns_readiness_result(&payload).unwrap(),
            DecodedGuestDnsReadinessResult {
                termination,
                duration_ms: 17,
                answer: b"192.0.2.1 STREAM\n",
                output_truncated: true,
                diagnostic: "diagnostic",
            }
        );
    }
}

#[test]
fn result_enforces_bounds() {
    assert!(
        encode_guest_dns_readiness_result(
            GuestDnsReadinessTermination::TimedOut,
            1,
            &vec![0; GUEST_DNS_READINESS_MAX_ANSWER_BYTES + 1],
            false,
            "",
        )
        .is_err()
    );
    assert!(
        encode_guest_dns_readiness_result(
            GuestDnsReadinessTermination::TimedOut,
            1,
            b"",
            false,
            &"x".repeat(GUEST_DNS_READINESS_MAX_DIAGNOSTIC_BYTES + 1),
        )
        .is_err()
    );
}

#[test]
fn result_rejects_unknown_and_malformed_values() {
    let valid = encode_guest_dns_readiness_result(
        GuestDnsReadinessTermination::Exited { exit_code: 0 },
        1,
        b"answer",
        false,
        "",
    )
    .unwrap();

    let mut unknown_termination = valid.clone();
    unknown_termination[0] = 0xFF;
    assert!(matches!(
        decode_guest_dns_readiness_result(&unknown_termination),
        Err(ProtocolError::InvalidPayload(
            "guest_dns_readiness_result unknown termination"
        ))
    ));

    assert!(matches!(
        decode_guest_dns_readiness_result(&[0x00, 0x00, 0x00, 0x00]),
        Err(ProtocolError::InvalidPayload(
            "guest_dns_readiness_result exit_code truncated"
        ))
    ));

    let mut unknown_flags = valid.clone();
    unknown_flags[9] = 0x80;
    assert!(decode_guest_dns_readiness_result(&unknown_flags).is_err());

    for malformed in [
        valid[..valid.len() - 1].to_vec(),
        [&valid[..], &[0]].concat(),
    ] {
        assert!(decode_guest_dns_readiness_result(&malformed).is_err());
    }
}
