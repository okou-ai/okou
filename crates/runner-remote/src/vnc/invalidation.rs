//! Cancellation custody for pending and admitted VNC work, never cached authority.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::{Failure, authority::Transport, kerberos::Binding, sessions::Session};

#[cfg(test)]
mod tests;

pub(super) type Registry = Arc<Mutex<Entries>>;

#[derive(Default)]
pub(super) struct Entries {
    pub(super) sessions: HashMap<Uuid, Arc<Session>>,
    starting: HashMap<Uuid, Pending>,
}

struct Pending {
    connection: Uuid,
    ssh: [Option<Uuid>; 2],
    cancel: CancellationToken,
}

fn ssh_connection(transport: Transport) -> Option<Uuid> {
    match transport {
        Transport::Direct => None,
        Transport::Ssh { connection, .. } => Some(connection),
    }
}

fn dependencies(transport: Transport, kerberos: Option<Binding>) -> [Option<Uuid>; 2] {
    [
        ssh_connection(transport),
        kerberos
            .and_then(|binding| binding.kdc)
            .and_then(ssh_connection),
    ]
}

fn affected_ssh(routes: [Option<Uuid>; 2], connection: Option<Uuid>) -> bool {
    routes
        .into_iter()
        .flatten()
        .any(|route| connection.is_none_or(|connection| route == connection))
}

impl Entries {
    pub(super) fn invalidate(&self, connection: Option<Uuid>, ssh: bool) {
        for pending in self.starting.values() {
            let affected = if ssh {
                affected_ssh(pending.ssh, connection)
            } else {
                connection.is_none_or(|connection| connection == pending.connection)
            };
            if affected {
                pending.cancel.cancel();
            }
        }
        for session in self.sessions.values() {
            let affected = if ssh {
                affected_ssh(
                    dependencies(session.transport, session.kerberos),
                    connection,
                )
            } else {
                connection.is_none_or(|connection| connection == session.info.connection_id)
            };
            if affected {
                session.cancel.cancel();
            }
        }
    }
}

/// A start is visible to notifications before its first authority await.
pub(super) struct Admission {
    registry: Registry,
    id: Uuid,
    cancel: CancellationToken,
}

impl Admission {
    pub(super) fn new(
        registry: Registry,
        connection: Uuid,
        cancel: CancellationToken,
    ) -> Result<Self, Failure> {
        let id = Uuid::new_v4();
        registry
            .lock()
            .map_err(|_| Failure::Protocol)?
            .starting
            .insert(
                id,
                Pending {
                    connection,
                    ssh: [None, None],
                    cancel: cancel.clone(),
                },
            );
        Ok(Self {
            registry,
            id,
            cancel,
        })
    }

    pub(super) fn bind(
        &self,
        transport: Transport,
        kerberos: Option<Binding>,
    ) -> Result<(), Failure> {
        let mut entries = self.registry.lock().map_err(|_| Failure::Protocol)?;
        let pending = entries
            .starting
            .get_mut(&self.id)
            .ok_or(Failure::Cancelled)?;
        if self.cancel.is_cancelled() {
            return Err(Failure::Cancelled);
        }
        // Before routes are known, the final current-authority check fences
        // changes made during resolve. Bind before opening either route.
        pending.ssh = dependencies(transport, kerberos);
        Ok(())
    }

    pub(super) fn admit(&self, session: Arc<Session>) -> Result<(), Failure> {
        let mut entries = self.registry.lock().map_err(|_| Failure::Protocol)?;
        if self.cancel.is_cancelled() || !entries.starting.contains_key(&self.id) {
            return Err(Failure::Cancelled);
        }
        entries.sessions.insert(session.info.session_id, session);
        entries.starting.remove(&self.id);
        Ok(())
    }
}

impl Drop for Admission {
    fn drop(&mut self) {
        if let Ok(mut entries) = self.registry.lock() {
            entries.starting.remove(&self.id);
        }
    }
}
