use super::super::super::*;
use super::env::MockRunEnv;
use futures_util::FutureExt;
use std::future::Future;
use std::panic::AssertUnwindSafe;

use crate::idle_pool::ParkingState;
use crate::workspace_image_cache::WorkspaceImageCache;
use runner_provider::{RunCancellationHandle, RunCancellationRegistry};

const WAIT_POLL_INTERVAL: Duration = Duration::from_millis(10);

pub(super) enum WaitProbe<T> {
    Ready(T),
    Pending(String),
}

pub(super) async fn wait_for_probe<T, F, Fut>(timeout: Duration, mut probe: F) -> T
where
    F: FnMut() -> Fut,
    Fut: Future<Output = WaitProbe<T>>,
{
    let deadline = tokio::time::Instant::now() + timeout;
    let mut last_pending_message = None;
    let result = tokio::time::timeout_at(deadline, async {
        loop {
            match probe().await {
                WaitProbe::Ready(value) => return value,
                WaitProbe::Pending(message) => {
                    last_pending_message = Some(message);
                    tokio::time::sleep(WAIT_POLL_INTERVAL).await;
                }
            }
        }
    })
    .await;

    match result {
        Ok(value) => value,
        Err(_) => match last_pending_message {
            Some(message) => panic!("{message}"),
            None => panic!("probe did not complete within {timeout:?}"),
        },
    }
}

#[tokio::test(start_paused = true)]
async fn wait_for_probe_times_out_while_probe_is_pending() {
    let local_timeout = Duration::from_secs(1);
    let result = tokio::time::timeout(
        local_timeout + Duration::from_secs(1),
        AssertUnwindSafe(wait_for_probe(local_timeout, || {
            std::future::pending::<WaitProbe<()>>()
        }))
        .catch_unwind(),
    )
    .await
    .expect("test guard elapsed before wait_for_probe's local deadline");

    let panic = result.expect_err("wait_for_probe should panic at its local deadline");
    let message = panic
        .downcast_ref::<String>()
        .expect("wait_for_probe panic should contain a String message");
    assert_eq!(message, "probe did not complete within 1s");
}

#[tokio::test(start_paused = true)]
#[should_panic(expected = "probe attempt 3")]
async fn wait_for_probe_preserves_latest_pending_message() {
    let mut attempt = 0;
    wait_for_probe(Duration::from_millis(25), || {
        attempt += 1;
        let attempt = attempt;
        async move { WaitProbe::<()>::Pending(format!("probe attempt {attempt}")) }
    })
    .await;
}

#[tokio::test(start_paused = true)]
async fn wait_for_probe_returns_after_pending_probe_becomes_ready() {
    let mut attempt = 0;
    let value = wait_for_probe(Duration::from_secs(1), || {
        attempt += 1;
        let attempt = attempt;
        async move {
            if attempt == 1 {
                WaitProbe::Pending("probe is not ready".to_string())
            } else {
                WaitProbe::Ready(42)
            }
        }
    })
    .await;

    assert_eq!(value, 42);
}

pub(in super::super) async fn assert_run_exits_within(
    run_handle: tokio::task::JoinHandle<RunnerResult<()>>,
    timeout: Duration,
    timeout_msg: &str,
) {
    let mut run_handle = run_handle;
    match tokio::time::timeout(timeout, &mut run_handle).await {
        Ok(Ok(Ok(()))) => {}
        Ok(Ok(Err(e))) => panic!("run() returned error: {e}"),
        Ok(Err(e)) => panic!("task panicked: {e}"),
        Err(_) => {
            run_handle.abort();
            let _ = tokio::time::timeout(Duration::from_secs(1), run_handle).await;
            panic!("{timeout_msg}");
        }
    }
}

/// Poll until `budget.allocated().2` (running_count) reaches `expected`.
///
/// The active budget lease is dropped after `provider.complete()` in the
/// spawned job task, so `wait_completion()` returning does NOT guarantee
/// the budget has been released yet. This helper avoids fixed sleeps as
/// synchronization.
pub(in super::super) async fn wait_budget_count(
    budget: &ResourceBudget,
    expected: usize,
    timeout: Duration,
) {
    wait_for_probe(timeout, || async {
        let actual = budget.allocated().2;
        if actual == expected {
            WaitProbe::Ready(())
        } else {
            WaitProbe::Pending(format!(
                "budget count did not reach {expected} within {timeout:?} (actual: {actual})",
            ))
        }
    })
    .await;
}

pub(in super::super) async fn wait_idle_pool_len(
    pool: &SharedIdlePool,
    expected: usize,
    timeout: Duration,
) {
    wait_for_probe(timeout, || async {
        let actual = pool.lock().await.len();
        if actual == expected {
            WaitProbe::Ready(())
        } else {
            WaitProbe::Pending(format!(
                "idle pool length did not reach {expected} within {timeout:?} (actual: {actual})",
            ))
        }
    })
    .await;
}

