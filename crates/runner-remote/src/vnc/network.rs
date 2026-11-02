//! Bind the complete public DNS answer set to a single selected socket address.

pub(super) use crate::destination::{Network, PublicNetwork};
use crate::destination::{is_valid_host, select_public_address};
use std::{
    net::{IpAddr, SocketAddr},
    sync::Arc,
};

use super::Failure;

pub(super) fn validate_host(host: &str) -> Result<(), Failure> {
    if is_valid_host(host) {
        return Ok(());
    }
    Err(Failure::UnsafeDestination)
}

pub(super) async fn destination(
    network: Arc<dyn Network>,
    host: &str,
    port: u16,
) -> Result<SocketAddr, Failure> {
    destination_traced(
        network,
        host,
        port,
        &crate::diagnostics::trace::Trace::default(),
    )
    .await
}

pub(super) async fn destination_traced(
    network: Arc<dyn Network>,
    host: &str,
    port: u16,
    trace: &crate::diagnostics::trace::Trace,
) -> Result<SocketAddr, Failure> {
    use crate::diagnostics::trace::{Progress, Stage};
    validate_host(host).inspect_err(|_| trace.set(Stage::DestinationPolicy, Progress::Failed))?;
    if port == 0 {
        trace.set(Stage::DestinationPolicy, Progress::Failed);
        return Err(Failure::UnsafeDestination);
    }
    let addresses = if let Ok(ip) = host.parse::<IpAddr>() {
        vec![SocketAddr::new(ip, port)]
    } else {
        trace.set(Stage::Dns, Progress::Running);
        let addresses = network
            .resolve(&format!("{host}."), port)
            .await
            .map_err(|_| {
                trace.set(Stage::Dns, Progress::Failed);
                Failure::Network
            })?;
        trace.set(Stage::Dns, Progress::Passed);
        addresses
    };
    let address = select_public_address(&addresses, port).ok_or_else(|| {
        trace.set(Stage::DestinationPolicy, Progress::Failed);
        Failure::UnsafeDestination
    })?;
    trace.set(Stage::DestinationPolicy, Progress::Passed);
    trace.selected(address.ip());
    Ok(address)
}

#[cfg(test)]
mod tests;
