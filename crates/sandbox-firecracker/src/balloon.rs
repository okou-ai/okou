use std::time::Duration;

use sandbox::{SandboxError, SandboxIdleTransition};
use tokio::sync::watch;
use tracing::info;

use crate::api::ApiClient;
use crate::sandbox::SandboxState;

/// Available-memory pressure boundary for one-shot idle park inflation.
pub(crate) const PRESSURE_AVAILABLE_MIB: i64 = 192;
/// Inflation leaves at least the smallest supported profile's Guest capacity.
pub(crate) const MIN_GUEST_MIB: u32 = guest_contracts::process_containment::MIN_PROFILE_MEMORY_MB;
/// Background park can tolerate slower convergence and remains interruptible
/// by an exact successor. Keep a bound because the full resource lease is held.
const PARK_DEFLATION_TIMEOUT: Duration = Duration::from_secs(30);
/// Bound foreground reuse recovery, including an in-flight statistics request.
/// On failure the caller destroys this sandbox; Guest operations remain fenced.
const UNPARK_DEFLATION_TIMEOUT: Duration = Duration::from_secs(5);
const POLL_INTERVAL: Duration = Duration::from_millis(200);
const FAST_POLL_INTERVALS: [Duration; 5] = [
    Duration::from_millis(25),
    Duration::from_millis(50),
    Duration::from_millis(100),
    Duration::from_millis(100),
    Duration::from_millis(100),
];

/// Confirm the current balloon reports no held pages before opening operations.
/// Active Guests then keep their configured capacity, with free-page reporting
/// returning genuinely free backing pages and no background target writer.
/// These counters are not a target-generation acknowledgement: an interrupted
/// Guest inflation batch can still be in flight before it updates actual pages.
pub(crate) async fn wait_for_unpark_deflation(
    client: &ApiClient,
    state_rx: watch::Receiver<SandboxState>,
    log_id: &str,
) -> sandbox::Result<()> {
    wait_for_deflation(client, state_rx, log_id, SandboxIdleTransition::Unpark).await
}

/// Observe exact counters with a deadline appropriate to park or activation.
pub(crate) async fn wait_for_deflation(
    client: &ApiClient,
    mut state_rx: watch::Receiver<SandboxState>,
    log_id: &str,
    transition: SandboxIdleTransition,
) -> sandbox::Result<()> {
    let timeout = match transition {
        SandboxIdleTransition::Park => PARK_DEFLATION_TIMEOUT,
        SandboxIdleTransition::Unpark => UNPARK_DEFLATION_TIMEOUT,
    };
    let error = |message: String| SandboxError::IdleTransition {
        transition,
        message,
    };
    let started_at = tokio::time::Instant::now();
    let convergence = async {
        let mut intervals = FAST_POLL_INTERVALS.into_iter();
        loop {
            let stats = client
                .get_balloon_statistics()
                .await
                .map_err(|source| error(format!("balloon deflation statistics: {source}")))?;
            // MiB values truncate and can conceal hundreds of held pages.
            if stats.target_pages == 0 && stats.actual_pages == 0 {
                info!(
                    id = %log_id,
                    elapsed_ms = started_at.elapsed().as_millis(),
                    "balloon deflation completed before Guest operations"
                );
                return Ok(());
            }
            tokio::time::sleep(intervals.next().unwrap_or(POLL_INTERVAL)).await;
        }
    };
    tokio::select! {
        biased;
        () = wait_for_crash_or_stop(&mut state_rx) => {
            Err(error("sandbox stopped during balloon deflation".into()))
        }
        result = tokio::time::timeout(timeout, convergence) => {
            result.unwrap_or_else(|_| Err(error(
                format!("balloon deflation did not complete within {} seconds", timeout.as_secs()),
            )))
        }
    }
}

async fn wait_for_crash_or_stop(state_rx: &mut watch::Receiver<SandboxState>) {
    loop {
        if matches!(
            *state_rx.borrow_and_update(),
            SandboxState::Crashed | SandboxState::Stopped
        ) {
            return;
        }
        if state_rx.changed().await.is_err() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::api::test_support::{MockFirecrackerApi, MockResponse};

    fn stats(target_pages: u64, actual_pages: u64) -> MockResponse {
        MockResponse::ok_body(
            serde_json::json!({
                "target_mib": target_pages / 256,
                "actual_mib": actual_pages / 256,
                "target_pages": target_pages,
                "actual_pages": actual_pages,
            })
            .to_string(),
        )
    }

    #[tokio::test]
    async fn deflation_requires_exact_zero_target_and_actual_pages() {
        let mut api = MockFirecrackerApi::with_responses([
            stats(0, 512),
            stats(0, 1),
            stats(1, 0),
            stats(0, 0),
        ]);
        let client = ApiClient::new(api.socket_path()).unwrap();
        let (_state_tx, state_rx) = watch::channel(SandboxState::Running);
        wait_for_unpark_deflation(&client, state_rx, "exact-pages")
            .await
            .unwrap();
        let requests = api.drain_requests();
        assert_eq!(requests.len(), 4);
        for request in requests {
            assert_eq!(request.method, "GET");
            assert_eq!(request.path, "/balloon/statistics");
        }
    }

    #[tokio::test]
    async fn deflation_propagates_statistics_failure() {
        for response in [
            MockResponse::internal_error_raw("failed"),
            MockResponse::ok_body("invalid JSON"),
        ] {
            let mut api = MockFirecrackerApi::repeating(response);
            let client = ApiClient::new(api.socket_path()).unwrap();
            let (_state_tx, state_rx) = watch::channel(SandboxState::Running);
            let error = wait_for_unpark_deflation(&client, state_rx, "failed-stats")
                .await
                .unwrap_err();
            assert!(error.to_string().contains("balloon deflation statistics"));
            assert_eq!(api.drain_requests().len(), 1);
        }
    }

    #[tokio::test]
    async fn deflation_deadline_includes_a_stalled_statistics_request() {
        let mut api = MockFirecrackerApi::with_handler(|_| async {
            std::future::pending::<MockResponse>().await
        });
        let client = ApiClient::new(api.socket_path()).unwrap();
        let (_state_tx, state_rx) = watch::channel(SandboxState::Running);
        let task = tokio::spawn(async move {
            wait_for_unpark_deflation(&client, state_rx, "stalled-stats").await
        });
        api.next_request().await;
        tokio::time::pause();
        tokio::time::advance(UNPARK_DEFLATION_TIMEOUT).await;
        let error = task.await.unwrap().unwrap_err();
        assert!(error.to_string().contains("within 5 seconds"));
    }

    #[tokio::test]
    async fn deflation_stops_on_crash_stop_or_closed_state_stream() {
        for terminal in [
            Some(SandboxState::Crashed),
            Some(SandboxState::Stopped),
            None,
        ] {
            let mut api = MockFirecrackerApi::with_handler(|_| async {
                std::future::pending::<MockResponse>().await
            });
            let client = ApiClient::new(api.socket_path()).unwrap();
            let (state_tx, state_rx) = watch::channel(SandboxState::Running);
            let task = tokio::spawn(async move {
                wait_for_unpark_deflation(&client, state_rx, "stopped-stats").await
            });
            api.next_request().await;
            if let Some(state) = terminal {
                state_tx.send(state).unwrap();
            }
            drop(state_tx);
            let error = tokio::time::timeout(Duration::from_secs(1), task)
                .await
                .unwrap()
                .unwrap()
                .unwrap_err();
            assert!(error.to_string().contains("sandbox stopped"));
        }
    }
}
