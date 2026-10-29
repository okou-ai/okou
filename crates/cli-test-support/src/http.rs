//! Real loopback HTTP recording and explicit response gates.

use std::sync::{
    Arc, Mutex, MutexGuard,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecordedRequest {
    pub path: String,
    pub authorization: Option<String>,
    pub content_type: Option<String>,
    pub client_request_id: Option<String>,
    pub body: String,
}

pub fn event_request_sequences(request: &RecordedRequest) -> Result<Vec<u32>, String> {
    use serde_json::value::RawValue;
    use std::collections::BTreeMap;

    #[derive(serde::Deserialize)]
    struct EventRequest<'a> {
        #[serde(borrow)]
        events: Vec<BTreeMap<String, &'a RawValue>>,
    }

    // Serde structs also accept positional arrays; this HTTP boundary requires
    // an object. Acknowledgement observation needs only sequence metadata, not
    // owned multi-MiB contents. Callers still assert complete parsed payloads.
    if !request.body.trim_start().starts_with('{') {
        return Err("event request omitted events array".into());
    }
    let body: EventRequest<'_> = serde_json::from_str(&request.body)
        .map_err(|error| format!("parse event request body: {error}"))?;
    body.events
        .into_iter()
        .map(|event| {
            let invalid = || "event omitted a u32 sequenceNumber".to_string();
            let sequence = event.get("sequenceNumber").ok_or_else(invalid)?;
            serde_json::from_str(sequence.get()).map_err(|_| invalid())
        })
        .collect()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RecordedHttpEvent {
    Request(RecordedRequest),
    Response { path: String, status: u16 },
}

pub struct RecordingServer {
    pub base_url: String,
    events: Arc<Mutex<Vec<RecordedHttpEvent>>>,
    handle: tokio::task::JoinHandle<()>,
}

impl RecordingServer {
    pub async fn start(ably_status: u16, ably_response_delay: Duration) -> Result<Self, String> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| format!("bind recording server: {e}"))?;
        let addr = listener
            .local_addr()
            .map_err(|e| format!("recording server local_addr: {e}"))?;
        let events = Arc::new(Mutex::new(Vec::new()));
        let task_events = Arc::clone(&events);
        let handle = tokio::spawn(async move {
            while let Ok((mut socket, _peer)) = listener.accept().await {
                let connection_events = Arc::clone(&task_events);
                tokio::spawn(async move {
                    let Ok(request) = read_http_request(&mut socket).await else {
                        let _ = write_http_response(&mut socket, 400).await;
                        return;
                    };
                    let status = if request.path.starts_with("/channels/") {
                        ably_status
                    } else {
                        200
                    };
                    let path = request.path.clone();
                    push_recorded_event(&connection_events, RecordedHttpEvent::Request(request));
                    if path.starts_with("/channels/") && !ably_response_delay.is_zero() {
                        tokio::time::sleep(ably_response_delay).await;
                    }
                    let _ = write_http_response(&mut socket, status).await;
                    push_recorded_event(
                        &connection_events,
                        RecordedHttpEvent::Response { path, status },
                    );
                });
            }
        });

        Ok(Self {
            base_url: format!("http://{addr}"),
            events,
            handle,
        })
    }

    fn lock_events(&self) -> Result<MutexGuard<'_, Vec<RecordedHttpEvent>>, String> {
        self.events
            .lock()
            .map_err(|_| "recording server event mutex poisoned".to_string())
    }

    pub fn events(&self) -> Result<Vec<RecordedHttpEvent>, String> {
        self.lock_events().map(|events| events.clone())
    }

    pub fn requests(&self) -> Result<Vec<RecordedRequest>, String> {
        Ok(self
            .events()?
            .into_iter()
            .filter_map(|event| match event {
                RecordedHttpEvent::Request(request) => Some(request),
                RecordedHttpEvent::Response { .. } => None,
            })
            .collect())
    }
}

impl Drop for RecordingServer {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

pub struct ControlledRequest {
    pub request: RecordedRequest,
    response: oneshot::Sender<u16>,
}

impl ControlledRequest {
    pub fn respond(self, status: u16) -> Result<(), String> {
        self.response
            .send(status)
            .map_err(|_| "controlled HTTP request closed before response".to_string())
    }
}

pub struct ControlledHttpServer {
    pub base_url: String,
    requests: Arc<AtomicUsize>,
    completed_responses: Arc<AtomicUsize>,
    recorded_requests: Arc<Mutex<Vec<RecordedRequest>>>,
    request_rx: mpsc::UnboundedReceiver<ControlledRequest>,
    handle: tokio::task::JoinHandle<()>,
}

impl ControlledHttpServer {
    pub async fn start() -> Result<Self, String> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|error| format!("bind controlled HTTP server: {error}"))?;
        let addr = listener
            .local_addr()
            .map_err(|error| format!("controlled HTTP server local_addr: {error}"))?;
        let requests = Arc::new(AtomicUsize::new(0));
        let task_requests = Arc::clone(&requests);
        let completed_responses = Arc::new(AtomicUsize::new(0));
        let task_completed_responses = Arc::clone(&completed_responses);
        let recorded_requests = Arc::new(Mutex::new(Vec::new()));
        let task_recorded_requests = Arc::clone(&recorded_requests);
        let (request_tx, request_rx) = mpsc::unbounded_channel();
        let handle = tokio::spawn(async move {
            while let Ok((mut socket, _peer)) = listener.accept().await {
                let connection_tx = request_tx.clone();
                let connection_requests = Arc::clone(&task_requests);
                let connection_completed_responses = Arc::clone(&task_completed_responses);
                let connection_recorded_requests = Arc::clone(&task_recorded_requests);
                tokio::spawn(async move {
                    let Ok(request) = read_http_request(&mut socket).await else {
                        let _ = write_http_response(&mut socket, 400).await;
                        return;
                    };
                    connection_requests.fetch_add(1, Ordering::SeqCst);
                    if let Ok(mut requests) = connection_recorded_requests.lock() {
                        requests.push(request.clone());
                    }
                    let (response, response_rx) = oneshot::channel();
                    if connection_tx
                        .send(ControlledRequest { request, response })
                        .is_err()
                    {
                        return;
                    }
                    let Ok(status) = response_rx.await else {
                        return;
                    };
                    let _ = write_http_response(&mut socket, status).await;
                    connection_completed_responses.fetch_add(1, Ordering::SeqCst);
                });
            }
        });

