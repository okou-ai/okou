use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant as WallInstant},
};

use rustix::fs::{OFlags, fcntl_getfl, fcntl_setfl};
use sha2::{Digest, Sha256};
use tokio::{
    sync::{OwnedSemaphorePermit, Semaphore, oneshot},
    time::Instant,
};
use zeroize::Zeroizing;

use crate::{Credentials, Error, KdcExchange, Source, Step, TicketPolicy, TicketStatus};

#[cfg(all(test, native_kerberos))]
mod tests;

const MAX_FRAME: usize = 131072;
const PROFILE: &[u8] = b"[libdefaults]\n dns_lookup_kdc = false\n dns_lookup_realm = false\n rdns = false\n canonicalize = false\n kdc_timesync = 0\n default_ccache_name = FILE:/absent\n default_client_keytab_name = FILE:/absent\n default_keytab_name = FILE:/absent\n";
static QUEUE: Semaphore = Semaphore::const_new(16);
static RUNNING: OnceLock<Arc<Semaphore>> = OnceLock::new();

#[cfg(native_kerberos)]
const BINARY: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/native/kerberos-worker"));
#[cfg(native_kerberos)]
const BINARY_DIGEST: &str = env!("KERBEROS_WORKER_SHA256");
#[cfg(native_kerberos)]
const NOTICES_DIGEST: &str = env!("KERBEROS_WORKER_NOTICES_SHA256");
#[cfg(not(native_kerberos))]
const NOTICES_DIGEST: &str = "";
#[cfg(not(native_kerberos))]
const BINARY: &[u8] = &[];
#[cfg(not(native_kerberos))]
const BINARY_DIGEST: &str = "";
#[cfg(native_kerberos)]
const NATIVE_TARGET: &str = env!("KERBEROS_WORKER_TARGET");
#[cfg(not(native_kerberos))]
const NATIVE_TARGET: &str = "";

/// Immutable redistribution bytes from this consumer's sealed build, never an override.
pub struct NativePackage {
    /// Complete static helper ELF.
    pub helper: &'static [u8],
    /// Build-verified helper identity.
    pub helper_sha256: &'static str,
    /// Complete joined MIT/musl/Zig redistribution notices.
    pub notices: &'static str,
    /// Build-verified notice identity.
    pub notices_sha256: &'static str,
    /// Native musl target selected by the build recipe.
    pub target: &'static str,
}

