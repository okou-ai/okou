use super::*;
use crate::network_log_transport::{NetworkLogSendError, PreparedNetworkLogRequest};

pub struct HttpClientConfig {
    pub api_url: String,
    pub vercel_bypass: Option<String>,
    pub client_session_id: String,
}

pub struct HttpClient {
    client: reqwest::Client,
    config: HttpClientConfig,
}

struct PreparedTestRequest {
    client: reqwest::Client,
    request: reqwest::Request,
    context: NetworkLogRequestContext,
}

impl HttpClient {
    pub fn new(config: HttpClientConfig) -> Result<Self, reqwest::Error> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()?;
        Ok(Self { client, config })
    }
}

impl NetworkLogHttpClient for HttpClient {
    fn prepare_network_log_upload(
        &self,
        sandbox_token: &str,
        payload: &NetworkLogPayload,
    ) -> Result<Box<dyn PreparedNetworkLogRequest>, String> {
        let _ = &self.config.vercel_bypass;
        let client_request_id = uuid::Uuid::new_v4().to_string();
        let client_version = env!("CARGO_PKG_VERSION").to_string();
        let request = self
            .client
            .post(format!(
                "{}/api/webhooks/agent/telemetry",
                self.config.api_url
            ))
            .bearer_auth(sandbox_token)
            .header(
                api_contracts::generated::constants::client::headers::CLIENT_REQUEST_ID_HEADER,
                &client_request_id,
            )
            .header(
                api_contracts::generated::constants::client::headers::CLIENT_SESSION_ID_HEADER,
                &self.config.client_session_id,
            )
            .header(
                api_contracts::generated::constants::client::headers::CLIENT_VERSION_HEADER,
                &client_version,
            )
            .json(payload)
            .build()
            .map_err(|error| error.to_string())?;
        let context = NetworkLogRequestContext {
            client_request_id,
            client_session_id: self.config.client_session_id.clone(),
            client_version,
        };
        Ok(Box::new(PreparedTestRequest {
            client: self.client.clone(),
            request,
            context,
        }))
    }
}

#[async_trait::async_trait]
impl PreparedNetworkLogRequest for PreparedTestRequest {
    fn context(&self) -> &NetworkLogRequestContext {
        &self.context
    }

    async fn send(self: Box<Self>) -> Result<reqwest::Response, NetworkLogSendError> {
        self.client
            .execute(self.request)
            .await
            .map_err(|error| NetworkLogSendError {
                message: format!(
                    "network_logs: send API request failed: {error}; cause={}",
                    if error.is_timeout() {
                        "timeout"
                    } else {
                        "unknown"
                    }
                ),
                transport: Some(NetworkLogTransportFailure {
                    kind: if error.is_timeout() {
                        "timeout"
                    } else if error.is_connect() {
                        "connect"
                    } else {
                        "unknown"
                    },
                    cause: if error.is_timeout() {
                        "timeout"
                    } else {
                        "unknown"
                    },
                }),
            })
    }
}
