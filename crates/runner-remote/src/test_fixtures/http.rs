//! Test stand-in for the Runner-owned authenticated request constructor.

use api_contracts::{Method, ResolvedRoute};
use reqwest::Request;
use serde_json::Value;

use crate::{RemoteApiRequestFactory, RemoteRequestError};

pub(crate) struct HttpClientConfig {
    pub(crate) api_url: String,
    pub(crate) vercel_bypass: Option<String>,
    pub(crate) client_session_id: String,
}

pub(crate) struct HttpClient {
    config: HttpClientConfig,
    client: reqwest::Client,
}

impl HttpClient {
    pub(crate) fn new(config: HttpClientConfig) -> Result<Self, reqwest::Error> {
        Ok(Self {
            config,
            client: reqwest::Client::builder().build()?,
        })
    }
}

impl RemoteApiRequestFactory for HttpClient {
    fn json_request(
        &self,
        route: ResolvedRoute,
        token: &str,
        body: &Value,
    ) -> Result<Request, RemoteRequestError> {
        let method = match route.method {
            Method::Get => reqwest::Method::GET,
            Method::Post => reqwest::Method::POST,
            Method::Put => reqwest::Method::PUT,
            Method::Patch => reqwest::Method::PATCH,
            Method::Delete => reqwest::Method::DELETE,
            Method::Head => reqwest::Method::HEAD,
            Method::Options => reqwest::Method::OPTIONS,
        };
        let mut request = self
            .client
            .request(method, route.url(&self.config.api_url))
            .bearer_auth(token)
            .header("x-client-session-id", &self.config.client_session_id);
        if let Some(bypass) = &self.config.vercel_bypass {
            request = request.header("x-vercel-protection-bypass", bypass);
        }
        request.json(body).build().map_err(|_| RemoteRequestError)
    }
}
