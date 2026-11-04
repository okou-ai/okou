use super::*;
use crate::{Decoder, MSG_HOME_DRIVE_MOUNT};

#[test]
fn request_binds_exact_paired_layout_without_caller_selected_inputs() {
    let mut frame = vec![1, 2, 3];
    encode_home_drive_mount_request_frame_into(&mut frame, 17).unwrap();
    let decoded = Decoder::new().decode(&frame).unwrap().remove(0);

    assert_eq!(decoded.msg_type, MSG_HOME_DRIVE_MOUNT);
    assert_eq!(decoded.seq, 17);
    assert_eq!(decoded.payload, HOME_DRIVE_LAYOUT.as_bytes());
    decode_home_drive_mount_request(&decoded.payload).unwrap();
    for incompatible in [
        b"".as_slice(),
        b"home-drive-v2",
        b"home-drive-v1\0",
        b"/dev/vda",
    ] {
        assert!(decode_home_drive_mount_request(incompatible).is_err());
    }
}

#[test]
fn result_round_trips_fixed_captured_output() {
    let payload = encode_home_drive_mount_result(
        ExecTermination::Exited { exit_code: 64 },
        23,
        ExecCapturedOutput::Captured {
            bytes: b"mount stdout",
            truncated: false,
        },
        ExecCapturedOutput::Captured {
            bytes: b"mount stderr",
            truncated: true,
        },
        "diagnostic",
    )
    .unwrap();
    let decoded = decode_home_drive_mount_result(&payload).unwrap();

    assert_eq!(
        decoded.termination,
        ExecTermination::Exited { exit_code: 64 }
    );
    assert_eq!(decoded.duration_ms, 23);
    assert_eq!(
        decoded.stdout,
        ExecCapturedOutput::Captured {
            bytes: b"mount stdout",
            truncated: false,
        }
    );
    assert_eq!(
        decoded.stderr,
        ExecCapturedOutput::Captured {
            bytes: b"mount stderr",
            truncated: true,
        }
    );
    assert_eq!(decoded.diagnostic, "diagnostic");
}

#[test]
fn result_rejects_discarded_or_oversized_output() {
    let captured = ExecCapturedOutput::Captured {
        bytes: &[],
        truncated: false,
    };
    assert!(
        encode_home_drive_mount_result(
            ExecTermination::Exited { exit_code: 0 },
            1,
            ExecCapturedOutput::Discarded,
            captured,
            "",
        )
        .is_err()
    );

    let oversized = vec![0; HOME_DRIVE_MOUNT_OUTPUT_LIMIT_BYTES + 1];
    assert!(
        encode_home_drive_mount_result(
            ExecTermination::Exited { exit_code: 0 },
            1,
            ExecCapturedOutput::Captured {
                bytes: &oversized,
                truncated: true,
            },
            captured,
            "",
        )
        .is_err()
    );
}

#[test]
fn result_capture_boundaries_match_across_payload_frame_and_decode() {
    let bytes = vec![0xA5; HOME_DRIVE_MOUNT_OUTPUT_LIMIT_BYTES + 1];
    let empty = ExecCapturedOutput::Captured {
        bytes: &[],
        truncated: false,
    };
    for field in ["stdout", "stderr"] {
        for truncated in [false, true] {
            let maximum = ExecCapturedOutput::Captured {
                bytes: &bytes[..HOME_DRIVE_MOUNT_OUTPUT_LIMIT_BYTES],
                truncated,
            };
            let (stdout, stderr) = if field == "stdout" {
                (maximum, empty)
            } else {
                (empty, maximum)
            };
            let termination = ExecTermination::Exited { exit_code: 7 };
            let payload =
                encode_home_drive_mount_result(termination, u32::MAX, stdout, stderr, "boundary")
                    .unwrap();
            let decoded = decode_home_drive_mount_result(&payload).unwrap();
            assert_eq!(decoded.termination, termination);
            assert_eq!(decoded.duration_ms, u32::MAX);
            assert_eq!(decoded.stdout, stdout);
            assert_eq!(decoded.stderr, stderr);
            assert_eq!(decoded.diagnostic, "boundary");
            let mut frame = b"stale frame bytes".to_vec();
            encode_home_drive_mount_result_frame_into(
                &mut frame,
                42,
                termination,
                u32::MAX,
                stdout,
                stderr,
                "boundary",
            )
            .unwrap();
            assert_eq!(
                frame,
                crate::encode(crate::MSG_HOME_DRIVE_MOUNT_RESULT, 42, &payload).unwrap()
            );

            for invalid in [
                ExecCapturedOutput::Captured {
                    bytes: &bytes,
                    truncated,
                },
                ExecCapturedOutput::Discarded,
            ] {
                let (stdout, stderr) = if field == "stdout" {
                    (invalid, empty)
                } else {
                    (empty, invalid)
                };
                assert_home_capture_errors(stdout, stderr, invalid, field);
            }
        }
    }

    // Both streams are invalid: stdout's contract violation takes precedence.
    let oversized = ExecCapturedOutput::Captured {
        bytes: &bytes,
        truncated: false,
    };
    assert_home_capture_errors(
        oversized,
        ExecCapturedOutput::Discarded,
        oversized,
        "stdout",
    );
    assert_home_capture_errors(
        ExecCapturedOutput::Discarded,
        oversized,
        ExecCapturedOutput::Discarded,
        "stdout",
    );
}

fn assert_home_capture_errors(
    stdout: ExecCapturedOutput<'_>,
    stderr: ExecCapturedOutput<'_>,
    invalid: ExecCapturedOutput<'_>,
    field: &'static str,
) {
    let termination = ExecTermination::WaitFailed;
    let payload = crate::encode_exec_result(termination, 0, stdout, stderr, "").unwrap();
    let mut frame = b"stale frame bytes".to_vec();
    let errors = [
        encode_home_drive_mount_result(termination, 0, stdout, stderr, "").unwrap_err(),
        encode_home_drive_mount_result_frame_into(
            &mut frame,
            42,
            termination,
            0,
            stdout,
            stderr,
            "",
        )
        .unwrap_err(),
        decode_home_drive_mount_result(&payload).unwrap_err(),
    ];
    assert_eq!(frame, b"stale frame bytes");
    for error in errors {
        match invalid {
            ExecCapturedOutput::Captured { bytes, .. } => assert!(matches!(
                error,
                ProtocolError::PayloadTooLarge(actual_field, size)
                    if actual_field == field && size == bytes.len()
            )),
            ExecCapturedOutput::Discarded => assert!(matches!(
                error,
                ProtocolError::InvalidPayload("home_drive_mount_result output must be captured")
            )),
        }
    }
}
