//! Public types for the ably-subscriber crate.

use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio_tungstenite::tungstenite;

pub(crate) const REDACTED_DEBUG_VALUE: &str = "[redacted]";

fn redact_query_param(input: &str, param: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(start) = rest.find(param) {
        output.push_str(&rest[..start + param.len()]);
        output.push_str("<redacted>");

        rest = &rest[start + param.len()..];
        let end = rest
            .find(['&', ' ', '"', '\'', ')', ']', '}'])
            .unwrap_or(rest.len());
        rest = &rest[end..];
    }
    output.push_str(rest);
    output
}

pub(crate) fn redact_auth_query_params(input: &str) -> String {
    let redacted = redact_query_param(input, "access_token=");
    redact_query_param(&redacted, "resume=")
}

/// A future that returns a `Result<TokenRequest>`.
pub type TokenFuture = Pin<Box<dyn Future<Output = Result<TokenRequest, BoxError>> + Send>>;

/// A boxed error type for the token callback.
pub type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// Ably TokenRequest — a signed request obtained from your server.
///
/// Your server creates this using `client.auth.createTokenRequest()` and
/// returns it to the client. The client then exchanges it with Ably's REST API
/// for an actual token.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenRequest {
    /// Ably API key name used to sign this token request.
    pub key_name: String,
    /// Request timestamp, in milliseconds since the Unix epoch.
    pub timestamp: i64,
    /// Unique nonce used to prevent token request replay.
    pub nonce: String,
    /// Message Authentication Code for the canonical token request fields.
    pub mac: String,
    /// JSON-encoded Ably capability requested for the token.
    pub capability: String,
    /// Requested token lifetime duration, in milliseconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl: Option<i64>,
    /// Client ID to associate with the requested token.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
}

impl fmt::Debug for TokenRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TokenRequest")
            .field("key_name", &self.key_name)
            .field("timestamp", &self.timestamp)
            .field("nonce", &self.nonce)
            .field("mac", &REDACTED_DEBUG_VALUE)
            .field("capability", &self.capability)
            .field("ttl", &self.ttl)
            .field("client_id", &self.client_id)
            .finish()
    }
}

/// Ably TokenDetails — the actual token returned by Ably's REST API.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenDetails {
    /// Ably token string used to authenticate realtime requests.
    pub token: String,
    /// Token expiry time, in milliseconds since the Unix epoch.
    #[serde(default)]
    pub expires: i64,
    /// Token issue time, in milliseconds since the Unix epoch.
    #[serde(default)]
    pub issued: i64,
    /// JSON-encoded Ably capability granted to the token.
    #[serde(default)]
    pub capability: Option<String>,
    /// Client ID associated with the token, when present.
    #[serde(default)]
    pub client_id: Option<String>,
}

impl fmt::Debug for TokenDetails {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TokenDetails")
            .field("token", &REDACTED_DEBUG_VALUE)
            .field("expires", &self.expires)
            .field("issued", &self.issued)
            .field("capability", &self.capability)
            .field("client_id", &self.client_id)
            .finish()
    }
}

/// A message received from an Ably channel.
#[derive(Debug, Clone)]
pub struct Message {
    /// Event name (e.g. "job", "events", "status").
    pub name: Option<String>,
    /// Message payload after MessagePack normalization and supported Ably
    /// `encoding` processing.
    ///
    /// Missing, `nil`, and non-finite root wire values are exposed as JSON
    /// `null`; those values nested inside arrays or maps are also JSON `null`.
    /// Binary and extension payload bytes become standard-base64 strings, and
    /// an extension's type tag is not retained. Invalid UTF-8 strings and map
    /// keys become empty strings. Other non-string map keys are formatted as
    /// strings, and duplicate converted keys use last-wins semantics.
    ///
    /// Supported `json` and `utf-8` encoding layers are processed after wire
    /// normalization. An encoding stack containing a `base64` layer stays in
    /// its normalized JSON form instead of being decoded to raw bytes.
    pub data: serde_json::Value,
    /// Unique message ID.
    pub id: Option<String>,
    /// Publisher's client ID.
    pub client_id: Option<String>,
    /// Server timestamp (milliseconds since epoch).
    pub timestamp: Option<i64>,
}

