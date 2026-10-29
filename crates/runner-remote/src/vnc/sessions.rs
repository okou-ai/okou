#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{
    io,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::TcpStream,
    sync::{OwnedSemaphorePermit, Semaphore},
    time::Instant,
};
use tokio_util::{sync::CancellationToken, task::TaskTracker};
use uuid::Uuid;

use super::evidence::{Snapshot, Stage};
use super::{
    Failure, Scope, VncRuntime,
    authority::{Authentication, Transport},
    invalidation::{Admission, Entries, Registry},
    network,
    protocol::{Info, Start},
};
use crate::diagnostics::{Report, trace::Progress};
use crate::ssh::DirectTcpIpStream;
use runner_types::ids::RunId;
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(test)]
mod tests;

pub(super) enum Carrier {
    Direct(TcpStream),
    Ssh(Box<DirectTcpIpStream>),
    Native(Box<super::native::Stream>),
}

impl AsyncRead for Carrier {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Direct(stream) => Pin::new(stream).poll_read(cx, buffer),
            Self::Ssh(stream) => Pin::new(stream.as_mut()).poll_read(cx, buffer),
            Self::Native(stream) => Pin::new(stream.as_mut()).poll_read(cx, buffer),
        }
    }
}

impl AsyncWrite for Carrier {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Self::Direct(stream) => Pin::new(stream).poll_write(cx, bytes),
            Self::Ssh(stream) => Pin::new(stream.as_mut()).poll_write(cx, bytes),
            Self::Native(stream) => Pin::new(stream.as_mut()).poll_write(cx, bytes),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Direct(stream) => Pin::new(stream).poll_flush(cx),
            Self::Ssh(stream) => Pin::new(stream.as_mut()).poll_flush(cx),
            Self::Native(stream) => Pin::new(stream.as_mut()).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Direct(stream) => Pin::new(stream).poll_shutdown(cx),
            Self::Ssh(stream) => Pin::new(stream.as_mut()).poll_shutdown(cx),
            Self::Native(stream) => Pin::new(stream.as_mut()).poll_shutdown(cx),
        }
    }
}

pub(super) type Engine = rfb_client::Session<Carrier>;

/// Kept until lifecycle cleanup, DNS, and native work physically finish.
struct Capacity {
    _host: OwnedSemaphorePermit,
    _run: OwnedSemaphorePermit,
}

/// Actual helper/DNS custody; completion is emitted only after the last owner drops.
pub(super) struct NativeWork {
    root: Option<tempfile::TempDir>,
    _capacity: Arc<Capacity>,
    _operation: Arc<OwnedSemaphorePermit>,
    // Must drop last: closing the channel wakes waiters only after custody ends.
    completion: Option<tokio::sync::oneshot::Sender<()>>,
}
impl Drop for NativeWork {
    fn drop(&mut self) {
        if self.root.take().is_some_and(|root| root.close().is_err()) {
            // Unknown root cleanup is not completion and cannot release capacity.
            std::mem::forget(Arc::clone(&self._capacity));
            std::mem::forget(Arc::clone(&self._operation));
            if let Some(completion) = self.completion.take() {
                std::mem::forget(completion);
            }
        }
    }
}

pub(super) struct Session {
    pub(super) info: Info,
    // Authority follows this Run-owned transport's native lifetime, as with SSH.
    pub(super) expires: Instant,
    pub(super) transport: Transport,
    pub(super) kerberos: Option<super::kerberos::Binding>,
    pub(super) cancel: CancellationToken,
    pub(super) native: Option<crate::tailscale::StreamGuard>,
    pub(super) closed: CancellationToken,
    pub(super) engine: tokio::sync::Mutex<Engine>,
    diagnostics: Option<crate::diagnostics::Handle>,
    identity: crate::diagnostics::Identity,
    diagnostic_terminal: Mutex<DiagnosticTerminal>,
    source: SourceEvidence,
    vnc: Option<Snapshot>,
    diagnostic_active: Arc<AtomicBool>,
}

#[derive(Default)]
struct DiagnosticTerminal {
    finished: bool,
    failure: Option<Failure>,
    cause: Option<crate::diagnostics::Cause>,
    observed_at: Option<chrono::DateTime<chrono::Utc>>,
}

impl Session {
    pub(super) fn diagnostic_started(&self) -> Option<Instant> {
        self.vnc.as_ref().map(|_| Instant::now())
    }

