//! Bounded, typed evidence without credentials, streams, leases or native owners.

mod rpc;
#[cfg(test)]
mod tests;
pub(crate) mod text;
pub(crate) mod trace;

use std::sync::atomic::{AtomicBool, Ordering};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex, Weak},
};

use chrono::{DateTime, Utc};
use runner_types::ids::RunId;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub(crate) use rpc::Authority;
const CAPACITY: usize = 64;
const MAX_REPORT_BYTES: usize = 8192;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Protocol {
    Ssh,
    Vnc,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Operation {
    Exec,
    Session,
    File,
    Forwarding,
    Start,
    Capture,
    Input,
    Retirement,
    Native,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(tag = "source", content = "code", rename_all = "snake_case")]
pub(crate) enum Cause {
    Ssh(crate::ssh::FailureReason),
    File(crate::ssh::FileFailure),
    Vnc(crate::vnc::Failure),
    Native(crate::tailscale::Failure),
}

#[derive(Clone, Default)]
pub(crate) struct Identity {
    pub(crate) created_at: Option<DateTime<Utc>>,
    pub(crate) generation: Option<i64>,
    pub(crate) session: Option<Uuid>,
}

#[derive(Clone, Serialize)]
pub(crate) struct Dependency {
    pub(crate) protocol: Protocol,
    pub(crate) connection_id: Uuid,
    pub(crate) cause: Option<Cause>,
    pub(crate) configuration_created_at: Option<DateTime<Utc>>,
    pub(crate) configuration_generation: Option<i64>,
}

/// Only finite values. This receipt neither owns nor refers back to Completion.
pub(crate) struct NativeEvidence {
    pub(crate) resource_id: Uuid,
    state: Mutex<NativeSnapshot>,
    watchers: Mutex<Vec<NativeWatch>>,
}

#[derive(Clone, Copy, Default, Serialize)]
pub(crate) struct NativeSnapshot {
    ready: bool,
    terminal: Option<crate::tailscale::Failure>,
    cleanup_complete: bool,
    cleanup_failure: Option<crate::tailscale::Failure>,
}

impl Serialize for NativeEvidence {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .serialize(serializer)
    }
}

impl NativeEvidence {
    pub(crate) fn new() -> Self {
        Self {
            resource_id: Uuid::new_v4(),
            state: Mutex::new(NativeSnapshot::default()),
            watchers: Mutex::new(Vec::new()),
        }
    }
    pub(crate) fn ready(&self) {
        self.state.lock().unwrap_or_else(|p| p.into_inner()).ready = true;
    }
    pub(crate) fn terminal(&self) -> Option<crate::tailscale::Failure> {
        self.state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .terminal
    }
    pub(crate) fn observe(self: &Arc<Self>, watch: NativeWatch) {
        let mut watchers = self.watchers.lock().unwrap_or_else(|p| p.into_inner());
        watchers.retain(NativeWatch::active);
        if watchers
            .iter()
            .any(|existing| existing.same_subject(&watch))
        {
            return;
        }
        if let Some(failure) = self.terminal() {
            watch.failed(self, failure);
        }
        if watchers.len() == 64 {
            watchers.remove(0);
        }
        watchers.push(watch);
    }
    pub(crate) fn terminate(
        self: &Arc<Self>,
        failure: crate::tailscale::Failure,
    ) -> crate::tailscale::Failure {
        let watchers = self.watchers.lock().unwrap_or_else(|p| p.into_inner());
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(first) = state.terminal {
            return first;
        }
        state.terminal = Some(failure);
        drop(state);
        for watch in watchers.iter() {
            watch.failed(self, failure);
        }
        failure
    }
    pub(crate) fn cleanup(&self, result: Result<(), crate::tailscale::Failure>) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.cleanup_complete = true;
        state.cleanup_failure = result.err();
    }
}

#[derive(Clone, Serialize)]
pub(crate) struct NativeSource {
    pub(crate) configuration_id: Uuid,
    pub(crate) generation: i64,
    pub(crate) resource_id: Uuid,
    #[serde(serialize_with = "serialize_evidence")]
    pub(crate) evidence: Arc<NativeEvidence>,
}

fn serialize_evidence<S: serde::Serializer>(
    value: &Arc<NativeEvidence>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    value.as_ref().serialize(serializer)
}