/// Events emitted by a [`Subscription`](crate::Subscription).
#[derive(Debug)]
pub enum Event {
    /// A message was received on the subscribed channel.
    Message(Message),
    /// Successfully connected (or reconnected) and channel is attached.
    Connected,
    /// Temporarily disconnected from the realtime connection.
    ///
    /// This is a transient status event: the background task keeps running and
    /// attempts to reconnect after emitting it.
    Disconnected {
        /// Optional diagnostic detail for the disconnect.
        ///
        /// `Some` values may come from Ably `DISCONNECTED` protocol messages,
        /// WebSocket close or error details, stream termination, heartbeat
        /// timeouts, or local suspended-retry transitions. `None` means the
        /// subscriber only knows that reconnecting is required and no more
        /// specific reason was available.
        ///
        /// Diagnostic strings generated by this crate redact Ably
        /// authentication query parameter values (`access_token` and the
        /// connection key in `resume`). Callers should still treat this text
        /// as operational diagnostics, not as a generally sanitized payload.
        reason: Option<String>,
    },
    /// An unrecoverable subscription error occurred.
    ///
    /// This is a terminal status event: the background task stops after
    /// emitting it.
    Error {
        /// Ably-style error code associated with the terminal failure.
        ///
        /// The code may come from an Ably protocol `ERROR` message or be
        /// generated locally by this crate for failures such as token renewal
        /// exhaustion.
        code: i32,
        /// Diagnostic error text for the terminal failure.
        ///
        /// The message may come from Ably protocol error details or local
        /// failure handling. Diagnostic strings generated by this crate redact
        /// Ably authentication query parameter values (`access_token` and the
        /// connection key in `resume`). Callers should still treat this text as
        /// operational diagnostics, not as a generally sanitized payload.
        message: String,
    },
}

/// Timing parameters for connection establishment, liveness, token renewal and retry.
/// Defaults are production-oriented.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct TimingConfig {
    // -- Connection ----------------------------------------------------------
    /// Timeout for WebSocket connect, HTTP requests, and token operations.
    pub connect_timeout: Duration,
    /// Timeout for protocol/WebSocket close operations and the total wait in
    /// [`Subscription::close_and_wait`](crate::Subscription::close_and_wait).
    pub close_timeout: Duration,
    /// Timeout for reconnect setup through sending the channel `ATTACH`.
    ///
    /// Waiting for the attach outcome is separately bounded by
    /// [`realtime_request_timeout`](Self::realtime_request_timeout), so a
    /// complete reconnect attempt can approach the sum of both timeouts.
    pub reconnect_timeout: Duration,
    /// Fallback `max_idle_interval` when the server omits connection details.
    /// If connection details are present but `maxIdleInterval` is zero or
    /// absent, no idle timeout is enforced, matching Ably realtime semantics.
    pub default_max_idle_interval: Duration,
    /// Default `connection_state_ttl` when the server doesn't specify one.
    pub default_connection_state_ttl: Duration,

    // -- Heartbeat -----------------------------------------------------------
    /// Extra margin added to `max_idle_interval` for heartbeat timeout.
    pub heartbeat_margin: Duration,

    // -- Reconnection retry --------------------------------------------------
    /// Retry timeout while in the Ably `disconnected` state.
    ///
    /// Matches ably-js `disconnectedRetryTimeout`.
    pub disconnected_retry_timeout: Duration,
    /// Retry timeout while in the Ably `suspended` state.
    ///
    /// Matches ably-js `suspendedRetryTimeout`.
    pub suspended_retry_timeout: Duration,
    /// Retry timeout while a channel is `suspended` after an attach failure.
    ///
    /// Matches ably-js `channelRetryTimeout`.
    pub channel_retry_timeout: Duration,
    /// Timeout for an in-flight realtime channel ATTACH operation.
    /// Initial subscribe connect+attach is bounded by
    /// [`connect_timeout`](Self::connect_timeout); this timeout applies after
    /// the subscription is established.
    ///
    /// Matches ably-js `realtimeRequestTimeout`.
    pub realtime_request_timeout: Duration,
    /// Minimum spacing between reconnect attempts after transport-level
    /// disconnects. This mirrors ably-js' guard against tight reconnect loops
    /// when a server or proxy repeatedly closes otherwise healthy sockets.
    pub min_reconnect_interval: Duration,

    // -- Token renewal -------------------------------------------------------
    /// How early before token expiry to start proactive renewal.
    ///
    /// When this exceeds half of a token's remaining lifetime, the effective
    /// margin is capped at that half-life so the next renewal stays in the
    /// future while retaining time to renew before expiry.
    pub token_renewal_margin: Duration,
    /// Delay before retrying a failed token renewal.
    pub token_renewal_retry_delay: Duration,
    /// Number of consecutive token renewal failures before emitting a fatal error.
    pub max_token_renewal_failures: u32,
}

impl Default for TimingConfig {
    fn default() -> Self {
        Self {
            // Connection
            connect_timeout: Duration::from_secs(30),
            close_timeout: Duration::from_secs(5),
            reconnect_timeout: Duration::from_secs(60),
            default_max_idle_interval: Duration::from_secs(15),
            default_connection_state_ttl: Duration::from_secs(120),
            // Heartbeat
            heartbeat_margin: Duration::from_secs(10),
            // Reconnection retry
            disconnected_retry_timeout: Duration::from_secs(15),
            suspended_retry_timeout: Duration::from_secs(30),
            channel_retry_timeout: Duration::from_secs(15),
            realtime_request_timeout: Duration::from_secs(10),
            min_reconnect_interval: Duration::from_secs(1),
            // Token renewal
            token_renewal_margin: Duration::from_secs(300),
            token_renewal_retry_delay: Duration::from_secs(30),
            max_token_renewal_failures: 3,
        }
    }
}