    pub(super) fn check_report(
        &self,
        failure: Option<Failure>,
        cleanup: Progress,
        started: Option<Instant>,
    ) -> Option<Report> {
        let handle = self.diagnostics.as_ref()?;
        handle.record(crate::diagnostics::Record {
            effects: None,
            protocol: crate::diagnostics::Protocol::Vnc,
            connection: self.info.connection_id,
            operation: crate::diagnostics::Operation::ActiveCheck,
            identity: self.identity.clone(),
            cause: failure.map(|failure| self.source.cause(failure)),
            dependency: self.source.dependency.clone(),
            native: self.source.native.clone(),
            ssh: self.source.snapshot(),
            vnc: self
                .source
                .vnc_snapshot(self.vnc.as_ref())
                .map(|mut snapshot| {
                    snapshot.observed(Stage::Retirement, cleanup, started);
                    snapshot
                }),
        })
    }

    pub(super) fn close(&self) {
        // Latch intentional close before its cancellation can become failure evidence.
        self.diagnostic_terminal
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .finished = true;
        self.retire();
    }
    pub(super) fn retire(&self) {
        self.diagnostic_active.store(false, Ordering::Release);
        self.cancel.cancel();
    }
    pub(super) fn failed(
        &self,
        operation: crate::diagnostics::Operation,
        failure: Failure,
    ) -> Option<Report> {
        self.failed_since(operation, failure, None)
    }

    pub(super) fn failed_since(
        &self,
        operation: crate::diagnostics::Operation,
        failure: Failure,
        started: Option<Instant>,
    ) -> Option<Report> {
        if matches!(
            failure,
            Failure::InvalidInput | Failure::StaleGeometry | Failure::SessionNotFound
        ) {
            return None;
        }
        self.diagnostic_active.store(false, Ordering::Release);
        let mut terminal = self
            .diagnostic_terminal
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if terminal.finished {
            return None;
        }
        if terminal.failure.is_some()
            && matches!(operation, crate::diagnostics::Operation::Retirement)
        {
            return None;
        }
        let source_failure = *terminal.failure.get_or_insert(failure);
        let cause = *terminal
            .cause
            .get_or_insert_with(|| self.source.cause(source_failure));
        let observed_at = *terminal.observed_at.get_or_insert_with(chrono::Utc::now);
        self.diagnostics.as_ref().and_then(|diagnostics| {
            diagnostics.record(crate::diagnostics::Record {
                effects: None,
                protocol: crate::diagnostics::Protocol::Vnc,
                connection: self.info.connection_id,
                operation,
                identity: self.identity.clone(),
                cause: Some(cause),
                dependency: self.source.dependency.clone().map(|mut dependency| {
                    if matches!(cause, crate::diagnostics::Cause::Native(_)) {
                        dependency.cause = Some(cause);
                    }
                    dependency
                }),
                native: self.source.native.clone(),
                ssh: self.source.snapshot(),
                vnc: self.source.vnc_snapshot(self.vnc.as_ref()).map(|snapshot| {
                    let mut snapshot = snapshot.operation(operation, failure, started);
                    snapshot.first_failure = Some(source_failure);
                    snapshot.first_failure_at = Some(observed_at);
                    snapshot
                }),
            })
        })
    }
}

pub(crate) struct Run {
    pub(super) runtime: Arc<VncRuntime>,
    pub(super) id: RunId,
    cancel: CancellationToken,
    ssh: Option<Arc<crate::ssh::Run>>,
    pub(super) native: Arc<crate::native::Run>,
    capacity: Arc<Semaphore>,
    sessions: Registry,
    pub(super) tasks: TaskTracker,
    diagnostics: std::sync::OnceLock<crate::diagnostics::Handle>,
}

#[derive(Default)]
pub(super) struct StartEvidence {
    identity: crate::diagnostics::Identity,
    pub(super) source: SourceEvidence,
    rfb_source: Option<Box<SourceEvidence>>,
    pub(super) vnc: Option<Snapshot>,
    handle: Option<crate::diagnostics::Handle>,
    ssh: Option<Arc<crate::ssh::Run>>,
    active_check: bool,
    connection: Option<Uuid>,
    active: Option<Arc<AtomicBool>>,
}

