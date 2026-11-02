//! Executable early registration policy; the runtime owns stream consumption.

use runner_supervisor::reactor::EarlySignals;

/// Subscribe before configuration/home/runtime work. Each preceding receiver
/// drops if a subsequent subscription fails, preserving the startup error path.
pub(super) fn register_early_signals() -> std::io::Result<EarlySignals> {
    use tokio::signal::unix::{SignalKind, signal};
    let sigterm = signal(SignalKind::terminate())?;
    let sigint = signal(SignalKind::interrupt())?;
    let sigusr1 = signal(SignalKind::user_defined1())?;
    let sigusr2 = signal(SignalKind::user_defined2())?;
    Ok(EarlySignals::new(sigterm, sigint, sigusr1, sigusr2))
}

#[cfg(test)]
mod tests;
