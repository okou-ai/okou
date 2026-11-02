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
