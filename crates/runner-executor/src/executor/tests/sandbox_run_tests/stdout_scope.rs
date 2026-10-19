use super::super::support::spawn_run_in_sandbox_test;
use super::*;
use sandbox::{
    GuestProcessControlHandle, GuestProcessHandle, GuestProcessWaiter, ProcessControlAck,
    ProcessControlOutcome,
};
use std::os::unix::fs::PermissionsExt;
use tokio_util::{sync::CancellationToken, task::AbortOnDropHandle};

const WAIT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy)]
enum ScopeEnd {
    PendingProcess,
    PendingDrain,
    ProviderUnwind,
}

async fn assert_abandoned_stdout_retires(scope_end: ScopeEnd) {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let context = minimal_context();
    let path = config.log_paths.system_stream_log(context.run_id);
    let (sender, receiver) = tokio::sync::mpsc::channel(2);
    for bytes in [b"accepted first\n".to_vec(), b"accepted second\n".to_vec()] {
        sender
            .try_send(ProcessOutputChunk {
                bytes,
                truncated: false,
            })
            .unwrap();
    }
    let (entered, waiting) = tokio::sync::oneshot::channel();
    let handle = GuestProcessHandle::new(
        1,
        Some(receiver),
        Some(GuestProcessControlHandle::new_with_outcome(
            |message_id, _, _| {
                Box::pin(async move {
                    ProcessControlOutcome::Delivered(ProcessControlAck { message_id })
                })
            },
        )),
        GuestProcessWaiter::new(move |_timeout| {
            Box::pin(async move {
                entered.send(()).unwrap();
                match scope_end {
                    ScopeEnd::PendingProcess => std::future::pending().await,
                    ScopeEnd::PendingDrain => Ok(ProcessExit::new(1, 0, Vec::new(), Vec::new())),
                    ScopeEnd::ProviderUnwind => {
                        std::panic::resume_unwind(Box::new("provider process waiter failed"))
                    }
                }
            })
        }),
    );
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_agent_process_handle(handle);
    let sandbox = create_overridden_sandbox(overrides).await;
    let task = AbortOnDropHandle::new(spawn_run_in_sandbox_test(
        sandbox,
        context,
        config,
        CancellationToken::new(),
    ));
    tokio::time::timeout(WAIT, waiting)
        .await
        .expect("execution must reach its actual provider process waiter")
        .unwrap();
    if !matches!(scope_end, ScopeEnd::ProviderUnwind) {
        assert!(
            !task.is_finished(),
            "the retained sender must keep stdout open"
        );
        task.abort_handle().abort();
    }
    let error = tokio::time::timeout(WAIT, task)
        .await
        .expect("execution scope destruction must finish")
        .err()
        .expect("execution scope must end exceptionally");
    if matches!(scope_end, ScopeEnd::ProviderUnwind) {
        assert!(error.is_panic());
    } else {
        assert!(error.is_cancelled());
    }

    // Keep the actual provider sender alive: its destruction cannot explain
    // receiver retirement or successful persistence of the accepted queue.
    tokio::time::timeout(WAIT, sender.closed())
        .await
        .expect("abandoned execution must retire its stdout receiver");
    let expected = b"accepted first\naccepted second\n";
    tokio::time::timeout(WAIT, async {
        loop {
            if tokio::fs::read(&path)
                .await
                .is_ok_and(|bytes| bytes == expected)
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("retirement must preserve all accepted stdout bytes");
    let error = sender
        .try_send(ProcessOutputChunk {
            bytes: b"late output".to_vec(),
            truncated: false,
        })
        .unwrap_err();
    assert!(matches!(
        error,
        tokio::sync::mpsc::error::TrySendError::Closed(_)
    ));
    assert_eq!(tokio::fs::read(&path).await.unwrap(), expected);
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[tokio::test]
async fn abandoned_process_wait_closes_stdout_and_preserves_accepted_bytes() {
    assert_abandoned_stdout_retires(ScopeEnd::PendingProcess).await;
}

#[tokio::test]
async fn abandoned_stdout_join_closes_stdout_and_preserves_accepted_bytes() {
    assert_abandoned_stdout_retires(ScopeEnd::PendingDrain).await;
}

#[tokio::test]
async fn provider_wait_unwind_closes_stdout_and_preserves_accepted_bytes() {
    assert_abandoned_stdout_retires(ScopeEnd::ProviderUnwind).await;
}
