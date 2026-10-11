//! Native resource ownership. Networking stays in the trusted Run registration.

mod configuration;
mod control_io;
mod control_key;
mod core;
mod derp_reader;
#[cfg(feature = "test-support")]
mod diagnostic_fixture;
mod diagnostics;
mod domain;
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

pub(super) use configuration::Configuration;
#[cfg(test)]
pub(super) use domain::Control;
pub(super) use domain::{Failure, Pool, Work};
#[cfg(test)]
pub(super) use producer::TestServices;
pub(super) use producer::work;
pub(super) use provisioning_effect::Journal;
pub(super) use registry::{Key, Node, Registry};
pub(super) use tcp::Stream;

pub(crate) fn in_domain() -> bool {
    diagnostics::in_domain()
}

#[cfg(test)]
mod tests;

#[cfg(feature = "test-support")]
pub(crate) use diagnostic_fixture::run as diagnostic_fixture;