#[derive(Clone, Default)]
pub(super) struct SourceEvidence {
    dependency: Option<crate::diagnostics::Dependency>,
    native: Option<crate::diagnostics::NativeSource>,
    ssh: Option<crate::diagnostics::trace::Snapshot>,
    trace: Option<crate::ssh::ForwardingTrace>,
    carrier: Option<(super::evidence::Role, crate::diagnostics::trace::Trace)>,
}
impl SourceEvidence {
    fn failed_native(&self) -> Option<Uuid> {
        let source = self.native.as_ref()?;
        source
            .evidence
            .terminal()
            .filter(|failure| *failure != crate::tailscale::Failure::Cancelled)
            .map(|_| source.resource_id)
    }

    fn has_source_failure(&self) -> bool {
        self.failed_native().is_some()
            || self
                .dependency
                .as_ref()
                .is_some_and(|dependency| dependency.cause.is_some())
            || self
                .carrier
                .as_ref()
                .and_then(|(_, trace)| trace.carrier_snapshot())
                .is_some_and(|snapshot| snapshot.has_failure())
            || self
                .snapshot()
                .is_some_and(|snapshot| snapshot.access_failure.is_some())
    }

    fn vnc_snapshot(&self, snapshot: Option<&Snapshot>) -> Option<Snapshot> {
        let mut snapshot = snapshot?.clone();
        if let Some((role, trace)) = &self.carrier
            && let Some(carrier) = snapshot.carrier(*role)
        {
            carrier.access = trace.carrier_snapshot();
        }
        if let Some(resource) = self.failed_native() {
            snapshot.failed_carrier(resource);
        }
        Some(snapshot)
    }

    fn cause(&self, failure: Failure) -> crate::diagnostics::Cause {
        if matches!(failure, Failure::Cancelled | Failure::Network)
            && let Some(root) = self
                .native
                .as_ref()
                .and_then(|source| source.evidence.terminal())
                .filter(|root| *root != crate::tailscale::Failure::Cancelled)
        {
            return crate::diagnostics::Cause::Native(root);
        }
        crate::diagnostics::Cause::Vnc(failure)
    }
    fn snapshot(&self) -> Option<crate::diagnostics::trace::Snapshot> {
        self.trace
            .as_ref()
            .and_then(crate::ssh::ForwardingTrace::snapshot)
            .or_else(|| self.ssh.clone())
    }
}

pub(super) struct StartFailure {
    pub(super) reason: Failure,
    pub(super) report: Option<Box<Report>>,
}

impl StartEvidence {
    pub(super) fn begin_kdc_source(&mut self) {
        if self.vnc.is_some() {
            self.rfb_source
                .get_or_insert_with(|| Box::new(self.source.clone()));
        }
        self.source = SourceEvidence::default();
    }
    pub(super) fn is_check(&self) -> bool {
        self.active_check
    }
    pub(super) fn capture_carrier(&mut self) {
        self.vnc = self.source.vnc_snapshot(self.vnc.as_ref());
    }
    fn capture_failure(&mut self) {
        self.capture_carrier();
        if let Some(rfb) = &self.rfb_source
            && let Some(resource) = rfb.failed_native()
        {
            if let Some(snapshot) = &mut self.vnc {
                snapshot.failed_carrier(resource);
            }
            // RFB's outer scope can interrupt an otherwise healthy independent
            // KDC future. Preserve its known source through that future's drop.
            if !self.source.has_source_failure() {
                self.source = rfb.as_ref().clone();
            }
        }
    }
    pub(super) fn carrier(
        &mut self,
        role: super::evidence::Role,
    ) -> Option<&mut super::evidence::Carrier> {
        self.vnc.as_mut()?.carrier(role).as_deref_mut()
    }
    pub(super) fn retain_carrier(
        &mut self,
        role: super::evidence::Role,
        trace: crate::diagnostics::trace::Trace,
    ) {
        if self.vnc.is_some() {
            self.source.carrier = Some((role, trace));
        }
    }
    pub(super) fn retain_native(&mut self, source: crate::diagnostics::NativeSource) {
        if self
            .handle
            .as_ref()
            .is_some_and(crate::diagnostics::Handle::enabled)
        {
            if let (Some(handle), Some(connection), Some(active)) =
                (&self.handle, self.connection, &self.active)
                && let Some(watch) = handle.watch_vnc(
                    connection,
                    self.identity.clone(),
                    &source,
                    self.source.dependency.clone(),
                    active,
                )
            {
                source
                    .evidence
                    .observe(watch.with_vnc(self.vnc.clone(), source.connection.clone()));
            }
            self.source.native = Some(source);
        }
    }
    pub(super) fn begin(&mut self, stage: Stage) {
        if let Some(snapshot) = &mut self.vnc {
            snapshot.begin(stage);
        }
    }
    pub(super) fn set(&mut self, stage: Stage, status: Progress) {
        if let Some(snapshot) = &mut self.vnc {
            snapshot.set(stage, status);
        }
    }
    pub(super) fn retain_ssh_stream(&mut self, connection: Uuid, stream: &DirectTcpIpStream) {
        let identity = stream.diagnostic_identity();
        self.source = SourceEvidence {
            native: stream.diagnostic_source(),
            trace: Some(stream.diagnostic_trace()),
            ssh: None,
            dependency: Some(crate::diagnostics::Dependency {
                protocol: crate::diagnostics::Protocol::Ssh,
                connection_id: connection,
                cause: None,
                configuration_created_at: identity.created_at,
                configuration_generation: identity.generation,
            }),
            carrier: None,
        };
    }
    pub(super) fn retain_ssh_failure(
        &mut self,
        connection: Uuid,
        failure: crate::ssh::ForwardingFailure,
    ) {
        self.source.native = failure.native;
        self.source.ssh = failure.trace;
        self.source.trace = None;
        self.source.dependency = Some(crate::diagnostics::Dependency {
            protocol: crate::diagnostics::Protocol::Ssh,
            connection_id: connection,
            cause: Some(crate::diagnostics::Cause::Ssh(failure.reason)),
            configuration_created_at: failure.identity.created_at,
            configuration_generation: failure.identity.generation,
        });
    }
}