/// Inspect/export the same sealed bytes used by native resource provisioning.
/// Unsupported targets or a broken package refuse before returning any bytes.
pub fn native_package() -> Result<NativePackage, Error> {
    if BINARY.is_empty()
        || BINARY.len() > 16 * 1024 * 1024
        || Sha256::digest(BINARY)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
            != BINARY_DIGEST
        || Sha256::digest(crate::NATIVE_NOTICES.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
            != NOTICES_DIGEST
    {
        return Err(Error::Unavailable);
    }
    Ok(NativePackage {
        helper: BINARY,
        helper_sha256: BINARY_DIGEST,
        notices: crate::NATIVE_NOTICES,
        notices_sha256: NOTICES_DIGEST,
        target: NATIVE_TARGET,
    })
}

struct Request {
    kind: u8,
    payload: Zeroizing<Vec<u8>>,
    reply: oneshot::Sender<Result<Reply, Error>>,
}
struct Reply {
    kind: u8,
    payload: Zeroizing<Vec<u8>>,
}
// Fixed, inode-checked cleanup is owned from the first allocation, including
// partial provisioning and OS thread/exec failures. Never recursively delete a
// pathname: a recreated directory or an unexpected entry is cleanup uncertainty.
struct Directory {
    tree: tempfile::TempDir,
    identity: (u64, u64),
    files: Vec<(&'static str, u64, u64)>,
    cleaned: Arc<AtomicBool>,
    unlinked: bool,
    attempted: bool,
}
impl Directory {
    fn path(&self) -> &Path {
        self.tree.path()
    }
    fn verify(&self) -> Result<(), Error> {
        let metadata = fs::symlink_metadata(self.path()).map_err(|_| Error::CleanupUnknown)?;
        if !metadata.is_dir() || (metadata.dev(), metadata.ino()) != self.identity {
            return Err(Error::CleanupUnknown);
        }
        Ok(())
    }
    fn create_file(&mut self, name: &'static str) -> Result<File, Error> {
        self.verify()?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(self.path().join(name))
            .map_err(|_| Error::Unavailable)?;
        let metadata = file.metadata().map_err(|_| Error::CleanupUnknown)?;
        self.files.push((name, metadata.dev(), metadata.ino()));
        Ok(file)
    }
    fn unlink(&mut self) -> Result<(), Error> {
        self.verify()?;
        for &(name, dev, ino) in &self.files {
            self.verify()?;
            let path = self.path().join(name);
            match fs::symlink_metadata(&path) {
                Ok(metadata)
                    if metadata.is_file() && (metadata.dev(), metadata.ino()) == (dev, ino) =>
                {
                    fs::remove_file(path).map_err(|_| Error::CleanupUnknown)?;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                _ => return Err(Error::CleanupUnknown),
            }
        }
        self.verify()?;
        fs::remove_dir(self.path()).map_err(|_| Error::CleanupUnknown)?;
        self.unlinked = true;
        Ok(())
    }
    fn cleanup(&mut self) -> Result<(), Error> {
        if self.attempted {
            return if self.cleaned.load(Ordering::Acquire) {
                Ok(())
            } else {
                Err(Error::CleanupUnknown)
            };
        }
        self.attempted = true;
        if !self.unlinked {
            self.unlink()?;
        }
        match fs::symlink_metadata(self.path()) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            _ => return Err(Error::CleanupUnknown),
        }
        self.cleaned.store(true, Ordering::Release);
        Ok(())
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = self.cleanup();
    }
}
struct Resources {
    // Rust drops fields in declaration order, including a failed thread spawn:
    // close input descriptors, verify the tree, THEN decide whether to release.
    cache: Option<File>,
    keytab: Option<File>,
    tree: Directory,
    capacity: Capacity,
}
impl Resources {
    fn create(root: &Path, capacity: Capacity) -> Result<Self, Error> {
        let package = native_package()?;
        let metadata = fs::symlink_metadata(root).map_err(|_| Error::Unavailable)?;
        if !metadata.is_dir()
            || metadata.permissions().mode() & 0o7777 != 0o700
            || metadata.uid() != rustix::process::geteuid().as_raw()
            || root.canonicalize().map_err(|_| Error::Unavailable)? != root
        {
            return Err(Error::Unavailable);
        }
        let mut tree = tempfile::Builder::new()
            .prefix("kerberos-")
            .tempdir_in(root)
            .map_err(|_| Error::Unavailable)?;
        capacity.clean.store(false, Ordering::Release);
        // Keep even an early/unwind path from TempDir's unchecked recursive Drop.
        tree.disable_cleanup(true);
        let metadata = fs::symlink_metadata(tree.path()).map_err(|_| Error::CleanupUnknown)?;
        let mut resources = Self {
            cache: None,
            keytab: None,
            tree: Directory {
                tree,
                identity: (metadata.dev(), metadata.ino()),
                files: Vec::with_capacity(4),
                cleaned: capacity.clean.clone(),
                unlinked: false,
                attempted: false,
            },
            capacity,
        };
        fs::set_permissions(resources.tree.path(), fs::Permissions::from_mode(0o700))
            .map_err(|_| Error::Unavailable)?;
        let mut binary = resources.tree.create_file("helper")?;
        binary
            .write_all(package.helper)
            .map_err(|_| Error::Unavailable)?;
        binary
            .set_permissions(fs::Permissions::from_mode(0o700))
            .map_err(|_| Error::Unavailable)?;
        let mut profile = resources.tree.create_file("profile.conf")?;
        profile.write_all(PROFILE).map_err(|_| Error::Unavailable)?;
        resources.cache = Some(resources.tree.create_file("input.cache")?);
        resources.keytab = Some(resources.tree.create_file("input.keytab")?);
        Ok(resources)
    }
    fn provision(&mut self, mode: u8, bytes: &[u8]) -> Result<(), Error> {
        if bytes.len() > 65536 {
            return Err(Error::Invalid);
        }
        // Ready attests private readonly bind mounts holding these exact inodes.
        // Unlink EVERY name before writing any secret, not merely before consumption:
        // parent death during a write must not leave a named cache/keytab orphan.
        self.tree.unlink()?;
        let cache = self.cache.as_mut().ok_or(Error::CleanupUnknown)?;
        let keytab = self.keytab.as_mut().ok_or(Error::CleanupUnknown)?;
        match mode {
            0 => cache.write_all(bytes),
            2 => keytab.write_all(bytes),
            1 if bytes.is_empty() => Ok(()),
            _ => return Err(Error::Invalid),
        }
        .map_err(|_| Error::Unavailable)?;
        cache
            .flush()
            .and_then(|()| keytab.flush())
            .map_err(|_| Error::Unavailable)
    }
    fn cleanup(mut self) -> Result<(), Error> {
        drop(self.cache.take());
        drop(self.keytab.take());
        self.tree.cleanup()
    }
}

// Futures can disappear while waiting for bootstrap, authority or KDC delivery.
// A dropped oneshot alone cannot notify an actor waiting for the NEXT KDC command.
struct AbortOnDrop {
    flag: Arc<AtomicBool>,
    armed: bool,
}
impl AbortOnDrop {
    fn new(flag: Arc<AtomicBool>) -> Self {
        Self { flag, armed: true }
    }
    fn disarm(&mut self) {
        self.armed = false;
    }
}
impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        if self.armed {
            self.flag.store(true, Ordering::Release);
        }
    }
}

