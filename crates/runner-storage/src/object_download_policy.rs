//! Limits and transient-failure policy for read-only Runner object downloads.

use std::error::Error as _;
use std::time::Duration;

use reqwest::header::RETRY_AFTER;

/// Maximum time allowed for one bounded object-download request.
pub const OBJECT_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30);

/// Retry limits for Runner-owned archives and session-history blobs only.
/// These do not renew signed URLs, retry writes, or replay the agent.
pub const OBJECT_DOWNLOAD_MAX_ATTEMPTS: usize = 3;
/// Base exponential delay between read-only object-download attempts.
pub const OBJECT_DOWNLOAD_RETRY_DELAY: Duration = Duration::from_millis(200);
/// Overall deadline, including requests and provider-directed backoff.
pub const OBJECT_DOWNLOAD_BUDGET: Duration = Duration::from_secs(90);

/// A typed transport interruption that can recover with a fresh body buffer.
pub fn object_download_transient_transport_kind(error: &reqwest::Error) -> Option<&'static str> {
    if error.is_timeout() {
        return Some("timeout");
    }
    if error.is_connect() {
        return Some("connect");
    }
    // chunk() wraps body interruptions as decode errors. Do not retry every
    // decode failure or classify errors from dependency message strings.
    let mut source = error.source();
    while let Some(error) = source {
        if let Some(error) = error.downcast_ref::<std::io::Error>()
            && matches!(
                error.kind(),
                std::io::ErrorKind::ConnectionReset
                    | std::io::ErrorKind::ConnectionAborted
                    | std::io::ErrorKind::BrokenPipe
                    | std::io::ErrorKind::UnexpectedEof
            )
        {
            return Some("body_interrupted");
        }
        if let Some(error) = error.downcast_ref::<hyper::Error>()
            && (error.is_incomplete_message() || error.is_closed())
        {
            return Some("body_interrupted");
        }
        source = error.source();
    }
    None
}

/// Provider delay for an explicitly transient status. Missing hints permit
/// normal backoff; malformed or repeated hints are terminal rather than ignored.
pub fn object_download_http_retry_after(response: &reqwest::Response) -> Option<Duration> {
    if !matches!(response.status().as_u16(), 429 | 500 | 502 | 503 | 504) {
        return None;
    }
    let mut values = response.headers().get_all(RETRY_AFTER).iter();
    let Some(value) = values.next() else {
        return Some(Duration::ZERO);
    };
    // Retry-After is not list-valued. Do not choose an earlier value over a
    // conflicting provider delay, even when one of the values parses alone.
    if values.next().is_some() {
        return None;
    }
    value.to_str().ok().and_then(parse_retry_after)
}

fn parse_retry_after(value: &str) -> Option<Duration> {
    let value = value.trim();
    if !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()) {
        return value.parse::<u64>().ok().map(Duration::from_secs);
    }
    let date = chrono::DateTime::parse_from_rfc2822(value).ok()?;
    Some(
        date.signed_duration_since(chrono::Utc::now())
            .to_std()
            .unwrap_or(Duration::ZERO),
    )
}
