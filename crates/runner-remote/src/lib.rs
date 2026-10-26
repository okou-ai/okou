//! Assignment-bound guest RPC, remote usage, SSH, Tailscale, and VNC services.

mod authority_invalidation;
pub mod browser;
mod cloudflare;
mod destination;
mod diagnostics;
pub mod guest_rpc;
mod native;
pub mod run_usage;
pub mod ssh;
pub mod tailscale;
mod tls;
pub mod vnc;

/// Initialization failure confined to remote authority clients.
#[derive(Debug, thiserror::Error)]
pub enum RemoteInitError {
    #[error("Browser authority initialization failed")]
    BrowserAuthority,
    #[error("SSH authority client initialization failed")]
    SshAuthority,
    #[error("SSH Access TLS initialization failed")]
    SshAccessTls,
    #[error("VNC authority client initialization failed")]
    VncAuthority,
}

#[cfg(test)]
mod test_fixtures;