struct Capacity {
    permit: Option<OwnedSemaphorePermit>,
    clean: Arc<AtomicBool>,
    reaped: Arc<AtomicBool>,
}
impl Drop for Capacity {
    fn drop(&mut self) {
        if let Some(permit) = self.permit.take() {
            if self.clean.load(Ordering::Acquire) && self.reaped.load(Ordering::Acquire) {
                drop(permit);
            } else {
                std::mem::forget(permit);
            }
        }
    }
}
struct Reaper {
    child: Child,
    resources: Option<Resources>,
    reaped: Arc<AtomicBool>,
    failed_cleanup: bool,
}
impl Reaper {
    fn finish(&mut self) -> Result<(), Error> {
        if self
            .child
            .try_wait()
            .map_err(|_| Error::CleanupUnknown)?
            .is_none()
            && self.child.kill().is_err()
            && self
                .child
                .try_wait()
                .map_err(|_| Error::CleanupUnknown)?
                .is_none()
        {
            return Err(Error::CleanupUnknown);
        }
        self.child.wait().map_err(|_| Error::CleanupUnknown)?;
        // Early setup failure can leave pipes on Child instead of local Io.
        // Close those too, before the resource owner may release capacity.
        drop(self.child.stdin.take());
        drop(self.child.stdout.take());
        drop(self.child.stderr.take());
        self.reaped.store(true, Ordering::Release);
        if let Some(resources) = self.resources.take() {
            self.failed_cleanup = true;
            resources.cleanup()?;
            self.failed_cleanup = false;
        }
        if self.failed_cleanup {
            return Err(Error::CleanupUnknown);
        }
        Ok(())
    }
}
impl Drop for Reaper {
    fn drop(&mut self) {
        let _ = self.finish();
    }
}

/// One actual isolated native process. Not Clone; Debug does not expose source bytes.
pub struct Context {
    sender: mpsc::SyncSender<Request>,
    aborted: Arc<AtomicBool>,
    terminal: Option<oneshot::Receiver<Result<(), Error>>>,
    initialized: Zeroizing<Vec<u8>>,
    realm: String,
    online: bool,
    sequence: u32,
    requests: usize,
    bytes: usize,
    deadline: Instant,
    ticket_expiry: Option<Instant>,
    gss_expiry: Option<Instant>,
    imported_expiry: Option<Instant>,
    operation_started: Instant,
    id: u32,
}
impl std::fmt::Debug for Context {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Context([REDACTED])")
    }
}
impl Drop for Context {
    fn drop(&mut self) {
        self.aborted.store(true, Ordering::Release);
    }
}

fn encode_name(out: &mut Vec<u8>, name: &kerberos_credentials::Principal) -> Result<(), Error> {
    let string = |out: &mut Vec<u8>, value: &str| -> Result<(), Error> {
        out.extend_from_slice(
            &u16::try_from(value.len())
                .map_err(|_| Error::Invalid)?
                .to_be_bytes(),
        );
        out.extend_from_slice(value.as_bytes());
        Ok(())
    };
    string(out, name.realm())?;
    out.push(u8::try_from(name.components().len()).map_err(|_| Error::Invalid)?);
    for part in name.components() {
        string(out, part)?;
    }
    Ok(())
}

