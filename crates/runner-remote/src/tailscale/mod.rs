//! Shared native Tailscale transport and resource ownership.
//! Authorized consumers retain node registrations and their own capacity leases.

mod configuration;
mod control_io;
mod control_key;
mod core;
mod derp_reader;
#[cfg(feature = "test-support")]
mod diagnostic_fixture;
mod diagnostics;
mod domain;
mod lease;
mod logout;
mod map_reader;
mod node_root;
mod peers;
mod producer;
mod provisioning;
mod provisioning_effect;
mod provisioning_io;
mod region_map;
mod regional_driver;
mod regional_relay;
mod registration;
mod registry;
mod relay;
mod relay_driver;
mod resolver;
mod tcp;

pub(crate) use configuration::Configuration;
pub use diagnostics::safe_log_metadata;
#[cfg(test)]
pub(crate) use domain::Control;
pub use domain::Failure;
pub(crate) use domain::{Pool, Work};
pub(crate) use lease::Lease;
#[cfg(test)]
pub(crate) use producer::TestServices;
pub(crate) use producer::work;
pub(crate) use provisioning_effect::Journal;
pub(crate) use registry::{Key, Node, Registry};
pub(crate) use tcp::Stream;

/// Used by the Runner panic hook before raw-payload integrations.
pub fn in_domain() -> bool {
    diagnostics::in_domain()
}

#[cfg(test)]
mod tests;

#[cfg(feature = "test-support")]
pub use diagnostic_fixture::run as diagnostic_fixture;
