//! Convert the admitted SSH authority snapshot at the native carrier boundary.

use api_contracts::generated::types::runners::ssh::ResolveResponseResolvedTailscaleTailscale;

use crate::tailscale::{Configuration, Failure};

pub(super) fn configuration(
    authority: ResolveResponseResolvedTailscaleTailscale,
) -> Result<Configuration, Failure> {
    let id = uuid::Uuid::parse_str(&authority.config_id).map_err(|_| Failure::DomainFailed)?;
    Configuration::new(
        id,
        authority.generation,
        authority.client_id,
        authority.client_secret,
        authority.tags,
    )
}
