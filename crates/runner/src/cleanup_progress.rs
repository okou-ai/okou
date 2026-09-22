//! Observation of required cleanup, without timing out its ownership.

use std::time::{Duration, Instant};

use tokio_util::task::AbortOnDropHandle;
use tracing::{Instrument, warn};

const WARNING_INTERVAL: Duration = Duration::from_secs(30);

pub(crate) enum CleanupIdentity {
    Runner,
    Process(Option<u32>),
    Run(runner_types::ids::RunId),
}

/// Dropping this observer stops diagnostics, never the cleanup it describes.
pub(crate) struct CleanupProgress {
    started: Instant,
    _observer: AbortOnDropHandle<()>,
}

impl CleanupProgress {
    pub(crate) fn start(
        component: &'static str,
        phase: &'static str,
        identity: CleanupIdentity,
    ) -> Self {
        let started = Instant::now();
        // Axiom serializes event fields, not inherited span fields. Keep the
        // authoritative safe identity on the warning itself.
        let (pid, run_id) = match identity {
            CleanupIdentity::Runner => (Some(std::process::id()), None),
            CleanupIdentity::Process(pid) => (pid, None),
            CleanupIdentity::Run(run_id) => (None, Some(run_id.to_string())),
        };
        let observer = tokio::spawn(
            async move {
                let mut tick = tokio::time::interval_at(
                    tokio::time::Instant::now() + WARNING_INTERVAL,
                    WARNING_INTERVAL,
                );
                tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    tick.tick().await;
                    warn!(
                        component,
                        phase,
                        pid,
                        run_id = run_id.as_deref(),
                        elapsed_ms = crate::duration::duration_ms(started.elapsed()),
                        "required cleanup still pending"
                    );
                }
            }
            .in_current_span(),
        );
        Self {
            started,
            _observer: AbortOnDropHandle::new(observer),
        }
    }

    pub(crate) fn elapsed(&self) -> Duration {
        self.started.elapsed()
    }
}
