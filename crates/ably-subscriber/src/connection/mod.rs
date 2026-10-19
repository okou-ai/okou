//! Connection management: event loop, reconnection, and token renewal.

mod auth;
mod endpoint;
mod errors;
mod event_loop;
mod handshake;
mod message;
mod session;
mod state;
mod transport;

pub(crate) use auth::exchange_token;
pub(crate) use endpoint::{DEFAULT_REALTIME_HOST, rest_host};
pub(crate) use event_loop::{BacklogWarnings, EventLoopState, run_event_loop};
pub(crate) use handshake::connect_and_attach;
pub(crate) use session::SessionState;
pub(crate) use transport::TransportCloseTracker;
