use super::*;

#[test]
fn status_schema_roundtrips_all_stages_and_rejects_malformed_snapshots() {
    for stage in [
        FileWriteStage::Idle,
        FileWriteStage::Queued,
        FileWriteStage::StartingHelper,
        FileWriteStage::WaitingForHelper,
        FileWriteStage::JoiningStdin,
        FileWriteStage::DrainingStderr,
        FileWriteStage::WaitingForWriter,
        FileWriteStage::WritingResponse,
        FileWriteStage::ResponseSent,
    ] {
        let status = FileWriteStatus {
            sequence: if stage == FileWriteStage::Idle {
                0
            } else {
                0x12345678
            },
            stage,
        };
        assert_eq!(
            FileWriteStatus::decode_payload(&status.encode_payload()).unwrap(),
            status
        );
    }
    for payload in [
        b"".as_slice(),
        &[0, 0, 0, 0],
        &[0, 0, 0, 0, 0, 0],
        &[0, 0, 0, 1, 255],
        &[0, 0, 0, 1, 0],
        &[0, 0, 0, 0, 3],
    ] {
        assert!(
            FileWriteStatus::decode_payload(payload).is_err(),
            "{payload:?}"
        );
    }
}
