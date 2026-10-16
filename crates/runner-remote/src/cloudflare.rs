//! Bounded Cloudflare Access byte transport. Consumers retain destination authority.

#[cfg(test)]
mod tests;

use bytes::Bytes;
use futures_util::{Sink, Stream};
use rustls::{ClientConfig, pki_types::ServerName};
use std::{
    io,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    task::{Context, Poll, ready},
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, ReadBuf};
use tokio_rustls::TlsConnector;
use tokio_tungstenite::{
    WebSocketStream,
    tungstenite::{
        self, Message, client::IntoClientRequest, http::HeaderValue, protocol::WebSocketConfig,
    },
};

const HANDSHAKE_BYTES: u64 = 32 * 1024;
const MESSAGE_BYTES: usize = 1024 * 1024;
// cloudflared's origin reader can discard bytes beyond its 16 KiB buffer.
// Split writes into separate messages bounded by that buffer.
const WRITE_BYTES: usize = 16 * 1024;

pub(crate) trait ByteIo: AsyncRead + AsyncWrite + Send + Unpin {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin> ByteIo for T {}

/// Deliberately has no Debug implementation: service-token values are private.
pub(crate) struct Configuration<'a> {
    host: &'a str,
    client_id: &'a str,
    client_secret: &'a str,
}

impl<'a> Configuration<'a> {
    pub(crate) fn new(
        host: &'a str,
        port: u64,
        client_id: &'a str,
        client_secret: &'a str,
    ) -> Option<Self> {
        if port != 443
            || host.parse::<std::net::IpAddr>().is_ok()
            || host.len() > 253
            || host.split('.').any(|label| {
                label.is_empty()
                    || label.len() > 63
                    || label.starts_with('-')
                    || label.ends_with('-')
                    || !label
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            })
            || !valid_header(client_id)
            || !valid_header(client_secret)
        {
            return None;
        }
        Some(Self {
            host,
            client_id,
            client_secret,
        })
    }
}

#[derive(Clone, Copy, Debug, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Failure {
    Tls,
    Protocol,
    Rejected,
    Network,
}

fn valid_header(value: &str) -> bool {
    !value.is_empty() && value.len() <= 4096 && value.bytes().all(|b| (0x21..=0x7e).contains(&b))
}

