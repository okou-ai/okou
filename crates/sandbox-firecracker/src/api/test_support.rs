use std::collections::VecDeque;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinSet;
use tokio_util::task::AbortOnDropHandle;

pub(crate) const MOCK_REQUEST_READ_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_MOCK_REQUEST_HEADER_BYTES: usize = 16 * 1024;
const MAX_MOCK_REQUEST_BODY_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug)]
pub(crate) struct MockRequest {
    pub(crate) raw: String,
    pub(crate) method: String,
    pub(crate) path: String,
    pub(crate) body: String,
}

#[derive(Clone, Debug)]
pub(crate) struct MockResponse {
    pub(crate) status: u16,
    pub(crate) reason: &'static str,
    pub(crate) body: String,
}

impl MockResponse {
    pub(crate) fn ok() -> Self {
        Self::new(200, "OK", "")
    }

    pub(crate) fn ok_body(body: impl Into<String>) -> Self {
        Self::new(200, "OK", body)
    }

    pub(crate) fn no_content() -> Self {
        Self::new(204, "No Content", "")
    }

    pub(crate) fn bad_request_fault(message: &str) -> Self {
        Self::new(
            400,
            "Bad Request",
            serde_json::json!({ "fault_message": message }).to_string(),
        )
    }

    pub(crate) fn internal_error_raw(body: impl Into<String>) -> Self {
        Self::new(500, "Internal Server Error", body)
    }

    pub(crate) fn new(status: u16, reason: &'static str, body: impl Into<String>) -> Self {
        Self {
            status,
            reason,
            body: body.into(),
        }
    }

    pub(crate) fn to_http(&self) -> String {
        format!(
            "HTTP/1.1 {} {}\r\nContent-Length: {}\r\n\r\n{}",
            self.status,
            self.reason,
            self.body.len(),
            self.body
        )
    }
}

enum MockResponseMode {
    Queue(VecDeque<MockResponse>),
    Repeat(MockResponse),
}

impl MockResponseMode {
    fn next_response(&mut self) -> MockResponse {
        match self {
            Self::Queue(responses) => responses.pop_front().unwrap_or_else(|| {
                MockResponse::internal_error_raw("unexpected extra Firecracker API request")
            }),
            Self::Repeat(response) => response.clone(),
        }
    }
}

pub(crate) struct MockFirecrackerApi {
    // Request abort before releasing the socket directory and request receiver.
    _server: AbortOnDropHandle<()>,
    _dir: tempfile::TempDir,
    sock_path: PathBuf,
    requests: mpsc::UnboundedReceiver<MockRequest>,
}

impl MockFirecrackerApi {
    pub(crate) fn with_responses(responses: impl IntoIterator<Item = MockResponse>) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let sock_path = dir.path().join("fc.sock");
        let listener = UnixListener::bind(&sock_path).unwrap();
        Self::spawn(
            dir,
            sock_path,
            async move { listener },
            MockResponseMode::Queue(responses.into_iter().collect()),
        )
    }

    pub(crate) fn repeating(response: MockResponse) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let sock_path = dir.path().join("fc.sock");
        let listener = UnixListener::bind(&sock_path).unwrap();
        Self::spawn(
            dir,
            sock_path,
            async move { listener },
            MockResponseMode::Repeat(response),
        )
    }

    pub(crate) fn with_handler<H, F>(handler: H) -> Self
    where
        H: Fn(MockRequest) -> F + Send + Sync + 'static,
        F: Future<Output = MockResponse> + Send + 'static,
    {
        let dir = tempfile::tempdir().unwrap();
        let sock_path = dir.path().join("fc.sock");
        let listener = UnixListener::bind(&sock_path).unwrap();
        let (tx, requests) = mpsc::unbounded_channel();
        let server = tokio::spawn(serve_mock_api_with_handler(listener, tx, handler));

        Self {
            _dir: dir,
            sock_path,
            requests,
            _server: AbortOnDropHandle::new(server),
        }
    }

    pub(crate) fn deferred_repeating(response: MockResponse) -> (Self, oneshot::Sender<()>) {
        let dir = tempfile::tempdir().unwrap();
        let sock_path = dir.path().join("deferred.sock");
        let bind_path = sock_path.clone();
        let (bind_tx, bind_rx) = oneshot::channel();
        let (tx, requests) = mpsc::unbounded_channel();
        let server = tokio::spawn(async move {
            if bind_rx.await.is_err() {
                return;
            }

            let listener = UnixListener::bind(&bind_path).unwrap();
            serve_mock_api(listener, MockResponseMode::Repeat(response), tx).await;
        });

        (
            Self {
                _dir: dir,
                sock_path,
                requests,
                _server: AbortOnDropHandle::new(server),
            },
            bind_tx,
        )
    }

    fn spawn(
        dir: tempfile::TempDir,
        sock_path: PathBuf,
        bind: impl std::future::Future<Output = UnixListener> + Send + 'static,
        responses: MockResponseMode,
    ) -> Self {
        let (tx, requests) = mpsc::unbounded_channel();
        let server = tokio::spawn(async move {
            let listener = bind.await;
            serve_mock_api(listener, responses, tx).await;
        });

        Self {
            _dir: dir,
            sock_path,
            requests,
            _server: AbortOnDropHandle::new(server),
        }
    }

    pub(crate) fn socket_path(&self) -> &Path {
        &self.sock_path
    }

    pub(crate) async fn next_request(&mut self) -> MockRequest {
        tokio::time::timeout(MOCK_REQUEST_READ_TIMEOUT, self.requests.recv())
            .await
            .expect("timed out waiting for Firecracker API request")
            .expect("mock Firecracker API server stopped before capturing request")
    }

    /// Drain requests that the mock server has already captured.
    ///
    /// This does not wait for in-flight requests. Use it after the operation
    /// under test has reached a synchronization point, such as after the API
    /// client call returns.
    pub(crate) fn drain_requests(&mut self) -> Vec<MockRequest> {
        let mut requests = Vec::new();
        while let Ok(request) = self.requests.try_recv() {
            requests.push(request);
        }
        requests
    }
}

