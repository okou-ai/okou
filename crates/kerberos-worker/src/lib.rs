//! A private bounded MIT initiator, never a network connection or saved profile.
//!
//! Native credentials live in one readonly filesystem / MEMORY-cache process.
//! The caller retains exact current authority and KDC transport. No native
//! destination, ambient source, fallback or uncertain-send retry is admitted.
//! Cancellation retains the actual process slot until kill, wait and cleanup.
#![forbid(unsafe_code)]

mod supervisor;

use std::{fmt, future::Future, path::Path, sync::Arc, time::Duration};

use kerberos_credentials::{ClientKeytab, Principal, ServiceTicketCache};
use tokio::time::Instant;
use zeroize::Zeroizing;

pub use supervisor::{Context, NativePackage, native_package};

/// Redistribution notices for the pinned native MIT/musl/Zig dependency closure.
/// Referenced by sealed package validation so a linked consumer retains the notices.
/// A future product release must still verify its actual distribution artifacts.
pub const NATIVE_NOTICES: &str = concat!(
    include_str!("../native/NOTICE-MIT"),
    "\n",
    include_str!("../native/NOTICE-musl"),
    "\n",
    include_str!("../native/NOTICE-Zig")
);

/// Static, non-secret failure categories; native errors/paths/causes are not exposed.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum Error {
    #[error("invalid Kerberos input")]
    Invalid,
    #[error("native Kerberos is unavailable")]
    Unavailable,
    #[error("Kerberos credential or KDC policy was rejected")]
    CredentialRejected,
    #[error("Kerberos identity mismatch")]
    IdentityMismatch,
    #[error("Kerberos authentication expired")]
    Expired,
    #[error("current Kerberos authority refused")]
    Authority,
    #[error("caller KDC transport unavailable")]
    KdcUnavailable,
    #[error("KDC delivery is unknown; do not replay")]
    DeliveryUnknown,
    #[error("private Kerberos protocol refused")]
    Protocol,
    #[error("ticket is not renewable")]
    NonRenewable,
    #[error("ticket renewal lifetime exhausted")]
    RenewalExhausted,
    #[error("Kerberos deadline exceeded")]
    Deadline,
    #[error("Kerberos worker capacity exceeded")]
    Capacity,
    #[error("Kerberos process cleanup could not be confirmed")]
    CleanupUnknown,
}

/// Long-term password bytes; no truncation, normalization, Clone or byte Debug.
pub struct Password(Zeroizing<String>);
impl Password {
    /// Caller must bound allocation before constructing owned input.
    pub fn new(value: Zeroizing<String>) -> Result<Self, Error> {
        if !(1..=1023).contains(&value.len()) || value.as_bytes().contains(&0) {
            return Err(Error::Invalid);
        }
        Ok(Self(value))
    }
}
impl fmt::Debug for Password {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Password([REDACTED])")
    }
}

/// Distinct sources, not fallback levels. Uploaded paths/exported handles are absent.
pub enum Source {
    /// K1 canonical selected-service-only cache; no KDC/renewal is possible.
    Ticket(ServiceTicketCache),
    /// Explicit online same-source password acquisition/renewal.
    Password(Password),
    /// Explicit online same-source K1 canonical AES keytab acquisition/renewal.
    Keytab(ClientKeytab),
}
impl fmt::Debug for Source {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Source([REDACTED])")
    }
}

/// Bound explicit identities and owned source. Native validation checks them again.
pub struct Credentials {
    initiator: Principal,
    target: Principal,
    source: Source,
}
impl Credentials {
    /// Exact saved realm, solely for the caller's independent route check.
    pub fn realm(&self) -> &str {
        self.initiator.realm()
    }
    /// Source classification only; never grants product authority or network access.
    pub fn is_online(&self) -> bool {
        !matches!(self.source, Source::Ticket(_))
    }
    pub fn new(initiator: Principal, target: Principal, source: Source) -> Result<Self, Error> {
        if initiator.realm() != target.realm()
            || target.components().len() != 2
            || !target
                .components()
                .first()
                .is_some_and(|part| part == "vnc")
        {
            return Err(Error::Invalid);
        }
        Ok(Self {
            initiator,
            target,
            source,
        })
    }
}
impl fmt::Debug for Credentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Credentials([REDACTED])")
    }
}

/// Requested online ticket policy. This cannot extend an existing GSS/RFB session.
#[derive(Clone, Copy, Debug)]
pub struct TicketPolicy {
    lifetime: u32,
    renewable_lifetime: u32,
}
impl TicketPolicy {
    pub fn new(lifetime: Duration, renewable_lifetime: Duration) -> Result<Self, Error> {
        if lifetime.is_zero()
            || lifetime > Duration::from_secs(7200)
            || renewable_lifetime > Duration::from_secs(7200)
            || lifetime.subsec_nanos() != 0
            || renewable_lifetime.subsec_nanos() != 0
        {
            return Err(Error::Invalid);
        }
        Ok(Self {
            lifetime: u32::try_from(lifetime.as_secs()).map_err(|_| Error::Invalid)?,
            renewable_lifetime: u32::try_from(renewable_lifetime.as_secs())
                .map_err(|_| Error::Invalid)?,
        })
    }
}

