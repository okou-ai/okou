use crate::LOG_TAG;
use crate::error::DownloadError;
use guest_telemetry::log_info;
use std::cell::Cell;
use std::io;
use std::io::Read;
use std::rc::Rc;
use std::sync::LazyLock;
use std::time::{Duration, Instant};

const TIMEOUT: Duration = Duration::from_secs(60);
const LOOKUP_ERROR_PREFIX: &str = "failed to lookup address information:";

/// Global HTTP agent with timeout and system certificate verification.
/// Uses platform verifier to trust system CA certificates (including proxy CA).
static HTTP_AGENT: LazyLock<ureq::Agent> = LazyLock::new(|| {
    use ureq::tls::{RootCerts, TlsConfig};

    ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        .http_status_as_error(false)
        .tls_config(
            TlsConfig::builder()
                .root_certs(RootCerts::PlatformVerifier)
                .build(),
        )
        .build()
        .new_agent()
});

/// Open the archive byte stream. HTTP/HTTPS URLs use the direct remote-fetch
/// path; `file://` URLs are the runner storage-cache path for guest-local
/// tarballs staged over vsock.
pub(crate) fn open_archive(
    url: &str,
    metrics: Option<&RemoteArchiveAttemptMetrics>,
) -> Result<ArchiveSource, DownloadError> {
    if let Some(path) = url.strip_prefix("file://") {
        log_info!(LOG_TAG, "Reading local archive");
        let file = std::fs::File::open(path)
            .map_err(|e| DownloadError::new(format!("Failed to open local archive: {e}")))?;
        let compressed_bytes = file
            .metadata()
            .ok()
            .filter(|metadata| metadata.is_file())
            .map(|metadata| metadata.len());
        return Ok(ArchiveSource::local(file, compressed_bytes));
    }

    let metrics = metrics.cloned().unwrap_or_default();
    let request_start = Instant::now();
    let response = HTTP_AGENT.get(url).call();
    metrics.record_request_to_response_headers(request_start.elapsed());
    let response = response.map_err(|e| DownloadError::new(classify_http_error(&e)))?;
    if response.status().is_client_error() || response.status().is_server_error() {
        return Err(crate::http_failure::from_response(url, response));
    }
    Ok(ArchiveSource::http(
        response.into_body().into_reader(),
        metrics,
    ))
}

fn classify_http_error(error: &ureq::Error) -> String {
    // Never render the raw error: URI-bearing variants can expose presigned credentials.
    match error {
        ureq::Error::HostNotFound => request_error_message("dns"),
        ureq::Error::Timeout(timeout) => format!(
            "HTTP request error (kind=timeout phase={})",
            timeout_phase(*timeout)
        ),
        ureq::Error::ConnectionFailed => request_error_message("connection"),
        ureq::Error::Io(error) if error.to_string().starts_with(LOOKUP_ERROR_PREFIX) => {
            "HTTP request error (kind=dns phase=resolve)".to_string()
        }
        ureq::Error::Io(error) => {
            format!("HTTP request error (kind=io io_kind={:?})", error.kind())
        }
        ureq::Error::Tls(_)
        | ureq::Error::Pem(_)
        | ureq::Error::Rustls(_)
        | ureq::Error::TlsRequired => request_error_message("tls"),
        ureq::Error::InvalidProxyUrl | ureq::Error::ConnectProxyFailed(_) => {
            request_error_message("proxy")
        }
        ureq::Error::Protocol(_)
        | ureq::Error::RedirectFailed
        | ureq::Error::BodyExceedsLimit(_)
        | ureq::Error::TooManyRedirects
        | ureq::Error::LargeResponseHeader(_, _)
        | ureq::Error::Decompress(_, _)
        | ureq::Error::BodyStalled => request_error_message("protocol"),
        ureq::Error::Http(_) | ureq::Error::BadUri(_) | ureq::Error::RequireHttpsOnly(_) => {
            request_error_message("invalid_request")
        }
        _ => request_error_message("unknown"),
    }
}

fn request_error_message(kind: &'static str) -> String {
    format!("HTTP request error (kind={kind})")
}

