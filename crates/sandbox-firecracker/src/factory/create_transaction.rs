//! Sandbox creation resource ownership.
//!
//! `SandboxCreateTransaction` owns resources acquired while
//! `FirecrackerFactory::create` builds a sandbox. The normal create path
//! prepares a stable sandbox workspace, optionally prepares the workspace drive
//! image, creates the socket directory, acquires a network namespace, checks
//! out a prepared NBD COW device, and then commits those stable resources into
//! `SandboxCreateResources`.
//!
//! Until commit succeeds, every acquired resource remains transaction-owned.
//! Rollback keeps the cleanup order tied to resource safety: destroy the COW
//! device first, use that result to decide whether backing workspace files are
//! safe to delete, release the network namespace next, and only start
//! filesystem cleanup after the network lease has been released. If network
//! release fails, the directories stay owned by the transaction so `Drop` can
//! hand stable resources to `LeakCleaner` when possible.
//!
//! `Drop` is only a synchronous fallback for abandoned transactions. It can
//! clean local socket and workspace state, but async-only resources such as COW
//! devices and network leases need leak-cleaner handoff. That handoff
//! requires a stable workspace path, socket directory, live leak channel, and at
//! least one async-only resource; otherwise the transaction logs what remains
//! and runner GC is the final backstop.
//!
//! Rollback filesystem cleanup starts its blocking task before returning a
//! waiter. This keeps rollback task cancellation from moving blocking deletion
//! back into transaction `Drop` on a Tokio worker thread.

use std::{future::Future, path::PathBuf, pin::Pin};

use async_trait::async_trait;
use sandbox::{SandboxError, SandboxInvalidStateContext};
use tracing::warn;

use nbd_cow::PooledNbdCowDevice;

use crate::cow_cleanup::{CowCleanupOutcome, destroy_cow_device_with_retries};
use crate::factory::cleanup_group::{FactoryCleanupGroup, FactoryCleanupTaskKind};
use crate::leaked_resources::LeakedResources;
use crate::network::{NetnsLease, NetnsPoolHandle};
use crate::paths::{SandboxPaths, SockPaths};

#[async_trait]
pub(super) trait CreateRollbackCleanup {
    async fn destroy_cow_device(&self, cow_device: CreateTransactionCowDevice)
    -> CowCleanupOutcome;
    async fn release_network(&self, network: &mut Option<NetnsLease>);
    fn start_filesystem_cleanup(
        &self,
        cleanup: CreateRollbackFilesystemCleanup,
    ) -> CreateRollbackFilesystemCleanupWaiter;
}

#[must_use = "create rollback filesystem cleanup waiters should be awaited so join failures are logged"]
pub(super) struct CreateRollbackFilesystemCleanupWaiter {
    future: Pin<Box<dyn Future<Output = ()> + Send + 'static>>,
}

impl CreateRollbackFilesystemCleanupWaiter {
    fn new<F>(future: F) -> Self
    where
        F: Future<Output = ()> + Send + 'static,
    {
        Self {
            future: Box::pin(future),
        }
    }

    fn ready() -> Self {
        Self::new(std::future::ready(()))
    }

    async fn wait(self) {
        self.future.await;
    }
}

pub(super) struct CreateRollbackFilesystemCleanup {
    steps: Vec<CreateRollbackFilesystemCleanupStep>,
}

enum CreateRollbackFilesystemCleanupStep {
    RemoveDir { kind: &'static str, path: PathBuf },
}

impl CreateRollbackFilesystemCleanup {
    fn new() -> Self {
        Self { steps: Vec::new() }
    }

    fn push_remove_dir(&mut self, kind: &'static str, path: PathBuf) {
        self.steps
            .push(CreateRollbackFilesystemCleanupStep::RemoveDir { kind, path });
    }

    fn is_empty(&self) -> bool {
        self.steps.is_empty()
    }

    fn run_sync(self, id: &str) {
        for step in self.steps {
            match step {
                CreateRollbackFilesystemCleanupStep::RemoveDir { kind, path } => {
                    remove_create_rollback_dir_sync(id, kind, path);
                }
            }
        }
    }
}

fn remove_create_rollback_dir_sync(id: &str, kind: &'static str, path: PathBuf) {
    match std::fs::remove_dir_all(&path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            warn!(
                id = %id,
                error = %e,
                path = %path.display(),
                kind,
                "failed to delete create-rollback directory"
            );
        }
    }
}

pub(super) struct FactoryCreateRollbackCleanup {
    pub(super) id: String,
    pub(super) netns_pool: NetnsPoolHandle,
}

