//! Test constructor for the same API client used in production.

pub(crate) use runner_provider::HttpClient;

pub(crate) struct HttpClientConfig {
    pub(crate) api_url: String,
    pub(crate) vercel_bypass: Option<String>,
    pub(crate) client_session_id: String,
}

pub(crate) fn http_client(config: HttpClientConfig) -> HttpClient {
    HttpClient::new(runner_provider::HttpClientConfig {
        api_url: config.api_url,
        vercel_bypass: config.vercel_bypass,
        client_session_id: config.client_session_id,
        runner_version: env!("CARGO_PKG_VERSION"),
    })
    .unwrap()
}
