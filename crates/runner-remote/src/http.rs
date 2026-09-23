//! Narrow request-construction seam for authenticated remote authority calls.

use api_contracts::ResolvedRoute;
use reqwest::Request;
use serde_json::Value;

/// Builds canonical Runner API requests while the remote owner controls transport.
pub trait RemoteApiRequestFactory: Send + Sync {
    fn json_request(
        &self,
        route: ResolvedRoute,
        token: &str,
        body: &Value,
    ) -> Result<Request, RemoteRequestError>;
}

/// Opaque request-construction error; credentials and request bodies are never exposed.
#[derive(Debug, thiserror::Error)]
#[error("failed to construct remote API request")]
pub struct RemoteRequestError;