impl Run {
    pub(super) fn new(
        runtime: Arc<VncRuntime>,
        id: RunId,
        cancel: CancellationToken,
        ssh: Option<Arc<crate::ssh::Run>>,
        native: Arc<crate::native::Run>,
    ) -> Self {
        Self {
            runtime,
            id,
            cancel,
            ssh,
            native,
            capacity: Arc::new(Semaphore::new(2)),
            sessions: Arc::new(Mutex::new(Entries::default())),
            tasks: TaskTracker::new(),
            diagnostics: std::sync::OnceLock::new(),
        }
    }

    pub(crate) fn close(&self) {
        self.cancel.cancel();
    }

    pub(crate) fn set_diagnostics(&self, diagnostics: crate::diagnostics::Handle) {
        let _ = self.diagnostics.set(diagnostics);
    }

    pub(super) fn diagnostics_handle(&self) -> Option<crate::diagnostics::Handle> {
        self.diagnostics.get().cloned()
    }

    pub(super) fn invalidate(&self, connection: Option<Uuid>, ssh: bool) {
        if let Ok(entries) = self.sessions.lock() {
            entries.invalidate(connection, ssh);
        }
    }

    pub(crate) async fn shutdown(&self) {
        self.close();
        self.tasks.close();
        self.tasks.wait().await;
    }

    pub(super) fn lookup(&self, id: Uuid) -> Result<Arc<Session>, Failure> {
        self.sessions
            .lock()
            .map_err(|_| Failure::Protocol)?
            .sessions
            .get(&id)
            .cloned()
            .ok_or(Failure::SessionNotFound)
    }

    pub(super) fn snapshot(&self) -> Result<Vec<Arc<Session>>, Failure> {
        let mut sessions: Vec<_> = self
            .sessions
            .lock()
            .map_err(|_| Failure::Protocol)?
            .sessions
            .values()
            .cloned()
            .collect();
        sessions.sort_by_key(|session| session.info.session_id);
        Ok(sessions)
    }

    pub(super) async fn start(
        &self,
        request: Start,
        scope: &Scope,
        operation: Arc<OwnedSemaphorePermit>,
    ) -> Result<Arc<Session>, StartFailure> {
        self.start_observed(
            request,
            scope,
            operation,
            self.diagnostics.get().cloned(),
            false,
        )
        .await
    }