#[async_trait]
impl CreateRollbackCleanup for FactoryCreateRollbackCleanup {
    async fn destroy_cow_device(
        &self,
        cow_device: CreateTransactionCowDevice,
    ) -> CowCleanupOutcome {
        match cow_device {
            CreateTransactionCowDevice::Real(cow_device) => {
                destroy_cow_device_with_retries(&self.id, cow_device).await
            }
            #[cfg(test)]
            CreateTransactionCowDevice::Test => {
                panic!("factory cleanup should not receive a test COW device")
            }
        }
    }

    async fn release_network(&self, network: &mut Option<NetnsLease>) {
        let outcome = self.netns_pool.release(network).await;
        if let Some(message) = outcome.invalid_message() {
            warn!(id = %self.id, error = %message, "failed to release netns during rollback");
        }
    }

    fn start_filesystem_cleanup(
        &self,
        cleanup: CreateRollbackFilesystemCleanup,
    ) -> CreateRollbackFilesystemCleanupWaiter {
        if cleanup.is_empty() {
            return CreateRollbackFilesystemCleanupWaiter::ready();
        }

        // Start blocking deletion before returning the waiter so dropping or
        // aborting the async rollback task cannot move this cleanup back into
        // transaction Drop on a Tokio worker thread.
        let id = self.id.clone();
        let cleanup = tokio::task::spawn_blocking(move || cleanup.run_sync(&id));
        CreateRollbackFilesystemCleanupWaiter::new(async move {
            if let Err(e) = cleanup.await {
                warn!(
                    error = %e,
                    "create rollback filesystem cleanup task failed"
                );
            }
        })
    }
}

pub(super) struct SandboxCreateResources {
    pub(super) sandbox_paths: SandboxPaths,
    pub(super) sock_paths: SockPaths,
    pub(super) network: NetnsLease,
    pub(super) cow_device: PooledNbdCowDevice,
}

pub(super) enum CreateTransactionCowDevice {
    Real(PooledNbdCowDevice),
    #[cfg(test)]
    Test,
}

impl CreateTransactionCowDevice {
    fn requires_async_cleanup(&self) -> bool {
        match self {
            Self::Real(_) => true,
            #[cfg(test)]
            Self::Test => false,
        }
    }

    fn validate_real(&self, _context: &str) -> sandbox::Result<()> {
        match self {
            Self::Real(_) => Ok(()),
            #[cfg(test)]
            Self::Test => Err(create_transaction_invalid_state(&format!(
                "test COW device cannot be used at {_context}"
            ))),
        }
    }

    fn into_real(self, _context: &str) -> sandbox::Result<PooledNbdCowDevice> {
        match self {
            Self::Real(cow_device) => Ok(cow_device),
            #[cfg(test)]
            Self::Test => Err(create_transaction_invalid_state(&format!(
                "test COW device cannot be used at {_context}"
            ))),
        }
    }

    fn into_leaked_real(self) -> Option<PooledNbdCowDevice> {
        match self {
            Self::Real(cow_device) => Some(cow_device),
            #[cfg(test)]
            Self::Test => None,
        }
    }
}

#[derive(Default)]
enum WorkspaceOwnership {
    /// No workspace is currently owned.
    #[default]
    None,
    /// The stable sandbox workspace path is owned.
    Workspace(PathBuf),
}

impl WorkspaceOwnership {
    fn state_name(&self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Workspace(_) => "workspace",
        }
    }

    fn has_resources(&self) -> bool {
        !matches!(self, Self::None)
    }
}

pub(super) struct SandboxCreateTransaction {
    id: String,
    workspace: WorkspaceOwnership,
    sock_dir: Option<PathBuf>,
    network: Option<NetnsLease>,
    cow_device: Option<CreateTransactionCowDevice>,
    leak_tx: Option<tokio::sync::mpsc::UnboundedSender<LeakedResources>>,
    delete_workspace_on_leak_cleanup: bool,
}

impl SandboxCreateTransaction {
    pub(super) fn new_with_leak_tx(
        id: String,
        leak_tx: Option<tokio::sync::mpsc::UnboundedSender<LeakedResources>>,
    ) -> Self {
        Self {
            id,
            workspace: WorkspaceOwnership::None,
            sock_dir: None,
            network: None,
            cow_device: None,
            leak_tx,
            delete_workspace_on_leak_cleanup: true,
        }
    }

    pub(super) fn track_workspace(&mut self, workspace: PathBuf) -> sandbox::Result<()> {
        if !matches!(self.workspace, WorkspaceOwnership::None) {
            return Err(create_transaction_invalid_state(&format!(
                "cannot track workspace while workspace state is {}",
                self.workspace.state_name()
            )));
        }
        self.workspace = WorkspaceOwnership::Workspace(workspace);
        Ok(())
    }

    pub(super) fn track_sock_dir(&mut self, sock_dir: PathBuf) {
        self.sock_dir = Some(sock_dir);
    }

