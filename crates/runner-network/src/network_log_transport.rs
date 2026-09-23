use reqwest::Response;

use crate::network_logs::NetworkLogPayload;

/// Correlation fields captured before an upload is sent.
#[derive(Clone, Debug)]
pub struct NetworkLogRequestContext {
    pub client_request_id: String,
    pub client_session_id: String,
    pub client_version: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NetworkLogTransportFailure {
    pub kind: &'static str,
    pub cause: &'static str,
}

#[derive(Debug)]
pub struct NetworkLogSendError {
    pub message: String,
    pub transport: Option<NetworkLogTransportFailure>,
}

impl std::fmt::Display for NetworkLogSendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

#[async_trait::async_trait]
pub trait PreparedNetworkLogRequest: Send {
    fn context(&self) -> &NetworkLogRequestContext;
    async fn send(self: Box<Self>) -> Result<Response, NetworkLogSendError>;
}

pub trait NetworkLogHttpClient: Send + Sync {
    fn prepare_network_log_upload(
        &self,
        sandbox_token: &str,
        payload: &NetworkLogPayload,
    ) -> Result<Box<dyn PreparedNetworkLogRequest>, String>;
}
