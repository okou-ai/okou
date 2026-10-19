//! In-memory connector registry commands shared by Provider and Network.

use std::collections::HashMap;

use crate::types::{FirewallEntry, NetworkPolicy};

#[derive(Clone)]
pub enum CustomConnectorRuntimeRegistryState {
    Available {
        firewall: FirewallEntry,
        network_policy: Box<NetworkPolicy>,
        routing_variables: HashMap<String, String>,
    },
    Absent,
}

#[derive(Clone)]
pub enum ConnectorRuntimeRegistryUpdate {
    BuiltinAvailable {
        connector_slug: String,
        network_policy: NetworkPolicy,
    },
    BuiltinAbsent {
        connector_slug: String,
    },
    Custom {
        custom_connector_id: String,
        state: CustomConnectorRuntimeRegistryState,
    },
}
