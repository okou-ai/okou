//! Host proxy, DNS, CA, and network log behavior for Runner.

pub mod ca;
pub mod dns;
mod error;
pub mod kmsg_log;
pub mod network_log_drain;
pub mod network_log_manager;
pub mod network_log_process;
pub mod network_log_transport;
pub mod network_logs;
pub mod proxy;

pub use error::{NetworkError, NetworkResult};

#[cfg(any(test, feature = "test-support"))]
mod test_fixtures;
#[cfg(any(test, feature = "test-support"))]
pub use test_fixtures::ReapGate;
