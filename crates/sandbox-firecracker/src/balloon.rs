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
mod tests;
