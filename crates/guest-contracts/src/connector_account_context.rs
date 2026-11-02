//! Non-secret connector account selection exposed to managed CLI children.

/// Current connector account context schema version.
pub const SCHEMA_VERSION: u8 = 1;

/// One run's connector account selections.
#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunConnectorAccountContext {
    /// Wire schema version.
    pub schema_version: u8,
    /// Logical connector targets admitted for the run.
    pub targets: Vec<RunConnectorAccountTarget>,
}

/// One logical connector target and its run-pinned account, when available.
#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum RunConnectorAccountTarget {
    /// Built-in connector target.
    #[serde(rename_all = "camelCase")]
    Builtin {
        /// Public connector slug.
        connector_slug: String,
        /// Exact connector account selected at admission.
        connection_id: Option<String>,
    },
    /// User-managed custom connector target.
    #[serde(rename_all = "camelCase")]
    Custom {
        /// Custom connector definition id.
        custom_connector_id: String,
        /// Exact connector account selected at admission.
        connection_id: Option<String>,
    },
}

#[cfg(test)]
mod tests;