async fn serve_mock_api(
    listener: UnixListener,
    mut responses: MockResponseMode,
    tx: mpsc::UnboundedSender<MockRequest>,
) {
    loop {
        let Ok((mut stream, _)) = listener.accept().await else {
            break;
        };

        let request = match read_mock_request_with_timeout(&mut stream).await {
            Ok(request) => request,
            Err(response) => {
                let _ = stream.write_all(response.to_http().as_bytes()).await;
                continue;
            }
        };

        if tx.send(request).is_err() {
            break;
        }

        let response = responses.next_response();
        let _ = stream.write_all(response.to_http().as_bytes()).await;
    }
}

async fn serve_mock_api_with_handler<H, F>(
    listener: UnixListener,
    tx: mpsc::UnboundedSender<MockRequest>,
    handler: H,
) where
    H: Fn(MockRequest) -> F + Send + Sync + 'static,
    F: Future<Output = MockResponse> + Send + 'static,
{
    let handler = Arc::new(handler);
    let mut connections = JoinSet::new();

    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else {
                    break;
                };
                let tx = tx.clone();
                let handler = Arc::clone(&handler);
                connections.spawn(async move {
                    serve_mock_handler_connection(stream, tx, handler).await;
                });
            }
            completed = connections.join_next(), if !connections.is_empty() => {
                drop(completed);
            }
        }
    }
}

async fn serve_mock_handler_connection<H, F>(
    mut stream: UnixStream,
    tx: mpsc::UnboundedSender<MockRequest>,
    handler: Arc<H>,
) where
    H: Fn(MockRequest) -> F + Send + Sync + 'static,
    F: Future<Output = MockResponse> + Send + 'static,
{
    let request = match read_mock_request_with_timeout(&mut stream).await {
        Ok(request) => request,
        Err(response) => {
            let _ = stream.write_all(response.to_http().as_bytes()).await;
            return;
        }
    };

    if tx.send(request.clone()).is_err() {
        return;
    }

    let response = handler(request).await;
    let _ = stream.write_all(response.to_http().as_bytes()).await;
}

async fn read_mock_request_with_timeout(
    stream: &mut UnixStream,
) -> Result<MockRequest, MockResponse> {
    match tokio::time::timeout(MOCK_REQUEST_READ_TIMEOUT, read_mock_request(stream)).await {
        Ok(Ok(request)) => Ok(request),
        Ok(Err(error)) => Err(MockResponse::internal_error_raw(format!(
            "read request: {error}"
        ))),
        Err(_) => Err(MockResponse::internal_error_raw("read request timed out")),
    }
}

pub(crate) async fn read_mock_request(stream: &mut UnixStream) -> std::io::Result<MockRequest> {
    let mut buf = Vec::with_capacity(4096);
    loop {
        if header_end(&buf).is_some() {
            break;
        }
        if buf.len() > MAX_MOCK_REQUEST_HEADER_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("request headers too large: {} bytes", buf.len()),
            ));
        }

        let read = stream.read_buf(&mut buf).await?;
        if read == 0 {
            break;
        }
    }

    let header_end = header_end(&buf).ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "request missing HTTP header terminator",
        )
    })?;
    if header_end > MAX_MOCK_REQUEST_HEADER_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("request headers too large: {header_end} bytes"),
        ));
    }
    let headers = String::from_utf8_lossy(&buf[..header_end.saturating_sub(4)]).to_string();
    let content_length = headers
        .lines()
        .find_map(|line| {
            let (key, value) = line.split_once(':')?;
            if key.trim().eq_ignore_ascii_case("content-length") {
                value.trim().parse::<usize>().ok()
            } else {
                None
            }
        })
        .unwrap_or(0);
    if content_length > MAX_MOCK_REQUEST_BODY_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("request body too large: {content_length} bytes"),
        ));
    }

    let already_read = buf.len().saturating_sub(header_end);
    if already_read < content_length {
        let mut tail = vec![0u8; content_length - already_read];
        stream.read_exact(&mut tail).await?;
        buf.extend_from_slice(&tail);
    }

    let body_end = header_end.saturating_add(content_length);
    let body =
        String::from_utf8_lossy(buf.get(header_end..body_end).unwrap_or_default()).to_string();
    let raw = String::from_utf8_lossy(&buf).to_string();
    let first_line = headers.lines().next().unwrap_or_default();
    let mut request_line = first_line.split_whitespace();
    let method = request_line.next().unwrap_or_default().to_string();
    let path = request_line.next().unwrap_or_default().to_string();

    Ok(MockRequest {
        raw,
        method,
        path,
        body,
    })
}

fn header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| index + 4)
}