    pub(super) async fn start_observed(
        &self,
        request: Start,
        scope: &Scope,
        operation: Arc<OwnedSemaphorePermit>,
        handle: Option<crate::diagnostics::Handle>,
        active_check: bool,
    ) -> Result<Arc<Session>, StartFailure> {
        let connection = request.connection_id;
        let ssh = self.ssh.as_ref().map(|ssh| match &handle {
            Some(handle) if active_check => ssh.with_diagnostics(handle.clone()),
            _ => Arc::clone(ssh),
        });
        let mut evidence = StartEvidence {
            connection: Some(connection),
            active: handle
                .as_ref()
                .filter(|handle| handle.enabled())
                .map(|_| Arc::new(AtomicBool::new(true))),
            vnc: handle
                .as_ref()
                .filter(|handle| handle.enabled())
                .map(|_| Snapshot::default()),
            handle,
            ssh,
            active_check,
            ..StartEvidence::default()
        };
        evidence.begin(Stage::Admission);
        let result = self
            .start_inner(request, scope, operation, &mut evidence)
            .await;
        let report = if let Err(failure) = &result {
            evidence.capture_failure();
            if let Some(snapshot) = &mut evidence.vnc {
                snapshot.finish(*failure);
            }
            evidence.handle.as_ref().and_then(|diagnostics| {
                diagnostics.record(crate::diagnostics::Record {
                    effects: None,
                    protocol: crate::diagnostics::Protocol::Vnc,
                    connection,
                    operation: if active_check {
                        crate::diagnostics::Operation::ActiveCheck
                    } else {
                        crate::diagnostics::Operation::Start
                    },
                    identity: evidence.identity,
                    cause: Some(evidence.source.cause(*failure)),
                    ssh: evidence.source.snapshot(),
                    dependency: evidence.source.dependency,
                    native: evidence.source.native,
                    vnc: evidence.vnc,
                })
            })
        } else {
            None
        };
        result.map_err(|reason| StartFailure {
            reason,
            report: report.map(Box::new),
        })
    }

