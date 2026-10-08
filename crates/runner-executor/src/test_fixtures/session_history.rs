use std::io;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{Notify, oneshot};
use tokio::task::JoinHandle;

const RAW_HTTP_FIXTURE_TIMEOUT: Duration = Duration::from_secs(5);

pub struct OneShotSessionHistoryServer {
    url: String,
    task: Option<JoinHandle<io::Result<()>>>,
}

#[derive(Clone, Copy)]
enum ResponseBodyEncoding {
    Raw,
    Chunked,
}

struct SessionHistoryFixtureResponse {
    status: String,
    body: Vec<u8>,
    content_length: Option<u64>,
    headers: Vec<(&'static str, &'static str)>,
    body_encoding: ResponseBodyEncoding,
    request_received: Option<oneshot::Sender<()>>,
    release_response: Option<Arc<Notify>>,
}

impl OneShotSessionHistoryServer {
    pub async fn respond_once(
        status: impl Into<String>,
        body: impl Into<Vec<u8>> + Send + 'static,
        content_length: Option<u64>,
    ) -> Self {
        Self::spawn(SessionHistoryFixtureResponse {
            status: status.into(),
            body: body.into(),
            content_length,
            headers: Vec::new(),
            body_encoding: ResponseBodyEncoding::Raw,
            request_received: None,
            release_response: None,
        })
        .await
    }

    pub async fn respond_once_with_headers(
        status: impl Into<String>,
        body: impl Into<Vec<u8>> + Send + 'static,
        content_length: Option<u64>,
        headers: Vec<(&'static str, &'static str)>,
    ) -> Self {
        Self::spawn(SessionHistoryFixtureResponse {
            status: status.into(),
            body: body.into(),
            content_length,
            headers,
            body_encoding: ResponseBodyEncoding::Raw,
            request_received: None,
            release_response: None,
        })
        .await
    }

    pub async fn respond_once_chunked(
        status: impl Into<String>,
        body: impl Into<Vec<u8>> + Send + 'static,
    ) -> Self {
        Self::spawn(SessionHistoryFixtureResponse {
            status: status.into(),
            body: body.into(),
            content_length: None,
            headers: vec![("Transfer-Encoding", "chunked")],
            body_encoding: ResponseBodyEncoding::Chunked,
            request_received: None,
            release_response: None,
        })
        .await
    }

    pub async fn respond_once_after_request(
        body: impl Into<Vec<u8>> + Send + 'static,
        request_received: oneshot::Sender<()>,
        release_response: Arc<Notify>,
    ) -> Self {
        let body = body.into();
        let content_length = Some(body.len() as u64);
        Self::spawn(SessionHistoryFixtureResponse {
            status: "200 OK".to_string(),
            body,
            content_length,
            headers: Vec::new(),
            body_encoding: ResponseBodyEncoding::Raw,
            request_received: Some(request_received),
            release_response: Some(release_response),
        })
        .await
    }

    pub fn url(&self) -> String {
        self.url.clone()
    }

    pub async fn assert_served(mut self) {
        let mut task = self
            .task
            .take()
            .expect("session history fixture task should be present");
        match tokio::time::timeout(RAW_HTTP_FIXTURE_TIMEOUT, &mut task).await {
            Ok(result) => {
                result
                    .expect("session history fixture server task should not panic")
                    .expect("session history fixture server should not fail");
            }
            Err(_) => {
                task.abort();
                let _ = task.await;
                panic!("session history fixture server should finish");
            }
        }
    }

    async fn spawn(response: SessionHistoryFixtureResponse) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(serve_session_history_once(listener, response));

        Self {
            url: format!("http://{address}/history.blob?token=secret"),
            task: Some(task),
        }
    }
}

impl Drop for OneShotSessionHistoryServer {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

async fn serve_session_history_once(
    listener: TcpListener,
    response: SessionHistoryFixtureResponse,
) -> io::Result<()> {
    let (mut stream, _) = listener.accept().await?;
    let mut request = [0u8; 1024];
    let request_bytes = stream.read(&mut request).await?;
    if request_bytes == 0 {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "session history fixture received an empty request",
        ));
    }

    if let Some(request_received) = response.request_received {
        let _ = request_received.send(());
    }
    if let Some(release_response) = response.release_response {
        release_response.notified().await;
    }

    let content_length_header = response
        .content_length
        .map(|content_length| format!("Content-Length: {content_length}\r\n"))
        .unwrap_or_default();
    let extra_headers = response
        .headers
        .into_iter()
        .map(|(name, value)| format!("{name}: {value}\r\n"))
        .collect::<String>();
    let response_head = format!(
        "HTTP/1.1 {}\r\n{content_length_header}{extra_headers}Connection: close\r\n\r\n",
        response.status
    );
    stream.write_all(response_head.as_bytes()).await?;
    match response.body_encoding {
        ResponseBodyEncoding::Raw => {
            stream.write_all(&response.body).await?;
        }
        ResponseBodyEncoding::Chunked => {
            let chunk_header = format!("{:x}\r\n", response.body.len());
            stream.write_all(chunk_header.as_bytes()).await?;
            stream.write_all(&response.body).await?;
            stream.write_all(b"\r\n0\r\n\r\n").await?;
        }
    }
    Ok(())
}
