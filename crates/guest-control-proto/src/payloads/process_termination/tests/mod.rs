use super::*;

const ERRORS: TerminationDecodeErrors = TerminationDecodeErrors {
    termination_truncated: "test termination truncated",
    exit_code_truncated: "test exit_code truncated",
    invalid_tag: "test invalid termination tag",
};

#[test]
fn every_termination_round_trips_with_stable_bytes() {
    for (termination, expected) in [
        (
            ExecTermination::Exited { exit_code: -9 },
            vec![0x00, 0xff, 0xff, 0xff, 0xf7],
        ),
        (ExecTermination::TimedOut, vec![0x01]),
        (ExecTermination::Cancelled, vec![0x02]),
        (ExecTermination::StartFailed, vec![0x03]),
        (ExecTermination::WaitFailed, vec![0x04]),
    ] {
        let mut encoded = Vec::new();
        append_termination(&mut encoded, termination);

        assert_eq!(encoded, expected);
        assert_eq!(encoded.len(), termination_encoded_len(termination));

        let mut offset = 0;
        assert_eq!(
            decode_termination(&encoded, &mut offset, ERRORS).unwrap(),
            termination
        );
        assert_eq!(offset, encoded.len());
    }
}

#[test]
fn decoder_rejects_unknown_tag_and_truncated_exit_code() {
    let mut offset = 0;
    assert!(matches!(
        decode_termination(&[0xff], &mut offset, ERRORS),
        Err(ProtocolError::InvalidPayload(
            "test invalid termination tag"
        ))
    ));

    let mut offset = 0;
    assert!(matches!(
        decode_termination(&[0x00, 0x00, 0x00, 0x00], &mut offset, ERRORS),
        Err(ProtocolError::InvalidPayload("test exit_code truncated"))
    ));
}
