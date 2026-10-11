//! Retain caller-owned capacity until native physical work is destroyed.

use std::sync::Arc;

pub(crate) struct Lease {
    _owner: Arc<dyn Send + Sync>,
}

impl Lease {
    pub(crate) fn new<T: Send + Sync + 'static>(owner: Arc<T>) -> Self {
        Self { _owner: owner }
    }
}
