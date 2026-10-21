//! Existing fixed-restore entry points retain their original evidence contract.

use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires exact committed Host/current Guests, owned KVM/NBD, new matching snapshot and unchanged P1"]
async fn native_fixed_restore_loss_retains_original_uncertainty() -> TestResult<()> {
    guest_preparation::selected(
        guest_preparation::Kind::FixedRestore,
        "OKOU_TEST_FIXED_RESTORE",
    )
    .await
}

#[test]
fn fixed_restore_reader_checks_original_files_and_cli() {
    guest_preparation::reader_test("fixed_restore_report_test.py");
}
