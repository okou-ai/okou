use std::time::Duration;

use tracing::{error, info, warn};

use crate::error::{RunnerError, RunnerResult};
use crate::proxy;
use crate::retry::RetryState;

/// Initial backoff before retrying mitmproxy after a crash.
pub(super) const MITM_BACKOFF_INITIAL: Duration = Duration::from_secs(1);
/// Maximum backoff between mitmproxy restart attempts.
pub(super) const MITM_BACKOFF_MAX: Duration = Duration::from_secs(30);
/// Stop retrying mitmproxy after this many consecutive failures.
pub(super) const MITM_MAX_CONSECUTIVE_FAILURES: u32 = 20;

pub(super) type MitmRestartHandle =
    tokio::task::JoinHandle<Result<proxy::ManagedMitmdump, proxy::MitmRestartError>>;

/// Startup failures may retry, but an unknown old-child cleanup outcome must
/// stop recovery instead of racing a new child against the fallback reaper.
pub(super) async fn recv_mitm_restart(
    handle: &mut Option<MitmRestartHandle>,
) -> RunnerResult<Result<proxy::ManagedMitmdump, String>> {
    let Some(task) = handle.as_mut() else {
        return std::future::pending().await;
    };
    let result = task.await;
    *handle = None;
    match result {
        Ok(Ok(child)) => Ok(Ok(child)),
        Ok(Err(proxy::MitmRestartError::Startup(error))) => Ok(Err(error.to_string())),
        Ok(Err(proxy::MitmRestartError::Cleanup(error))) => Err(RunnerError::Internal(format!(
            "old mitmdump cleanup failed: {error}"
        ))),
        Err(error) => Err(RunnerError::Internal(format!(
            "mitmproxy recovery task failed: {error}"
        ))),
    }
}

pub(super) fn stop_mitm_retries(
    crash_rx: &mut tokio::sync::mpsc::Receiver<()>,
    retry: &mut RetryState<MitmRestartHandle>,
) {
    crash_rx.close();
    while crash_rx.try_recv().is_ok() {}
    retry.clear_timer();
}

/// Spawn a background mitm restart task when the backoff timer fires
/// and no restart is already in flight.
pub(super) fn maybe_spawn_mitm_restart(
    mitm: &mut proxy::MitmProxy,
    crash_rx: &mut tokio::sync::mpsc::Receiver<()>,
    retry: &mut RetryState<MitmRestartHandle>,
) {
    if !retry.timer_ready() {
        return;
    }
    retry.clear_timer();
    // Defensive drain: clears any crash notification already buffered
    // from the very crash that armed this restart timer, so it can't
    // re-trigger the select loop after we're done. `begin_restart` no
    // longer produces post-call signals — each child owns its own
    // `stopping` Arc, locked to `true` before kill — so this only
    // sweeps pre-existing entries.
    while crash_rx.try_recv().is_ok() {}
    let params = mitm.begin_restart();
    retry.handle = Some(tokio::spawn(params.spawn()));
}

/// Handle the result of a background mitm restart task.
pub(super) fn handle_mitm_restart_result(
    result: Result<proxy::ManagedMitmdump, String>,
    mitm: &mut proxy::MitmProxy,
    retry: &mut RetryState<MitmRestartHandle>,
) {
    match result {
        Ok(child) => {
            if retry.consecutive_failures() > 0 {
                info!(
                    attempts = retry.consecutive_failures(),
                    "mitmproxy restarted after failures"
                );
            } else {
                info!("mitmproxy restarted");
            }
            mitm.complete_restart(child);
            retry.on_success();
        }
        Err(e) => {
            // Capture before on_failure() — matches the delay actually scheduled.
            let next_secs = retry.backoff().as_secs();
            if !retry.on_failure() {
                error!(
                    error = %e,
                    failures = retry.consecutive_failures(),
                    "mitmproxy restart abandoned after too many failures"
                );
                return;
            }
            if retry.consecutive_failures() >= 5 {
                error!(
                    error = %e,
                    failures = retry.consecutive_failures(),
                    next_attempt_secs = next_secs,
                    "mitmproxy restart failing persistently"
                );
            } else {
                warn!(
                    error = %e,
                    next_attempt_secs = next_secs,
                    "mitmproxy restart failed"
                );
            }
        }
    }
}

