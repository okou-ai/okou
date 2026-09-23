use std::io;
use std::net::SocketAddr;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

const RAW_HTTP_FIXTURE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_REQUEST_HEADER_BYTES: usize = 64 * 1024;
const MAX_REQUEST_BODY_BYTES: usize = 1024 * 1024;

pub(crate) enum RawHttpAction {
    Respond(Vec<u8>),
    WaitForDisconnect,
    WaitThenRespond {
        release: oneshot::Receiver<()>,
        response: Vec<u8>,
    },
}

pub(crate) struct RawHttpTestServer {
    address: SocketAddr,
    requests: mpsc::Receiver<String>,
    task: Option<JoinHandle<io::Result<()>>>,
}

impl RawHttpTestServer {
    pub(crate) async fn spawn(actions: Vec<RawHttpAction>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (request_tx, requests) = mpsc::channel(actions.len().max(1));
        let task = tokio::spawn(serve(listener, actions, request_tx));

        Self {
            address,
            requests,
            task: Some(task),
        }
    }

    pub(crate) fn url(&self) -> String {
        format!("http://{}", self.address)
    }

    pub(crate) async fn next_request(&mut self, description: &str) -> String {
        let deadline = tokio::time::Instant::now() + RAW_HTTP_FIXTURE_TIMEOUT;
        self.next_request_before(deadline, description)
            .await
            .unwrap_or_else(|error| panic!("{error}"))
    }

    pub(crate) fn try_next_request(&mut self) -> Result<String, mpsc::error::TryRecvError> {
        self.requests.try_recv()
    }

    pub(crate) async fn next_request_before(
        &mut self,
        deadline: tokio::time::Instant,
        description: &str,
    ) -> Result<String, String> {
        match tokio::time::timeout_at(deadline, self.requests.recv()).await {
            Ok(Some(request)) => Ok(request),
            Ok(None) => Err(format!(
                "raw HTTP request channel closed before {description}"
            )),
            Err(_) => Err(format!("timed out waiting for {description}")),
        }
    }

    pub(crate) async fn assert_finished(mut self) {
        if let Err(error) = self.finish_with_timeout(RAW_HTTP_FIXTURE_TIMEOUT).await {
            panic!("raw HTTP fixture should finish: {error}");
        }
    }

    pub(crate) async fn assert_finished_with_requests(mut self) -> Vec<String> {
        if let Err(error) = self.finish_with_timeout(RAW_HTTP_FIXTURE_TIMEOUT).await {
            panic!("raw HTTP fixture should finish: {error}");
        }
        let mut requests = Vec::new();
        while let Some(request) = self.requests.recv().await {
            requests.push(request);
        }
        requests
    }

    async fn finish_with_timeout(&mut self, timeout: Duration) -> Result<(), String> {
        let task = self
            .task
            .take()
            .expect("raw HTTP fixture task should be present");
        finish_task_with_timeout(task, timeout)
            .await?
            .map_err(|error| format!("server failed: {error}"))
    }
}

impl Drop for RawHttpTestServer {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

pub(crate) async fn read_http_request(socket: &mut TcpStream) -> io::Result<String> {
    read_http_request_with_timeout(socket, RAW_HTTP_FIXTURE_TIMEOUT).await
}

pub(crate) async fn join_raw_http_task<T>(task: JoinHandle<T>, description: &str) -> T {
    finish_task_with_timeout(task, RAW_HTTP_FIXTURE_TIMEOUT)
        .await
        .unwrap_or_else(|error| panic!("{description} should finish: {error}"))
}

async fn finish_task_with_timeout<T>(
    mut task: JoinHandle<T>,
    timeout: Duration,
) -> Result<T, String> {
    match tokio::time::timeout(timeout, &mut task).await {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(error)) if error.is_cancelled() => Err("server task was cancelled".to_string()),
        Ok(Err(error)) => Err(format!("server task failed: {error}")),
        Err(_) => {
            task.abort();
            match tokio::time::timeout(RAW_HTTP_FIXTURE_TIMEOUT, task).await {
                Ok(Err(error)) if error.is_cancelled() => {
                    Err("timed out; task reaped after abort".to_string())
                }
                Ok(Ok(_)) => Err("timed out; task completed while reaping after abort".to_string()),
                Ok(Err(error)) => Err(format!(
                    "timed out; task cleanup failed while reaping after abort: {error}"
                )),
                Err(_) => Err("timed out reaping task after abort".to_string()),
            }
        }
    }
}

async fn read_http_request_with_timeout(
    socket: &mut TcpStream,
    timeout: Duration,
) -> io::Result<String> {
    tokio::time::timeout(timeout, read_http_request_inner(socket))
        .await
        .map_err(|_| {
            io::Error::new(
                io::ErrorKind::TimedOut,
                "timed out reading raw HTTP request",
            )
        })?
}

