use runner_network::NetworkError;
use runner_network::proxy::{
    ConnectorRuntimeFailCloseOutcome, ConnectorRuntimePublication,
    ConnectorRuntimeRegistryTransaction, ProxyRegistryHandle, RegistryPublication,
};
use runner_types::types::ConnectorRuntimeTarget;

#[derive(Clone)]
pub(crate) struct ProviderRegistryAdapter(pub ProxyRegistryHandle);

struct ProviderTransactionAdapter(ConnectorRuntimeRegistryTransaction);
struct ProviderPublicationReceipt(RegistryPublication);

fn provider_registry_error(error: NetworkError) -> runner_provider::ProviderError {
    match error {
        NetworkError::Config(message) => runner_provider::ProviderError::Config(message),
        NetworkError::Internal(message) => runner_provider::ProviderError::Internal(message),
        NetworkError::Io(error) => runner_provider::ProviderError::Io(error),
    }
}

fn provider_registry_publication<T>(
    publication: ConnectorRuntimePublication<T>,
) -> runner_provider::ConnectorRuntimePublication<T> {
    runner_provider::ConnectorRuntimePublication {
        outcomes: publication.outcomes,
        publication: publication.publication.map(|receipt| {
            Box::new(ProviderPublicationReceipt(receipt))
                as Box<dyn runner_provider::RegistryPublicationReceipt>
        }),
    }
}

#[async_trait::async_trait]
impl runner_provider::RegistryPublicationReceipt for ProviderPublicationReceipt {
    async fn observe(self: Box<Self>) {
        self.0.observe().await;
    }
}

#[async_trait::async_trait]
impl runner_provider::ConnectorRuntimeRegistry for ProviderRegistryAdapter {
    async fn begin_transaction(
        &self,
    ) -> runner_provider::ProviderResult<
        Box<dyn runner_provider::ConnectorRuntimeRegistryTransaction>,
    > {
        self.0
            .connector_runtime_registry_transaction()
            .await
            .map(|transaction| {
                Box::new(ProviderTransactionAdapter(transaction))
                    as Box<dyn runner_provider::ConnectorRuntimeRegistryTransaction>
            })
            .map_err(provider_registry_error)
    }
}

#[async_trait::async_trait]
impl runner_provider::ConnectorRuntimeRegistryTransaction for ProviderTransactionAdapter {
    async fn apply_updates_if_run_matches(
        self: Box<Self>,
        source_ip: &str,
        run_id: &str,
        updates: &[runner_provider::ConnectorRuntimeRegistryUpdate],
    ) -> runner_provider::ProviderResult<Option<runner_provider::ConnectorRuntimePublication<bool>>>
    {
        self.0
            .apply_updates_if_run_matches(source_ip, run_id, updates)
            .await
            .map(|publication| publication.map(provider_registry_publication))
            .map_err(provider_registry_error)
    }

    async fn fail_closed_targets_if_run_matches(
        self: Box<Self>,
        source_ip: &str,
        run_id: &str,
        targets: &[ConnectorRuntimeTarget],
    ) -> runner_provider::ProviderResult<
        Option<
            runner_provider::ConnectorRuntimePublication<
                runner_provider::ConnectorRuntimeFailCloseOutcome,
            >,
        >,
    > {
        self.0
            .fail_closed_targets_if_run_matches(source_ip, run_id, targets)
            .await
            .map(|publication| {
                publication.map(|publication| {
                    let publication = ConnectorRuntimePublication {
                        outcomes: publication
                            .outcomes
                            .into_iter()
                            .map(|outcome| match outcome {
                                ConnectorRuntimeFailCloseOutcome::Applied => {
                                    runner_provider::ConnectorRuntimeFailCloseOutcome::Applied
                                }
                                ConnectorRuntimeFailCloseOutcome::Unchanged => {
                                    runner_provider::ConnectorRuntimeFailCloseOutcome::Unchanged
                                }
                                ConnectorRuntimeFailCloseOutcome::Failed(error) => {
                                    runner_provider::ConnectorRuntimeFailCloseOutcome::Failed(
                                        provider_registry_error(error),
                                    )
                                }
                            })
                            .collect(),
                        publication: publication.publication,
                    };
                    provider_registry_publication(publication)
                })
            })
            .map_err(provider_registry_error)
    }
}
