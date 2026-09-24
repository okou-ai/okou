//! Assignment-bound guest RPC, remote usage, SSH, and VNC services.

pub mod guest_rpc;
pub mod run_usage;
pub mod ssh;
pub mod vnc;

/// Initialization failure confined to remote authority clients.
#[derive(Debug, thiserror::Error)]
pub enum RemoteInitError {
    #[error("SSH authority client initialization failed")]
    SshAuthority,
    #[error("SSH Access TLS initialization failed")]
    SshAccessTls,
    #[error("VNC authority client initialization failed")]
    VncAuthority,
}

#[cfg(test)]
mod test_fixtures;