pub(crate) async fn start(
    root: &Path,
    credentials: Credentials,
    policy: TicketPolicy,
    deadline: Instant,
) -> Result<Context, Error> {
    let deadline = deadline.min(Instant::now() + Duration::from_secs(30));
    if deadline <= Instant::now() {
        return Err(Error::Deadline);
    }
    let waiting = QUEUE.try_acquire().map_err(|_| Error::Capacity)?;
    let semaphore = RUNNING.get_or_init(|| Arc::new(Semaphore::new(2))).clone();
    let permit = tokio::time::timeout_at(deadline, semaphore.acquire_owned())
        .await
        .map_err(|_| Error::Deadline)?
        .map_err(|_| Error::Unavailable)?;
    drop(waiting);
    let realm = credentials.initiator.realm().to_owned();
    let (mode, file_bytes) = match &credentials.source {
        Source::Ticket(cache) => (0, Zeroizing::new(cache.canonical_bytes().to_vec())),
        Source::Password(_) => (1, Zeroizing::new(Vec::new())),
        Source::Keytab(keytab) => (2, Zeroizing::new(keytab.canonical_bytes().to_vec())),
    };
    let declared = match &credentials.source {
        Source::Ticket(cache) => Some(cache.declared_expires_at()),
        _ => None,
    };
    let mut initialized = Zeroizing::new(Vec::with_capacity(4096));
    initialized.push(mode);
    encode_name(&mut initialized, &credentials.initiator)?;
    encode_name(&mut initialized, &credentials.target)?;
    initialized.extend_from_slice(&policy.lifetime.to_be_bytes());
    initialized.extend_from_slice(&policy.renewable_lifetime.to_be_bytes());
    if let Source::Password(password) = credentials.source {
        initialized.extend_from_slice(
            &u16::try_from(password.0.len())
                .map_err(|_| Error::Invalid)?
                .to_be_bytes(),
        );
        initialized.extend_from_slice(password.0.as_bytes());
    }
    let resources = Resources::create(
        root,
        Capacity {
            permit: Some(permit),
            clean: Arc::new(AtomicBool::new(true)),
            reaped: Arc::new(AtomicBool::new(true)),
        },
    )?;
    // Synchronous fixed-file materialization can consume the remaining budget.
    // Refuse before assigning any native/thread work after that absolute bound.
    if deadline <= Instant::now() {
        return Err(Error::Deadline);
    }
    let (sender, receiver) = mpsc::sync_channel(1);
    let (ready_tx, ready_rx) = oneshot::channel();
    let (terminal_tx, terminal_rx) = oneshot::channel();
    let aborted = Arc::new(AtomicBool::new(false));
    let cancelled = aborted.clone();
    let mut abort = AbortOnDrop::new(aborted.clone());
    thread::Builder::new()
        .name("kerberos-reaper".into())
        .spawn(move || {
            let result = supervise(
                resources,
                (mode, file_bytes),
                receiver,
                ready_tx,
                cancelled,
                deadline.into_std(),
            );
            let _ = terminal_tx.send(result);
        })
        .map_err(|_| Error::Unavailable)?;
    let id = tokio::time::timeout_at(deadline, ready_rx)
        .await
        .map_err(|_| Error::Deadline)?
        .map_err(|_| Error::Unavailable)??;
    let mut ticket_expiry = None;
    if let Some(declared) = declared {
        ticket_expiry = Some(declared_deadline(declared)?);
    }
    let context = Context {
        sender,
        aborted,
        terminal: Some(terminal_rx),
        initialized,
        realm,
        online: mode != 0,
        sequence: 0,
        requests: 0,
        bytes: 0,
        deadline,
        ticket_expiry,
        gss_expiry: None,
        imported_expiry: ticket_expiry,
        operation_started: Instant::now(),
        id,
    };
    abort.disarm();
    Ok(context)
}