    async fn start_inner(
        &self,
        request: Start,
        scope: &Scope,
        operation: Arc<OwnedSemaphorePermit>,
        evidence: &mut StartEvidence,
    ) -> Result<Arc<Session>, Failure> {
        let started = Instant::now();
        scope.check()?;
        if self.cancel.is_cancelled() {
            return Err(Failure::Cancelled);
        }
        let capacity = Arc::new(Capacity {
            _run: Arc::clone(&self.capacity)
                .try_acquire_owned()
                .map_err(|_| Failure::ResourceExhausted)?,
            _host: Arc::clone(&self.runtime.capacity)
                .try_acquire_owned()
                .map_err(|_| Failure::ResourceExhausted)?,
        });
        let session_cancel = self.cancel.child_token();
        let admission = Admission::new(
            Arc::clone(&self.sessions),
            request.connection_id,
            session_cancel.clone(),
        )?;
        let scope = &Scope {
            session: session_cancel.clone(),
            ..scope.clone()
        };
        let mut root_builder = tempfile::Builder::new();
        let root_prefix = format!("okou-vnc-kerberos-{}-", self.id);
        root_builder.prefix(&root_prefix);
        #[cfg(unix)]
        root_builder.permissions(std::fs::Permissions::from_mode(0o700));
        let root = root_builder.tempdir().map_err(|_| Failure::Unavailable)?;
        let (completion, done) = tokio::sync::oneshot::channel();
        let private_root = root.path().to_owned();
        let native_work = Arc::new(NativeWork {
            root: Some(root),
            _capacity: Arc::clone(&capacity),
            _operation: Arc::clone(&operation),
            completion: Some(completion),
        });
        let native_closed = CancellationToken::new();
        let completed = native_closed.clone();
        self.tasks.spawn(async move {
            let _ = done.await;
            completed.cancel();
        });
        let native_owner: Arc<dyn kerberos_worker::WorkOwner> = native_work.clone();
        evidence.begin(Stage::Credential);
        let mut credential = scope
            .wait(self.runtime.authority.resolve(
                self.id,
                request.connection_id,
                self.ssh.is_some(),
                Some((&private_root, Arc::clone(&native_owner), scope.deadline)),
                &mut evidence.identity,
            ))
            .await??;
        admission.bind(
            credential.transport,
            match &credential.authentication {
                Authentication::Kerberos { binding, .. } => Some(*binding),
                _ => None,
            },
        )?;
        let mut observation = super::observation::Attempt {
            created_at: credential.created_at,
            generation: credential.generation,
            transport: credential.transport,
            kerberos: match &credential.authentication {
                Authentication::Kerberos { binding, .. } => Some(*binding),
                _ => None,
            },
            authenticated_at: None,
        };
        let connection_id = request.connection_id;
        let mut diagnostic = super::diagnostics::Attempt::new(
            started,
            &credential.authentication,
            credential.transport,
        );
        diagnostic.apply(&mut evidence.vnc);
        if let Some(snapshot) = &mut evidence.vnc {
            snapshot.route = super::evidence::route(credential.transport);
            snapshot.kdc_route = match &credential.authentication {
                Authentication::Kerberos { kdc, .. } => kdc
                    .as_ref()
                    .map(|kdc| super::evidence::route(kdc.transport)),
                _ => None,
            };
        }
        let result = async {
            let mut transport = credential.transport;
            let stream = match transport {
                Transport::Direct => {
                    evidence.begin(Stage::Destination);
                    let resolver_capacity = Arc::clone(&capacity);
                    let network = Arc::clone(&self.runtime.network);
                    let host = credential.host.clone();
                    let port = credential.port;
                    // OS DNS may keep running after its waiter is cancelled. Own its permits
                    // in a tracked task until the actual resolver returns.
                    let resolve = self.tasks.spawn(async move {
                        let _capacity = resolver_capacity;
                        let _operation = operation;
                        network::destination(network, &host, port).await
                    });
                    let address = scope.wait(resolve).await?.map_err(|_| Failure::Network)??;
                    if let Some(snapshot) = &mut evidence.vnc {
                        snapshot.address = Some(address);
                    }
                    evidence.begin(Stage::Transport);
                    let socket = scope
                        .wait(self.runtime.network.connect(address))
                        .await?
                        .map_err(|_| Failure::Network)?;
                    Carrier::Direct(socket)
                }
                Transport::Ssh {
                    connection,
                    generation,
                } => {
                    evidence.begin(Stage::Transport);
                    let ssh = evidence.ssh.as_ref().ok_or(Failure::UnsupportedProfile)?;
                    let stream = scope
                        .wait(ssh.open_direct_tcpip_diagnosed(
                            connection,
                            generation,
                            &credential.host,
                            credential.port,
                            session_cancel.clone(),
                            scope.deadline,
                        ))
                        .await?
                        .map_err(|failure| {
                            let reason = Failure::from(failure.reason);
                            evidence.retain_ssh_failure(connection, *failure);
                            reason
                        })?;
                    transport = Transport::Ssh {
                        connection,
                        generation: stream.generation(),
                    };
                    evidence.retain_ssh_stream(connection, &stream);
                    Carrier::Ssh(Box::new(stream))
                }
                Transport::Cloudflare { .. } | Transport::Tailscale { .. } => {
                    evidence.begin(Stage::Transport);
                    let configuration = credential.native.take().ok_or(Failure::Authority)?;
                    let stream = self
                        .native_dialer()
                        .dial(
                            configuration,
                            super::native::Destination {
                                host: &credential.host,
                                port: credential.port,
                                role: super::evidence::Role::Rfb,
                            },
                            scope,
                            native_work.clone(),
                            evidence,
                        )
                        .await?;
                    // Admission input alone is insufficient: require the actual
                    // verified origin TLS or exact peer stream before RFB bytes.
                    if credential.authentication.requires_outer_protection() {
                        stream.require_raw_protection()?;
                    }
                    scope
                        .wait(self.runtime.authority.check(
                            self.id,
                            request.connection_id,
                            credential.generation,
                            transport,
                            observation.kerberos,
                        ))
                        .await??;
                    Carrier::Native(Box::new(stream))
                }
            };
            let native = match &stream {
                Carrier::Native(stream) => stream.guard(),
                _ => None,
            };
            let scope = &Scope {
                native: native.into_iter().collect(),
                ..scope.clone()
            };
            observation.transport = transport;
            if let Authentication::Kerberos { binding, kdc, .. } = &mut credential.authentication {
                binding.record_ssh_generation(kdc, credential.transport, transport);
                observation.kerberos = Some(*binding);
            }
            let mut kerberos = match &credential.authentication {
                Authentication::Kerberos { binding, .. } => Some(*binding),
                _ => None,
            };
            diagnostic.stage = "authentication";
            evidence.begin(Stage::Authentication);
            // This latch outlives cancellation of the nested authentication future.
            let kdc_delivery = std::sync::atomic::AtomicBool::new(false);
            let authenticated = scope
                .wait_deadline_aware(async {
                    match credential.authentication {
                        Authentication::Kerberos {
                            server_name,
                            roots,
                            credentials,
                            policy,
                            binding,
                            kdc,
                        } => {
                            let realm = credentials.realm().to_owned();
                            let mut caller = super::kerberos::Caller {
                                runtime: Arc::clone(&self.runtime),
                                run: self.id,
                                connection: request.connection_id,
                                generation: credential.generation,
                                rfb: transport,
                                binding,
                                kdc,
                                realm,
                                scope: scope.clone(),
                                ssh: evidence.ssh.clone(),
                                tasks: self.tasks.clone(),
                                owner: Arc::clone(&native_owner),
                                exchanges: 0,
                                total: 0,
                                awaiting_kdc_reply: &kdc_delivery,
                                native: self.native_dialer(),
                                diagnostics: evidence,
                            };
                            let result = Box::pin(rfb_client::authenticate_qemu_gssapi(
                                stream,
                                &server_name,
                                roots,
                                rfb_client::QemuGssapiAuthentication {
                                    credentials,
                                    ticket_policy: policy,
                                    private_root: private_root.clone(),
                                    expires_at: Instant::now()
                                        + std::time::Duration::from_secs(7200),
                                },
                                &mut caller,
                                scope.deadline,
                            ))
                            .await;
                            kerberos = Some(caller.binding);
                            observation.kerberos = kerberos;
                            caller.authentication_result(result)
                        }
                        Authentication::X509 {
                            server_name,
                            authentication,
                            roots,
                        } => {
                            rfb_client::authenticate(
                                stream,
                                &server_name,
                                authentication,
                                roots,
                                scope.deadline,
                            )
                            .await
                        }
                        Authentication::ClientCertificate {
                            server_name,
                            authentication,
                            roots,
                            identity,
                        } => {
                            rfb_client::authenticate_with_client_certificate(
                                stream,
                                &server_name,
                                authentication,
                                roots,
                                identity,
                                scope.deadline,
                            )
                            .await
                        }
                        Authentication::AppleVncPassword(password) => {
                            rfb_client::authenticate_apple_vnc_password(
                                stream,
                                password,
                                scope.deadline,
                            )
                            .await
                        }
                        Authentication::AppleDh(credentials) => {
                            rfb_client::authenticate_apple_dh(stream, credentials, scope.deadline)
                                .await
                        }
                        Authentication::AppleSrp(credentials) => {
                            rfb_client::authenticate_apple_srp(stream, credentials, scope.deadline)
                                .await
                        }
                        Authentication::RsaAes {
                            security,
                            pin,
                            credentials,
                        } => {
                            rfb_client::authenticate_rsa_aes(
                                stream,
                                security,
                                credentials,
                                pin,
                                scope.deadline,
                            )
                            .await
                        }
                        Authentication::AppleRsaSrp(credentials) => {
                            rfb_client::authenticate_apple_rsa_srp(
                                stream,
                                credentials,
                                scope.deadline,
                            )
                            .await
                        }
                    }
                })
                .await
                .map_err(|failure| {
                    if kdc_delivery.load(Ordering::Relaxed) {
                        Failure::DeliveryUnknown
                    } else {
                        failure
                    }
                })?
                .map_err(|error| diagnostic.rfb_failure(error))?;
            diagnostic.stage = "initialization";
            evidence.begin(Stage::Initialization);
            let connection = scope
                .wait(authenticated.initialize(request.mode.into(), scope.deadline))
                .await?
                .map_err(|error| diagnostic.rfb_failure(error))?;
            observation.authenticated_at = Some(chrono::Utc::now());
            let engine = Engine::new(connection);
            let expires = engine.expires_at();
            // Retain main's native-expiry bound while recording connection evidence.
            let authority_scope = Scope {
                deadline: scope.deadline.min(expires),
                ..scope.clone()
            };
            diagnostic.stage = "authority_recheck";
            evidence.begin(Stage::AuthorityRecheck);
            authority_scope
                .wait(self.runtime.authority.check(
                    self.id,
                    request.connection_id,
                    credential.generation,
                    transport,
                    kerberos,
                ))
                .await??;
            authority_scope.check()?;
            if self.cancel.is_cancelled() {
                return Err(Failure::Cancelled);
            }
            diagnostic.stage = "session_admission";
            evidence.begin(Stage::SessionAdmission);
            let session_id = Uuid::new_v4();
            evidence.identity.session = Some(session_id);
            evidence.capture_carrier();
            let ssh_dependency = evidence.source.dependency.clone();
            let native = evidence.source.native.clone();
            let diagnostic_active = Arc::new(AtomicBool::new(true));
            if let (ssh, Some(source), Some(handle)) =
                (ssh_dependency.clone(), &native, evidence.handle.as_ref())
                && let Some(watch) = handle.watch_vnc(
                    request.connection_id,
                    evidence.identity.clone(),
                    source,
                    ssh,
                    &diagnostic_active,
                )
            {
                source.evidence.observe(watch.with_vnc(
                    evidence.vnc.clone().map(|mut snapshot| {
                        snapshot.set(Stage::SessionAdmission, Progress::Passed);
                        snapshot
                    }),
                    source.connection.clone(),
                ));
            }
            let session = Arc::new(Session {
                info: Info {
                    session_id,
                    connection_id: request.connection_id,
                    mode: request.mode,
                },
                expires,
                transport,
                kerberos,
                cancel: session_cancel,
                native: scope.native.first().cloned(),
                closed: CancellationToken::new(),
                engine: tokio::sync::Mutex::new(engine),
                diagnostics: evidence.handle.clone(),
                identity: evidence.identity.clone(),
                diagnostic_terminal: Mutex::new(DiagnosticTerminal::default()),
                source: evidence.source.clone(),
                vnc: evidence.vnc.clone().map(|mut snapshot| {
                    snapshot.set(Stage::SessionAdmission, Progress::Passed);
                    snapshot
                }),
                diagnostic_active,
            });
            admission.admit(Arc::clone(&session))?;
            self.tasks.spawn(cleanup(
                Arc::clone(&session),
                Arc::clone(&self.sessions),
                scope.sandbox.clone(),
                expires,
                capacity,
                native_closed,
            ));
            Ok(session)
        }
        .await;
        diagnostic.apply(&mut evidence.vnc);
        if !evidence.active_check {
            diagnostic.finish(self.id, connection_id, result.as_ref().err().copied());
        }
        if !evidence.active_check
            && let Some(report) = observation.finish(result.as_ref().err().copied())
        {
            if let Ok(permit) = Arc::clone(&self.runtime.reports).try_acquire_owned() {
                let runtime = Arc::clone(&self.runtime);
                let run = self.id;
                // Reporting owns no session capacity, operation lease or guest output.
                self.tasks.spawn(async move {
                    let _permit = permit;
                    runtime.authority.observe(run, connection_id, report).await;
                });
            } else {
                tracing::info!(run_id = %self.id, connection_id = %connection_id, "VNC observation report capacity exhausted");
            }
        }
        result
    }