/// Configuration for [`subscribe`](crate::subscribe).
#[non_exhaustive]
pub struct SubscribeConfig {
    /// Callback that returns a fresh [`TokenRequest`] from your server.
    pub get_token: Box<dyn Fn() -> TokenFuture + Send + Sync>,
    /// Channel name to subscribe to (e.g. `"runner-group:my-group"`).
    pub channel: String,
    /// Optional channel parameters (e.g. `{"rewind": "2m"}`).
    pub channel_params: Option<HashMap<String, String>>,
    /// Ably realtime host/authority, without a URL scheme, path, query, or
    /// fragment. Defaults to `"realtime.ably.io"`.
    pub host: Option<String>,
    /// Ably REST host for token exchange. Defaults to `"rest.ably.io"` when
    /// `host` is the default, otherwise falls back to the realtime host value.
    /// Like [`host`](Self::host), this must be a host/authority rather than a
    /// base URL.
    pub rest_host: Option<String>,
    /// Request Ably's server heartbeat interval, between five seconds and
    /// thirty minutes, sent as the `heartbeatInterval` transport parameter.
    /// `None` retains the service default. The server's negotiated
    /// `maxIdleInterval` remains authoritative for local idle detection.
    pub heartbeat_interval: Option<Duration>,
    /// Override timing parameters. `None` uses [`TimingConfig::default()`].
    pub timing: Option<TimingConfig>,
}

impl SubscribeConfig {
    /// Create a new configuration with the required fields.
    ///
    /// Optional fields default to `None` and can be set after construction.
    pub fn new(
        get_token: Box<dyn Fn() -> TokenFuture + Send + Sync>,
        channel: impl Into<String>,
    ) -> Self {
        Self {
            get_token,
            channel: channel.into(),
            channel_params: None,
            host: None,
            rest_host: None,
            heartbeat_interval: None,
            timing: None,
        }
    }
}

/// Errors returned by this crate.
#[derive(thiserror::Error)]
pub enum Error {
    /// WebSocket transport failure while connecting, reading, writing, or
    /// closing the Ably realtime connection.
    ///
    /// `Display` and `Debug` redact Ably authentication query parameter values
    /// from formatted WebSocket error messages.
    #[error("WebSocket error: {}", redact_auth_query_params(&.0.to_string()))]
    WebSocket(Box<tungstenite::Error>),

    /// HTTP client setup or request failure while exchanging a [`TokenRequest`]
    /// for Ably token details.
    ///
    /// This covers the `reqwest` client used for Ably REST token exchange and
    /// the exchange request/response itself. It is distinct from
    /// [`Error::TokenFetch`], which represents the user-provided token request
    /// callback.
    #[error("Token exchange HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    /// Failure while encoding an outbound Ably protocol message as MessagePack.
    #[error("MessagePack encode error: {0}")]
    MsgpackEncode(#[from] rmp_serde::encode::Error),

    /// Ably protocol-level failure or a local failure mapped into Ably-style
    /// protocol error fields.
    ///
    /// The `code` and `message` may come from an Ably protocol message, such as
    /// `ERROR`, `DISCONNECTED`, `DETACHED`, or `CLOSED`, or they may be
    /// generated locally by this crate for conditions such as decode failures,
    /// timeouts, or a connection closing before the expected protocol message
    /// arrives. Callers should not assume this variant always means the Ably
    /// service returned the error.
    ///
    /// `Display` and `Debug` redact Ably authentication query parameter values
    /// from the formatted message.
    #[error(
        "Ably protocol error: code={code}, {}",
        redact_auth_query_params(message)
    )]
    Protocol {
        /// Ably-style error code, either received from Ably or generated by
        /// this crate for a locally detected protocol failure.
        code: i32,
        /// Human-readable protocol error detail, either received from Ably or
        /// generated locally by this crate.
        message: String,
    },

    /// Failure returned by the user-provided token request callback.
    ///
    /// This is distinct from [`Error::Http`], which represents the subsequent
    /// Ably REST token exchange. `Display` and `Debug` redact Ably
    /// authentication query parameter values from the formatted callback
    /// error.
    #[error("Token fetch failed: {}", redact_auth_query_params(&.0.to_string()))]
    TokenFetch(BoxError),

    /// Invalid endpoint URL or URL component built from the subscription
    /// configuration or token request.
    ///
    /// This also covers local validation failures for endpoint host and
    /// [`TokenRequest`] key-name values that would otherwise be silently
    /// normalized by URL parsing. The message deliberately omits the raw input
    /// because callers may accidentally include credentials in host-like values
    /// or authentication material in token request fields.
    #[error("URL parse error: {0}")]
    Url(#[from] url::ParseError),
}

impl fmt::Debug for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("Error")
            .field(&redact_auth_query_params(&self.to_string()))
            .finish()
    }
}

impl From<tungstenite::Error> for Error {
    fn from(e: tungstenite::Error) -> Self {
        Error::WebSocket(Box::new(e))
    }
}

#[cfg(test)]
mod tests;
