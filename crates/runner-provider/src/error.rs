use reqwest::StatusCode;

#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("api error: {0}")]
    Api(String),

    #[error("api error: {0}")]
    ApiStatus(Box<ApiStatusError>),

    #[error("api error: {0}")]
    ApiTransport(Box<ApiTransportError>),

    #[error("api error: {0}")]
    ApiBodyRead(Box<ApiBodyReadError>),

    #[error("config error: {0}")]
    Config(String),

    #[error("internal error: {0}")]
    Internal(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

impl From<runner_host::HostError> for ProviderError {
    fn from(error: runner_host::HostError) -> Self {
        match error {
            runner_host::HostError::Config(message) => Self::Config(message),
            runner_host::HostError::Internal(message) => Self::Internal(message),
            runner_host::HostError::Io(error) => Self::Io(error),
        }
    }
}

pub type ProviderResult<T> = Result<T, ProviderError>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiStatusError {
    pub endpoint_label: &'static str,
    pub status: StatusCode,
    pub body: String,
}

impl std::fmt::Display for ApiStatusError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} {}: {}", self.endpoint_label, self.status, self.body)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiRequestContext {
    pub endpoint_label: &'static str,
    pub method: String,
    pub host: String,
    pub path: String,
    pub client_request_id: String,
    pub client_session_id: String,
    pub client_version: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiFailureKind {
    Timeout,
    Connect,
    Request,
    Body,
    Unknown,
}

impl ApiFailureKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Timeout => "timeout",
            Self::Connect => "connect",
            Self::Request => "request",
            Self::Body => "body",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiTransportCause {
    Timeout,
    ConnectionRefused,
    ConnectionReset,
    ConnectionAborted,
    NetworkUnreachable,
    HostUnreachable,
    NotConnected,
    BrokenPipe,
    UnexpectedEof,
    HttpIncompleteMessage,
    HttpCanceled,
    HttpClosed,
    HttpParse,
    HttpBodyWriteAborted,
    HttpShutdown,
    Io,
    Unknown,
}

impl ApiTransportCause {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Timeout => "timeout",
            Self::ConnectionRefused => "connection_refused",
            Self::ConnectionReset => "connection_reset",
            Self::ConnectionAborted => "connection_aborted",
            Self::NetworkUnreachable => "network_unreachable",
            Self::HostUnreachable => "host_unreachable",
            Self::NotConnected => "not_connected",
            Self::BrokenPipe => "broken_pipe",
            Self::UnexpectedEof => "unexpected_eof",
            Self::HttpIncompleteMessage => "http_incomplete_message",
            Self::HttpCanceled => "http_canceled",
            Self::HttpClosed => "http_closed",
            Self::HttpParse => "http_parse",
            Self::HttpBodyWriteAborted => "http_body_write_aborted",
            Self::HttpShutdown => "http_shutdown",
            Self::Io => "io",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiTransportError {
    pub request: ApiRequestContext,
    pub failure_kind: ApiFailureKind,
    pub failure_cause: ApiTransportCause,
    pub summary: String,
}

impl std::fmt::Display for ApiTransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}: send API request failed: {}; cause={}",
            self.request.endpoint_label,
            self.summary,
            self.failure_cause.as_str()
        )
    }
}

#[derive(Debug)]
pub struct ApiBodyReadError {
    pub endpoint_label: &'static str,
    pub status: StatusCode,
    pub content_type: &'static str,
    pub content_length: Option<u64>,
    pub received_bytes: u64,
    pub failure_cause: ApiTransportCause,
}

impl std::fmt::Display for ApiBodyReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} read response body: cause={}, status={}, content_type={}, content_length={:?}, received_bytes={}",
            self.endpoint_label,
            self.failure_cause.as_str(),
            self.status.as_u16(),
            self.content_type,
            self.content_length,
            self.received_bytes,
        )
    }
}
