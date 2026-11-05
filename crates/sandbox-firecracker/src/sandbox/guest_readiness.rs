use std::io;

use guest_control_client::GuestControlClient;
use sandbox::{SandboxStartObserver, SandboxStartStage};
use tokio::time::Instant;

use super::validate_guest_home_drive;
use crate::guest_dns_readiness::{GuestDnsReadinessError, wait_for_guest_dns_readiness};

#[derive(Debug)]
pub(super) enum GuestReadinessError {
    Home(io::Error),
    Dns {
        port: u16,
        error: GuestDnsReadinessError,
    },
}

/// Both operations own bounded Guest requests. Join their terminal results so a
/// failed gate does not abandon its admitted sibling. Dropping this whole wait
/// still fences either in-flight request; startup must discard that connection.
pub(super) async fn wait_for_guest_readiness(
    guest: &GuestControlClient,
    has_home: bool,
    dns_port: Option<u16>,
    observer: &mut dyn SandboxStartObserver,
) -> Result<(), GuestReadinessError> {
    let home = async {
        if !has_home {
            return None;
        }
        let started = Instant::now();
        let result = validate_guest_home_drive(guest).await;
        Some((result, started.elapsed()))
    };
    let dns = async {
        let port = dns_port?;
        let started = Instant::now();
        let result = wait_for_guest_dns_readiness(guest, observer).await;
        Some((port, result, started.elapsed()))
    };
    let (home, dns) = tokio::join!(home, dns);

    // These are overlapping operation durations, not additive critical-path
    // slices. Deliver both outcomes before the caller diagnoses or cleans up.
    if let Some((result, duration)) = &home {
        observer.record_stage(
            SandboxStartStage::GuestHomeValidation,
            *duration,
            result.is_ok(),
        );
    }
    if let Some((_, result, duration)) = &dns {
        observer.record_stage(
            SandboxStartStage::GuestDnsReadiness,
            *duration,
            result.is_ok(),
        );
    }
    // Preserve the serial path's Home-error precedence when both gates fail.
    if let Some((result, _)) = home {
        result.map_err(GuestReadinessError::Home)?;
    }
    if let Some((port, result, _)) = dns {
        result.map_err(|error| GuestReadinessError::Dns { port, error })?;
    }
    Ok(())
}
