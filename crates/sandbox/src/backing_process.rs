//! Retained provider-owned backing identity and positive child-wait observation.

use async_trait::async_trait;
use uuid::Uuid;

/// Opaque identity of one provider-owned backing process generation.
///
/// Mint once for the exact backing's retained completion and preserve it in
/// every clone. A Sandbox label or numeric PID cannot substitute this identity.
/// This value grants no signalling, adoption, destruction or memory authority.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct BackingProcessIdentity(Uuid);

impl BackingProcessIdentity {
    /// Allocate a distinct identity for a newly owned backing generation.
    pub fn new_generation() -> Self {
        Self(Uuid::new_v4())
    }

    /// The opaque generation, suitable for an owner's captured operation key.
    pub fn generation(self) -> Uuid {
        self.0
    }
}

/// Independently retained observation of an exact provider-owned backing.
///
/// Providers must preserve the same identity and terminal wait result for all
/// observers, including after a consuming monitor wait or Sandbox teardown.
/// Observation must not signal or destroy the backing, borrow mutable Sandbox,
/// or acquire locks needed by the producer to publish its child-wait result.
#[async_trait]
pub trait SandboxBackingProcess: Send + Sync {
    /// Immutable identity of the exact backing whose wait result is observed.
    fn identity(&self) -> BackingProcessIdentity;

    /// Wait for positive child-wait proof, independently of later cleanup.
    ///
    /// `true` requires a successful provider-owned child wait; a nonzero child
    /// exit status still confirms exit. Wait failure or lost/aborted producer
    /// returns `false`, meaning unconfirmed, not known-live. Pending completion
    /// remains pending; dropping or timing out one caller must not cancel the
    /// producer or discard another caller's shared terminal result.
    ///
    /// Generic kill success, lifecycle state, absent PID and elapsed time are
    /// not proof. Confirmation does not establish saved data, disk cleanup,
    /// physical RAM relief or permission to settle a memory operation.
    async fn exit_confirmed(&self) -> bool;
}
