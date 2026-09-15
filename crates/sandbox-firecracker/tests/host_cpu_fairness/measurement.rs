use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use super::TestResult;

#[derive(Debug)]
pub(super) struct Measurement {
    pub(super) usage: Vec<u64>,
    pub(super) control_ticks: u64,
    pub(super) control_max_gap_micros: u64,
}

struct ControlTicker {
    stop: Arc<AtomicBool>,
    ticks: Arc<AtomicU64>,
    max_gap_micros: Arc<AtomicU64>,
    task: tokio::task::JoinHandle<()>,
}

impl ControlTicker {
    fn start() -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let ticks = Arc::new(AtomicU64::new(0));
        let max_gap_micros = Arc::new(AtomicU64::new(0));
        let ticker_stop = Arc::clone(&stop);
        let ticker_ticks = Arc::clone(&ticks);
        let ticker_max_gap_micros = Arc::clone(&max_gap_micros);
        let task = tokio::task::spawn_blocking(move || {
            let mut previous = std::time::Instant::now();
            while !ticker_stop.load(Ordering::Relaxed) {
                let now = std::time::Instant::now();
                let gap_micros =
                    u64::try_from(now.duration_since(previous).as_micros()).unwrap_or(u64::MAX);
                ticker_max_gap_micros.fetch_max(gap_micros, Ordering::Relaxed);
                previous = now;
                ticker_ticks.fetch_add(1, Ordering::Relaxed);
                std::hint::spin_loop();
            }
        });
        Self {
            stop,
            ticks,
            max_gap_micros,
            task,
        }
    }

    async fn finish(mut self) -> TestResult<(u64, u64)> {
        self.stop.store(true, Ordering::Relaxed);
        (&mut self.task).await?;
        Ok((
            self.ticks.load(Ordering::Relaxed),
            self.max_gap_micros.load(Ordering::Relaxed),
        ))
    }
}

impl Drop for ControlTicker {
    fn drop(&mut self) {
        // Aborting a running spawn_blocking task cannot stop its closure.
        self.stop.store(true, Ordering::Relaxed);
    }
}

pub(super) async fn sample(
    mut read_usage: impl FnMut() -> TestResult<Vec<u64>>,
    window: Duration,
) -> TestResult<Measurement> {
    let before = read_usage()?;
    let ticker = ControlTicker::start();
    tokio::time::sleep(window).await;
    let after = read_usage();
    // Join even when sampling failed, then preserve the original sampling error.
    let ticker_result = ticker.finish().await;
    let after = after?;
    let (control_ticks, control_max_gap_micros) = ticker_result?;
    let usage = after
        .iter()
        .zip(before)
        .map(|(after, before)| after.saturating_sub(before))
        .collect();
    Ok(Measurement {
        usage,
        control_ticks,
        control_max_gap_micros,
    })
}

#[cfg(test)]
mod tests;