/// During shutdown, preserve a restart task that has already produced a child
/// so the normal usage-flush and proxy-stop path can still own it.
pub(super) async fn finish_mitm_restart_before_shutdown(
    mitm: &mut proxy::MitmProxy,
    retry: &mut RetryState<MitmRestartHandle>,
) -> RunnerResult<()> {
    if retry.handle.is_none() {
        return Ok(());
    }

    info!("waiting for in-flight mitmproxy restart before shutdown");
    match recv_mitm_restart(&mut retry.handle).await? {
        Ok(child) => {
            info!("mitmproxy restart completed during shutdown");
            mitm.complete_restart(child);
            retry.on_success();
        }
        Err(e) => {
            warn!(error = %e, "mitmproxy restart failed during shutdown");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::Instant;

    use super::*;

    /// Create a MitmProxy for testing (does not start mitmdump).
    async fn test_mitm() -> (
        proxy::MitmProxy,
        tokio::sync::mpsc::Receiver<()>,
        tempfile::TempDir,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let (mitm, rx) = proxy::MitmProxy::new(proxy::ProxyConfig {
            mitmdump_bin: PathBuf::from("true"),
            ca_dir: dir.path().to_path_buf(),
            ca_lock_path: dir.path().join("ca.lock"),
            addon_dir: dir.path().join("addon"),
            registry_path: dir.path().join("registry.json"),
            registry_lock_path: dir.path().join("registry.lock"),
            builtin_firewall_catalog_cache_path: dir
                .path()
                .join("builtin-firewall-catalog-cache.json"),
            runtime_dir: dir.path().join("mitmdump-runtime"),
            runtime_lock_path: dir.path().join("mitmdump-runtime.lock"),
            api_url: None,
            client_session_id: "runner-session-test".to_string(),
            runner_token: None,
        })
        .await
        .unwrap();
        (mitm, rx, dir)
    }

    #[tokio::test(flavor = "current_thread")]
    async fn maybe_spawn_mitm_restart_drives_single_flight_failure_retry() {
        let (mut mitm, _mitm_crash_rx) = proxy::MitmProxy::noop();
        let (crash_tx, mut crash_rx) = tokio::sync::mpsc::channel(1);
        let mut retry: RetryState<MitmRestartHandle> = RetryState::new(
            MITM_BACKOFF_INITIAL,
            MITM_BACKOFF_MAX,
            Some(MITM_MAX_CONSECUTIVE_FAILURES),
        );

        crash_tx.try_send(()).unwrap();
        let future_deadline = Instant::now() + Duration::from_secs(60);
        retry.restart_at = Some(future_deadline);

        maybe_spawn_mitm_restart(&mut mitm, &mut crash_rx, &mut retry);

        assert_eq!(retry.restart_at, Some(future_deadline));
        assert!(retry.handle.is_none());
        assert_eq!(crash_rx.try_recv(), Ok(()));

        crash_tx.try_send(()).unwrap();
        retry.restart_at = Some(Instant::now() - Duration::from_secs(1));

        maybe_spawn_mitm_restart(&mut mitm, &mut crash_rx, &mut retry);

        assert!(retry.restart_at.is_none());
        assert_eq!(
            crash_rx.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        );
        let restart_handle = retry.handle.as_ref().expect("restart handle");
        assert!(!restart_handle.is_finished());
        let restart_id = restart_handle.id();

        crash_tx.try_send(()).unwrap();
        let in_flight_deadline = Instant::now() - Duration::from_secs(1);
        retry.restart_at = Some(in_flight_deadline);

        maybe_spawn_mitm_restart(&mut mitm, &mut crash_rx, &mut retry);

        assert_eq!(retry.restart_at, Some(in_flight_deadline));
        assert_eq!(
            retry.handle.as_ref().map(tokio::task::JoinHandle::id),
            Some(restart_id)
        );
        assert_eq!(crash_rx.try_recv(), Ok(()));

        let result = recv_mitm_restart(&mut retry.handle).await.unwrap();
        assert!(retry.handle.is_none());
        assert!(result.is_err());

        let failure_handled_at = Instant::now();
        handle_mitm_restart_result(result, &mut mitm, &mut retry);

        assert_eq!(retry.consecutive_failures(), 1);
        assert!(
            retry
                .restart_at
                .is_some_and(|at| at >= failure_handled_at + MITM_BACKOFF_INITIAL)
        );
        assert_eq!(retry.backoff(), MITM_BACKOFF_INITIAL * 2);
    }

    #[tokio::test]
    async fn mitm_restart_success_resets_backoff() {
        let (mut mitm, _rx, _dir) = test_mitm().await;
        let mut retry: RetryState<MitmRestartHandle> = RetryState::new(
            MITM_BACKOFF_INITIAL,
            MITM_BACKOFF_MAX,
            Some(MITM_MAX_CONSECUTIVE_FAILURES),
        );
        retry.backoff = Duration::from_secs(16);
        retry.consecutive_failures = 5;

        let child = tokio::process::Command::new("true")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();

        handle_mitm_restart_result(
            Ok(proxy::ManagedMitmdump::unmanaged(child)),
            &mut mitm,
            &mut retry,
        );

        assert_eq!(retry.backoff, MITM_BACKOFF_INITIAL);
        assert_eq!(retry.consecutive_failures, 0);
    }

    #[tokio::test]
    async fn mitm_restart_failure_schedules_retry_with_backoff() {
        let (mut mitm, _rx, _dir) = test_mitm().await;
        let mut retry: RetryState<MitmRestartHandle> = RetryState::new(
            MITM_BACKOFF_INITIAL,
            MITM_BACKOFF_MAX,
            Some(MITM_MAX_CONSECUTIVE_FAILURES),
        );

        handle_mitm_restart_result(Err("spawn failed".into()), &mut mitm, &mut retry);

        assert_eq!(retry.consecutive_failures, 1);
        assert!(retry.restart_at.is_some());
        assert_eq!(retry.backoff, MITM_BACKOFF_INITIAL * 2);
    }

    #[tokio::test]
    async fn mitm_restart_backoff_caps_at_max() {
        let (mut mitm, _rx, _dir) = test_mitm().await;
        let mut retry: RetryState<MitmRestartHandle> = RetryState::new(
            MITM_BACKOFF_INITIAL,
            MITM_BACKOFF_MAX,
            Some(MITM_MAX_CONSECUTIVE_FAILURES),
        );
        retry.backoff = MITM_BACKOFF_MAX;
        retry.consecutive_failures = 10;

        handle_mitm_restart_result(Err("spawn failed".into()), &mut mitm, &mut retry);

        assert_eq!(retry.backoff, MITM_BACKOFF_MAX);
        assert!(retry.restart_at.is_some());
    }

    #[tokio::test]
    async fn mitm_restart_circuit_breaker_stops_retrying() {
        let (mut mitm, _rx, _dir) = test_mitm().await;
        let mut retry: RetryState<MitmRestartHandle> = RetryState::new(
            MITM_BACKOFF_INITIAL,
            MITM_BACKOFF_MAX,
            Some(MITM_MAX_CONSECUTIVE_FAILURES),
        );
        retry.backoff = MITM_BACKOFF_MAX;
        retry.consecutive_failures = 19;

        handle_mitm_restart_result(Err("binary missing".into()), &mut mitm, &mut retry);

        assert_eq!(retry.consecutive_failures, 20);
        assert!(
            retry.restart_at.is_none(),
            "circuit breaker should prevent further retries"
        );
    }

    #[tokio::test]
    async fn finish_mitm_restart_before_shutdown_captures_child() {
        let (mut mitm, _rx, _dir) = test_mitm().await;
        let mut retry: RetryState<MitmRestartHandle> = RetryState::new(
            MITM_BACKOFF_INITIAL,
            MITM_BACKOFF_MAX,
            Some(MITM_MAX_CONSECUTIVE_FAILURES),
        );

        let child = tokio::process::Command::new("sleep")
            .arg("60")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        retry.handle = Some(tokio::spawn(async move {
            Ok(proxy::ManagedMitmdump::unmanaged(child))
        }));

        finish_mitm_restart_before_shutdown(&mut mitm, &mut retry)
            .await
            .unwrap();

        assert!(retry.handle.is_none());
        mitm.set_control_directory_for_test(_dir.path().to_path_buf());
        assert!(
            mitm.usage_flush_target().is_some(),
            "completed restart child should remain owned for shutdown flush"
        );
        mitm.stop().await.unwrap();
    }

    #[tokio::test]
    async fn finish_mitm_restart_before_shutdown_drops_failed_handle() {
        let (mut mitm, _rx, _dir) = test_mitm().await;
        let mut retry: RetryState<MitmRestartHandle> = RetryState::new(
            MITM_BACKOFF_INITIAL,
            MITM_BACKOFF_MAX,
            Some(MITM_MAX_CONSECUTIVE_FAILURES),
        );
        retry.handle = Some(tokio::spawn(async {
            Err(proxy::MitmRestartError::Startup(
                crate::error::RunnerError::Internal("spawn failed".into()),
            ))
        }));

        finish_mitm_restart_before_shutdown(&mut mitm, &mut retry)
            .await
            .unwrap();

        assert!(retry.handle.is_none());
        assert!(mitm.usage_flush_target().is_none());
    }
}
