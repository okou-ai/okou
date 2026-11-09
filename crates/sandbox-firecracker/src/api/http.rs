use std::error::Error as _;
use std::io;
use std::path::Path;

use reqwest::header::{ACCEPT, HeaderValue};
use reqwest::{Method, Response};

use super::client::ApiError;

const API_ORIGIN: &str = "http://localhost";
const MAX_COLLECTED_BODY_BYTES: usize = 64 * 1024;
const BODY_LIMIT_DIAGNOSTIC: &str = "response body exceeds 64 KiB limit";

pub(super) enum ResponseMode {
    StatusOnly,
    Collect,
}

enum BodyCollectionError {
    TooLarge,
    Transport(reqwest::Error),
}

pub(super) fn build_client(socket_path: &Path) -> Result<reqwest::Client, ApiError> {
    reqwest::Client::builder()
        .unix_socket(socket_path)
        .http1_only()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .no_proxy()
        .pool_max_idle_per_host(0)
        // This fixed plaintext Unix-socket transport never uses TLS. Avoid
        // loading platform trust roots for every VMM operation's client.
        .tls_certs_only(std::iter::empty())
        .build()
        .map_err(map_transport_error)
}

pub(super) async fn send_request(
    client: &reqwest::Client,
    method: Method,
    path: &str,
    body: Option<&serde_json::Value>,
    response_mode: ResponseMode,
) -> Result<Vec<u8>, ApiError> {
    let mut request = client
        .request(method, format!("{API_ORIGIN}{path}"))
        .header(ACCEPT, HeaderValue::from_static("application/json"));
    if let Some(body) = body {
        request = request.json(body);
    }

    let response = request.send().await.map_err(map_transport_error)?;
    let status = response.status();

    if status.is_success() {
        return match response_mode {
            ResponseMode::StatusOnly => Ok(Vec::new()),
            ResponseMode::Collect => collect_body(response).await.map_err(|error| match error {
                BodyCollectionError::TooLarge => ApiError::Other(BODY_LIMIT_DIAGNOSTIC.into()),
                BodyCollectionError::Transport(error) => map_transport_error(error),
            }),
        };
    }

    let status = status.as_u16();
    let body = match collect_body(response).await {
        Ok(body) => fault_message_or_body(&body),
        Err(BodyCollectionError::TooLarge) => BODY_LIMIT_DIAGNOSTIC.into(),
        Err(BodyCollectionError::Transport(error)) => return Err(map_transport_error(error)),
    };
    Err(ApiError::Http { status, body })
}

async fn collect_body(mut response: Response) -> Result<Vec<u8>, BodyCollectionError> {
    let capacity = match response.content_length() {
        Some(length) if length > MAX_COLLECTED_BODY_BYTES as u64 => {
            return Err(BodyCollectionError::TooLarge);
        }
        Some(length) => usize::try_from(length).map_err(|_| BodyCollectionError::TooLarge)?,
        None => 0,
    };
    let mut body = Vec::with_capacity(capacity);

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(BodyCollectionError::Transport)?
    {
        let length = body
            .len()
            .checked_add(chunk.len())
            .ok_or(BodyCollectionError::TooLarge)?;
        if length > MAX_COLLECTED_BODY_BYTES {
            return Err(BodyCollectionError::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }

    Ok(body)
}

fn fault_message_or_body(body: &[u8]) -> String {
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|value| value.get("fault_message")?.as_str().map(String::from))
        .unwrap_or_else(|| String::from_utf8_lossy(body).into_owned())
}

fn map_transport_error(error: reqwest::Error) -> ApiError {
    if !error.is_connect() {
        return ApiError::Transport(error);
    }

    let kind = io_error_kind(&error).unwrap_or(io::ErrorKind::Other);
    ApiError::Connect(io::Error::new(kind, error))
}

fn io_error_kind(error: &reqwest::Error) -> Option<io::ErrorKind> {
    let mut source = error.source();
    while let Some(error) = source {
        if let Some(error) = error.downcast_ref::<io::Error>() {
            return Some(error.kind());
        }
        source = error.source();
    }
    None
}
