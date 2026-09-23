//! API and local job-provider coordination for Runner.

mod active_input;
#[cfg(test)]
mod axiom_layer;
mod connector_registry;
mod duration;
mod error;
mod http;
pub mod local_queue;
mod profile;
pub mod provider;
#[cfg(test)]
mod proxy;
mod retry;
mod run_cancellation;

pub use active_input::{
    ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES, API_ACTIVE_INPUT_RECHECK_INTERVAL, ActiveInputBatch,
    ActiveInputNotifications, ActiveInputSource, ApiActiveInputRecovery,
    identified_active_input_payload_len, local_active_input_delivery_id,
};
pub use connector_registry::{
    ConnectorRuntimeFailCloseOutcome, ConnectorRuntimePublication, ConnectorRuntimeRegistry,
    ConnectorRuntimeRegistryHandle, ConnectorRuntimeRegistryTransaction,
    ConnectorRuntimeRegistryUpdate, CustomConnectorRuntimeRegistryState,
    RegistryPublicationReceipt,
};
pub use error::{
    ApiBodyReadError, ApiFailureKind, ApiRequestContext, ApiStatusError, ApiTransportCause,
    ApiTransportError, ProviderError, ProviderResult,
};
pub use http::{
    PreparedProviderHttpRequest, ProviderHttpClient, ProviderHttpRequest, ProviderHttpTransport,
    provider_http_transport_error,
};
pub use provider::*;
pub use run_cancellation::{
    DuplicateRunCancellationRegistration, RunCancellationHandle, RunCancellationMode,
    RunCancellationRegistration, RunCancellationRegistry, RunCancellationSignals,
};

#[cfg(test)]
mod test_fixtures {
    pub(crate) mod execution_context;
    pub(crate) mod firewall_base_url_contract;
    pub(crate) mod raw_http;
}
