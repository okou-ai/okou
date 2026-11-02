use std::path::PathBuf;

use nbd_cow::PooledNbdCowDevice;

use crate::network::NetnsLease;
use crate::process::ProcessExitCompletion;

/// Resources that require async cleanup when a sandbox is dropped without
/// going through `factory.destroy()` or when create is dropped mid-allocation.
///
/// Drop impls send these to a cleanup channel owned by the factory, which
/// drains them asynchronously.
pub(crate) struct LeakedResources {
    pub(crate) sandbox_id: String,
    pub(crate) create_custody: Option<sandbox::SandboxCreateCustody>,
    /// None only for allocation cleanup that never launched a process.
    pub(crate) process_exit: Option<ProcessExitCompletion>,
    pub(crate) cow_device: Option<PooledNbdCowDevice>,
    pub(crate) network: Option<NetnsLease>,
    pub(crate) sock_dir: PathBuf,
    pub(crate) workspace: PathBuf,
    pub(crate) delete_workspace: bool,
}

#[cfg(test)]
mod tests;