impl Context {
    /// Observability for actual-process tests, never a credential identifier.
    pub fn process_id(&self) -> u32 {
        self.id
    }
    async fn raw(&mut self, kind: u8, payload: Zeroizing<Vec<u8>>) -> Result<Reply, Error> {
        if self.aborted.load(Ordering::Acquire) {
            return Err(Error::Unavailable);
        }
        if payload.len() > MAX_FRAME || self.deadline <= Instant::now() {
            return Err(Error::Deadline);
        }
        let (reply, receiver) = oneshot::channel();
        self.sender
            .try_send(Request {
                kind,
                payload,
                reply,
            })
            .map_err(|_| Error::Unavailable)?;
        tokio::time::timeout_at(self.deadline, receiver)
            .await
            .map_err(|_| Error::Deadline)?
            .map_err(|_| Error::Unavailable)?
    }
    async fn command<K: KdcExchange>(
        &mut self,
        kind: u8,
        payload: Zeroizing<Vec<u8>>,
        caller: &mut K,
    ) -> Result<Reply, Error> {
        let mut abort = AbortOnDrop::new(self.aborted.clone());
        let result = crate::before_deadline(self.deadline, Error::Deadline, async {
            caller.authorize().await?;
            self.sequence = self.sequence.checked_add(1).ok_or(Error::Protocol)?;
            self.operation_started = Instant::now();
            let mut reply = self.raw(kind, payload).await?;
            while reply.kind == 32 {
                if !self.online {
                    return Err(Error::Protocol);
                }
                self.requests += 1;
                let prefix: [u8; 2] = reply
                    .payload
                    .get(..2)
                    .ok_or(Error::Protocol)?
                    .try_into()
                    .map_err(|_| Error::Protocol)?;
                let size = usize::from(u16::from_be_bytes(prefix));
                let realm = reply.payload.get(2..2 + size).ok_or(Error::Protocol)?;
                let request = reply.payload.get(2 + size..).ok_or(Error::Protocol)?;
                if realm != self.realm.as_bytes()
                    || !(1..=65536).contains(&request.len())
                    || self.requests > 16
                {
                    return Err(Error::Protocol);
                }
                self.bytes = self
                    .bytes
                    .checked_add(request.len())
                    .ok_or(Error::Protocol)?;
                if self.bytes > 524288 {
                    return Err(Error::Protocol);
                }
                caller.authorize().await?;
                let response = caller.exchange(&self.realm, request).await?;
                self.bytes = self
                    .bytes
                    .checked_add(response.len())
                    .ok_or(Error::Protocol)?;
                if !(1..=65536).contains(&response.len()) || self.bytes > 524288 {
                    return Err(Error::Protocol);
                }
                reply = self.raw(33, response).await?;
            }
            if reply.kind == 255 {
                let code = reply.payload.first().copied().ok_or(Error::Protocol)?;
                if reply.payload.len() != 1 {
                    return Err(Error::Protocol);
                }
                return Err(match code {
                    1 => Error::Invalid,
                    2 => Error::CredentialRejected,
                    3 => Error::IdentityMismatch,
                    4 => Error::Expired,
                    6 => Error::KdcUnavailable,
                    9 => Error::NonRenewable,
                    10 => Error::RenewalExhausted,
                    _ => Error::Protocol,
                });
            }
            Ok(reply)
        })
        .await;
        if result.is_ok() {
            abort.disarm();
        }
        result
    }
    async fn authentication_command<K: KdcExchange>(
        &mut self,
        kind: u8,
        payload: Zeroizing<Vec<u8>>,
        caller: &mut K,
    ) -> Result<Reply, Error> {
        let ticket_expiry = self.ticket_expiry.ok_or(Error::Expired)?;
        let expiry = self
            .gss_expiry
            .map_or(ticket_expiry, |bound| bound.min(ticket_expiry));
        // Source/completed-GSS expiry bounds every resumed authority/native poll,
        // not just entry. Explicit renew/reacquire retain the operation deadline.
        crate::before_deadline(expiry, Error::Expired, self.command(kind, payload, caller)).await
    }
    fn status(&mut self, reply: Reply) -> Result<TicketStatus, Error> {
        let mut abort = AbortOnDrop::new(self.aborted.clone());
        if reply.kind != 16 || reply.payload.len() != 13 {
            return Err(Error::Protocol);
        }
        let duration = be32(reply.payload.get(..4).ok_or(Error::Protocol)?)?;
        let renewable = *reply.payload.get(4).ok_or(Error::Protocol)?;
        if duration == 0 || renewable > 1 {
            return Err(Error::Expired);
        }
        // Acquisition/renewal issues a new ticket during the operation. Its
        // remaining lifetime must not be backdated to before KDC latency. The
        // absolute native endtime still caps response transit with full current
        // wall-clock precision; imported material retains its original bound.
        let received_at = Instant::now();
        let expires_at =
            declared_deadline(be32(reply.payload.get(9..13).ok_or(Error::Protocol)?)?)?
                .min(received_at + Duration::from_secs(u64::from(duration)));
        let expires_at = self
            .imported_expiry
            .map_or(expires_at, |bound| bound.min(expires_at));
        self.ticket_expiry = Some(expires_at);
        let status = TicketStatus {
            expires_at,
            renewable: renewable == 1,
            declared_renew_till: be32(reply.payload.get(5..9).ok_or(Error::Protocol)?)?,
        };
        abort.disarm();
        Ok(status)
    }
    pub(crate) async fn initialize<K: KdcExchange>(
        &mut self,
        caller: &mut K,
    ) -> Result<TicketStatus, Error> {
        let payload = std::mem::replace(&mut self.initialized, Zeroizing::new(Vec::new()));
        let reply = self.command(1, payload, caller).await?;
        self.status(reply)
    }
    /// Explicit online renewal for a future handshake; cannot extend established auth.
    pub async fn renew<K: KdcExchange>(&mut self, caller: &mut K) -> Result<TicketStatus, Error> {
        if !self.online {
            return Err(Error::Authority);
        }
        let reply = self.command(6, Zeroizing::new(Vec::new()), caller).await?;
        self.status(reply)
    }
    /// Explicit same-source acquisition, never an automatic renewal fallback.
    pub async fn reacquire<K: KdcExchange>(
        &mut self,
        caller: &mut K,
    ) -> Result<TicketStatus, Error> {
        if !self.online {
            return Err(Error::Authority);
        }
        let reply = self.command(7, Zeroizing::new(Vec::new()), caller).await?;
        self.status(reply)
    }
    pub async fn step<K: KdcExchange>(
        &mut self,
        token: Option<Zeroizing<Vec<u8>>>,
        caller: &mut K,
    ) -> Result<Step, Error> {
        let mut abort = AbortOnDrop::new(self.aborted.clone());
        if self
            .ticket_expiry
            .is_some_and(|bound| bound <= Instant::now())
            || self.gss_expiry.is_some_and(|bound| bound <= Instant::now())
        {
            return Err(Error::Expired);
        }
        let (kind, payload) = token.map_or((2, Zeroizing::new(Vec::new())), |bytes| (3, bytes));
        if payload.len() > 16384 {
            return Err(Error::Protocol);
        }
        let reply = self.authentication_command(kind, payload, caller).await?;
        if reply.kind != 17 || !(6..=16390).contains(&reply.payload.len()) {
            return Err(Error::Protocol);
        }
        let complete = *reply.payload.first().ok_or(Error::Protocol)?;
        if complete > 1 {
            return Err(Error::Protocol);
        }
        let seconds = be32(reply.payload.get(1..5).ok_or(Error::Protocol)?)?;
        if complete == 1 && (seconds == 0 || seconds == u32::MAX) {
            return Err(Error::Expired);
        }
        // MIT reports seconds using a whole-second clock. Round down, never grant
        // up to an extra second beyond a completed context's actual deadline.
        let expiry = if complete == 1 {
            self.operation_started + Duration::from_secs(u64::from(seconds.saturating_sub(1)))
        } else {
            self.ticket_expiry.ok_or(Error::Expired)?
        };
        if complete == 1 && expiry <= Instant::now() {
            return Err(Error::Expired);
        }
        if complete == 1 {
            self.gss_expiry = Some(expiry);
        }
        let bytes = reply.payload.get(6..).ok_or(Error::Protocol)?;
        let token = match reply.payload.get(5) {
            Some(0) if bytes.is_empty() => None,
            Some(1) => Some(Zeroizing::new(bytes.to_vec())),
            _ => return Err(Error::Protocol),
        };
        let step = Step {
            complete: complete == 1,
            expires_at: self.ticket_expiry.map_or(expiry, |bound| bound.min(expiry)),
            token,
        };
        abort.disarm();
        Ok(step)
    }
    pub async fn select_no_layer<K: KdcExchange>(
        &mut self,
        offer: Zeroizing<Vec<u8>>,
        caller: &mut K,
    ) -> Result<Zeroizing<Vec<u8>>, Error> {
        let mut abort = AbortOnDrop::new(self.aborted.clone());
        if self
            .ticket_expiry
            .is_some_and(|bound| bound <= Instant::now())
            || self.gss_expiry.is_some_and(|bound| bound <= Instant::now())
        {
            return Err(Error::Expired);
        }
        if !(1..=16384).contains(&offer.len()) {
            return Err(Error::Protocol);
        }
        let reply = self.authentication_command(4, offer, caller).await?;
        if reply.kind != 18 || !(1..=16384).contains(&reply.payload.len()) {
            return Err(Error::Protocol);
        }
        abort.disarm();
        Ok(reply.payload)
    }
    /// Return only after actual kill/wait, pipe closure and fixed-tree cleanup.
    pub async fn close(mut self) -> Result<(), Error> {
        if !self.aborted.load(Ordering::Acquire) {
            let _ = self.raw(5, Zeroizing::new(Vec::new())).await;
        }
        self.aborted.store(true, Ordering::Release);
        let terminal = self.terminal.take().ok_or(Error::Unavailable)?;
        terminal.await.map_err(|_| Error::CleanupUnknown)?
    }
}
fn declared_deadline(seconds: u32) -> Result<Instant, Error> {
    // Capture monotonic time FIRST: conversion cannot add the elapsed measurement
    // interval, and UNIX timestamps retain the current clock's subsecond precision.
    let anchor = Instant::now();
    let end = std::time::UNIX_EPOCH + Duration::from_secs(u64::from(seconds));
    let remaining = end
        .duration_since(std::time::SystemTime::now())
        .map_err(|_| Error::Expired)?;
    if remaining.is_zero() {
        return Err(Error::Expired);
    }
    Ok(anchor + remaining)
}
fn be32(bytes: &[u8]) -> Result<u32, Error> {
    Ok(u32::from_be_bytes(
        bytes.try_into().map_err(|_| Error::Protocol)?,
    ))
}

