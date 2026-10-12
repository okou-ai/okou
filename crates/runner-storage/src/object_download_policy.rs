//! Bounded retry scheduling and transient-failure policy for read-only Runner object downloads.

use std::error::Error as _;
use std::future::Future;
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

/// One fixed retry budget for a Runner-owned archive or session-history blob.
///
/// Callers supply a fresh read-only attempt future, then ask for a retry only
/// after it fails. Cancellation, error classification, validation and resource
/// ownership remain with the caller.
pub struct ObjectDownloadRetryBudget {
    deadline: tokio::time::Instant,
    attempt: usize,
}

impl Default for ObjectDownloadRetryBudget {
    fn default() -> Self {
        Self {
            deadline: tokio::time::Instant::now() + OBJECT_DOWNLOAD_BUDGET,
            attempt: 1,
        }
    }
}

impl ObjectDownloadRetryBudget {
    /// Bound one fresh attempt, rejecting both overdue starts and ready results.
    pub async fn run_attempt<T>(
        &self,
        attempt: impl Future<Output = T>,
    ) -> Result<T, ObjectDownloadBudgetExpired> {
        before_deadline(self.deadline, attempt).await
    }

    /// Schedule another attempt only when the caller's failure is retryable.
    ///
    /// The caller's `None` marks a terminal failure; retryable failures without
    /// a provider hint pass `Some(Duration::ZERO)`. Exhaustion and a delay that
    /// cannot fit return `None`, preserving the caller's last attempt error.
    pub fn next_retry(&mut self, retry_after: Option<Duration>) -> Option<ObjectDownloadRetry> {
        let retry_after = retry_after?;
        if self.attempt >= OBJECT_DOWNLOAD_MAX_ATTEMPTS {
            return None;
        }
        let backoff = OBJECT_DOWNLOAD_RETRY_DELAY * (1 << (self.attempt - 1));
        let delay = backoff.max(retry_after);
        if delay
            >= self
                .deadline
                .saturating_duration_since(tokio::time::Instant::now())
        {
            return None;
        }
        let retry = ObjectDownloadRetry {
            deadline: self.deadline,
            attempt: self.attempt,
            delay,
        };
        self.attempt += 1;
        Some(retry)
    }
}

/// One scheduled backoff, with metadata for the caller's existing retry log.
pub struct ObjectDownloadRetry {
    deadline: tokio::time::Instant,
    attempt: usize,
    delay: Duration,
}

impl ObjectDownloadRetry {
    /// The failed attempt preceding this backoff, numbered from one.
    pub fn attempt(&self) -> usize {
        self.attempt
    }

    /// The greater of exponential backoff and the provider's requested delay.
    pub fn delay(&self) -> Duration {
        self.delay
    }

    /// Wait within the original budget; an overdue wakeup is not a new attempt.
    pub async fn wait(self) -> Result<(), ObjectDownloadBudgetExpired> {
        before_deadline(self.deadline, tokio::time::sleep(self.delay)).await
    }
}

/// The shared scheduler's deadline expired, independent of caller error types.
#[derive(Debug, Eq, PartialEq, thiserror::Error)]
#[error("object download retry budget expired")]
pub struct ObjectDownloadBudgetExpired;

async fn before_deadline<T>(
    deadline: tokio::time::Instant,
    future: impl Future<Output = T>,
) -> Result<T, ObjectDownloadBudgetExpired> {
    // Timeout polls its inner future before an expired timer. A late backoff
    // wakeup must not poll another GET, and a ready overdue result must not win.
    if tokio::time::Instant::now() >= deadline {
        return Err(ObjectDownloadBudgetExpired);
    }
    let result = tokio::time::timeout_at(deadline, future)
        .await
        .map_err(|_| ObjectDownloadBudgetExpired)?;
    if tokio::time::Instant::now() >= deadline {
        return Err(ObjectDownloadBudgetExpired);
    }
    Ok(result)
}

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
