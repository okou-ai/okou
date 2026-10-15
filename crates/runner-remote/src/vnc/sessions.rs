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

use super::{
    Failure, Scope, VncRuntime,
    authority::{Authentication, Transport},
    invalidation::{Admission, Entries, Registry},
    network,
    protocol::{Info, Start},
};
use crate::ssh::DirectTcpIpStream;
use runner_types::ids::RunId;
use std::sync::atomic::{AtomicBool, Ordering};

pub(super) enum DirectOrSshStream {
    Direct(TcpStream),
    Ssh(Box<DirectTcpIpStream>),
}

impl AsyncRead for DirectOrSshStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Direct(stream) => Pin::new(stream).poll_read(cx, buffer),
            Self::Ssh(stream) => Pin::new(stream.as_mut()).poll_read(cx, buffer),
        }
    }
}

impl AsyncWrite for DirectOrSshStream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Self::Direct(stream) => Pin::new(stream).poll_write(cx, bytes),
            Self::Ssh(stream) => Pin::new(stream.as_mut()).poll_write(cx, bytes),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Direct(stream) => Pin::new(stream).poll_flush(cx),
            Self::Ssh(stream) => Pin::new(stream.as_mut()).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Direct(stream) => Pin::new(stream).poll_shutdown(cx),
            Self::Ssh(stream) => Pin::new(stream.as_mut()).poll_shutdown(cx),
        }
    }
}

pub(super) type Engine = rfb_client::Session<DirectOrSshStream>;

/// Kept by lifecycle cleanup and pending DNS, independently of guest streams.
struct Capacity {
    _host: OwnedSemaphorePermit,
    _run: OwnedSemaphorePermit,
}

/// Actual helper/DNS custody; completion is emitted only after the last owner drops.
struct NativeWork {
    root: Option<tempfile::TempDir>,
    _capacity: Arc<Capacity>,
    _operation: Arc<OwnedSemaphorePermit>,
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
            return;
        }
        if let Some(completion) = self.completion.take() {
            let _ = completion.send(());
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
    pub(super) closed: CancellationToken,
    pub(super) engine: tokio::sync::Mutex<Engine>,
    diagnostics: Option<crate::diagnostics::Handle>,
    identity: crate::diagnostics::Identity,
    terminal: Mutex<Option<Failure>>,
    dependency: Option<crate::diagnostics::Dependency>,
    native: Option<crate::diagnostics::NativeSource>,
    diagnostic_active: Arc<AtomicBool>,
}

impl Session {
    pub(super) fn retire(&self) {
        self.diagnostic_active.store(false, Ordering::Release);
        self.cancel.cancel();
    }
    pub(super) fn failed(&self, operation: crate::diagnostics::Operation, failure: Failure) {
        if matches!(
            failure,
            Failure::InvalidInput | Failure::StaleGeometry | Failure::SessionNotFound
        ) {
            return;
        }
        self.diagnostic_active.store(false, Ordering::Release);
        let mut terminal = self.terminal.lock().unwrap_or_else(|p| p.into_inner());
        if terminal.is_some() {
            return;
        }
        *terminal = Some(failure);
        if let Some(diagnostics) = &self.diagnostics {
            diagnostics.record(crate::diagnostics::Record {
                protocol: crate::diagnostics::Protocol::Vnc,
                connection: self.info.connection_id,
                operation,
                identity: self.identity.clone(),
                cause: crate::diagnostics::Cause::Vnc(failure),
                dependency: self.dependency.clone().map(|mut dependency| {
                    dependency.cause = self
                        .native
                        .as_ref()
                        .and_then(|native| native.evidence.terminal())
                        .map(crate::diagnostics::Cause::Native);
                    dependency
                }),
                native: self.native.clone(),
            });
        }
    }
}

pub(crate) struct Run {
    pub(super) runtime: Arc<VncRuntime>,
    pub(super) id: RunId,
    cancel: CancellationToken,
    ssh: Option<Arc<crate::ssh::Run>>,
    capacity: Arc<Semaphore>,
    sessions: Registry,
    tasks: TaskTracker,
    diagnostics: std::sync::OnceLock<crate::diagnostics::Handle>,
}

#[derive(Default)]
struct StartEvidence {
    identity: crate::diagnostics::Identity,
    dependency: Option<crate::diagnostics::Dependency>,
    native: Option<crate::diagnostics::NativeSource>,
}

