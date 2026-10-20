//! Accepted real physical pause while the public repark still awaits its HTTP response.

pub(super) use super::native_transition::Fault;
use super::*;

#[test]
fn native_pause_reader_checks_original_files_and_cli() {
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/guarded_idle_native/native_pause_report_test.py"
        ))
        .output()
        .expect("native pause reader requires Python3");
    assert!(
        output.status.success(),
        "native pause report: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires exact-source Host/current Guests, owned KVM/NBD and accepted-pause P1 proof"]
async fn native_accepted_physical_pause_loss_preserves_required_saving() -> TestResult<()> {
    measured_selected_corpora(
        &[NativeScope::Batch(IdleRetirementBatchScope::All)],
        &[
            Corpus::NativePause(Fault::Drop),
            Corpus::NativePause(Fault::ObserverUnwind),
            Corpus::NativePause(Fault::ProducerUnwind),
        ],
    )
    .await
}