struct Io<'a> {
    input: &'a mut ChildStdin,
    output: &'a mut ChildStdout,
    aborted: &'a AtomicBool,
    deadline: WallInstant,
}
impl Io<'_> {
    fn check(&mut self, request: Option<&Request>) -> Result<(), Error> {
        if self.aborted.load(Ordering::Acquire) || request.is_some_and(|r| r.reply.is_closed()) {
            return Err(Error::Unavailable);
        }
        if WallInstant::now() >= self.deadline {
            return Err(Error::Deadline);
        }
        Ok(())
    }
    fn write(&mut self, bytes: &[u8], request: &Request) -> Result<(), Error> {
        let mut remaining = bytes;
        while !remaining.is_empty() {
            self.check(Some(request))?;
            match self.input.write(remaining) {
                Ok(0) => return Err(Error::Unavailable),
                Ok(n) => remaining = remaining.get(n..).ok_or(Error::Protocol)?,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(1))
                }
                Err(_) => return Err(Error::Unavailable),
            }
        }
        Ok(())
    }
    fn read(&mut self, bytes: &mut [u8], request: Option<&Request>) -> Result<(), Error> {
        let mut remaining = bytes;
        while !remaining.is_empty() {
            self.check(request)?;
            match self.output.read(remaining) {
                Ok(0) => return Err(Error::Unavailable),
                Ok(n) => remaining = remaining.get_mut(n..).ok_or(Error::Protocol)?,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(1))
                }
                Err(_) => return Err(Error::Unavailable),
            }
        }
        Ok(())
    }
    fn reply(&mut self, sequence: u32, request: Option<&Request>) -> Result<Reply, Error> {
        let mut header = [0u8; 16];
        self.read(&mut header, request)?;
        if header.get(4..9) != Some(b"KRB2\x02")
            || header.get(10..12) != Some(&[0, 0])
            || be32(header.get(12..).ok_or(Error::Protocol)?)? != sequence
        {
            return Err(Error::Protocol);
        }
        let size = usize::try_from(be32(header.get(..4).ok_or(Error::Protocol)?)?)
            .map_err(|_| Error::Protocol)?;
        if size > MAX_FRAME {
            return Err(Error::Protocol);
        }
        let mut payload = Zeroizing::new(vec![0; size]);
        self.read(&mut payload, request)?;
        Ok(Reply {
            kind: *header.get(9).ok_or(Error::Protocol)?,
            payload,
        })
    }
    fn request(&mut self, sequence: u32, request: &Request) -> Result<Reply, Error> {
        let mut header = [0u8; 16];
        header.get_mut(..4).ok_or(Error::Protocol)?.copy_from_slice(
            &u32::try_from(request.payload.len())
                .map_err(|_| Error::Protocol)?
                .to_be_bytes(),
        );
        header
            .get_mut(4..9)
            .ok_or(Error::Protocol)?
            .copy_from_slice(b"KRB2\x02");
        *header.get_mut(9).ok_or(Error::Protocol)? = request.kind;
        header
            .get_mut(12..)
            .ok_or(Error::Protocol)?
            .copy_from_slice(&sequence.to_be_bytes());
        self.write(&header, request)?;
        self.write(&request.payload, request)?;
        self.reply(sequence, Some(request))
    }
}