pub(in super::super) async fn wait_idle_pool_reuse_keys(
    pool: &SharedIdlePool,
    expected: &[&str],
    timeout: Duration,
) {
    let mut expected: Vec<String> = expected
        .iter()
        .map(|reuse_key| (*reuse_key).to_string())
        .collect();
    expected.sort_unstable();
    wait_for_probe(timeout, || async {
        let actual = pool.lock().await.held_reuse_keys();
        if actual == expected {
            WaitProbe::Ready(())
        } else {
            WaitProbe::Pending(format!(
                "idle pool reuse keys did not reach {expected:?} within {timeout:?} (actual: {actual:?})",
            ))
        }
    })
    .await;
}

pub(in super::super) async fn wait_workspace_cache_reuse_keys(
    cache: &WorkspaceImageCache,
    expected: &[&str],
    timeout: Duration,
) {
    let mut expected: Vec<String> = expected
        .iter()
        .map(|reuse_key| (*reuse_key).to_string())
        .collect();
    expected.sort_unstable();
    wait_for_probe(timeout, || async {
        let states = cache.held_workspace_states().await;
        for state in &states {
            if chrono::DateTime::parse_from_rfc3339(&state.last_completed_at).is_err() {
                return WaitProbe::Pending(format!(
                    "workspace cache state had invalid timestamp: {state:?}",
                ));
            }
        }
        let mut actual: Vec<String> = states.into_iter().map(|state| state.reuse_key).collect();
        actual.sort_unstable();
        if actual == expected {
            WaitProbe::Ready(())
        } else {
            WaitProbe::Pending(format!(
                "workspace cache reuse keys did not reach {expected:?} within {timeout:?} (actual: {actual:?})",
            ))
        }
    })
    .await;
}

pub(in super::super) async fn wait_sandbox_lifecycle_counts(
    overrides: &sandbox_mock::MockSandboxOverrides,
    expected_park: u32,
    expected_unpark: u32,
    timeout: Duration,
) {
    wait_for_probe(timeout, || async {
        let actual_park = overrides.park_call_count();
        let actual_unpark = overrides.unpark_call_count();
        if actual_park == expected_park && actual_unpark == expected_unpark {
            WaitProbe::Ready(())
        } else {
            WaitProbe::Pending(format!(
                "sandbox lifecycle counts did not reach park={expected_park} unpark={expected_unpark} within {timeout:?} (actual park={actual_park} unpark={actual_unpark})",
            ))
        }
    })
    .await;
}

/// Poll until the idle pool parking state reaches `expected`.
pub(in super::super) async fn wait_parking_state(
    pool: &SharedIdlePool,
    expected: ParkingState,
    timeout: Duration,
) {
    wait_for_probe(timeout, || async {
        let actual = pool.lock().await.parking_state();
        if actual == expected {
            WaitProbe::Ready(())
        } else {
            WaitProbe::Pending(format!(
                "idle pool parking state did not reach {expected:?} within {timeout:?} (actual: {actual:?})",
            ))
        }
    })
    .await;
}

pub(in super::super) async fn wait_cancel_handle(
    tokens: &RunCancellationRegistry,
    run_id: RunId,
    timeout: Duration,
) -> RunCancellationHandle {
    wait_for_probe(timeout, || async {
        let handle = tokens.handle(run_id).await;
        if let Some(handle) = handle {
            WaitProbe::Ready(handle)
        } else {
            WaitProbe::Pending(format!(
                "cancel token for {run_id} not found within {timeout:?}",
            ))
        }
    })
    .await
}

pub(in super::super) async fn wait_cancel_token(
    tokens: &RunCancellationRegistry,
    run_id: RunId,
    timeout: Duration,
) -> CancellationToken {
    wait_cancel_handle(tokens, run_id, timeout).await.token()
}

pub(in super::super) async fn wait_cancel_token_removed(
    tokens: &RunCancellationRegistry,
    run_id: RunId,
    timeout: Duration,
) {
    wait_for_probe(timeout, || async {
        let present = tokens.handle(run_id).await.is_some();
        if present {
            WaitProbe::Pending(format!(
                "cancel token for {run_id} still present after {timeout:?}",
            ))
        } else {
            WaitProbe::Ready(())
        }
    })
    .await;
}

pub(in super::super) async fn wait_discover_entered(env: &MockRunEnv, timeout: Duration) {
    assert!(
        env.handle.wait_discover_entered(timeout).await,
        "run() did not enter discover_fut select! within {timeout:?}"
    );
}

pub(in super::super) async fn wait_budget_exhausted_reactor(env: &MockRunEnv, timeout: Duration) {
    env.start_observer
        .wait_budget_exhausted_reactor(timeout)
        .await;
}

pub(in super::super) async fn wait_usage_flush_requested(env: &MockRunEnv, timeout: Duration) {
    env.start_observer.wait_usage_flush_requested(timeout).await;
}
