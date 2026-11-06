//! Shared Linux process creation and exact-child ownership.

mod child;
mod command;
mod fd;
mod mount_namespace;
mod spawn;

#[cfg(feature = "tokio")]
pub mod asynchronous;

pub use child::Child;
pub use command::{Command, Stdio};
pub use fd::private_descriptor;
pub use spawn::{Credentials, SpawnOptions, spawn};