fn supervise(
    resources: Resources,
    source: (u8, Zeroizing<Vec<u8>>),
    receiver: mpsc::Receiver<Request>,
    ready: oneshot::Sender<Result<u32, Error>>,
    aborted: Arc<AtomicBool>,
    deadline: WallInstant,
) -> Result<(), Error> {
    // A scheduler-delayed reaper must not start a native process for a caller
    // that already cancelled or expired. Cleanup still owns the allocated files
    // and permit; no secret is provisioned on any of these refusal paths.
    if aborted.load(Ordering::Acquire) || ready.is_closed() {
        let _ = ready.send(Err(Error::Unavailable));
        return resources.cleanup();
    }
    if WallInstant::now() >= deadline {
        let _ = ready.send(Err(Error::Deadline));
        return resources.cleanup();
    }
    let (mode, bytes) = source;
    let binary: PathBuf = resources.tree.path().join("helper");
    let spawn = Command::new(binary)
        .current_dir(resources.tree.path())
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let child = match spawn {
        Ok(child) => child,
        Err(_) => {
            let _ = ready.send(Err(Error::Unavailable));
            return resources.cleanup();
        }
    };
    let reaped = resources.capacity.reaped.clone();
    reaped.store(false, Ordering::Release);
    let mut owner = Reaper {
        child,
        resources: Some(resources),
        reaped,
        failed_cleanup: false,
    };
    let id = owner.child.id();
    let mut stdin = owner.child.stdin.take().ok_or(Error::CleanupUnknown)?;
    let mut stdout = owner.child.stdout.take().ok_or(Error::CleanupUnknown)?;
    let result = (|| {
        fcntl_setfl(
            &stdin,
            fcntl_getfl(&stdin).map_err(|_| Error::Unavailable)? | OFlags::NONBLOCK,
        )
        .map_err(|_| Error::Unavailable)?;
        fcntl_setfl(
            &stdout,
            fcntl_getfl(&stdout).map_err(|_| Error::Unavailable)? | OFlags::NONBLOCK,
        )
        .map_err(|_| Error::Unavailable)?;
        let mut io = Io {
            input: &mut stdin,
            output: &mut stdout,
            aborted: &aborted,
            deadline,
        };
        if ready.is_closed() {
            return Err(Error::Unavailable);
        }
        let reply = io.reply(0, None)?;
        if reply.kind != 0 || !reply.payload.is_empty() || ready.is_closed() {
            return Err(Error::Unavailable);
        }
        owner
            .resources
            .as_mut()
            .ok_or(Error::CleanupUnknown)?
            .provision(mode, &bytes)?;
        drop(bytes);
        ready.send(Ok(id)).map_err(|_| Error::Unavailable)?;
        let mut sequence = 0u32;
        let mut pending_kdc = false;
        loop {
            io.check(None)?;
            // An idle crashed native child must not keep an apparently usable
            // context/slot until the next caller operation or wall deadline.
            if owner
                .child
                .try_wait()
                .map_err(|_| Error::CleanupUnknown)?
                .is_some()
            {
                return Err(Error::Unavailable);
            }
            let request = match receiver.recv_timeout(Duration::from_millis(2)) {
                Ok(request) => request,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
            };
            if (request.kind == 33) != pending_kdc {
                let _ = request.reply.send(Err(Error::Protocol));
                return Err(Error::Protocol);
            }
            if !pending_kdc {
                sequence = sequence.checked_add(1).ok_or(Error::Protocol)?;
            }
            let reply = io.request(sequence, &request);
            match reply {
                Ok(reply) => {
                    pending_kdc = reply.kind == 32;
                    let closed = reply.kind == 19;
                    if request.reply.send(Ok(reply)).is_err() {
                        return Ok(());
                    }
                    if closed {
                        let until = WallInstant::now() + Duration::from_millis(200);
                        while owner
                            .child
                            .try_wait()
                            .map_err(|_| Error::CleanupUnknown)?
                            .is_none()
                            && WallInstant::now() < until
                        {
                            thread::sleep(Duration::from_millis(1));
                        }
                        return Ok(());
                    }
                }
                Err(error) => {
                    let _ = request.reply.send(Err(error));
                    return Err(error);
                }
            }
        }
    })();
    // Retain the slot until actual reap and descriptor/resource closure, irrespective
    // of a cancelled waiter, native error, malformed response or drop.
    drop(stdin);
    drop(stdout);
    owner.finish()?;
    match result {
        Err(Error::CleanupUnknown) => Err(Error::CleanupUnknown),
        _ => Ok(()),
    }
}
