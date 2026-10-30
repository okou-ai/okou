//! Test-only provider-port adapter over the canonical network registry.
//!
//! Schema, validation, policy mutation, persistence and receipt observation all
//! stay in runner-network. The controls below only synchronize provider tests at
//! the transaction boundary; they do not implement registry behavior.

use std::ops::Deref;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use runner_network::NetworkError;
pub(crate) use runner_network::proxy::SandboxRegistration;
use runner_network::proxy::{
    ConnectorRuntimeFailCloseOutcome as NetworkFailCloseOutcome,
    ConnectorRuntimePublication as NetworkPublication,
    ConnectorRuntimeRegistryTransaction as NetworkTransaction,
    ProxyRegistryHandle as NetworkRegistry, RegistryPublication,
};
use runner_types::types::ConnectorRuntimeTarget;
use tokio::sync::oneshot;

use crate::{
    ConnectorRuntimeFailCloseOutcome, ConnectorRuntimePublication, ConnectorRuntimeRegistry,
    ConnectorRuntimeRegistryTransaction, ConnectorRuntimeRegistryUpdate, ProviderError,
    ProviderResult, RegistryPublicationReceipt,
};

pub(crate) type ProxyRegistryHandle = Arc<TestProxyRegistry>;

pub(crate) struct TestProxyRegistry {
    inner: NetworkRegistry,
    update_attempt_tx: Mutex<Option<tokio::sync::mpsc::UnboundedSender<()>>>,
    transaction_gate: Mutex<Option<TransactionGate>>,
}

struct TestRegistryTransaction {
    inner: NetworkTransaction,
    gate: Option<TransactionGate>,
}

struct TestPublicationReceipt(RegistryPublication);

struct TransactionGate {
    entered: oneshot::Sender<()>,
    release: oneshot::Receiver<()>,
    settled: oneshot::Sender<()>,
}

/// Pauses delegation after the canonical transaction has acquired its flock.
pub(crate) struct RegistryTransactionGate {
    entered: oneshot::Receiver<()>,
    release: oneshot::Sender<()>,
    settled: oneshot::Receiver<()>,
}

impl RegistryTransactionGate {
    pub(crate) async fn wait_entered(&mut self) {
        tokio::time::timeout(Duration::from_secs(5), &mut self.entered)
            .await
            .expect("registry transaction should start")
            .expect("registry transaction should signal entry");
    }

    pub(crate) async fn finish(self) {
        drop(self.release);
        tokio::time::timeout(Duration::from_secs(5), self.settled)
            .await
            .expect("registry transaction should settle")
            .expect("registry transaction should signal completion");
    }
}

async fn enter_transaction_gate(gate: Option<TransactionGate>) -> Option<oneshot::Sender<()>> {
    let gate = gate?;
    let _ = gate.entered.send(());
    let _ = gate.release.await;
    Some(gate.settled)
}

fn settle_transaction_gate(settled: Option<oneshot::Sender<()>>) {
    if let Some(settled) = settled {
        let _ = settled.send(());
    }
}

impl Deref for TestProxyRegistry {
    type Target = NetworkRegistry;

    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}

impl TestProxyRegistry {
    pub(crate) fn new(registry_path: PathBuf, lock_path: PathBuf) -> ProxyRegistryHandle {
        Arc::new(Self {
            inner: NetworkRegistry::new(registry_path, lock_path),
            update_attempt_tx: Mutex::new(None),
            transaction_gate: Mutex::new(None),
        })
    }

    pub(crate) fn with_connector_runtime_update_attempt_tx(
        self: Arc<Self>,
        tx: tokio::sync::mpsc::UnboundedSender<()>,
    ) -> Arc<Self> {
        *self.update_attempt_tx.lock().unwrap() = Some(tx);
        self
    }