    pub(super) fn track_network(&mut self, network: NetnsLease) {
        self.network = Some(network);
    }

    pub(super) fn track_cow_device(&mut self, cow_device: PooledNbdCowDevice) {
        self.cow_device = Some(CreateTransactionCowDevice::Real(cow_device));
    }

    pub(super) fn preserve_workspace_on_leak_cleanup(&mut self) {
        self.delete_workspace_on_leak_cleanup = false;
    }

    pub(super) fn allow_workspace_delete_on_leak_cleanup(&mut self) {
        self.delete_workspace_on_leak_cleanup = true;
    }

    pub(super) fn commit(&mut self) -> sandbox::Result<SandboxCreateResources> {
        self.validate_base_resources("commit")?;
        self.cow_device
            .as_ref()
            .ok_or_else(|| create_transaction_invalid_state("missing COW device at commit"))?
            .validate_real("commit")?;

        let (workspace, sock_dir, network) = self.take_base_resources_after_validation()?;
        let cow_device = self
            .cow_device
            .take()
            .ok_or_else(|| create_transaction_invalid_state("missing COW device at commit"))?
            .into_real("commit")?;

        Ok(SandboxCreateResources {
            sandbox_paths: SandboxPaths::new(workspace),
            sock_paths: SockPaths::new(sock_dir),
            network,
            cow_device,
        })
    }

    fn validate_base_resources(&self, context: &str) -> sandbox::Result<()> {
        if !matches!(self.workspace, WorkspaceOwnership::Workspace(_)) {
            return Err(create_transaction_invalid_state(&format!(
                "missing stable workspace at {context}; workspace state is {}",
                self.workspace.state_name()
            )));
        }
        if self.sock_dir.is_none() {
            return Err(create_transaction_invalid_state(&format!(
                "missing sock dir at {context}"
            )));
        }
        if self.network.is_none() {
            return Err(create_transaction_invalid_state(&format!(
                "missing netns at {context}"
            )));
        }
        Ok(())
    }

    fn take_base_resources_after_validation(
        &mut self,
    ) -> sandbox::Result<(PathBuf, PathBuf, NetnsLease)> {
        let workspace = self.take_stable_workspace().ok_or_else(|| {
            create_transaction_invalid_state("missing stable workspace after validation")
        })?;
        let sock_dir = self
            .sock_dir
            .take()
            .ok_or_else(|| create_transaction_invalid_state("missing sock dir after validation"))?;
        let network = self
            .network
            .take()
            .ok_or_else(|| create_transaction_invalid_state("missing netns after validation"))?;
        Ok((workspace, sock_dir, network))
    }

    async fn rollback<C>(&mut self, cleanup: &C)
    where
        C: CreateRollbackCleanup + Sync,
    {
        let keep_workspace = if let Some(cow_device) = self.cow_device.take() {
            // The COW finalizer continues in the background if this future is
            // cancelled. Keep the workspace until backing files are safe to
            // delete.
            self.delete_workspace_on_leak_cleanup = false;
            let cow_cleanup_outcome = cleanup.destroy_cow_device(cow_device).await;
            let backing_files_safe_to_delete = cow_cleanup_outcome.backing_files_safe_to_delete();
            self.delete_workspace_on_leak_cleanup = backing_files_safe_to_delete;
            !backing_files_safe_to_delete
        } else {
            !self.delete_workspace_on_leak_cleanup
        };
        if let Some(network) = self.network.take() {
            self.network = Some(network);
            cleanup.release_network(&mut self.network).await;
        }
        if self.network.is_some() {
            warn!(
                id = %self.id,
                "keeping create rollback directories so Drop can hand unreleased netns to leak cleaner"
            );
            return;
        }
        let filesystem_cleanup = self.take_filesystem_cleanup_on_rollback(keep_workspace);
        cleanup
            .start_filesystem_cleanup(filesystem_cleanup)
            .wait()
            .await;
    }

    fn has_resources(&self) -> bool {
        self.workspace.has_resources()
            || self.sock_dir.is_some()
            || self.network.is_some()
            || self
                .cow_device
                .as_ref()
                .is_some_and(CreateTransactionCowDevice::requires_async_cleanup)
    }

    fn take_filesystem_cleanup_on_rollback(
        &mut self,
        keep_workspace: bool,
    ) -> CreateRollbackFilesystemCleanup {
        let mut cleanup = CreateRollbackFilesystemCleanup::new();
        if let Some(sock_dir) = self.sock_dir.take() {
            cleanup.push_remove_dir("sock", sock_dir);
        }
        self.add_workspace_filesystem_cleanup_on_rollback(&mut cleanup, keep_workspace);
        cleanup
    }