    pub(super) fn authorize(&self, session: &Session, scope: &Scope) -> Result<(), Failure> {
        scope.check()?;
        if self.cancel.is_cancelled() || session.cancel.is_cancelled() {
            return Err(Failure::Cancelled);
        }
        if Instant::now() >= session.expires {
            session.failed(crate::diagnostics::Operation::Retirement, Failure::TimedOut);
            session.retire();
            return Err(Failure::TimedOut);
        }
        // Notifications only cancel this exact authority. Subscription outages
        // neither restore it nor retire it; missed delivery can delay revocation
        // until the original Run/session/credential lifetime ends, as with SSH.
        Ok(())
    }

    pub(super) fn explanation(&self, report: Option<&Report>) -> Option<String> {
        let handle = self.diagnostics.get()?;
        if !handle.enabled() || !handle.current() {
            return None;
        }
        report?.message()
    }
}

impl Drop for Run {
    fn drop(&mut self) {
        self.close();
        let mut runs = self.runtime.runs.lock().unwrap_or_else(|p| p.into_inner());
        if runs
            .get(&self.id)
            .is_some_and(|owner| std::ptr::eq(owner.as_ptr(), self))
        {
            runs.remove(&self.id);
        }
    }
}

async fn cleanup(
    session: Arc<Session>,
    registry: Registry,
    sandbox: CancellationToken,
    expires: Instant,
    capacity: Arc<Capacity>,
    native_closed: CancellationToken,
) {
    tokio::select! { biased;
        () = session.cancel.cancelled() => {},
        () = async {
            match &session.native { Some(guard) => guard.retired().await, None => std::future::pending().await }
        } => {},
        () = sandbox.cancelled() => {},
        () = tokio::time::sleep_until(expires) => { session.failed(crate::diagnostics::Operation::Retirement, Failure::TimedOut); },
    }
    session.retire();
    // Active operations observe the same cancellation before releasing this
    // mutex. Taking it proves no RFB operation still owns the socket.
    session.engine.lock().await.close();
    // Dropping the byte stream only cancels native TCP; its owning thread must
    // still destroy the SDK connection and release its NativeWork lease.
    native_closed.cancelled().await;
    if let Ok(mut entries) = registry.lock() {
        entries.sessions.remove(&session.info.session_id);
    }
    // Metadata snapshots may still retain Session handles. Only the lifecycle
    // task owns capacity: holding the engine mutex through image delivery makes
    // this close prove that socket and capture work have actually ended.
    drop(capacity);
    session.closed.cancel();
}
