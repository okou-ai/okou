//! Accepted real resume while the public unpark still awaits its HTTP response.

pub(super) use super::native_transition::Fault;
use super::*;

#[test]
fn native_unpark_reader_checks_original_files_and_cli() {
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/guarded_idle_native/native_unpark_report_test.py"
        ))
        .output()
        .expect("native unpark reader requires Python3");
    assert!(
        output.status.success(),
        "native unpark report: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires exact-source Host/current Guests, owned KVM/NBD and accepted-resume P1 proof"]
async fn native_accepted_unpark_loss_preserves_required_saving() -> TestResult<()> {
    measured_selected_corpora(
        &[NativeScope::Batch(IdleRetirementBatchScope::All)],
        &[
            Corpus::NativeUnpark(Fault::Drop),
            Corpus::NativeUnpark(Fault::ObserverUnwind),
            Corpus::NativeUnpark(Fault::ProducerUnwind),
        ],
    )
    .await
}
