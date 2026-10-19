//! Ably Pub/Sub subscribe-only Realtime SDK.
//!
//! Implements the minimum subset of the Ably realtime protocol needed for
//! subscribing to channels via WebSocket with MessagePack encoding.
//!
//! # Features
//! - TokenRequest-based authentication (exchange with Ably REST API)
//! - MessagePack binary protocol (Ably default)
//! - Automatic connection resume after disconnection
//! - Proactive token renewal before expiry
//! - Heartbeat-based connection liveness detection when Ably advertises a
//!   positive idle interval
//!
//! # Example
//! ```no_run
//! # async fn example() -> Result<(), ably_subscriber::Error> {
//! use ably_subscriber::{SubscribeConfig, Event};
//!
//! let config = ably_subscriber::SubscribeConfig::new(
//!     Box::new(|| Box::pin(async { todo!() })),
//!     "my-channel",
//! );
//!
//! let mut sub = ably_subscriber::subscribe(config).await?;
//! while let Some(event) = sub.next().await {
//!     match event {
//!         Event::Message(msg) => println!("got: {:?}", msg.name),
//!         Event::Connected => println!("connected"),
//!         _ => {}
//!     }
//! }
//! # Ok(())
//! # }
//! ```

#![deny(missing_docs)]

mod connection;
mod event_queue;
#[doc(hidden)]
pub mod protocol;
mod subscribe;
mod types;

pub use subscribe::{Subscription, subscribe};
pub use types::{
    BoxError, Error, Event, Message, SubscribeConfig, TimingConfig, TokenDetails, TokenFuture,
    TokenRequest,
};