        Ok(Self {
            base_url: format!("http://{addr}"),
            requests,
            completed_responses,
            recorded_requests,
            request_rx,
            handle,
        })
    }

    pub async fn next_request(&mut self, timeout: Duration) -> Result<ControlledRequest, String> {
        tokio::time::timeout(timeout, self.request_rx.recv())
            .await
            .map_err(|_| format!("controlled HTTP server received no request within {timeout:?}"))?
            .ok_or_else(|| "controlled HTTP server stopped accepting requests".to_string())
    }

    pub fn request_count(&self) -> usize {
        self.requests.load(Ordering::SeqCst)
    }

    pub fn completed_response_count(&self) -> usize {
        self.completed_responses.load(Ordering::SeqCst)
    }

    pub fn requests(&self) -> Result<Vec<RecordedRequest>, String> {
        self.recorded_requests
            .lock()
            .map(|requests| requests.clone())
            .map_err(|_| "controlled HTTP request mutex poisoned".to_string())
    }
}

impl Drop for ControlledHttpServer {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

async fn read_http_request(socket: &mut tokio::net::TcpStream) -> Result<RecordedRequest, String> {
    let mut buffer = Vec::new();
    let header_end = loop {
        if let Some(index) = find_subsequence(&buffer, b"\r\n\r\n") {
            break index;
        }
        let mut chunk = [0u8; 1024];
        let read = socket
            .read(&mut chunk)
            .await
            .map_err(|e| format!("read request: {e}"))?;
        if read == 0 {
            return Err("connection closed before request headers".to_string());
        }
        buffer.extend_from_slice(
            chunk
                .get(..read)
                .ok_or_else(|| "read chunk length out of bounds".to_string())?,
        );
    };

    let header_bytes = buffer
        .get(..header_end)
        .ok_or_else(|| "request header range out of bounds".to_string())?;
    let headers = std::str::from_utf8(header_bytes)
        .map_err(|e| format!("request headers are not UTF-8: {e}"))?;
    let (request_line, header_lines) = headers
        .split_once("\r\n")
        .map_or((headers, ""), |(line, rest)| (line, rest));
    let path = request_line
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| format!("invalid request line: {request_line:?}"))?
        .to_string();

    let mut authorization = None;
    let mut content_type = None;
    let mut client_request_id = None;
    let mut content_length = 0usize;
    for line in header_lines.lines() {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let trimmed_name = name.trim();
        let trimmed_value = value.trim();
        if trimmed_name.eq_ignore_ascii_case("authorization") {
            authorization = Some(trimmed_value.to_string());
        }
        if trimmed_name.eq_ignore_ascii_case("content-type") {
            content_type = Some(trimmed_value.to_string());
        }
        if trimmed_name.eq_ignore_ascii_case("x-client-request-id") {
            client_request_id = Some(trimmed_value.to_string());
        }
        if trimmed_name.eq_ignore_ascii_case("content-length") {
            content_length = trimmed_value
                .parse()
                .map_err(|e| format!("invalid content-length {trimmed_value:?}: {e}"))?;
        }
    }

    let body_start = header_end
        .checked_add(4)
        .ok_or_else(|| "request header length overflow".to_string())?;
    let body_end = body_start
        .checked_add(content_length)
        .ok_or_else(|| "request body length overflow".to_string())?;
    buffer.truncate(body_end);
    buffer.drain(..body_start);
    if buffer.len() < content_length {
        socket
            .take((content_length - buffer.len()) as u64)
            .read_to_end(&mut buffer)
            .await
            .map_err(|e| format!("read request body: {e}"))?;
        if buffer.len() < content_length {
            return Err("connection closed before request body".to_string());
        }
    }
    let body = match String::from_utf8(buffer) {
        Ok(body) => body,
        Err(error) => String::from_utf8_lossy(error.as_bytes()).into_owned(),
    };

    Ok(RecordedRequest {
        path,
        authorization,
        content_type,
        client_request_id,
        body,
    })
}

async fn write_http_response(
    socket: &mut tokio::net::TcpStream,
    status: u16,
) -> Result<(), String> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        500 => "Internal Server Error",
        _ => "OK",
    };
    let response =
        format!("HTTP/1.1 {status} {reason}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
    socket
        .write_all(response.as_bytes())
        .await
        .map_err(|e| format!("write response: {e}"))
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn push_recorded_event(events: &Arc<Mutex<Vec<RecordedHttpEvent>>>, event: RecordedHttpEvent) {
    if let Ok(mut events) = events.lock() {
        events.push(event);
    }
}
