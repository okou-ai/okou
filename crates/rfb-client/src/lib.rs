//! Verified RFB 3.8 / VeNCrypt 0.2 X509 authentication, bounded captures and serialized input.
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
    /// Negotiating the required VeNCrypt 0.2 X509 security profile.
    SecurityNegotiation,
    /// Establishing the certificate-verified TLS transport.
    TlsHandshake,
    /// Completing the X509None SecurityResult exchange.
    X509NoneAuthentication,
    /// Completing the VNC password challenge and SecurityResult exchange.
    VncAuthentication,
    /// Sending X509Plain credentials and completing the SecurityResult exchange.
    X509PlainAuthentication,
}

impl AuthenticationStage {
    /// Stable non-secret label for structured local diagnostics.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::RfbVersion => "rfb_version",
            Self::SecurityNegotiation => "security_negotiation",
            Self::TlsHandshake => "tls_handshake",
            Self::X509NoneAuthentication => "x509_none_authentication",
            Self::VncAuthentication => "vnc_authentication",
            Self::X509PlainAuthentication => "x509_plain_authentication",
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
        Self::new_zeroizing(Zeroizing::new(password))
    }

    /// Validate a password whose allocation is already zeroizing, transferring
    /// that allocation without making another plaintext copy.
    pub fn new_zeroizing(mut password: Zeroizing<String>) -> Result<Self, Error> {
        let bytes = Zeroizing::new(std::mem::take(&mut *password).into_bytes());
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

/// Validated VeNCrypt Plain credentials. Both fields retain their exact UTF-8
/// bytes, are redacted from Debug output and are erased when dropped.
pub struct PlainCredentials {
    username: Zeroizing<Vec<u8>>,
    password: Zeroizing<Vec<u8>>,
}

impl PlainCredentials {
    /// Accept non-empty UTF-8 values below TigerVNC's 1024-byte field limit.
    /// Embedded NUL bytes are rejected because common servers use C strings.
    /// Spaces are significant; no truncation or normalization is performed.
    pub fn new(username: String, password: String) -> Result<Self, Error> {
        Self::new_zeroizing(username, Zeroizing::new(password))
    }

    /// Validate credentials whose password allocation is already zeroizing,
    /// transferring it without making another plaintext copy.
    pub fn new_zeroizing(username: String, mut password: Zeroizing<String>) -> Result<Self, Error> {
        let username = Zeroizing::new(username.into_bytes());
        let password = Zeroizing::new(std::mem::take(&mut *password).into_bytes());
        if !(1..=1023).contains(&username.len()) || username.contains(&0) {
            return Err(Error::InvalidPlainUsername);
        }
        if !(1..=1023).contains(&password.len()) || password.contains(&0) {
            return Err(Error::InvalidPlainPassword);
        }
        Ok(Self { username, password })
    }
}

impl fmt::Debug for PlainCredentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PlainCredentials([REDACTED])")
    }
}

/// Exact certificate-TLS VeNCrypt authentication selected by the caller.
///
/// `None` verifies the server and encrypts the session, but does not
/// authenticate the VNC client. This engine capability is not itself a policy
/// decision to expose that profile to users.
pub enum X509Authentication {
    /// X509None (subtype 260), with no inner client authentication.
    None,
    /// X509Vnc (subtype 261), with the classic VNC password challenge.
    VncPassword(VncPassword),
    /// X509Plain (subtype 262), with a username and password sent inside TLS.
    Plain(PlainCredentials),
}

impl X509Authentication {
    const fn subtype(&self) -> u32 {
        match self {
            Self::None => 260,
            Self::VncPassword(_) => 261,
            Self::Plain(_) => 262,
        }
    }

    const fn stage(&self) -> AuthenticationStage {
        match self {
            Self::None => AuthenticationStage::X509NoneAuthentication,
            Self::VncPassword(_) => AuthenticationStage::VncAuthentication,
            Self::Plain(_) => AuthenticationStage::X509PlainAuthentication,
        }
    }
}

impl fmt::Debug for X509Authentication {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::None => f.write_str("X509Authentication::None"),
            Self::VncPassword(_) => f.write_str("X509Authentication::VncPassword([REDACTED])"),
            Self::Plain(_) => f.write_str("X509Authentication::Plain([REDACTED])"),
        }
    }
}

/// An authenticated connection, positioned immediately after SecurityResult.
/// It retains no client credentials. Dropping it drops the underlying owned stream.
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

/// Authenticate an owned stream using one exact certificate-TLS VeNCrypt profile.
///
/// `server_name` is the saved DNS name or unbracketed IP used for certificate
/// verification, independent of the already selected socket address. TLS always
/// verifies chain, validity and identity before releasing reusable credentials.
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
    authentication: X509Authentication,
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
    let final_stage = authentication.stage();
    let authenticated =
        authentication::authenticate(stream, server_name, authentication, roots, deadline).await?;
    // Keep this API-boundary check even though each phase checks after success.
    // Never transfer a connection whose authentication deadline already passed.
    if deadline <= Instant::now() {
        return Err(Error::AuthenticationDeadlineExceeded { stage: final_stage });
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
    #[error("Plain username must contain 1-1023 UTF-8 bytes without NUL")]
    InvalidPlainUsername,
    #[error("Plain password must contain 1-1023 UTF-8 bytes without NUL")]
    InvalidPlainPassword,
    #[error("invalid TLS server name")]
    InvalidServerName,
    #[error("custom trust requires 1-8 valid DER certificates totaling at most 64 KiB")]
    InvalidTrustRoots,
    #[error("unsupported RFB version; RFB 3.8 is required")]
    UnsupportedRfbVersion,
    #[error("server does not offer the required VeNCrypt X509 profile")]
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