    pub(crate) fn gate_next_transaction(&self) -> RegistryTransactionGate {
        let (entered_tx, entered) = oneshot::channel();
        let (release, release_rx) = oneshot::channel();
        let (settled_tx, settled) = oneshot::channel();
        let previous = self
            .transaction_gate
            .lock()
            .unwrap()
            .replace(TransactionGate {
                entered: entered_tx,
                release: release_rx,
                settled: settled_tx,
            });
        assert!(previous.is_none(), "only one gate may own a transaction");
        RegistryTransactionGate {
            entered,
            release,
            settled,
        }
    }
}

fn provider_registry_error(error: NetworkError) -> ProviderError {
    match error {
        NetworkError::Config(message) => ProviderError::Config(message),
        NetworkError::Internal(message) => ProviderError::Internal(message),
        NetworkError::Io(error) => ProviderError::Io(error),
    }
}

fn provider_registry_publication<T>(
    publication: NetworkPublication<T>,
) -> ConnectorRuntimePublication<T> {
    ConnectorRuntimePublication {
        outcomes: publication.outcomes,
        publication: publication.publication.map(|receipt| {
            Box::new(TestPublicationReceipt(receipt)) as Box<dyn RegistryPublicationReceipt>
        }),
    }
}

#[async_trait]
impl RegistryPublicationReceipt for TestPublicationReceipt {
    async fn observe(self: Box<Self>) {
        self.0.observe().await;
    }
}

#[async_trait]
impl ConnectorRuntimeRegistry for TestProxyRegistry {
    async fn begin_transaction(
        &self,
    ) -> ProviderResult<Box<dyn ConnectorRuntimeRegistryTransaction>> {
        if let Some(tx) = self.update_attempt_tx.lock().unwrap().as_ref() {
            tx.send(())
                .expect("connector runtime update observer should remain available");
        }
        let inner = self
            .inner
            .connector_runtime_registry_transaction()
            .await
            .map_err(provider_registry_error)?;
        Ok(Box::new(TestRegistryTransaction {
            inner,
            gate: self.transaction_gate.lock().unwrap().take(),
        }))
    }
}

#[async_trait]
impl ConnectorRuntimeRegistryTransaction for TestRegistryTransaction {
    async fn apply_updates_if_run_matches(
        self: Box<Self>,
        source_ip: &str,
        run_id: &str,
        updates: &[ConnectorRuntimeRegistryUpdate],
    ) -> ProviderResult<Option<ConnectorRuntimePublication<bool>>> {
        let settled = enter_transaction_gate(self.gate).await;
        let result = self
            .inner
            .apply_updates_if_run_matches(source_ip, run_id, updates)
            .await
            .map(|publication| publication.map(provider_registry_publication))
            .map_err(provider_registry_error);
        settle_transaction_gate(settled);
        result
    }

    async fn fail_closed_targets_if_run_matches(
        self: Box<Self>,
        source_ip: &str,
        run_id: &str,
        targets: &[ConnectorRuntimeTarget],
    ) -> ProviderResult<Option<ConnectorRuntimePublication<ConnectorRuntimeFailCloseOutcome>>> {
        let settled = enter_transaction_gate(self.gate).await;
        let result = self
            .inner
            .fail_closed_targets_if_run_matches(source_ip, run_id, targets)
            .await
            .map(|publication| {
                publication.map(|publication| {
                    provider_registry_publication(NetworkPublication {
                        outcomes: publication
                            .outcomes
                            .into_iter()
                            .map(|outcome| match outcome {
                                NetworkFailCloseOutcome::Applied => {
                                    ConnectorRuntimeFailCloseOutcome::Applied
                                }
                                NetworkFailCloseOutcome::Unchanged => {
                                    ConnectorRuntimeFailCloseOutcome::Unchanged
                                }
                                NetworkFailCloseOutcome::Failed(error) => {
                                    ConnectorRuntimeFailCloseOutcome::Failed(
                                        provider_registry_error(error),
                                    )
                                }
                            })
                            .collect(),
                        publication: publication.publication,
                    })
                })
            })
            .map_err(provider_registry_error);
        settle_transaction_gate(settled);
        result
    }
}