fn timeout_phase(timeout: ureq::Timeout) -> &'static str {
    match timeout {
        ureq::Timeout::Global => "global",
        ureq::Timeout::PerCall => "per_call",
        ureq::Timeout::Resolve => "resolve",
        ureq::Timeout::Connect => "connect",
        ureq::Timeout::SendRequest => "send_request",
        ureq::Timeout::Await100 => "await_100",
        ureq::Timeout::SendBody => "send_body",
        ureq::Timeout::RecvResponse => "recv_response",
        ureq::Timeout::RecvBody => "recv_body",
        _ => "unknown",
    }
}

pub(crate) struct ArchiveSource {
    reader: Box<dyn Read>,
    http_body_read_failure: HttpBodyReadFailure,
    compressed_bytes: Option<u64>,
}

impl ArchiveSource {
    pub(crate) fn local(reader: impl Read + 'static, compressed_bytes: Option<u64>) -> Self {
        Self {
            reader: Box::new(reader),
            http_body_read_failure: HttpBodyReadFailure::disabled(),
            compressed_bytes,
        }
    }

    fn http(reader: impl Read + 'static, metrics: RemoteArchiveAttemptMetrics) -> Self {
        let http_body_read_failure = HttpBodyReadFailure::enabled();
        Self {
            reader: Box::new(HttpBodyReader {
                reader,
                failure: http_body_read_failure.clone(),
                metrics,
            }),
            http_body_read_failure,
            compressed_bytes: None,
        }
    }

    pub(crate) fn compressed_bytes(&self) -> Option<u64> {
        self.compressed_bytes
    }

    pub(crate) fn into_parts(self) -> (Box<dyn Read>, HttpBodyReadFailure) {
        (self.reader, self.http_body_read_failure)
    }
}

#[derive(Clone, Default)]
pub(crate) struct RemoteArchiveAttemptMetrics {
    state: Rc<RemoteArchiveAttemptMetricsState>,
}

#[derive(Default)]
struct RemoteArchiveAttemptMetricsState {
    request_to_response_headers: Cell<Duration>,
    body_read: Cell<Duration>,
    compressed_bytes_consumed: Cell<u64>,
}

#[derive(Clone, Copy, Default)]
pub(crate) struct RemoteArchiveAttemptSnapshot {
    pub(crate) request_to_response_headers: Duration,
    pub(crate) body_read: Duration,
    pub(crate) compressed_bytes_consumed: u64,
}

impl RemoteArchiveAttemptMetrics {
    fn record_request_to_response_headers(&self, duration: Duration) {
        self.state.request_to_response_headers.set(
            self.state
                .request_to_response_headers
                .get()
                .saturating_add(duration),
        );
    }

    fn record_body_read(&self, duration: Duration, bytes_read: usize) {
        let bytes_read = u64::try_from(bytes_read).unwrap_or(u64::MAX);
        self.state
            .body_read
            .set(self.state.body_read.get().saturating_add(duration));
        self.state.compressed_bytes_consumed.set(
            self.state
                .compressed_bytes_consumed
                .get()
                .saturating_add(bytes_read),
        );
    }

    pub(crate) fn snapshot(&self) -> RemoteArchiveAttemptSnapshot {
        RemoteArchiveAttemptSnapshot {
            request_to_response_headers: self.state.request_to_response_headers.get(),
            body_read: self.state.body_read.get(),
            compressed_bytes_consumed: self.state.compressed_bytes_consumed.get(),
        }
    }
}

#[derive(Clone)]
pub(crate) struct HttpBodyReadFailure {
    failed: Option<Rc<Cell<bool>>>,
}

impl HttpBodyReadFailure {
    fn enabled() -> Self {
        Self {
            failed: Some(Rc::new(Cell::new(false))),
        }
    }

    fn disabled() -> Self {
        Self { failed: None }
    }

    fn mark_failed(&self) {
        if let Some(failed) = &self.failed {
            failed.set(true);
        }
    }

    pub(crate) fn failed(&self) -> bool {
        self.failed.as_ref().is_some_and(|failed| failed.get())
    }
}

struct HttpBodyReader<R> {
    reader: R,
    failure: HttpBodyReadFailure,
    metrics: RemoteArchiveAttemptMetrics,
}

impl<R: Read> Read for HttpBodyReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let start = Instant::now();
        let result = self.reader.read(buffer);
        let duration = start.elapsed();
        match result {
            Ok(bytes_read) => {
                self.metrics.record_body_read(duration, bytes_read);
                Ok(bytes_read)
            }
            Err(e) => {
                self.metrics.record_body_read(duration, 0);
                self.failure.mark_failed();
                Err(e)
            }
        }
    }
}