pub(crate) async fn connect<S: ByteIo>(
    stream: S,
    configuration: Configuration<'_>,
    tls: Arc<ClientConfig>,
    trace: &crate::diagnostics::trace::Trace,
) -> Result<(impl ByteIo + use<S>, Arc<AtomicBool>), Failure> {
    use crate::diagnostics::trace::{Progress, Stage};
    trace.set(Stage::AccessTls, Progress::Running);
    let host = configuration.host;
    let server_name = ServerName::try_from(host.to_owned()).map_err(|_| Failure::Tls)?;
    let stream = TlsConnector::from(tls)
        .connect(server_name, stream)
        .await
        .map_err(|_| {
            trace.set(Stage::AccessTls, Progress::Failed);
            trace.access_failure(Failure::Tls);
            Failure::Tls
        })?;
    trace.set(Stage::AccessTls, Progress::Passed);
    trace.set(Stage::AccessWebsocket, Progress::Running);
    // The caller already opened one policy-validated IP. This function never resolves,
    // follows redirects, consults proxy variables or sends to a different recipient.
    let mut request = format!("wss://{host}/")
        .into_client_request()
        .map_err(|_| Failure::Protocol)?;
    for (name, secret) in [
        ("CF-Access-Client-Id", configuration.client_id),
        ("CF-Access-Client-Secret", configuration.client_secret),
    ] {
        let mut value = HeaderValue::from_str(secret).map_err(|_| Failure::Protocol)?;
        value.set_sensitive(true);
        request.headers_mut().insert(name, value);
    }
    let config = WebSocketConfig::default()
        .read_buffer_size(16 * 1024)
        .write_buffer_size(0)
        .max_write_buffer_size(64 * 1024)
        .max_message_size(Some(MESSAGE_BYTES))
        .max_frame_size(Some(MESSAGE_BYTES));
    // Bound the entire HTTP upgrade, including a reflected rejection body read-ahead.
    // Release only this read limit after the library verifies the 101 handshake.
    let (mut websocket, response) = tokio_tungstenite::client_async_with_config(
        request,
        UpgradeIo(stream.take(HANDSHAKE_BYTES)),
        Some(config),
    )
    .await
    .map_err(|error| {
        trace.set(Stage::AccessWebsocket, Progress::Failed);
        let failure = match error {
            tungstenite::Error::Http(response)
                if matches!(response.status().as_u16(), 401 | 403) =>
            {
                Failure::Rejected
            }
            tungstenite::Error::Http(response)
                if response.status().is_server_error() || response.status().as_u16() == 429 =>
            {
                Failure::Network
            }
            tungstenite::Error::Io(error) if error.kind() != io::ErrorKind::UnexpectedEof => {
                Failure::Network
            }
            _ => Failure::Protocol,
        };
        trace.access_failure(failure);
        failure
    })?;
    // Tungstenite 0.30 does not reject unsolicited extensions itself.
    if response.headers().contains_key("sec-websocket-extensions") {
        trace.set(Stage::AccessWebsocket, Progress::Failed);
        trace.access_failure(Failure::Protocol);
        return Err(Failure::Protocol);
    }
    websocket.get_mut().0.set_limit(u64::MAX);
    let failed = Arc::new(AtomicBool::new(false));
    trace.set(Stage::AccessWebsocket, Progress::Passed);
    let mut stream = ByteStream::new(websocket, Arc::clone(&failed));
    stream.trace = trace.clone();
    Ok((stream, failed))
}

/// Tokio's read limiter deliberately has no AsyncWrite implementation.
struct UpgradeIo<S>(tokio::io::Take<S>);

impl<S: AsyncRead + Unpin> AsyncRead for UpgradeIo<S> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().0).poll_read(cx, buf)
    }
}
impl<S: AsyncRead + AsyncWrite + Unpin> AsyncWrite for UpgradeIo<S> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(self.get_mut().0.get_mut()).poll_write(cx, bytes)
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(self.get_mut().0.get_mut()).poll_flush(cx)
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(self.get_mut().0.get_mut()).poll_shutdown(cx)
    }
}

/// No pump tasks or unbounded queues: one bounded incoming message plus the
/// library's explicitly bounded write buffer. The caller retains IO/capacity ownership.
pub(crate) struct ByteStream<S> {
    trace: crate::diagnostics::trace::Trace,
    websocket: WebSocketStream<S>,
    pending: Bytes,
    flush_control: bool,
    closed: bool,
    failed: Arc<AtomicBool>,
}

impl<S: AsyncRead + AsyncWrite + Unpin> ByteStream<S> {
    pub(crate) fn new(websocket: WebSocketStream<S>, failed: Arc<AtomicBool>) -> Self {
        Self {
            trace: crate::diagnostics::trace::Trace::default(),
            websocket,
            pending: Bytes::new(),
            flush_control: false,
            closed: false,
            failed,
        }
    }

    fn error(&self, error: tungstenite::Error) -> io::Error {
        self.trace.set(
            crate::diagnostics::trace::Stage::AccessWebsocket,
            crate::diagnostics::trace::Progress::Failed,
        );
        self.trace.access_failure(
            if matches!(
                &error,
                tungstenite::Error::Protocol(_)
                    | tungstenite::Error::Capacity(_)
                    | tungstenite::Error::Utf8(_)
            ) {
                Failure::Protocol
            } else {
                Failure::Network
            },
        );
        if matches!(
            error,
            tungstenite::Error::Protocol(_)
                | tungstenite::Error::Capacity(_)
                | tungstenite::Error::Utf8(_)
        ) {
            self.failed.store(true, Ordering::Release);
        }
        // Never attach library diagnostics: rejected responses can reflect secrets.
        io::Error::other("Cloudflare Access carrier failed")
    }

