use std::{
    pin::Pin,
    task::{Context, Poll},
};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio_rustls::client::TlsStream;

/// Owned post-authentication RFB stream. The selected authentication entry point
/// fixes the variant; there is no TLS-to-raw fallback.
pub struct AuthenticatedStream<S> {
    inner: Inner<S>,
}

enum Inner<S> {
    VerifiedTls(Box<TlsStream<S>>),
    AppleDhRaw(S),
    AppleSrpRaw(S),
}

impl<S> AuthenticatedStream<S> {
    pub(crate) fn verified_tls(stream: TlsStream<S>) -> Self {
        Self {
            inner: Inner::VerifiedTls(Box::new(stream)),
        }
    }

    pub(crate) fn apple_dh_raw(stream: S) -> Self {
        Self {
            inner: Inner::AppleDhRaw(stream),
        }
    }

    pub(crate) fn apple_srp_raw(stream: S) -> Self {
        Self {
            inner: Inner::AppleSrpRaw(stream),
        }
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncRead for AuthenticatedStream<S> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        match &mut self.get_mut().inner {
            Inner::VerifiedTls(stream) => Pin::new(stream.as_mut()).poll_read(cx, buf),
            Inner::AppleDhRaw(stream) => Pin::new(stream).poll_read(cx, buf),
            Inner::AppleSrpRaw(stream) => Pin::new(stream).poll_read(cx, buf),
        }
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncWrite for AuthenticatedStream<S> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        match &mut self.get_mut().inner {
            Inner::VerifiedTls(stream) => Pin::new(stream.as_mut()).poll_write(cx, buf),
            Inner::AppleDhRaw(stream) => Pin::new(stream).poll_write(cx, buf),
            Inner::AppleSrpRaw(stream) => Pin::new(stream).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match &mut self.get_mut().inner {
            Inner::VerifiedTls(stream) => Pin::new(stream.as_mut()).poll_flush(cx),
            Inner::AppleDhRaw(stream) => Pin::new(stream).poll_flush(cx),
            Inner::AppleSrpRaw(stream) => Pin::new(stream).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match &mut self.get_mut().inner {
            Inner::VerifiedTls(stream) => Pin::new(stream.as_mut()).poll_shutdown(cx),
            Inner::AppleDhRaw(stream) => Pin::new(stream).poll_shutdown(cx),
            Inner::AppleSrpRaw(stream) => Pin::new(stream).poll_shutdown(cx),
        }
    }
}
