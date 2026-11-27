use crate::LOG_TAG;
use crate::connection_observation::{self, CallObservation};
use crate::error::DownloadError;
use guest_telemetry::log_info;
use std::cell::Cell;
use std::fs::File;
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

    let config = ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        // Keep more connections from a completed wave for the next requests,
        // within ureq's existing total idle budget.
        .max_idle_connections_per_host(8)
        .http_status_as_error(false)
        .tls_config(
            TlsConfig::builder()
                .root_certs(RootCerts::PlatformVerifier)
                .build(),
        )
        .build();
    connection_observation::agent(config)
});

/// Open the archive byte stream. HTTP/HTTPS URLs use the direct remote-fetch
/// path; `file://` URLs are the runner storage-cache path for guest-local
/// tarballs staged over vsock.
pub(crate) fn open_archive(
    url: &str,
    remote_metrics: Option<&RemoteArchiveAttemptMetrics>,
    local_metrics: Option<&LocalArchiveAttemptMetrics>,
) -> Result<ArchiveSource<'static>, DownloadError> {
    if let Some(path) = url.strip_prefix("file://") {
        return Ok(LocalArchive::open(path)?.into_source(local_metrics));
    }

    let metrics = remote_metrics.cloned().unwrap_or_default();
    let observation = url
        .split_once("://")
        .is_some_and(|(scheme, _)| {
            scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https")
        })
        .then(CallObservation::start);
    let request_start = Instant::now();
    let response = HTTP_AGENT.get(url).call();
    let request_elapsed = request_start.elapsed();
    metrics.record_request_to_response_headers(request_elapsed);
    if let Some(observation) = observation {
        observation.finish(request_elapsed, response.is_ok());
    }
    let response = response.map_err(|e| DownloadError::new(classify_http_error(&e)))?;
    if response.status().is_client_error() || response.status().is_server_error() {
        return Err(crate::http_failure::from_response(url, response));
    }
    let body = response.into_body();
    let content_length = body.content_length();
    Ok(ArchiveSource::http(
        body.into_reader(),
        content_length,
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

pub(crate) struct LocalArchive {
    pub(crate) file: File,
    pub(crate) compressed_bytes: Option<u64>,
}

impl LocalArchive {
    pub(crate) fn open(path: &str) -> Result<Self, DownloadError> {
        log_info!(LOG_TAG, "Reading local archive");
        let file = File::open(path)
            .map_err(|e| DownloadError::new(format!("Failed to open local archive: {e}")))?;
        let compressed_bytes = file
            .metadata()
            .ok()
            .filter(|metadata| metadata.is_file())
            .map(|metadata| metadata.len());
        Ok(Self {
            file,
            compressed_bytes,
        })
    }

    pub(crate) fn into_source(
        self,
        metrics: Option<&LocalArchiveAttemptMetrics>,
    ) -> ArchiveSource<'static> {
        match metrics {
            Some(metrics) => ArchiveSource::local(
                measure_local_body(self.file, metrics),
                self.compressed_bytes,
            ),
            None => ArchiveSource::local(self.file, self.compressed_bytes),
        }
    }
}

pub(crate) enum ArchiveReader<'input> {
    Stream(Box<dyn Read + 'input>),
    Inline(&'input [u8]),
}

impl Read for ArchiveReader<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        match self {
            Self::Stream(reader) => reader.read(buffer),
            Self::Inline(bytes) => bytes.read(buffer),
        }
    }
}

pub(crate) struct ArchiveSource<'input> {
    reader: ArchiveReader<'input>,
    http_body_read_failure: HttpBodyReadFailure,
    compressed_bytes: Option<u64>,
}

impl<'input> ArchiveSource<'input> {
    pub(crate) fn local(reader: impl Read + 'input, compressed_bytes: Option<u64>) -> Self {
        Self {
            reader: ArchiveReader::Stream(Box::new(reader)),
            http_body_read_failure: HttpBodyReadFailure::disabled(),
            compressed_bytes,
        }
    }

    pub(crate) fn inline(archive: &'input [u8]) -> Self {
        Self {
            reader: ArchiveReader::Inline(archive),
            http_body_read_failure: HttpBodyReadFailure::disabled(),
            compressed_bytes: Some(archive.len() as u64),
        }
    }

    fn http(
        reader: impl Read + 'static,
        content_length: Option<u64>,
        metrics: RemoteArchiveAttemptMetrics,
    ) -> Self {
        let http_body_read_failure = HttpBodyReadFailure::enabled();
        Self {
            reader: ArchiveReader::Stream(Box::new(HttpBodyReader {
                reader,
                failure: http_body_read_failure.clone(),
                remaining_content_length: content_length,
                metrics,
            })),
            http_body_read_failure,
            compressed_bytes: None,
        }
    }

    pub(crate) fn compressed_bytes(&self) -> Option<u64> {
        self.compressed_bytes
    }

    pub(crate) fn into_parts(self) -> (ArchiveReader<'input>, HttpBodyReadFailure) {
        (self.reader, self.http_body_read_failure)
    }
}

#[derive(Clone, Default)]
pub(crate) struct LocalArchiveAttemptMetrics {
    body_read: Rc<Cell<Duration>>,
}

impl LocalArchiveAttemptMetrics {
    pub(crate) fn body_read(&self) -> Duration {
        self.body_read.get()
    }

    pub(crate) fn record_body_read(&self, elapsed: Duration) {
        self.body_read
            .set(self.body_read.get().saturating_add(elapsed));
    }
}

pub(crate) fn measure_local_body<R: Read>(
    reader: R,
    metrics: &LocalArchiveAttemptMetrics,
) -> impl Read + use<R> {
    LocalBodyReader {
        reader,
        metrics: metrics.clone(),
    }
}

struct LocalBodyReader<R> {
    reader: R,
    metrics: LocalArchiveAttemptMetrics,
}

impl<R: Read> Read for LocalBodyReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let start = Instant::now();
        let result = self.reader.read(buffer);
        self.metrics.record_body_read(start.elapsed());
        result
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

    pub(crate) fn disabled() -> Self {
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
    remaining_content_length: Option<u64>,
    metrics: RemoteArchiveAttemptMetrics,
}

impl<R: Read> Read for HttpBodyReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let start = Instant::now();
        match self.reader.read(buffer) {
            Ok(bytes_read) => {
                self.remaining_content_length = self
                    .remaining_content_length
                    .and_then(|remaining| remaining.checked_sub(bytes_read as u64));
                if bytes_read > 0 && self.remaining_content_length == Some(0) {
                    // The gzip decoder can stop after the final data read. ureq
                    // returns the connection to the pool on its next nonempty read.
                    // A completed fixed-length body needs no more response bytes.
                    self.remaining_content_length = None;
                    let _ = self.reader.read(&mut [0]);
                }
                self.metrics.record_body_read(start.elapsed(), bytes_read);
                Ok(bytes_read)
            }
            Err(e) => {
                self.metrics.record_body_read(start.elapsed(), 0);
                self.failure.mark_failed();
                Err(e)
            }
        }
    }
}

#[cfg(test)]
mod tests;
