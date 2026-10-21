//! Exact canonical final preparation request/result, before quiesce or pause.

use guest_control_client::test_support::request_gate::Frame;
use guest_control_proto::{
    DecodedExecResult, ExecCapturedOutput, ExecControlPolicy, ExecLifecyclePolicy,
    ExecOutputPolicy, ExecProcessRole, ExecTermination, ExecTimeoutPolicy, MSG_EXEC_RESULT,
    MSG_EXEC_START,
};
use runner_lifecycle::idle_reuse_preparation::IdleReusePreparation;

use super::*;

fn preparation(id: &str, history: RunId, operation: RunId) -> TestResult<IdleReusePreparation> {
    let runtime =
        guest_contracts::runtime_paths::run_dir_for_home("/home/user", &history.to_string())?;
    let runtime = runtime
        .to_str()
        .ok_or_else(|| io::Error::other("original runtime is not UTF8"))?;
    Ok(
        IdleReusePreparation::new(id, operation, history, Some(runtime))
            .map_err(|error| io::Error::other(error.to_string()))?,
    )
}

pub(super) fn validate_request(
    frame: &Frame,
    payload: &[u8],
    history: RunId,
    operation: RunId,
    id: &str,
) -> TestResult<()> {
    let expected = preparation(id, history, operation)?;
    let request = expected.exec_request();
    let actual = guest_control_proto::decode_exec_start(payload)?;
    if frame.message_type() != MSG_EXEC_START
        || actual.lifecycle != ExecLifecyclePolicy::OneShot
        || actual.role != ExecProcessRole::Workload
        || actual.timeout
            != (ExecTimeoutPolicy::Duration {
                timeout_ms: request.timeout_ms(),
            })
        || actual.command != request.cmd
        || !actual.env.is_empty()
        || !actual.sudo
        || actual.label != "idle-reuse-preparation-and-park"
        || actual.stdout != (ExecOutputPolicy::Capture { limit_bytes: 65536 })
        || actual.stderr != (ExecOutputPolicy::Capture { limit_bytes: 65536 })
        || !actual.expected_exit_codes.is_empty()
        || actual.control != ExecControlPolicy::Disabled
        || actual.stdin_bytes != request.stdin_bytes
    {
        return Err(io::Error::other(
            "actual final preparation request or original attribution changed",
        )
        .into());
    }
    Ok(())
}

pub(super) fn validate_result<'a>(
    frame: &Frame,
    payload: &'a [u8],
    history: RunId,
    operation: RunId,
    id: &str,
) -> TestResult<DecodedExecResult<'a>> {
    let decoded = guest_control_proto::decode_exec_result(payload)?;
    let (
        ExecCapturedOutput::Captured {
            bytes: stdout,
            truncated: false,
        },
        ExecCapturedOutput::Captured {
            bytes: stderr,
            truncated: false,
        },
    ) = (decoded.stdout, decoded.stderr)
    else {
        return Err(io::Error::other("final preparation output drains are incomplete").into());
    };
    if frame.message_type() != MSG_EXEC_RESULT
        || decoded.termination != (ExecTermination::Exited { exit_code: 0 })
        || !decoded.diagnostic.is_empty()
        || stdout.len() > 65536
        || stderr.len() > 65536
    {
        return Err(
            io::Error::other("actual canonical final exec did not finish successfully").into(),
        );
    }
    // Apply the actual owner's report/capacity gate without completing repark,
    // quiesce, physical pause or any lost observer's reconciliation.
    preparation(id, history, operation)?
        .validate_result(&sandbox::ExecResult::new(
            0,
            stdout.to_vec(),
            stderr.to_vec(),
        ))
        .map_err(|error| io::Error::other(error.to_string()))?;
    Ok(decoded)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires exact committed Host/current Guests, owned KVM/NBD, new matching snapshot and unchanged P1"]
async fn native_final_exec_loss_retains_original_uncertainty() -> TestResult<()> {
    guest_preparation::selected(guest_preparation::Kind::FinalExec, "OKOU_TEST_FINAL_EXEC").await
}

#[test]
fn final_exec_reader_checks_original_files_and_cli() {
    guest_preparation::reader_test("final_exec_report_test.py");
}