    fn flush(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match Pin::new(&mut self.websocket).poll_flush(cx) {
            Poll::Ready(Ok(())) => {
                self.flush_control = false;
                Poll::Ready(Ok(()))
            }
            Poll::Ready(Err(tungstenite::Error::ConnectionClosed)) if self.closed => {
                Poll::Ready(Ok(()))
            }
            Poll::Ready(Err(error)) => Poll::Ready(Err(self.error(error))),
            Poll::Pending => Poll::Pending,
        }
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncRead for ByteStream<S> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if buf.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        // Limit empty/control frames processed in one poll so hostile peers cannot
        // monopolize the executor and starve Run cancellation.
        for _ in 0..16 {
            if this.flush_control {
                // Continue polling reads even under write backpressure. The pending
                // flush retains its write waker; it must not prevent incoming data.
                if let Poll::Ready(Err(error)) = this.flush(cx) {
                    return Poll::Ready(Err(error));
                }
            }
            if !this.pending.is_empty() {
                let size = buf.remaining().min(this.pending.len());
                buf.put_slice(&this.pending.split_to(size));
                return Poll::Ready(Ok(()));
            }
            if this.closed {
                return Poll::Ready(Ok(()));
            }
            match ready!(Pin::new(&mut this.websocket).poll_next(cx)) {
                Some(Ok(Message::Binary(bytes))) => this.pending = bytes,
                Some(Ok(Message::Ping(_))) => this.flush_control = true,
                Some(Ok(Message::Pong(_))) => (),
                Some(Ok(Message::Close(_))) => {
                    this.trace.set(
                        crate::diagnostics::trace::Stage::AccessWebsocket,
                        crate::diagnostics::trace::Progress::Failed,
                    );
                    this.trace.access_failure(Failure::Network);
                    this.closed = true;
                    this.flush_control = true;
                }
                Some(Ok(_)) => {
                    this.trace.set(
                        crate::diagnostics::trace::Stage::AccessWebsocket,
                        crate::diagnostics::trace::Progress::Failed,
                    );
                    this.trace.access_failure(Failure::Protocol);
                    this.failed.store(true, Ordering::Release);
                    return Poll::Ready(Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "Cloudflare Access requires binary frames",
                    )));
                }
                Some(Err(error)) => return Poll::Ready(Err(this.error(error))),
                None => {
                    this.trace.set(
                        crate::diagnostics::trace::Stage::AccessWebsocket,
                        crate::diagnostics::trace::Progress::Failed,
                    );
                    this.trace.access_failure(Failure::Network);
                    this.closed = true;
                    return Poll::Ready(Ok(()));
                }
            }
        }
        cx.waker().wake_by_ref();
        Poll::Pending
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncWrite for ByteStream<S> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        if bytes.is_empty() {
            return Poll::Ready(Ok(0));
        }
        if this.closed {
            return Poll::Ready(Err(io::ErrorKind::BrokenPipe.into()));
        }
        if let Err(error) = ready!(Pin::new(&mut this.websocket).poll_ready(cx)) {
            return Poll::Ready(Err(this.error(error)));
        }
        let size = bytes.len().min(WRITE_BYTES);
        if let Err(error) = Pin::new(&mut this.websocket).start_send(Message::Binary(
            Bytes::copy_from_slice(bytes.split_at(size).0),
        )) {
            return Poll::Ready(Err(this.error(error)));
        }
        Poll::Ready(Ok(size))
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.get_mut().flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        match Pin::new(&mut this.websocket).poll_close(cx) {
            Poll::Ready(Ok(())) => {
                this.closed = true;
                Poll::Ready(Ok(()))
            }
            Poll::Ready(Err(error)) => Poll::Ready(Err(this.error(error))),
            Poll::Pending => Poll::Pending,
        }
    }
}
