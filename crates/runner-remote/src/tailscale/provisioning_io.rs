//! Fixed-origin API IO, with byte and cancellation admission below HTTP prefetch.

use std::{
    io,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::Duration,
};

use bytes::Bytes;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, ReadBuf};
use tokio_util::sync::{CancellationToken, WaitForCancellationFutureOwned};
use ts_http_util::{BytesBody, Client, HeaderValue, Method, Request, ResponseExt};
use zeroize::Zeroizing;

use super::{Failure, control_io::LimitedIo, provisioning_effect::Journal};

const HOST: &str = "api.tailscale.com";
const RAW_BYTES: usize = 1024 * 1024;
const BODY_BYTES: usize = 64 * 1024;

pub(super) trait Dial: Clone + 'static {
    type Io: AsyncRead + AsyncWrite + Unpin + Send + 'static;
    async fn connect(&self) -> Result<Self::Io, Failure>;
}

#[derive(Clone)]
pub(super) struct Https(pub(super) super::resolver::Resolver);

impl Dial for Https {
    type Io = ts_tls_util::TlsStream<LimitedIo<tokio::net::TcpStream>>;

    async fn connect(&self) -> Result<Self::Io, Failure> {
        if !super::diagnostics::in_domain() {
            return Err(Failure::DomainFailed);
        }
        // Resolver blocking descendants originate inside this retained runtime;
        // Runtime Drop joins them before the physical owner releases capacity.
        let io = self.0.connect(HOST, 443).await?;
        Self::authenticate(io, &super::registration::VerifiedTls).await
    }
}

impl Https {
    /// Keep the fixed certificate name and raw handshake cap in the shared
    /// production composition. Fixtures replace only the external authority.
    pub(super) async fn authenticate<Io>(
        io: Io,
        tls: &impl super::registration::Tls,
    ) -> Result<ts_tls_util::TlsStream<LimitedIo<Io>>, Failure>
    where
        Io: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        if !super::diagnostics::in_domain() {
            return Err(Failure::DomainFailed);
        }
        let name = ts_tls_util::ServerName::try_from(HOST).map_err(|_| Failure::DomainFailed)?;
        let (io, _) = LimitedIo::new(io, RAW_BYTES);
        tls.connect(name, io)
            .await
            .map_err(|_| Failure::DomainFailed)
    }
}

pub(super) struct Api<D> {
    dial: D,
}

pub(super) struct Admission {
    pub(super) cancelled: Option<CancellationToken>,
    pub(super) creation: Option<Arc<Journal>>,
}

impl<D: Dial> Api<D> {
    pub(super) fn new(dial: D) -> Self {
        Self { dial }
    }

    /// Every operation has one fresh owned connection. No independent SDK dial,
    /// redirects, retries, environment proxies or caller-selected API origins.
    pub(super) async fn request(
        &self,
        method: Method,
        path: &str,
        content_type: &'static str,
        body: Vec<u8>,
        authorization: Option<HeaderValue>,
        admission: Admission,
    ) -> Result<Zeroizing<Vec<u8>>, Failure> {
        if !super::diagnostics::in_domain()
            || !path.starts_with("/api/v2/")
            || path.len() > 1024
            || body.len() > BODY_BYTES
        {
            return Err(Failure::DomainFailed);
        }
        let operation = async {
            let io = self.dial.connect().await?;
            let (io, _) = LimitedIo::new(io, RAW_BYTES);
            let io = AdmittedIo::new(io, admission.cancelled, admission.creation);
            let client = ts_http_util::http1::connect::<BytesBody>(io)
                .await
                .map_err(|_| Failure::DomainFailed)?;
            let mut request = Request::builder()
                .method(method)
                .uri(format!("https://{HOST}{path}"))
                .header("Host", HOST)
                .header("Connection", "close")
                .header("Content-Type", content_type)
                .body(Bytes::from(body).into())
                .map_err(|_| Failure::DomainFailed)?;
            if let Some(value) = authorization {
                request.headers_mut().insert("Authorization", value);
            }
            let response = client
                .send(request)
                .await
                .map_err(|_| Failure::DomainFailed)?;
            // All API operations in the first-party key contract use HTTP 200.
            // Redirects/non-success bodies never become follow-up destinations.
            if response.status() != ts_http_util::StatusCode::OK {
                return Err(Failure::DomainFailed);
            }
            collect_secret(response.into_read()).await
        };
        tokio::time::timeout(Duration::from_secs(10), operation)
            .await
            .unwrap_or(Err(Failure::DomainFailed))
    }
}

async fn collect_secret(mut input: impl AsyncRead + Unpin) -> Result<Zeroizing<Vec<u8>>, Failure> {
    let mut body = Zeroizing::new(Vec::with_capacity(BODY_BYTES));
    let mut chunk = Zeroizing::new([0; 4096]);
    loop {
        let count = chunk.len().min(BODY_BYTES - body.len() + 1);
        let count = input
            .read(chunk.get_mut(..count).ok_or(Failure::DomainFailed)?)
            .await
            .map_err(|_| Failure::DomainFailed)?;
        if count == 0 {
            return Ok(body);
        }
        if count > BODY_BYTES - body.len() {
            return Err(Failure::DomainFailed);
        }
        body.extend_from_slice(chunk.get(..count).ok_or(Failure::DomainFailed)?);
    }
}

struct AdmittedIo<Io> {
    io: Io,
    cancellation: Option<Pin<Box<WaitForCancellationFutureOwned>>>,
    creation: Option<Arc<Journal>>,
}

impl<Io> AdmittedIo<Io> {
    fn new(io: Io, cancelled: Option<CancellationToken>, creation: Option<Arc<Journal>>) -> Self {
        Self {
            io,
            cancellation: cancelled.map(|token| Box::pin(token.cancelled_owned())),
            creation,
        }
    }

    fn admitted(&mut self, cx: &mut Context<'_>) -> io::Result<()> {
        if self
            .cancellation
            .as_mut()
            .is_some_and(|cancelled| cancelled.as_mut().poll(cx).is_ready())
        {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "native provider cancelled",
            ));
        }
        Ok(())
    }
}

impl<Io: AsyncRead + Unpin> AsyncRead for AdmittedIo<Io> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        out: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        self.admitted(cx)?;
        Pin::new(&mut self.io).poll_read(cx, out)
    }
}

impl<Io: AsyncWrite + Unpin> AsyncWrite for AdmittedIo<Io> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        self.admitted(cx)?;
        if !bytes.is_empty()
            && let Some(journal) = self.creation.take()
        {
            journal
                .creating()
                .map_err(|_| io::Error::other("native provider effect sealed"))?;
        }
        Pin::new(&mut self.io).poll_write(cx, bytes)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.admitted(cx)?;
        Pin::new(&mut self.io).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.admitted(cx)?;
        Pin::new(&mut self.io).poll_shutdown(cx)
    }
}

/// Encode form fields and captured key IDs, never an origin or whole endpoint.
pub(super) fn encoded(value: &str) -> String {
    let mut result = String::with_capacity(value.len() * 3);
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            result.push(char::from(byte));
        } else {
            result.push('%');
            for nibble in [byte >> 4, byte & 15] {
                result.push(char::from(if nibble < 10 {
                    b'0' + nibble
                } else {
                    b'A' + nibble - 10
                }));
            }
        }
    }
    result
}
