use api_contracts::generated::routes;
use runner_network::network_log_transport::{
    NetworkLogHttpClient, NetworkLogRequestContext, NetworkLogSendError,
    NetworkLogTransportFailure, PreparedNetworkLogRequest,
};
use runner_network::network_logs::NetworkLogPayload;

use crate::error::RunnerError;
use crate::http::{HttpClient, PreparedApiRequest};

pub(crate) struct NetworkLogHttpAdapter<'a>(pub &'a HttpClient);

struct PreparedUpload {
    request: PreparedApiRequest,
    context: NetworkLogRequestContext,
}

impl NetworkLogHttpClient for NetworkLogHttpAdapter<'_> {
    fn prepare_network_log_upload(
        &self,
        sandbox_token: &str,
        payload: &NetworkLogPayload,
    ) -> Result<Box<dyn PreparedNetworkLogRequest>, String> {
        let request = self
            .0
            .request_route(routes::webhooks::agent::telemetry::SEND, sandbox_token)
            .json(payload)
            .prepare("network_logs")
            .map_err(|error| error.to_string())?;
        let context = request.context();
        let context = NetworkLogRequestContext {
            client_request_id: context.client_request_id.clone(),
            client_session_id: context.client_session_id.clone(),
            client_version: context.client_version.clone(),
        };
        Ok(Box::new(PreparedUpload { request, context }))
    }
}

#[async_trait::async_trait]
impl PreparedNetworkLogRequest for PreparedUpload {
    fn context(&self) -> &NetworkLogRequestContext {
        &self.context
    }

    async fn send(self: Box<Self>) -> Result<reqwest::Response, NetworkLogSendError> {
        self.request.send().await.map_err(|error| {
            let transport = match &error {
                RunnerError::ApiTransport(error) => Some(NetworkLogTransportFailure {
                    kind: error.failure_kind.as_str(),
                    cause: error.failure_cause.as_str(),
                }),
                _ => None,
            };
            NetworkLogSendError {
                message: error.to_string(),
                transport,
            }
        })
    }
}
