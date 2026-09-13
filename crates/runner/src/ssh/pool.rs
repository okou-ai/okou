//! Reuse idle transports; each active channel exclusively owns its connection.

use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::Duration,
};

use tokio::{
    sync::{OwnedSemaphorePermit, Semaphore, watch},
    time::Instant,
};
use tokio_util::{sync::CancellationToken, task::TaskTracker};
use uuid::Uuid;

use super::{
    FailureReason, Scope, SshRuntime, authority::PreparedCredential, cache::Access, engine,
    io::HostLease, observation::Attempt,
};
use crate::ids::RunId;

const IDLE_CAPACITY: usize = 8;
// Eight short operations + eight retained sessions + eight idle transports.
const PHYSICAL_CAPACITY: usize = 24;
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const LIFETIME: Duration = Duration::from_secs(2 * 60 * 60);

pub(super) struct Pool {
    run: RunId,
    cancel: CancellationToken,
    capacity: Arc<Semaphore>,
    idle: Mutex<VecDeque<Idle>>,
    tasks: TaskTracker,
}

struct Idle {
    since: Instant,
    transport: Arc<Transport>,
}

struct Transport {
    connection: Uuid,
    credential: Arc<PreparedCredential>,
    access: Access,
    connected: engine::Connected,
    scope: Scope,
    host_lease: Arc<HostLease>,
    retained: bool,
    idle_deadline: watch::Sender<Option<Instant>>,
}

impl Transport {
    fn current(&self) -> Result<(), FailureReason> {
        self.scope.check()?;
        self.access.check()?;
        if self.connected.session.is_closed() {
            return Err(FailureReason::Disconnected);
        }
        Ok(())
    }

    fn retire(&self) {
        self.scope.cancelled.cancel();
        self.connected.close();
    }
}

impl Drop for Transport {
    fn drop(&mut self) {
        self.retire();
    }
}

pub(super) struct Request {
    pub(super) connection: Uuid,
    pub(super) credential: Arc<PreparedCredential>,
    pub(super) access: Access,
    pub(super) operation: Arc<OwnedSemaphorePermit>,
    pub(super) retained: bool,
}

/// Dropping an uncertain execution retires only its exclusive physical socket.
pub(super) struct Lease {
    pool: Arc<Pool>,
    transport: Arc<Transport>,
    retire_on_drop: bool,
}

impl Lease {
    pub(super) fn connected(&self) -> &engine::Connected {
        &self.transport.connected
    }

    /// Only callers that observed channel close and actual exit may return it.
    pub(super) fn reuse(mut self) {
        let transport = &self.transport;
        if !transport.retained
            || transport.current().is_err()
            || transport.connected.prepare_reuse().is_err()
        {
            transport.retire();
            return;
        }
        let now = Instant::now();
        let mut idle = self.pool.idle.lock().unwrap_or_else(|p| p.into_inner());
        if self.pool.cancel.is_cancelled() {
            transport.retire();
            return;
        }
        // The completed operation no longer pays for an otherwise idle socket.
        transport.host_lease.idle();
        transport
            .idle_deadline
            .send_replace(Some(now + IDLE_TIMEOUT));
        while idle.len() >= IDLE_CAPACITY {
            idle.pop_front();
        }
        idle.push_back(Idle {
            since: now,
            transport: Arc::clone(transport),
        });
        self.retire_on_drop = false;
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        if self.retire_on_drop {
            self.transport.retire();
        }
    }
}

impl Pool {
    pub(super) fn new(run: RunId, cancel: CancellationToken) -> Arc<Self> {
        Arc::new(Self {
            run,
            cancel,
            capacity: Arc::new(Semaphore::new(PHYSICAL_CAPACITY)),
            idle: Mutex::new(VecDeque::new()),
            tasks: TaskTracker::new(),
        })
    }

    pub(super) fn prune(&self) {
        let now = Instant::now();
        self.idle
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .retain(|idle| {
                now.duration_since(idle.since) < IDLE_TIMEOUT && idle.transport.current().is_ok()
            });
    }

    pub(super) async fn shutdown(&self) {
        self.cancel.cancel();
        self.idle.lock().unwrap_or_else(|p| p.into_inner()).clear();
        self.tasks.close();
        self.tasks.wait().await;
    }

