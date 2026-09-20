use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::{
    net::TcpStream,
    sync::{OwnedSemaphorePermit, Semaphore},
    time::Instant,
};
use tokio_util::{sync::CancellationToken, task::TaskTracker};
use uuid::Uuid;

use super::{
    Failure, Scope, VncRuntime, network,
    protocol::{Info, Start},
};
use crate::ids::RunId;

pub(super) type Engine = rfb_client::Session<TcpStream>;
type Registry = Arc<Mutex<HashMap<Uuid, Arc<Session>>>>;

/// Kept by lifecycle cleanup and pending DNS, independently of guest streams.
struct Capacity {
    _host: OwnedSemaphorePermit,
    _run: OwnedSemaphorePermit,
}

pub(super) struct Session {
    pub(super) info: Info,
    pub(super) generation: i64,
    pub(super) cancel: CancellationToken,
    pub(super) closed: CancellationToken,
    pub(super) engine: tokio::sync::Mutex<Engine>,
}

pub(crate) struct Run {
    pub(super) runtime: Arc<VncRuntime>,
    pub(super) id: RunId,
    cancel: CancellationToken,
    capacity: Arc<Semaphore>,
    sessions: Registry,
    tasks: TaskTracker,
}

impl Run {
    pub(super) fn new(runtime: Arc<VncRuntime>, id: RunId, cancel: CancellationToken) -> Self {
        Self {
            runtime,
            id,
            cancel,
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
        let credential = scope
            .wait(
                self.runtime
                    .authority
                    .resolve(self.id, request.connection_id),
            )
            .await??;
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
        let authenticated = scope
            .wait_deadline_aware(rfb_client::authenticate(
                socket,
                &credential.host,
                credential.password,
                credential.roots,
                scope.deadline,
            ))
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
            .wait(self.runtime.authority.check(
                self.id,
                request.connection_id,
                credential.generation,
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
            cancel: self.cancel.child_token(),
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
            .wait(self.runtime.authority.check(
                self.id,
                session.info.connection_id,
                session.generation,
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
