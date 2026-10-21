//! Genuine dispatcher acknowledgement, before ReadyForPark or physical pause.

use guest_control_client::test_support::request_gate::Frame;
use guest_control_proto::{MSG_OPERATIONS_QUIESCED, MSG_QUIESCE_OPERATIONS};

use super::*;

pub(super) fn validate_request(frame: &Frame, payload: &[u8]) -> TestResult<()> {
    if frame.message_type() != MSG_QUIESCE_OPERATIONS || !payload.is_empty() {
        return Err(io::Error::other("original empty quiesce request changed").into());
    }
    Ok(())
}

pub(super) fn validate_response(frame: &Frame, payload: &[u8]) -> TestResult<()> {
    // An error terminal (including Busy) is never a Quiesced acknowledgement.
    // The real dispatcher sends this only after fencing admission, observing
    // zero pending operations and validating empty process containment.
    if frame.message_type() != MSG_OPERATIONS_QUIESCED || !payload.is_empty() {
        return Err(io::Error::other("original Guest did not acknowledge quiescence").into());
    }
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires exact committed Host/current Guests, owned KVM/NBD, new matching snapshot and unchanged P1"]
async fn native_quiesce_loss_retains_original_uncertainty() -> TestResult<()> {
    guest_preparation::selected(guest_preparation::Kind::Quiesce, "OKOU_TEST_QUIESCE").await
}

#[test]
fn quiesce_reader_checks_original_files_and_cli() -> TestResult<()> {
    guest_preparation::reader_test("quiesce_report_test.py")
}
