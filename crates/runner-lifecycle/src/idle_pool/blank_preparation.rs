//! Concrete new blank resource custody before reusable inventory exists.

use std::{panic::AssertUnwindSafe, sync::Arc};

use sandbox::{Sandbox, SandboxConfig, SandboxFactory, SandboxParkOutcome};

use crate::guest_timezone::GuestTimezoneIntent;
use crate::host_memory_operations::{MemoryOperation, MemoryOperationError};
use crate::resource_budget::BudgetLease;
use crate::storage_fingerprints::StorageFingerprints;

use super::entry::{IdleSandboxMetadata, IdleSandboxResources};
use super::inventory_retirement::CapturedBacking;
use super::{IdleActivationOwner, IdleActivationState, IdlePoolIncoming, ParkedIdleCandidate};

/// A created sandbox is not a parked candidate. Retain this capsule outside
/// borrowed stage futures, including failure, cancellation and provider panic.
#[must_use = "retain until guarded inventory transfer or required cleanup acceptance"]
pub struct BlankPreparationResource {
    sandbox: Box<dyn Sandbox>,
    factory: Arc<Box<dyn SandboxFactory>>,
    lease: BudgetLease,
    config: SandboxConfig,
    profile_name: String,
    rootfs_hash: String,
    backing: Option<CapturedBacking>,
    prepared: bool,
}

impl BlankPreparationResource {
    pub fn new(
        sandbox: Box<dyn Sandbox>,
        factory: Arc<Box<dyn SandboxFactory>>,
        lease: BudgetLease,
        config: SandboxConfig,
        profile_name: String,
        rootfs_hash: String,
    ) -> Self {
        Self {
            sandbox,
            factory,
            lease,
            config,
            profile_name,
            rootfs_hash,
            backing: None,
            prepared: false,
        }
    }

    pub fn sandbox_id(&self) -> sandbox::SandboxId {
        self.config.id
    }

    pub async fn start(&mut self) -> sandbox::Result<()> {
        self.sandbox.start().await
    }

    /// Bind only the exact child generation produced by actual start. Missing
    /// or changed backing never settles the original Fresh preparation guard.
    pub fn bind_backing(
        &mut self,
        operation: &mut MemoryOperation,
    ) -> Result<(), MemoryOperationError> {
        let backing = std::panic::catch_unwind(AssertUnwindSafe(|| {
            if self.sandbox.id() != self.config.id.to_string()
                || self.lease.vcpu() != self.config.resources.cpu_count
                || self.lease.memory_mb() != self.config.resources.memory_mb
            {
                return Err(MemoryOperationError::OwnershipInvariant);
            }
            let backing = self
                .sandbox
                .backing_process()
                .ok_or(MemoryOperationError::MissingBacking)?;
            let identity = backing.identity();
            if let Some(original) = &self.backing
                && (original.identity != identity || original.process.identity() != identity)
            {
                return Err(MemoryOperationError::OwnershipInvariant);
            }
            Ok(CapturedBacking {
                process: backing,
                identity,
            })
        }))
        .unwrap_or(Err(MemoryOperationError::ProducerLost))?;
        if self.backing.is_none() {
            operation.bind_backing(backing.process.clone())?;
            self.backing = Some(backing);
        }
        Ok(())
    }

    pub async fn mount_home(&self) -> Result<(), String> {
        crate::home_mount::ensure_home_drive_mounted(self.sandbox.as_ref(), self.config.id)
            .await
            .map(|_| ())
            .map_err(|error| error.error.to_string())
    }

    pub async fn park(&mut self) -> Result<(), String> {
        match self
            .sandbox
            .park_for_blank_pool()
            .await
            .map_err(|e| e.to_string())?
        {
            SandboxParkOutcome::Reusable => {
                self.prepared = true;
                Ok(())
            }
            SandboxParkOutcome::NonReusable(reason) => Err(reason.as_str().to_owned()),
        }
    }

    pub fn prepared(&self) -> bool {
        self.prepared
    }

    fn metadata(&self) -> Result<IdleSandboxMetadata, MemoryOperationError> {
        std::panic::catch_unwind(AssertUnwindSafe(|| {
            if self.sandbox.id() != self.config.id.to_string() {
                return Err(MemoryOperationError::OwnershipInvariant);
            }
            if let Some(original) = &self.backing {
                let current = self
                    .sandbox
                    .backing_process()
                    .ok_or(MemoryOperationError::MissingBacking)?;
                if current.identity() != original.identity
                    || original.process.identity() != original.identity
                {
                    return Err(MemoryOperationError::OwnershipInvariant);
                }
            }
            Ok(IdleSandboxMetadata {
                identity: super::IdleSandboxIdentity::Blank(self.config.id),
                source_run_id: None,
                sandbox_id: self.config.id,
                profile_name: self.profile_name.clone(),
                rootfs_hash: self.rootfs_hash.clone(),
                device_rate_limits: self.config.device_rate_limits.clone(),
                source_ip: self.sandbox.source_ip().to_owned(),
                storage_fingerprints: StorageFingerprints::default(),
                restored_session_identity: None,
                history_generation_run_id: None,
                guest_timezone_intent: GuestTimezoneIntent::Unknown,
                last_completed_at: None,
            })
        }))
        .unwrap_or(Err(MemoryOperationError::ProducerLost))
    }

    pub fn into_incoming(
        self: Box<Self>,
    ) -> Result<IdlePoolIncoming, (Box<Self>, MemoryOperationError)> {
        if !self.prepared || self.backing.is_none() {
            return Err((self, MemoryOperationError::OwnershipInvariant));
        }
        let metadata = match self.metadata() {
            Ok(metadata) => metadata,
            Err(error) => return Err((self, error)),
        };
        let resource = *self;
        Ok(IdlePoolIncoming::park(ParkedIdleCandidate {
            resources: IdleSandboxResources {
                sandbox: resource.sandbox,
                factory: resource.factory,
                home_promotion: None,
            },
            metadata,
            budget_lease: resource.lease,
            retirement_backing: resource.backing,
        }))
    }

    /// Failed preparation stays uncertain rather than becoming parked inventory.
    /// The existing required cleanup engine retains home and the full lease.
    pub fn into_required_cleanup(
        self: Box<Self>,
    ) -> Result<IdleActivationOwner, (Box<Self>, MemoryOperationError)> {
        let metadata = match self.metadata() {
            Ok(metadata) => metadata,
            Err(error) => return Err((self, error)),
        };
        let resource = *self;
        Ok(IdleActivationOwner::from_parts(
            IdleSandboxResources {
                sandbox: resource.sandbox,
                factory: resource.factory,
                home_promotion: None,
            },
            metadata,
            resource.lease,
            IdleActivationState::Uncertain,
            resource.backing,
        ))
    }
}
