//! Public destination validation binds the entire DNS answer set to one socket.

pub(super) use crate::destination::{Network, PublicNetwork};
use crate::destination::{is_valid_host, select_public_address};
use std::{
    net::{IpAddr, SocketAddr},
    sync::Arc,
};

use super::FailureReason;

pub(super) async fn destination(
    network: Arc<dyn Network>,
    host: &str,
    port: u16,
    trace: &crate::diagnostics::trace::Trace,
) -> Result<SocketAddr, FailureReason> {
    use crate::diagnostics::trace::{Progress, Stage};
    let literal = host.parse::<IpAddr>();
    let addresses = if let Ok(ip) = literal {
        vec![SocketAddr::new(ip, port)]
    } else {
        if !is_valid_host(host) {
            trace.set(Stage::DestinationPolicy, Progress::Failed);
            return Err(FailureReason::UnsafeDestination);
        }
        trace.set(Stage::Dns, Progress::Running);
        let addresses = network
            .resolve(&format!("{host}."), port)
            .await
            .map_err(|_| {
                trace.set(Stage::Dns, Progress::Failed);
                FailureReason::NetworkFailure
            })?;
        trace.set(Stage::Dns, Progress::Passed);
        addresses
    };
    let Some(selected) = select_public_address(&addresses, port) else {
        trace.set(Stage::DestinationPolicy, Progress::Failed);
        return Err(FailureReason::UnsafeDestination);
    };
    trace.set(Stage::DestinationPolicy, Progress::Passed);
    trace.selected(selected.ip());
    Ok(selected)
}
