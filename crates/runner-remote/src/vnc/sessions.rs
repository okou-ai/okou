#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{
    collections::HashMap,
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
    network,
    protocol::{Info, Start},
};
use crate::ssh::DirectTcpIpStream;
use runner_types::ids::RunId;

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
type Registry = Arc<Mutex<HashMap<Uuid, Arc<Session>>>>;

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
    pub(super) generation: i64,
    pub(super) transport: Transport,
    pub(super) kerberos: Option<super::kerberos::Binding>,
    pub(super) cancel: CancellationToken,
    pub(super) closed: CancellationToken,
    pub(super) engine: tokio::sync::Mutex<Engine>,
}

pub(crate) struct Run {
    pub(super) runtime: Arc<VncRuntime>,
    pub(super) id: RunId,
    cancel: CancellationToken,
    ssh: Option<Arc<crate::ssh::Run>>,
    capacity: Arc<Semaphore>,
    sessions: Registry,
    tasks: TaskTracker,
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
            sessions: Arc::new(Mutex::new(HashMap::new())),
            tasks: TaskTracker::new(),
        }
    }

    pub(crate) fn close(&self) {
        self.cancel.cancel();
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
            .get(&id)
            .cloned()
            .ok_or(Failure::SessionNotFound)
    }

    pub(super) fn snapshot(&self) -> Result<Vec<Arc<Session>>, Failure> {
        let mut sessions: Vec<_> = self
            .sessions
            .lock()
            .map_err(|_| Failure::Protocol)?
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
        let mut root_builder = tempfile::Builder::new();
        root_builder.prefix("okou-vnc-kerberos-");
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
        let credential = scope
            .wait(self.runtime.authority.resolve(
                self.id,
                request.connection_id,
                self.ssh.is_some(),
                Some((&private_root, Arc::clone(&native_owner), scope.deadline)),
            ))
            .await??;
        let session_cancel = self.cancel.child_token();
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
                    .wait(ssh.open_direct_tcpip(
                        connection,
                        generation,
                        &credential.host,
                        credential.port,
                        session_cancel.clone(),
                        scope.deadline,
                    ))
                    .await?
                    .map_err(Failure::from)?;
                transport = Transport::Ssh {
                    connection,
                    generation: stream.generation(),
                };
                DirectOrSshStream::Ssh(Box::new(stream))
            }
        };
        let kerberos = match &credential.authentication {
            Authentication::Kerberos { binding, .. } => Some(*binding),
            _ => None,
        };
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
                        };
                        Box::pin(rfb_client::authenticate_qemu_gssapi(
                            stream,
                            &server_name,
                            roots,
                            rfb_client::QemuGssapiAuthentication {
                                credentials,
                                ticket_policy: policy,
                                private_root: private_root.clone(),
                                expires_at: Instant::now() + std::time::Duration::from_secs(7200),
                            },
                            &mut caller,
                            scope.deadline,
                        ))
                        .await
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
                        rfb_client::authenticate_apple_dh(stream, credentials, scope.deadline).await
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
                        rfb_client::authenticate_apple_rsa_srp(stream, credentials, scope.deadline)
                            .await
                    }
                }
            })
            .await?
            .map_err(|error| {
                if let rfb_client::Error::AuthenticationDeadlineExceeded { stage } = &error {
                    tracing::info!(
                        vnc_authentication_stage = stage.as_str(),
                        "VNC authentication deadline exceeded"
                    );
                }
                Failure::from(error)
            })?;
        let connection = scope
            .wait(authenticated.initialize(request.mode.into(), scope.deadline))
            .await?
            .map_err(Failure::from)?;
        let engine = Engine::new(connection);
        let expires = engine.expires_at();
        scope
            .wait(self.runtime.authority.check_kerberos(
                self.id,
                request.connection_id,
                credential.generation,
                transport,
                kerberos,
            ))
            .await??;
        scope.check()?;
        if self.cancel.is_cancelled() {
            return Err(Failure::Cancelled);
        }
        let session = Arc::new(Session {
            info: Info {
                session_id: Uuid::new_v4(),
                connection_id: request.connection_id,
                mode: request.mode,
            },
            generation: credential.generation,
            transport,
            kerberos,
            cancel: session_cancel,
            closed: CancellationToken::new(),
            engine: tokio::sync::Mutex::new(engine),
        });
        self.sessions
            .lock()
            .map_err(|_| Failure::Protocol)?
            .insert(session.info.session_id, Arc::clone(&session));
        self.tasks.spawn(cleanup(
            Arc::clone(&session),
            Arc::clone(&self.sessions),
            scope.sandbox.clone(),
            expires,
            capacity,
        ));
        Ok(session)
    }

    pub(super) async fn authorize(&self, session: &Session, scope: &Scope) -> Result<(), Failure> {
        let result = scope
            .wait(self.runtime.authority.check_kerberos(
                self.id,
                session.info.connection_id,
                session.generation,
                session.transport,
                session.kerberos,
            ))
            .await
            .and_then(|r| r);
        if result.is_err() {
            session.cancel.cancel();
        }
        result
    }
}

impl Drop for Run {
    fn drop(&mut self) {
        self.close();
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
        () = tokio::time::sleep_until(expires) => {},
    }
    session.cancel.cancel();
    // Active operations observe the same cancellation before releasing this
    // mutex. Taking it proves no RFB operation still owns the socket.
    session.engine.lock().await.close();
    if let Ok(mut entries) = registry.lock() {
        entries.remove(&session.info.session_id);
    }
    // Metadata snapshots may still retain Session handles. Only the lifecycle
    // task owns capacity: holding the engine mutex through image delivery makes
    // this close prove that socket and capture work have actually ended.
    drop(capacity);
    session.closed.cancel();
}