    fn add_workspace_filesystem_cleanup_on_rollback(
        &mut self,
        cleanup: &mut CreateRollbackFilesystemCleanup,
        keep_workspace: bool,
    ) {
        match std::mem::take(&mut self.workspace) {
            WorkspaceOwnership::None => {}
            WorkspaceOwnership::Workspace(workspace) => {
                if keep_workspace {
                    warn!(
                        id = %self.id,
                        path = %workspace.display(),
                        "keeping workspace after failed COW rollback"
                    );
                } else {
                    cleanup.push_remove_dir("workspace", workspace);
                }
            }
        }
    }

    fn cleanup_workspace_on_drop(&mut self) {
        match std::mem::take(&mut self.workspace) {
            WorkspaceOwnership::None => {}
            WorkspaceOwnership::Workspace(workspace) => {
                if self.delete_workspace_on_leak_cleanup {
                    let _ = std::fs::remove_dir_all(workspace);
                } else {
                    warn!(
                        id = %self.id,
                        path = %workspace.display(),
                        "preserving workspace after failed COW cleanup"
                    );
                }
            }
        }
    }

    fn take_stable_workspace(&mut self) -> Option<PathBuf> {
        let current = std::mem::take(&mut self.workspace);
        match current {
            WorkspaceOwnership::Workspace(workspace) => Some(workspace),
            other => {
                self.workspace = other;
                None
            }
        }
    }

    fn send_async_leaked_resources(&mut self) -> bool {
        let has_async_cow_resource = self
            .cow_device
            .as_ref()
            .is_some_and(CreateTransactionCowDevice::requires_async_cleanup);
        if self.network.is_none() && !has_async_cow_resource {
            return false;
        }

        let Some(leak_tx) = self.leak_tx.clone() else {
            return false;
        };
        let Some(sock_dir) = self.sock_dir.take() else {
            return false;
        };
        let Some(workspace) = self.take_stable_workspace() else {
            self.sock_dir = Some(sock_dir);
            return false;
        };

        let leaked = LeakedResources {
            sandbox_id: self.id.clone(),
            process_exit: None,
            cow_device: self
                .cow_device
                .take()
                .and_then(CreateTransactionCowDevice::into_leaked_real),
            network: self.network.take(),
            sock_dir,
            workspace,
            delete_workspace: self.delete_workspace_on_leak_cleanup,
        };

        match leak_tx.send(leaked) {
            Ok(()) => true,
            Err(tokio::sync::mpsc::error::SendError(mut leaked)) => {
                self.cow_device = leaked
                    .cow_device
                    .take()
                    .map(CreateTransactionCowDevice::Real);
                self.network = leaked.network.take();
                self.sock_dir = Some(leaked.sock_dir);
                self.workspace = WorkspaceOwnership::Workspace(leaked.workspace);
                false
            }
        }
    }
}

impl Drop for SandboxCreateTransaction {
    fn drop(&mut self) {
        if !self.has_resources() {
            return;
        }

        warn!(
            id = %self.id,
            workspace_state = self.workspace.state_name(),
            has_sock_dir = self.sock_dir.is_some(),
            has_network = self.network.is_some(),
            has_cow_device = self.cow_device.is_some(),
            "sandbox create transaction dropped without explicit commit or rollback"
        );

        if self.send_async_leaked_resources() {
            return;
        }
        if let Some(sock_dir) = self.sock_dir.take() {
            let _ = std::fs::remove_dir_all(sock_dir);
        }
        self.cleanup_workspace_on_drop();
        if self
            .cow_device
            .as_ref()
            .is_some_and(CreateTransactionCowDevice::requires_async_cleanup)
        {
            warn!(
                id = %self.id,
                "COW device acquired during create requires async rollback and may need runner gc"
            );
        }
        if self.network.is_some() {
            warn!(
                id = %self.id,
                "netns acquired during create requires async rollback and may need runner gc"
            );
        }
    }
}

fn create_transaction_invalid_state(message: &str) -> SandboxError {
    SandboxError::InvalidState {
        context: SandboxInvalidStateContext::Factory,
        state: "create transaction invalid".into(),
        message: message.into(),
    }
}

pub(super) async fn rollback_create_transaction<C>(
    tx: SandboxCreateTransaction,
    cleanup: C,
    cleanup_group: &FactoryCleanupGroup,
) where
    C: CreateRollbackCleanup + Send + Sync + 'static,
{
    let rollback_id = tx.id.clone();
    let rollback_waiter = cleanup_group.spawn(
        FactoryCleanupTaskKind::Rollback,
        rollback_id.clone(),
        async move {
            let mut tx = tx;
            tx.rollback(&cleanup).await;
        },
    );
    rollback_waiter.wait_logging_panic().await;
}

#[cfg(test)]
mod tests;