/// Independent caller-owned KDC authority/transport, not the VNC or SSH route.
///
/// Recheck current authority at actual connect/send boundaries inside exchange.
/// Implementations must return DeliveryUnknown for uncertain delivery and must not
/// replay it. The worker supplies only the expected realm and bounded message,
/// never a destination/route. Offline mode never calls exchange.
pub trait KdcExchange {
    /// Retain caller root/capacity until the actual helper is reaped and its tree removed.
    fn work_owner(&self) -> Option<Arc<dyn WorkOwner>> {
        None
    }
    fn authorize(&mut self) -> impl Future<Output = Result<(), Error>>;
    fn exchange(
        &mut self,
        realm: &str,
        request: &[u8],
    ) -> impl Future<Output = Result<Zeroizing<Vec<u8>>, Error>>;
}

/// Opaque resource custody only; never a credential or authority handle.
pub trait WorkOwner: Send + Sync {}
impl<T: Send + Sync> WorkOwner for T {}

/// Engine/fixture-only no-network policy. Product callers must supply real authority.
pub struct NoKdc;
impl KdcExchange for NoKdc {
    async fn authorize(&mut self) -> Result<(), Error> {
        Ok(())
    }
    async fn exchange(&mut self, _: &str, _: &[u8]) -> Result<Zeroizing<Vec<u8>>, Error> {
        Err(Error::Authority)
    }
}

/// Metadata only: neither a cryptographically authenticated ticket endtime nor revocation.
#[derive(Clone, Copy, Debug)]
pub struct TicketStatus {
    pub expires_at: Instant,
    pub renewable: bool,
    pub declared_renew_till: u32,
}

/// Owned native step token; Debug is redacted and bytes are zeroized on drop.
pub struct Step {
    pub complete: bool,
    pub expires_at: Instant,
    pub token: Option<Zeroizing<Vec<u8>>>,
}
impl fmt::Debug for Step {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Step([REDACTED])")
    }
}

/// Start a private context. Root must be trusted, nonsymlinked, private and owned.
///
/// The absolute deadline is clamped to 30 seconds, including queue/bootstrap/KDC
/// and all subsequent native operations. Idle expiry is driven by the supervisor.
/// No helper path or native library override is a runtime input.
pub async fn open<K: KdcExchange>(
    root: &Path,
    credentials: Credentials,
    policy: TicketPolicy,
    deadline: Instant,
    caller: &mut K,
) -> Result<(Context, TicketStatus), Error> {
    let deadline = deadline.min(Instant::now() + Duration::from_secs(30));
    before_deadline(deadline, Error::Deadline, async {
        caller.authorize().await?;
        let mut context =
            supervisor::start_owned(root, credentials, policy, deadline, caller.work_owner())
                .await?;
        let status = context.initialize(caller).await?;
        Ok((context, status))
    })
    .await
}

/// Secret-free actual helper bootstrap and confirmed teardown, before product KMS.
/// This public marker is never initialized or sent as a credential/KDC request.
/// The ordinary caller's UID/kernel policy must support the unchanged containment.
pub async fn probe(root: &Path, deadline: Instant) -> Result<(), Error> {
    probe_owned(root, deadline, None).await
}

/// The same probe with opaque caller resource custody on bootstrap cancellation.
pub async fn probe_owned(
    root: &Path,
    deadline: Instant,
    owner: Option<Arc<dyn WorkOwner>>,
) -> Result<(), Error> {
    native_package()?;
    let initiator = Principal::new("KERBEROS-PROBE.INVALID".into(), vec!["probe".into()])
        .map_err(|_| Error::Invalid)?;
    let target = Principal::new(
        "KERBEROS-PROBE.INVALID".into(),
        vec!["vnc".into(), "probe".into()],
    )
    .map_err(|_| Error::Invalid)?;
    let credentials = Credentials::new(
        initiator,
        target,
        Source::Password(Password::new(Zeroizing::new(
            "public-bootstrap-marker".into(),
        ))?),
    )?;
    let policy = TicketPolicy::new(Duration::from_secs(1), Duration::ZERO)?;
    before_deadline(deadline, Error::Deadline, async {
        let context = supervisor::start_owned(root, credentials, policy, deadline, owner).await?;
        context.close().await
    })
    .await
}

// timeout_at polls its future before its timer. Bound the entire owned operation
// before EVERY poll so a pending caller/queue/bootstrap gate cannot resume and
// perform IO at expiry, even when the final result would subsequently refuse it.
pub(crate) async fn before_deadline<T>(
    deadline: Instant,
    expiry_error: Error,
    future: impl Future<Output = Result<T, Error>>,
) -> Result<T, Error> {
    if deadline <= Instant::now() {
        return Err(expiry_error);
    }
    let mut future = std::pin::pin!(future);
    let guarded = std::future::poll_fn(|cx| {
        if deadline <= Instant::now() {
            return std::task::Poll::Ready(Err(expiry_error));
        }
        future.as_mut().poll(cx)
    });
    let value = tokio::time::timeout_at(deadline, guarded)
        .await
        .map_err(|_| expiry_error)??;
    if deadline <= Instant::now() {
        return Err(expiry_error);
    }
    Ok(value)
}
