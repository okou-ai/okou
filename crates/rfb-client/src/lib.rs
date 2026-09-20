//! Verified RFB 3.8 / VeNCrypt 0.2 / X509Vnc, bounded captures and serialized input.
//!
//! [`authenticate`] consumes an already connected stream. The caller owns
//! destination/authorization policy; this crate never resolves or connects a host.
//! Authentication stops before ClientInit. [`Authenticated::initialize`] adds
//! desktop negotiation with an explicit [`SharingMode`] and owned framebuffer updates.
//! [`Session`] adds immutable PNG captures and balanced keyboard/pointer input.
//! Failure or cancellation drops the stream, with no background tasks.

#![forbid(unsafe_code)]

mod authentication;
mod capture;
mod framebuffer;
mod input;
mod memory;
mod pixels;
mod session;
mod trust;
mod wire;
mod zrle;

#[cfg(test)]
mod tigervnc_tests;

use std::{fmt, io, time::Duration};

use tokio::io::{AsyncRead, AsyncWrite};
use tokio::time::Instant;
use tokio_rustls::client::TlsStream;
use zeroize::Zeroizing;

pub use capture::{Capture, CaptureMetadata};
pub use framebuffer::{Cursor, FramebufferConnection};
pub use input::{Input, InputOutcome, Key, MouseButton, ScrollAxis};
pub use session::{Geometry, Session};
pub use trust::TrustRoots;

/// Maximum lifetime of the complete negotiation, including TLS and authentication.
pub const MAX_HANDSHAKE_DURATION: Duration = Duration::from_secs(30);

/// Per-connection sharing request sent in RFB ClientInit. The server controls
/// whether it accepts the request and which other clients remain connected.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SharingMode {
    /// Request that existing clients remain connected (shared-flag = 1).
    Shared,
    /// Request that existing clients be disconnected (shared-flag = 0).
    /// The server may refuse this connection or override the request; successful
    /// initialization does not prove exclusive control of the desktop.
    Exclusive,
}

/// Bounded local stage active when VNC authentication exceeds its shared deadline.
///
/// A stage locates the client-side protocol responsibility. It does not identify
/// whether a server, firewall, proxy, or another network component caused silence.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AuthenticationStage {
    /// Waiting for or responding to the RFB 3.8 version banner.
    RfbVersion,
    /// Negotiating the required VeNCrypt 0.2 / X509Vnc security profile.
    SecurityNegotiation,
    /// Establishing the certificate-verified TLS transport.
    TlsHandshake,
    /// Completing the VNC password challenge and SecurityResult exchange.
    VncAuthentication,
}

impl AuthenticationStage {
    /// Stable non-secret label for structured local diagnostics.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::RfbVersion => "rfb_version",
            Self::SecurityNegotiation => "security_negotiation",
            Self::TlsHandshake => "tls_handshake",
            Self::VncAuthentication => "vnc_authentication",
        }
    }
}

impl fmt::Display for AuthenticationStage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A validated VNC password. Debug output is redacted and owned bytes are erased
/// when dropped, including on validation failure or cancellation.
pub struct VncPassword(Zeroizing<Vec<u8>>);

impl VncPassword {
    /// Accept 1-8 printable ASCII bytes. Spaces are significant; no truncation or
    /// normalization is performed. Other encodings are outside this profile.
    pub fn new(password: String) -> Result<Self, Error> {
        let bytes = Zeroizing::new(password.into_bytes());
        if !(1..=8).contains(&bytes.len()) || !bytes.iter().all(|b| (0x20..=0x7e).contains(b)) {
            return Err(Error::InvalidPassword);
        }
        Ok(Self(bytes))
    }
}

impl fmt::Debug for VncPassword {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("VncPassword([REDACTED])")
    }
}

/// An authenticated connection, positioned immediately after SecurityResult.
/// It retains no VNC password. Dropping it drops the underlying owned stream.
pub struct Authenticated<S> {
    stream: TlsStream<S>,
}

impl<S> Authenticated<S> {
    /// Transfer ownership of the verified TLS stream to the RFB session engine.
    /// The next client message is ClientInit; ServerInit has not been read.
    pub fn into_stream(self) -> TlsStream<S> {
        self.stream
    }
}