impl Run {
    pub(super) fn new(
        runtime: Arc<VncRuntime>,
        id: RunId,
        cancel: CancellationToken,
        ssh: Option<Arc<crate::ssh::Run>>,
    ) -> Self {
        Self {
            runtime,
            id,
            cancel,
            ssh,
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
    ) -> Result<Arc<Session>, Failure> {
        let connection = request.connection_id;
        let mut evidence = StartEvidence::default();
        let result = self
            .start_inner(request, scope, operation, &mut evidence)
            .await;
        if let Err(failure) = &result
            && let Some(diagnostics) = self.diagnostics.get()
        {
            diagnostics.record(crate::diagnostics::Record {
                protocol: crate::diagnostics::Protocol::Vnc,
                connection,
                operation: crate::diagnostics::Operation::Start,
                identity: evidence.identity,
                cause: crate::diagnostics::Cause::Vnc(*failure),
                dependency: evidence.dependency,
                native: evidence.native,
            });
        }
        result
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
        self.tasks.spawn(async move {
            let _ = done.await;
        });
        let native_owner: Arc<dyn kerberos_worker::WorkOwner> = native_work.clone();
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
        let result = async {
            let mut transport = credential.transport;
            let stream = match transport {
                Transport::Direct => {
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
                    let socket = scope
                        .wait(self.runtime.network.connect(address))
                        .await?
                        .map_err(|_| Failure::Network)?;
                    DirectOrSshStream::Direct(socket)
                }
                Transport::Ssh {
                    connection,
                    generation,
                } => {
                    let ssh = self.ssh.as_ref().ok_or(Failure::UnsupportedProfile)?;
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
                            evidence.native = failure.native;
                            evidence.dependency = Some(crate::diagnostics::Dependency {
                                protocol: crate::diagnostics::Protocol::Ssh,
                                connection_id: connection,
                                cause: Some(crate::diagnostics::Cause::Ssh(failure.reason)),
                                configuration_created_at: failure.identity.created_at,
                                configuration_generation: failure.identity.generation,
                            });
                            Failure::from(failure.reason)
                        })?;
                    transport = Transport::Ssh {
                        connection,
                        generation: stream.generation(),
                    };
                    evidence.native = stream.diagnostic_source();
                    let identity = stream.diagnostic_identity();
                    evidence.dependency = Some(crate::diagnostics::Dependency {
                        protocol: crate::diagnostics::Protocol::Ssh,
                        connection_id: connection,
                        cause: None,
                        configuration_created_at: identity.created_at,
                        configuration_generation: identity.generation,
                    });
                    DirectOrSshStream::Ssh(Box::new(stream))
                }
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
                                ssh: self.ssh.clone(),
                                tasks: self.tasks.clone(),
                                owner: Arc::clone(&native_owner),
                                exchanges: 0,
                                total: 0,
                                awaiting_kdc_reply: false,
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
                .await?
                .map_err(|error| diagnostic.rfb_failure(error))?;
            diagnostic.stage = "initialization";
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
            let session_id = Uuid::new_v4();
            evidence.identity.session = Some(session_id);
            let ssh_dependency = evidence.dependency.clone();
            let native = evidence.native.clone();
            let diagnostic_active = Arc::new(AtomicBool::new(true));
            if let (Some(ssh), Some(source), Some(handle)) =
                (ssh_dependency.clone(), &native, self.diagnostics.get())
                && let Some(watch) = handle.watch_vnc(
                    request.connection_id,
                    evidence.identity.clone(),
                    source,
                    ssh,
                    &diagnostic_active,
                )
            {
                source.evidence.observe(watch);
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
                closed: CancellationToken::new(),
                engine: tokio::sync::Mutex::new(engine),
                diagnostics: self.diagnostics.get().cloned(),
                identity: evidence.identity.clone(),
                terminal: Mutex::new(None),
                dependency: ssh_dependency,
                native,
                diagnostic_active,
            });
            admission.admit(Arc::clone(&session))?;
            self.tasks.spawn(cleanup(
                Arc::clone(&session),
                Arc::clone(&self.sessions),
                scope.sandbox.clone(),
                expires,
                capacity,
            ));
            Ok(session)
        }
        .await;
        diagnostic.finish(self.id, connection_id, result.as_ref().err().copied());
        if let Some(report) = observation.finish(result.as_ref().err().copied()) {
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
) {
    tokio::select! { biased;
        () = session.cancel.cancelled() => {},
        () = sandbox.cancelled() => {},
        () = tokio::time::sleep_until(expires) => { session.failed(crate::diagnostics::Operation::Retirement, Failure::TimedOut); },
    }
    session.retire();
    // Active operations observe the same cancellation before releasing this
    // mutex. Taking it proves no RFB operation still owns the socket.
    session.engine.lock().await.close();
    if let Ok(mut entries) = registry.lock() {
        entries.sessions.remove(&session.info.session_id);
    }
    // Metadata snapshots may still retain Session handles. Only the lifecycle
    // task owns capacity: holding the engine mutex through image delivery makes
    // this close prove that socket and capture work have actually ended.
    drop(capacity);
    session.closed.cancel();
}
