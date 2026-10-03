use std::{
    future::Future,
    pin::Pin,
    task::{Context, Poll},
};

use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    time::{Instant, Sleep},
};
use tokio_rustls::client::TlsStream;

/// Owned post-authentication RFB stream. The selected authentication entry point
/// fixes the variant; there is no TLS-to-raw fallback.
pub struct AuthenticatedStream<S> {
    inner: Inner<S>,
}

fn expired() -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::TimedOut, "RFB authentication expired")
}

enum Inner<S> {
    VerifiedTls(Box<TlsStream<S>>),
    VerifiedGssapi {
        stream: Box<TlsStream<S>>,
        expires_at: Instant,
        timer: Pin<Box<Sleep>>,
    },
    Expired,
    AppleDhRaw(S),
    AppleVncPasswordRaw(S),
    AppleSrpRaw(S),
    AppleRsaSrpRaw(S),
    RsaAes(Box<crate::rsa_aes::records::Records<S>>),
    RsaAesAuthenticationOnly(S),
}

impl<S> AuthenticatedStream<S> {
    pub(crate) fn verified_gssapi(stream: TlsStream<S>, expires_at: Instant) -> Self {
        Self {
            inner: Inner::VerifiedGssapi {
                stream: Box::new(stream),
                expires_at,
                timer: Box::pin(tokio::time::sleep_until(expires_at)),
            },
        }
    }
    pub(crate) fn authentication_expires_at(&self) -> Option<Instant> {
        match &self.inner {
            Inner::VerifiedGssapi { expires_at, .. } => Some(*expires_at),
            _ => None,
        }
    }
    fn expire(&mut self, cx: &mut Context<'_>) {
        if let Inner::VerifiedGssapi {
            expires_at, timer, ..
        } = &mut self.inner
            && (*expires_at <= Instant::now() || timer.as_mut().poll(cx).is_ready())
        {
            self.inner = Inner::Expired;
        }
    }
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

    pub(crate) fn apple_vnc_password_raw(stream: S) -> Self {
        Self {
            inner: Inner::AppleVncPasswordRaw(stream),
        }
    }

    pub(crate) fn apple_srp_raw(stream: S) -> Self {
        Self {
            inner: Inner::AppleSrpRaw(stream),
        }
    }

    pub(crate) fn apple_rsa_srp_raw(stream: S) -> Self {
        Self {
            inner: Inner::AppleRsaSrpRaw(stream),
        }
    }

    pub(crate) fn rsa_aes(stream: crate::rsa_aes::records::Records<S>) -> Self {
        Self {
            inner: Inner::RsaAes(Box::new(stream)),
        }
    }

    pub(crate) fn rsa_aes_raw(stream: S) -> Self {
        Self {
            inner: Inner::RsaAesAuthenticationOnly(stream),
        }
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncRead for AuthenticatedStream<S> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let this = self.get_mut();
        this.expire(cx);
        match &mut this.inner {
            Inner::VerifiedTls(stream) => Pin::new(stream.as_mut()).poll_read(cx, buf),
            Inner::VerifiedGssapi { stream, .. } => Pin::new(stream.as_mut()).poll_read(cx, buf),
            Inner::Expired => Poll::Ready(Err(expired())),
            Inner::AppleDhRaw(stream) => Pin::new(stream).poll_read(cx, buf),
            Inner::AppleVncPasswordRaw(stream) => Pin::new(stream).poll_read(cx, buf),
            Inner::AppleSrpRaw(stream) => Pin::new(stream).poll_read(cx, buf),
            Inner::AppleRsaSrpRaw(stream) => Pin::new(stream).poll_read(cx, buf),
            Inner::RsaAes(stream) => Pin::new(stream.as_mut()).poll_read(cx, buf),
            Inner::RsaAesAuthenticationOnly(stream) => Pin::new(stream).poll_read(cx, buf),
        }
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncWrite for AuthenticatedStream<S> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        let this = self.get_mut();
        this.expire(cx);
        match &mut this.inner {
            Inner::VerifiedTls(stream) => Pin::new(stream.as_mut()).poll_write(cx, buf),
            Inner::VerifiedGssapi { stream, .. } => Pin::new(stream.as_mut()).poll_write(cx, buf),
            Inner::Expired => Poll::Ready(Err(expired())),
            Inner::AppleDhRaw(stream) => Pin::new(stream).poll_write(cx, buf),
            Inner::AppleVncPasswordRaw(stream) => Pin::new(stream).poll_write(cx, buf),
            Inner::AppleSrpRaw(stream) => Pin::new(stream).poll_write(cx, buf),
            Inner::AppleRsaSrpRaw(stream) => Pin::new(stream).poll_write(cx, buf),
            Inner::RsaAes(stream) => Pin::new(stream.as_mut()).poll_write(cx, buf),
            Inner::RsaAesAuthenticationOnly(stream) => Pin::new(stream).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        let this = self.get_mut();
        this.expire(cx);
        match &mut this.inner {
            Inner::VerifiedTls(stream) => Pin::new(stream.as_mut()).poll_flush(cx),
            Inner::VerifiedGssapi { stream, .. } => Pin::new(stream.as_mut()).poll_flush(cx),
            Inner::Expired => Poll::Ready(Err(expired())),
            Inner::AppleDhRaw(stream) => Pin::new(stream).poll_flush(cx),
            Inner::AppleVncPasswordRaw(stream) => Pin::new(stream).poll_flush(cx),
            Inner::AppleSrpRaw(stream) => Pin::new(stream).poll_flush(cx),
            Inner::AppleRsaSrpRaw(stream) => Pin::new(stream).poll_flush(cx),
            Inner::RsaAes(stream) => Pin::new(stream.as_mut()).poll_flush(cx),
            Inner::RsaAesAuthenticationOnly(stream) => Pin::new(stream).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        let this = self.get_mut();
        this.expire(cx);
        match &mut this.inner {
            Inner::VerifiedTls(stream) => Pin::new(stream.as_mut()).poll_shutdown(cx),
            Inner::VerifiedGssapi { stream, .. } => Pin::new(stream.as_mut()).poll_shutdown(cx),
            Inner::Expired => Poll::Ready(Err(expired())),
            Inner::AppleDhRaw(stream) => Pin::new(stream).poll_shutdown(cx),
            Inner::AppleVncPasswordRaw(stream) => Pin::new(stream).poll_shutdown(cx),
            Inner::AppleSrpRaw(stream) => Pin::new(stream).poll_shutdown(cx),
            Inner::AppleRsaSrpRaw(stream) => Pin::new(stream).poll_shutdown(cx),
            Inner::RsaAes(stream) => Pin::new(stream.as_mut()).poll_shutdown(cx),
            Inner::RsaAesAuthenticationOnly(stream) => Pin::new(stream).poll_shutdown(cx),
        }
    }
}