#[derive(Clone, Serialize)]
pub(crate) struct Report {
    schema_version: u8,
    run_id: RunId,
    assignment_id: Uuid,
    pub(crate) attempt_id: Uuid,
    sequence: u64,
    observed_at: DateTime<Utc>,
    pub(crate) protocol: Protocol,
    pub(crate) connection_id: Uuid,
    pub(crate) session_id: Option<Uuid>,
    configuration_created_at: Option<DateTime<Utc>>,
    configuration_generation: Option<i64>,
    operation: Operation,
    stage: Stage,
    cause: Cause,
    pub(crate) dependencies: Vec<Dependency>,
    native: Option<NativeSource>,
    #[serde(skip)]
    ssh: Option<trace::Snapshot>,
    // Finer stages are deliberately not inferred from an operation's final code.
    detail: Detail,
    truncated: bool,
}

pub(crate) struct Record {
    pub(crate) protocol: Protocol,
    pub(crate) connection: Uuid,
    pub(crate) operation: Operation,
    pub(crate) identity: Identity,
    pub(crate) cause: Cause,
    pub(crate) dependency: Option<Dependency>,
    pub(crate) native: Option<NativeSource>,
    pub(crate) ssh: Option<trace::Snapshot>,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum Detail {
    NotObserved,
    Partial,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum Stage {
    SshOperation,
    VncOperation,
    NativeRuntime,
}

#[derive(Default)]
struct State {
    assignment: Uuid,
    sequence: u64,
    reports: VecDeque<Report>,
    latest_ssh: Option<Report>,
    latest_vnc: Option<Report>,
    evicted: u64,
}

struct Store {
    run: RunId,
    state: Mutex<State>,
}

#[derive(Clone)]
pub(crate) struct Handle {
    store: Arc<Store>,
    assignment: Uuid,
    enabled: bool,
}

pub(crate) struct NativeWatch {
    store: Weak<Store>,
    assignment: Uuid,
    connection: Uuid,
    identity: Identity,
    configuration: Uuid,
    generation: i64,
    protocol: Protocol,
    ssh_dependency: Option<Dependency>,
    active: Weak<AtomicBool>,
}

impl NativeWatch {
    fn active(&self) -> bool {
        self.active
            .upgrade()
            .is_some_and(|active| active.load(Ordering::Acquire))
    }
    pub(crate) fn same_subject(&self, other: &Self) -> bool {
        self.assignment == other.assignment
            && self.connection == other.connection
            && self.protocol == other.protocol
            && self.identity.created_at == other.identity.created_at
            && self.identity.generation == other.identity.generation
            && self.identity.session == other.identity.session
    }
    pub(crate) fn failed(
        &self,
        evidence: &Arc<NativeEvidence>,
        failure: crate::tailscale::Failure,
    ) {
        if failure == crate::tailscale::Failure::Cancelled || !self.active() {
            return;
        }
        if let Some(store) = self.store.upgrade() {
            let handle = Handle {
                store,
                assignment: self.assignment,
                enabled: true,
            };
            let _ = handle.record(Record {
                protocol: self.protocol,
                connection: self.connection,
                operation: Operation::Native,
                identity: self.identity.clone(),
                cause: Cause::Native(failure),
                dependency: self.ssh_dependency.clone().map(|mut dependency| {
                    dependency.cause = Some(Cause::Native(failure));
                    dependency
                }),
                native: Some(NativeSource {
                    configuration_id: self.configuration,
                    generation: self.generation,
                    resource_id: evidence.resource_id,
                    evidence: Arc::clone(evidence),
                }),
                ssh: None,
            });
        }
    }
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Selector {
    pub(crate) connection_id: Option<Uuid>,
    pub(crate) attempt_id: Option<Uuid>,
    pub(crate) session_id: Option<Uuid>,
}

impl Handle {
    pub(crate) fn new(run: RunId, enabled: bool) -> Self {
        let assignment = Uuid::new_v4();
        Self {
            store: Arc::new(Store {
                run,
                state: Mutex::new(State {
                    assignment,
                    ..State::default()
                }),
            }),
            assignment,
            enabled,
        }
    }
    pub(crate) fn replacement(&self, enabled: bool) -> Self {
        let assignment = Uuid::new_v4();
        self.store
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .assignment = assignment;
        Self {
            store: Arc::clone(&self.store),
            assignment,
            enabled,
        }
    }
    pub(crate) fn enabled(&self) -> bool {
        self.enabled
    }
    pub(crate) fn current(&self) -> bool {
        self.store
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .assignment
            == self.assignment
    }
    pub(crate) fn watch(
        &self,
        connection: Uuid,
        identity: Identity,
        configuration: Uuid,
        generation: i64,
        active: &Arc<AtomicBool>,
    ) -> Option<NativeWatch> {
        self.enabled.then(|| NativeWatch {
            store: Arc::downgrade(&self.store),
            assignment: self.assignment,
            connection,
            identity,
            configuration,
            generation,
            protocol: Protocol::Ssh,
            ssh_dependency: None,
            active: Arc::downgrade(active),
        })
    }
    pub(crate) fn watch_vnc(
        &self,
        connection: Uuid,
        identity: Identity,
        source: &NativeSource,
        ssh: Dependency,
        active: &Arc<AtomicBool>,
    ) -> Option<NativeWatch> {
        let mut watch = self.watch(
            connection,
            identity,
            source.configuration_id,
            source.generation,
            active,
        )?;
        watch.protocol = Protocol::Vnc;
        watch.ssh_dependency = Some(ssh);
        Some(watch)
    }
    pub(crate) fn record(&self, record: Record) -> Option<Report> {
        let Record {
            protocol,
            connection,
            operation,
            identity,
            cause,
            dependency,
            native,
            ssh,
        } = record;
        if !self.enabled {
            return None;
        }
        let mut state = self.store.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.assignment != self.assignment {
            return None;
        }
        state.sequence = state.sequence.saturating_add(1).min((1 << 53) - 1);
        let report = Report {
            schema_version: 1,
            run_id: self.store.run,
            assignment_id: self.assignment,
            attempt_id: Uuid::new_v4(),
            sequence: state.sequence,
            observed_at: Utc::now(),
            protocol,
            connection_id: connection,
            session_id: identity.session,
            configuration_created_at: identity.created_at,
            configuration_generation: identity.generation,
            operation,
            stage: match cause {
                Cause::Native(_) => Stage::NativeRuntime,
                _ => match protocol {
                    Protocol::Ssh => Stage::SshOperation,
                    Protocol::Vnc => Stage::VncOperation,
                },
            },
            cause,
            dependencies: dependency.into_iter().collect(),
            native,
            detail: if ssh.is_some() {
                Detail::Partial
            } else {
                Detail::NotObserved
            },
            ssh,
            truncated: false,
        };
        // The schema has no unbounded strings or collections; keep a hard guard as it evolves.
        if !report
            .evidence()
            .and_then(|value| serde_json::to_vec(&value).ok())
            .is_some_and(|bytes| bytes.len() <= MAX_REPORT_BYTES)
        {
            return None;
        }
        match protocol {
            Protocol::Ssh => state.latest_ssh = Some(report.clone()),
            Protocol::Vnc => state.latest_vnc = Some(report.clone()),
        }
        if state.reports.len() == CAPACITY {
            state.reports.pop_front();
            state.evicted = state.evicted.saturating_add(1);
        }
        state.reports.push_back(report.clone());
        drop(state);
        if let Some(value) = report.evidence() {
            tracing::info!(diagnostic = %value, "Remote operation failure retained");
        }
        Some(report)
    }
    fn select(&self, protocol: Protocol, selector: &Selector) -> Option<Report> {
        let state = self.store.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.assignment != self.assignment {
            return None;
        }
        let latest = match protocol {
            Protocol::Ssh => &state.latest_ssh,
            Protocol::Vnc => &state.latest_vnc,
        };
        if selector.connection_id.is_none()
            && selector.attempt_id.is_none()
            && selector.session_id.is_none()
        {
            return latest.clone();
        }
        let matches = |r: &&Report| {
            r.protocol == protocol
                && selector
                    .connection_id
                    .is_none_or(|id| r.connection_id == id)
                && selector.attempt_id.is_none_or(|id| r.attempt_id == id)
                && selector
                    .session_id
                    .is_none_or(|id| r.session_id == Some(id))
        };
        state
            .reports
            .iter()
            .rev()
            .chain(latest.iter())
            .find(matches)
            .cloned()
    }
}
