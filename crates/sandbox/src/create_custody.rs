//! Caller ownership carried by accepted physical creation and rollback work.

use std::sync::Arc;

/// Opaque ownership, not a policy value or permission to start another phase.
/// Providers clone it into every physical producer that can outlive `create`,
/// including failed-creation rollback. Losing an observer cannot drop custody.
#[derive(Clone)]
pub struct SandboxCreateCustody {
    _owner: Arc<dyn Send + Sync>,
}

impl SandboxCreateCustody {
    pub fn new(owner: Arc<dyn Send + Sync>) -> Self {
        Self { _owner: owner }
    }
}