async fn read_http_request_inner(socket: &mut TcpStream) -> io::Result<String> {
    let mut request = Vec::new();
    let mut buffer = [0_u8; 1024];
    let header_end = loop {
        let read = socket.read(&mut buffer).await?;
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "connection closed before HTTP headers completed",
            ));
        }
        request.extend_from_slice(&buffer[..read]);
        if let Some(header_end) = request
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .map(|position| position + 4)
        {
            if header_end > MAX_REQUEST_HEADER_BYTES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "HTTP request headers exceed fixture limit",
                ));
            }
            break header_end;
        }
        if request.len() >= MAX_REQUEST_HEADER_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "HTTP request headers exceed fixture limit",
            ));
        }
    };

    let headers = std::str::from_utf8(&request[..header_end]).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("HTTP request headers are not UTF-8: {error}"),
        )
    })?;
    let body_len = content_length(headers)?;
    if body_len > MAX_REQUEST_BODY_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "HTTP request body exceeds fixture limit",
        ));
    }
    let request_len = header_end.checked_add(body_len).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "HTTP request length exceeds fixture limit",
        )
    })?;

    while request.len() < request_len {
        let remaining = request_len - request.len();
        let read_len = remaining.min(buffer.len());
        let read = socket.read(&mut buffer[..read_len]).await?;
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "connection closed before HTTP body completed",
            ));
        }
        request.extend_from_slice(&buffer[..read]);
    }
    request.truncate(request_len);

    String::from_utf8(request).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("HTTP request is not UTF-8: {error}"),
        )
    })
}

pub(crate) fn http_response(status: &str, body: &[u8]) -> Vec<u8> {
    response(status, None, body)
}

pub(crate) fn json_response(status: &str, body: &str) -> Vec<u8> {
    response(status, Some("application/json"), body.as_bytes())
}

fn content_length(headers: &str) -> io::Result<usize> {
    let mut content_length = None;
    for line in headers.lines() {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.eq_ignore_ascii_case("content-length") {
            let value = value.trim();
            if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "invalid HTTP Content-Length: expected decimal digits",
                ));
            }
            let parsed = value.parse::<usize>().map_err(|error| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("invalid HTTP Content-Length: {error}"),
                )
            })?;
            if content_length.replace(parsed).is_some() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "duplicate HTTP Content-Length header",
                ));
            }
        }
    }
    Ok(content_length.unwrap_or(0))
}

fn response(status: &str, content_type: Option<&str>, body: &[u8]) -> Vec<u8> {
    let content_type = content_type
        .map(|value| format!("Content-Type: {value}\r\n"))
        .unwrap_or_default();
    let mut response = format!(
        "HTTP/1.1 {status}\r\n{content_type}Content-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    response.extend_from_slice(body);
    response
}

async fn serve(
    listener: TcpListener,
    actions: Vec<RawHttpAction>,
    request_tx: mpsc::Sender<String>,
) -> io::Result<()> {
    for (index, action) in actions.into_iter().enumerate() {
        let (mut socket, _) = listener.accept().await?;
        let request = read_http_request(&mut socket).await.map_err(|error| {
            if error.kind() == io::ErrorKind::TimedOut {
                fixture_timeout(index, "reading request")
            } else {
                error
            }
        })?;
        request_tx.send(request).await.map_err(|_| {
            io::Error::new(
                io::ErrorKind::BrokenPipe,
                format!("raw HTTP request receiver closed for action {}", index + 1),
            )
        })?;

        match action {
            RawHttpAction::Respond(response) => {
                write_response(index, &mut socket, &response).await?;
            }
            RawHttpAction::WaitForDisconnect => {
                let mut byte = [0];
                let read = tokio::time::timeout(RAW_HTTP_FIXTURE_TIMEOUT, socket.read(&mut byte))
                    .await
                    .map_err(|_| fixture_timeout(index, "waiting for client disconnect"))??;
                if read != 0 {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "expected client disconnect without another request",
                    ));
                }
            }
            RawHttpAction::WaitThenRespond { release, response } => {
                release.await.map_err(|_| {
                    io::Error::new(
                        io::ErrorKind::BrokenPipe,
                        format!("raw HTTP response release dropped for action {}", index + 1),
                    )
                })?;
                write_response(index, &mut socket, &response).await?;
            }
        }
    }
    Ok(())
}

async fn write_response(index: usize, socket: &mut TcpStream, response: &[u8]) -> io::Result<()> {
    tokio::time::timeout(RAW_HTTP_FIXTURE_TIMEOUT, socket.write_all(response))
        .await
        .map_err(|_| fixture_timeout(index, "writing response"))??;
    Ok(())
}

fn fixture_timeout(index: usize, stage: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::TimedOut,
        format!("timed out {stage} for raw HTTP action {}", index + 1),
    )
}
