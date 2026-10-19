use std::sync::Arc;

use async_trait::async_trait;
pub use runner_types::connector_registry::{
    ConnectorRuntimeRegistryUpdate, CustomConnectorRuntimeRegistryState,
};
use runner_types::types::ConnectorRuntimeTarget;

use crate::{ProviderError, ProviderResult};

pub enum ConnectorRuntimeFailCloseOutcome {
    Applied,
    Unchanged,
    Failed(ProviderError),
}

pub struct ConnectorRuntimePublication<T> {
    pub outcomes: Vec<T>,
    pub publication: Option<Box<dyn RegistryPublicationReceipt>>,
}

#[async_trait]
pub trait RegistryPublicationReceipt: Send {
    async fn observe(self: Box<Self>);
}

#[async_trait]
pub trait ConnectorRuntimeRegistryTransaction: Send {
    async fn apply_updates_if_run_matches(
        self: Box<Self>,
        source_ip: &str,
        run_id: &str,
        updates: &[ConnectorRuntimeRegistryUpdate],
    ) -> ProviderResult<Option<ConnectorRuntimePublication<bool>>>;

    async fn fail_closed_targets_if_run_matches(
        self: Box<Self>,
        source_ip: &str,
        run_id: &str,
        targets: &[ConnectorRuntimeTarget],
    ) -> ProviderResult<Option<ConnectorRuntimePublication<ConnectorRuntimeFailCloseOutcome>>>;
}

#[async_trait]
pub trait ConnectorRuntimeRegistry: Send + Sync {
    async fn begin_transaction(
        &self,
    ) -> ProviderResult<Box<dyn ConnectorRuntimeRegistryTransaction>>;
}

pub type ConnectorRuntimeRegistryHandle = Arc<dyn ConnectorRuntimeRegistry>;
