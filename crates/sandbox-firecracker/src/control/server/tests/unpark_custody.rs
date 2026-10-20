//! A control admitted before park must revalidate at actual Guest frame write.

use super::*;

#[tokio::test]
async fn old_control_cannot_cross_terminal_unpark_fence_release() {
    for expected_run_id in [None, Some("run-a".to_owned())] {
        let (exec_seen_tx, mut exec_seen_rx) = oneshot::channel();
        let fixture =
            VsockExecFixture::connect(|base| mock_guest_records_exec(base, exec_seen_tx)).await;
        fixture.coordinator.bind_run_control("run-a").unwrap();
        // These are the actual control server's initial observation and delayed
        // write admission, retained across the original park/unpark boundary.
        let guest = fixture.gate.begin_control_operation().await.unwrap();
        let admission = control_write_admission(&fixture.gate, expected_run_id);
        let attempt = fixture.coordinator.begin_prepare_park().unwrap();
        let fence = guest.try_fence_normal_operations().unwrap();
        fixture
            .coordinator
            .complete_prepare_park(&attempt, PrepareParkEvidence::AgentQuiesced)
            .unwrap();
        fixture.coordinator.mark_parked(&attempt).unwrap();
        fixture.coordinator.bind_run_control("run-a").unwrap();
        fixture
            .coordinator
            .mark_dirty(DirtyReason::abandoned_unpark(
                "borrowed unpark cancelled",
                Some(uuid::Uuid::new_v4()),
            ));
        drop(fence);

        let error = guest
            .exec_operation_capture_with_write_admission(
                guest_control_client::ExecCaptureRequest {
                    command: "must-not-cross-dirty-terminal-recovery",
                    timeout_ms: 5_000,
                    env: &[],
                    sudo: false,
                    label: "runner-exec",
                    stdout_limit_bytes: EXEC_OUTPUT_LIMIT_7_MIB.stdout_limit_bytes,
                    stderr_limit_bytes: EXEC_OUTPUT_LIMIT_7_MIB.stderr_limit_bytes,
                    expected_exit_codes: &[],
                    stdin_bytes: None,
                    wait_timeout: Duration::from_secs(5),
                },
                admission,
            )
            .await
            .unwrap_err();
        assert!(matches!(exec_seen_rx.try_recv(), Err(TryRecvError::Empty)));
        assert!(
            error.to_string().contains("operation gate closed"),
            "{error}"
        );
        assert!(guest.try_fence_normal_operations().is_ok());
        fixture.guest_task.abort();
        let _ = fixture.guest_task.await;
    }
}