    pub(super) async fn acquire(
        self: &Arc<Self>,
        runtime: &SshRuntime,
        request: Request,
        scope: &Scope,
        observation: &mut Attempt,
    ) -> Result<Lease, FailureReason> {
        scope.check()?;
        request.access.check()?;
        self.prune();
        if request.retained {
            let generation = generation(&request.credential)?;
            let found = {
                let mut idle = self.idle.lock().unwrap_or_else(|p| p.into_inner());
                // A fresh authoritative generation cannot reuse an older idle snapshot.
                idle.retain(|entry| {
                    entry.transport.connection != request.connection
                        || generation_matches(&entry.transport.credential, generation)
                });
                idle.iter()
                    .position(|entry| entry.transport.connection == request.connection)
                    .and_then(|index| idle.remove(index))
            };
            if let Some(idle) = found {
                let lease = Lease {
                    pool: Arc::clone(self),
                    transport: idle.transport,
                    retire_on_drop: true,
                };
                let transport = &lease.transport;
                transport.current()?;
                transport.host_lease.activate(request.operation)?;
                transport.idle_deadline.send_replace(None);
                scope.check()?;
                request.access.check()?;
                observation.connecting = false;
                return Ok(lease);
            }
        }

        let physical = scope
            .wait(Arc::clone(&self.capacity).acquire_owned())
            .await?
            .map_err(|_| FailureReason::ResourceExhausted)?;
        let host_lease = HostLease::new(request.operation, physical);
        let transport_scope = Scope {
            cancelled: self.cancel.child_token(),
            sandbox_cancelled: scope.sandbox_cancelled.clone(),
            deadline: Instant::now() + LIFETIME,
        };
        let access_cancelled = request.access.cancelled();
        let cancel_setup = transport_scope.cancelled.clone().drop_guard();
        let connect = async {
            let stream = runtime
                .open_socket(
                    Arc::clone(&host_lease),
                    &request.credential.host,
                    request.credential.port,
                    scope,
                )
                .await?;
            transport_scope.check()?;
            request.access.check()?;
            let mut config = engine::config();
            config.inactivity_timeout = None;
            config.keepalive_interval = Some(Duration::from_secs(30));
            config.keepalive_max = 3;
            engine::Execution {
                authority: Arc::clone(&runtime.authority),
                run: self.run,
                connection: request.connection,
                lease: Arc::clone(&host_lease),
                credential: Arc::clone(&request.credential),
            }
            .connect(stream, scope, &transport_scope, config, observation)
            .await
        };
        let connected = tokio::select! { biased;
            () = access_cancelled.cancelled(), if request.retained => Err(FailureReason::ConfigurationChanged),
            result = connect => result,
        }?;
        let (idle_deadline, _) = watch::channel(None);
        let transport = Arc::new(Transport {
            connection: request.connection,
            credential: request.credential,
            access: request.access,
            connected,
            scope: transport_scope,
            host_lease,
            retained: request.retained,
            idle_deadline,
        });
        let lease = Lease {
            pool: Arc::clone(self),
            transport: Arc::clone(&transport),
            retire_on_drop: true,
        };
        transport.current()?;
        self.monitor(&transport);
        let _ = cancel_setup.disarm();
        Ok(lease)
    }

    fn monitor(self: &Arc<Self>, transport: &Arc<Transport>) {
        let pool = Arc::downgrade(self);
        let weak = Arc::downgrade(transport);
        let scope = transport.scope.clone();
        let cancelled = transport.access.cancelled();
        let retained = transport.retained;
        let mut idle = transport.idle_deadline.subscribe();
        self.tasks.spawn(async move {
            let mut idle_deadline = *idle.borrow_and_update();
            loop {
                let deadline = idle_deadline.unwrap_or(scope.deadline).min(scope.deadline);
                tokio::select! { biased;
                    () = scope.cancelled.cancelled() => break,
                    () = scope.sandbox_cancelled.cancelled() => break,
                    () = cancelled.cancelled(), if retained => break,
                    changed = idle.changed() => {
                        if changed.is_err() { break; }
                        idle_deadline = *idle.borrow_and_update();
                    }
                    () = tokio::time::sleep_until(deadline) => {
                        if Instant::now() >= scope.deadline {
                            break;
                        }
                        let Some(pool) = pool.upgrade() else { break; };
                        // A selected idle timeout may race checkout or a newer idle period.
                        // Retire only entries still idle and expired under the checkout lock.
                        pool.prune();
                        // Checkout may have removed the entry before publishing its new deadline.
                        // Consume this expiry once, then await that change or lifecycle cancellation.
                        idle_deadline = None;
                    }
                }
            }
            if let Some(transport) = weak.upgrade() {
                transport.retire();
            }
        });
    }
}

fn generation(credential: &PreparedCredential) -> Result<i64, FailureReason> {
    Ok(credential
        .trust
        .lock()
        .map_err(|_| FailureReason::Protocol)?
        .generation)
}

fn generation_matches(credential: &PreparedCredential, expected: i64) -> bool {
    generation(credential).is_ok_and(|generation| generation == expected)
}