/// Authenticate an owned stream using only the supported secure profile.
///
/// `server_name` is the saved DNS name or unbracketed IP used for certificate
/// verification, independent of the already selected socket address. TLS always
/// verifies chain, validity and identity before responding to the VNC challenge.
///
/// The earlier of `deadline` and 30 seconds from this call bounds all network
/// stages together. [`Error::AuthenticationDeadlineExceeded`] identifies only the
/// bounded local [`AuthenticationStage`] active at expiry, not its infrastructure
/// cause. Dropping the future cancels authentication and drops `stream`; callers
/// must not retain clones of its underlying socket if closure is required. No
/// partial connection can be recovered after failure, and no retry is performed.
pub async fn authenticate<S>(
    stream: S,
    server_name: &str,
    password: VncPassword,
    roots: TrustRoots,
    deadline: Instant,
) -> Result<Authenticated<S>, Error>
where
    S: AsyncRead + AsyncWrite + Unpin + 'static,
{
    let deadline = deadline.min(Instant::now() + MAX_HANDSHAKE_DURATION);
    // Check before polling any I/O: timeout_at may first poll a ready inner future.
    if deadline <= Instant::now() {
        return Err(Error::AuthenticationDeadlineExceeded {
            stage: AuthenticationStage::RfbVersion,
        });
    }
    let authenticated =
        authentication::authenticate(stream, server_name, password, roots, deadline).await?;
    // Keep this API-boundary check even though each phase checks after success.
    // Never transfer a connection whose authentication deadline already passed.
    if deadline <= Instant::now() {
        return Err(Error::AuthenticationDeadlineExceeded {
            stage: AuthenticationStage::VncAuthentication,
        });
    }
    Ok(authenticated)
}

/// Bounded local error categories. Server-provided error text is never retained
/// or included in Display/Debug output.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("RFB session is closed")]
    SessionClosed,
    #[error("invalid or oversized RFB input operation")]
    InvalidInput,
    #[error("screenshot geometry belongs to another session or has changed")]
    StaleGeometry,
    #[error("PNG exceeds the 16 MiB image limit")]
    ImageTooLarge,
    #[error("PNG encoding failed")]
    ImageEncoding,
    #[error("invalid framebuffer dimensions or rectangle")]
    InvalidFramebuffer,
    #[error("invalid server pixel format")]
    InvalidPixelFormat,
    #[error("unsupported framebuffer encoding")]
    UnsupportedEncoding,
    #[error("invalid ZRLE compressed data")]
    InvalidCompressedData,
    #[error("RFB resource limit exceeded")]
    ResourceLimit,
    #[error("a full framebuffer update is required")]
    FullUpdateRequired,
    #[error("unsupported server message")]
    UnsupportedMessage,
    #[error("VNC password must contain 1-8 printable ASCII bytes")]
    InvalidPassword,
    #[error("invalid TLS server name")]
    InvalidServerName,
    #[error("custom trust requires 1-8 valid DER certificates totaling at most 64 KiB")]
    InvalidTrustRoots,
    #[error("unsupported RFB version; RFB 3.8 is required")]
    UnsupportedRfbVersion,
    #[error("server does not offer the required VeNCrypt/X509Vnc profile")]
    UnsupportedSecurity,
    #[error("server rejected security negotiation")]
    NegotiationRejected,
    #[error("server rejected the connection")]
    ServerRejected,
    #[error("VNC authentication failed")]
    AuthenticationFailed,
    #[error("invalid VNC authentication result")]
    InvalidAuthenticationResult,
    #[error("server error text exceeds the 4 KiB limit")]
    RemoteDataTooLarge,
    #[error("RFB authentication deadline exceeded during {stage}")]
    AuthenticationDeadlineExceeded {
        /// Last bounded local authentication stage before expiry.
        stage: AuthenticationStage,
    },
    #[error("RFB operation deadline exceeded")]
    DeadlineExceeded,
    #[error("TLS verification or handshake failed")]
    Tls(#[source] io::Error),
    #[error("RFB transport failed")]
    Io(#[from] io::Error),
    #[error("TLS provider configuration failed")]
    TlsConfiguration(#[source] rustls::Error),
}
