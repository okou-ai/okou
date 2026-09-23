//! Test registry adapter for exercising provider-owned connector synchronization.
//!
//! Production uses Runner's proxy-registry adapter through the public registry
//! port. This module intentionally exists only in provider unit tests so those
//! tests can verify orchestration without creating a dependency cycle.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use nix::fcntl::Flock;
use runner_types::types::{
    ConnectorRuntimeTarget, ConnectorRuntimeTargetRegistration, FirewallEntry, NetworkPolicy,
    SecretConnectorMetadata,
};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::{
    ConnectorRuntimeFailCloseOutcome, ConnectorRuntimePublication, ConnectorRuntimeRegistry,
    ConnectorRuntimeRegistryTransaction, ConnectorRuntimeRegistryUpdate,
    CustomConnectorRuntimeRegistryState, ProviderError, ProviderResult, RegistryPublicationReceipt,
};

pub(crate) mod write_test {
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use std::sync::{LazyLock, Mutex};
    use std::time::Duration;

    use tokio::sync::oneshot;

    static GATES: LazyLock<Mutex<HashMap<PathBuf, WriteOperation>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));

    struct WriteOperation {
        entered: oneshot::Sender<()>,
        release: oneshot::Receiver<()>,
        settled: oneshot::Sender<()>,
    }

    pub(crate) struct RegistryWriteGate {
        path: PathBuf,
        entered: oneshot::Receiver<()>,
        release: Option<oneshot::Sender<()>>,
        settled: oneshot::Receiver<()>,
    }

    impl RegistryWriteGate {
        pub(crate) fn new(path: &Path) -> Self {
            let (entered_tx, entered) = oneshot::channel();
            let (release, release_rx) = oneshot::channel();
            let (settled_tx, settled) = oneshot::channel();
            let previous = GATES.lock().unwrap().insert(
                path.to_path_buf(),
                WriteOperation {
                    entered: entered_tx,
                    release: release_rx,
                    settled: settled_tx,
                },
            );
            assert!(previous.is_none(), "only one write gate may own a path");
            Self {
                path: path.to_path_buf(),
                entered,
                release: Some(release),
                settled,
            }
        }

        pub(crate) async fn wait_entered(&mut self) {
            tokio::time::timeout(Duration::from_secs(5), &mut self.entered)
                .await
                .expect("registry write should start")
                .expect("registry write should signal entry");
        }

        pub(crate) async fn finish(mut self) {
            drop(self.release.take());
            tokio::time::timeout(Duration::from_secs(5), &mut self.settled)
                .await
                .expect("registry write should settle")
                .expect("registry write should signal completion");
        }
    }

    impl Drop for RegistryWriteGate {
        fn drop(&mut self) {
            GATES.lock().unwrap().remove(&self.path);
        }
    }

    pub(super) async fn enter(path: &Path) -> Option<oneshot::Sender<()>> {
        let operation = GATES.lock().unwrap().remove(path)?;
        let _ = operation.entered.send(());
        let _ = operation.release.await;
        Some(operation.settled)
    }

    pub(super) fn settle(settled: Option<oneshot::Sender<()>>) {
        if let Some(settled) = settled {
            let _ = settled.send(());
        }
    }
}

pub(crate) use write_test::RegistryWriteGate;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TestRegistryFile {
    sandboxes: HashMap<String, TestSandboxEntry>,
    updated_at: i64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TestSandboxEntry {
    run_id: String,
    cli_agent_type: String,
    sandbox_token: String,
    registered_at: i64,
    network_log_path: String,
    proxy_log_path: String,
    firewalls: Option<Vec<FirewallEntry>>,
    network_policies: Option<HashMap<String, NetworkPolicy>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    connector_runtime_targets: Vec<ConnectorRuntimeTarget>,
    #[serde(default, skip_serializing_if = "HashSet::is_empty")]
    omitted_builtin_firewalls: HashSet<String>,
    #[serde(default, skip_serializing_if = "HashSet::is_empty")]
    omitted_custom_connector_ids: HashSet<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    connector_routing_variables: HashMap<String, HashMap<String, String>>,
    encrypted_secrets: Option<String>,
    secret_connector_map: Option<HashMap<String, String>>,
    secret_connector_metadata_map: Option<HashMap<String, SecretConnectorMetadata>>,
    vars: Option<HashMap<String, String>>,
    #[serde(default)]
    capture_network_bodies: bool,
    billable_firewalls: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model_usage_provider: Option<String>,
}

pub(crate) struct SandboxRegistration<'a> {
    pub run_id: &'a str,
    pub cli_agent_type: &'a str,
    pub sandbox_token: &'a str,
    pub network_log_path: &'a Path,
    pub proxy_log_path: &'a Path,
    pub firewalls: Option<&'a [FirewallEntry]>,
    pub network_policies: Option<&'a HashMap<String, NetworkPolicy>>,
    pub connector_runtime_targets: Option<&'a [ConnectorRuntimeTargetRegistration]>,
    pub encrypted_secrets: Option<&'a str>,
    pub secret_connector_map: Option<&'a HashMap<String, String>>,
    pub secret_connector_metadata_map: Option<&'a HashMap<String, SecretConnectorMetadata>>,
    pub vars: Option<&'a HashMap<String, String>>,
    pub capture_network_bodies: bool,
    pub billable_firewalls: &'a [String],
    pub model_usage_provider: Option<&'a str>,
}

#[derive(Clone)]
struct ControlTarget {
    directory: PathBuf,
    generation: String,
}

pub(crate) type ProxyRegistryHandle = Arc<TestProxyRegistry>;

pub(crate) struct TestProxyRegistry {
    registry_path: PathBuf,
    lock_path: PathBuf,
    control_target: Mutex<Option<ControlTarget>>,
    update_attempt_tx: Mutex<Option<tokio::sync::mpsc::UnboundedSender<()>>>,
}

struct TestRegistryTransaction {
    registry_path: PathBuf,
    control_target: Option<ControlTarget>,
    _guard: Flock<File>,
}

struct TestPublicationReceipt {
    target: Option<ControlTarget>,
}

impl TestProxyRegistry {
    pub(crate) fn new(registry_path: PathBuf, lock_path: PathBuf) -> ProxyRegistryHandle {
        Arc::new(Self {
            registry_path,
            lock_path,
            control_target: Mutex::new(None),
            update_attempt_tx: Mutex::new(None),
        })
    }

    pub(crate) fn set_control_target_for_test(&self, directory: PathBuf, generation: String) {
        *self.control_target.lock().unwrap() = Some(ControlTarget {
            directory,
            generation,
        });
    }

    pub(crate) fn with_connector_runtime_update_attempt_tx(
        self: Arc<Self>,
        tx: tokio::sync::mpsc::UnboundedSender<()>,
    ) -> Arc<Self> {
        *self.update_attempt_tx.lock().unwrap() = Some(tx);
        self
    }

    pub(crate) async fn register_sandbox(
        &self,
        source_ip: &str,
        registration: &SandboxRegistration<'_>,
    ) -> ProviderResult<()> {
        let _guard = runner_host::lock::acquire(self.lock_path.clone()).await?;
        let mut registry = read_registry(&self.registry_path).await?;
        let (omitted_builtin_firewalls, omitted_custom_connector_ids) =
            initial_omitted_connector_runtime_targets(registration);
        let connector_routing_variables = initial_connector_routing_variables(registration)?;
        registry.sandboxes.insert(
            source_ip.to_string(),
            TestSandboxEntry {
                run_id: registration.run_id.to_string(),
                cli_agent_type: registration.cli_agent_type.to_string(),
                sandbox_token: registration.sandbox_token.to_string(),
                registered_at: chrono::Utc::now().timestamp_millis(),
                network_log_path: registration.network_log_path.to_string_lossy().into_owned(),
                proxy_log_path: registration.proxy_log_path.to_string_lossy().into_owned(),
                firewalls: registration.firewalls.map(<[FirewallEntry]>::to_vec),
                network_policies: registration.network_policies.cloned(),
                connector_runtime_targets: registration
                    .connector_runtime_targets
                    .unwrap_or_default()
                    .iter()
                    .map(ConnectorRuntimeTargetRegistration::target)
                    .collect(),
                omitted_builtin_firewalls,
                omitted_custom_connector_ids,
                connector_routing_variables,
                encrypted_secrets: registration.encrypted_secrets.map(str::to_string),
                secret_connector_map: registration.secret_connector_map.cloned(),
                secret_connector_metadata_map: registration.secret_connector_metadata_map.cloned(),
                vars: registration.vars.cloned(),
                capture_network_bodies: registration.capture_network_bodies,
                billable_firewalls: registration.billable_firewalls.to_vec(),
                model_usage_provider: registration.model_usage_provider.map(str::to_string),
            },
        );
        registry.updated_at = chrono::Utc::now().timestamp_millis();
        write_registry(&self.registry_path, &registry).await
    }

    pub(crate) async fn unregister_sandbox(&self, source_ip: &str) -> ProviderResult<()> {
        let _guard = runner_host::lock::acquire(self.lock_path.clone()).await?;
        let mut registry = read_registry(&self.registry_path).await?;
        registry.sandboxes.remove(source_ip);
        registry.updated_at = chrono::Utc::now().timestamp_millis();
        write_registry(&self.registry_path, &registry).await
    }

    fn control_target(&self) -> Option<ControlTarget> {
        self.control_target.lock().unwrap().clone()
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
        let guard = runner_host::lock::acquire(self.lock_path.clone()).await?;
        Ok(Box::new(TestRegistryTransaction {
            registry_path: self.registry_path.clone(),
            control_target: self.control_target(),
            _guard: guard,
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
        let mut registry = read_registry(&self.registry_path).await?;
        let Some(sandbox) = registry.sandboxes.get_mut(source_ip) else {
            return Ok(None);
        };
        if sandbox.run_id != run_id {
            return Ok(None);
        }

        let previous = serde_json::to_vec(&sandbox).map_err(|error| {
            ProviderError::Internal(format!("serialize test sandbox snapshot: {error}"))
        })?;
        let outcomes = updates
            .iter()
            .map(|update| apply_connector_runtime_update(sandbox, update))
            .collect::<ProviderResult<Vec<_>>>()?;
        let changed = previous
            != serde_json::to_vec(&sandbox).map_err(|error| {
                ProviderError::Internal(format!("serialize updated test sandbox: {error}"))
            })?;
        let publication = if changed {
            registry.updated_at = chrono::Utc::now().timestamp_millis();
            write_registry(&self.registry_path, &registry).await?;
            tracing::info!(
                source_ip,
                run_id,
                update_count = updates.len(),
                "applied connector runtime updates to proxy registry"
            );
            Some(Box::new(TestPublicationReceipt {
                target: self.control_target.clone(),
            }) as Box<dyn RegistryPublicationReceipt>)
        } else {
            None
        };
        Ok(Some(ConnectorRuntimePublication {
            outcomes,
            publication,
        }))
    }

    async fn fail_closed_targets_if_run_matches(
        self: Box<Self>,
        source_ip: &str,
        run_id: &str,
        targets: &[ConnectorRuntimeTarget],
    ) -> ProviderResult<Option<ConnectorRuntimePublication<ConnectorRuntimeFailCloseOutcome>>> {
        let mut registry = read_registry(&self.registry_path).await?;
        let Some(sandbox) = registry.sandboxes.get_mut(source_ip) else {
            return Ok(None);
        };
        if sandbox.run_id != run_id {
            return Ok(None);
        }

        let outcomes = targets
            .iter()
            .map(|target| match target {
                ConnectorRuntimeTarget::Builtin { connector_slug } => {
                    if fail_closed_builtin(sandbox, connector_slug) {
                        ConnectorRuntimeFailCloseOutcome::Applied
                    } else {
                        ConnectorRuntimeFailCloseOutcome::Unchanged
                    }
                }
                ConnectorRuntimeTarget::Custom {
                    custom_connector_id,
                } => match fail_closed_custom(sandbox, custom_connector_id) {
                    Ok(true) => ConnectorRuntimeFailCloseOutcome::Applied,
                    Ok(false) => ConnectorRuntimeFailCloseOutcome::Unchanged,
                    Err(error) => ConnectorRuntimeFailCloseOutcome::Failed(error),
                },
            })
            .collect::<Vec<_>>();
        let changed = outcomes
            .iter()
            .any(|outcome| matches!(outcome, ConnectorRuntimeFailCloseOutcome::Applied));
        let publication = if changed {
            registry.updated_at = chrono::Utc::now().timestamp_millis();
            write_registry(&self.registry_path, &registry).await?;
            tracing::info!(
                source_ip,
                run_id,
                target_count = targets.len(),
                applied_count = outcomes
                    .iter()
                    .filter(|outcome| {
                        matches!(outcome, ConnectorRuntimeFailCloseOutcome::Applied)
                    })
                    .count(),
                failed_count = outcomes
                    .iter()
                    .filter(|outcome| {
                        matches!(outcome, ConnectorRuntimeFailCloseOutcome::Failed(_))
                    })
                    .count(),
                "failed closed connector runtime targets in proxy registry"
            );
            Some(Box::new(TestPublicationReceipt {
                target: self.control_target.clone(),
            }) as Box<dyn RegistryPublicationReceipt>)
        } else {
            None
        };
        Ok(Some(ConnectorRuntimePublication {
            outcomes,
            publication,
        }))
    }
}

#[async_trait]
impl RegistryPublicationReceipt for TestPublicationReceipt {
    async fn observe(self: Box<Self>) {
        let Some(target) = self.target else {
            return;
        };
        let Ok(mut stream) =
            tokio::net::UnixStream::connect(target.directory.join("control.sock")).await
        else {
            return;
        };
        let request = serde_json::json!({
            "requestId": uuid::Uuid::new_v4().to_string(),
            "generation": target.generation,
            "method": "registry.apply",
            "params": {"digest": "test"},
        });
        let Ok(bytes) = serde_json::to_vec(&request) else {
            return;
        };
        if stream.write_u32(bytes.len() as u32).await.is_err()
            || stream.write_all(&bytes).await.is_err()
        {
            return;
        }
        let Ok(size) = stream.read_u32().await else {
            return;
        };
        let mut response = vec![0; size as usize];
        let _ = stream.read_exact(&mut response).await;
    }
}

async fn read_registry(path: &Path) -> ProviderResult<TestRegistryFile> {
    let content = tokio::fs::read_to_string(path).await?;
    serde_json::from_str(&content)
        .map_err(|error| ProviderError::Internal(format!("parse test registry: {error}")))
}

async fn write_registry(path: &Path, registry: &TestRegistryFile) -> ProviderResult<()> {
    let bytes = serde_json::to_vec(registry)
        .map_err(|error| ProviderError::Internal(format!("serialize test registry: {error}")))?;
    let settled = write_test::enter(path).await;
    let result = runner_host::state_file::write_private_atomic(path, &bytes).await;
    write_test::settle(settled);
    result?;
    Ok(())
}

fn firewall_name(entry: &FirewallEntry) -> &str {
    match entry {
        FirewallEntry::Builtin { name, .. } => name,
        FirewallEntry::Inline { firewall, .. } => &firewall.name,
    }
}

fn custom_connector_owner(entry: &FirewallEntry) -> Option<&str> {
    match entry {
        FirewallEntry::Inline {
            custom_connector_id: Some(custom_connector_id),
            ..
        } => Some(custom_connector_id),
        FirewallEntry::Builtin { .. } | FirewallEntry::Inline { .. } => None,
    }
}

fn builtin_connector_routing_key(connector_slug: &str) -> String {
    format!("builtin:{connector_slug}")
}

fn custom_connector_routing_key(custom_connector_id: &str) -> String {
    format!("custom:{custom_connector_id}")
}

fn initial_omitted_connector_runtime_targets(
    registration: &SandboxRegistration<'_>,
) -> (HashSet<String>, HashSet<String>) {
    let active_builtin = registration
        .firewalls
        .unwrap_or_default()
        .iter()
        .filter_map(|firewall| match firewall {
            FirewallEntry::Builtin { name, .. } => Some(name.as_str()),
            FirewallEntry::Inline { .. } => None,
        })
        .collect::<HashSet<_>>();
    let active_custom = registration
        .firewalls
        .unwrap_or_default()
        .iter()
        .filter_map(custom_connector_owner)
        .collect::<HashSet<_>>();
    let mut omitted_builtin = HashSet::new();
    let mut omitted_custom = HashSet::new();
    for target in registration.connector_runtime_targets.unwrap_or_default() {
        match target {
            ConnectorRuntimeTargetRegistration::Builtin { connector_slug, .. }
                if !active_builtin.contains(connector_slug.as_str()) =>
            {
                omitted_builtin.insert(connector_slug.clone());
            }
            ConnectorRuntimeTargetRegistration::Custom {
                custom_connector_id,
                ..
            } if !active_custom.contains(custom_connector_id.as_str()) => {
                omitted_custom.insert(custom_connector_id.clone());
            }
            _ => {}
        }
    }
    (omitted_builtin, omitted_custom)
}

fn initial_connector_routing_variables(
    registration: &SandboxRegistration<'_>,
) -> ProviderResult<HashMap<String, HashMap<String, String>>> {
    let targets = registration.connector_runtime_targets.unwrap_or_default();
    let builtin_targets = targets
        .iter()
        .filter_map(|target| match target {
            ConnectorRuntimeTargetRegistration::Builtin { connector_slug, .. } => {
                Some(connector_slug.as_str())
            }
            ConnectorRuntimeTargetRegistration::Custom { .. } => None,
        })
        .collect::<HashSet<_>>();
    let active_custom = registration
        .firewalls
        .unwrap_or_default()
        .iter()
        .filter_map(custom_connector_owner)
        .collect::<HashSet<_>>();
    let mut values = HashMap::new();
    for firewall in registration.firewalls.unwrap_or_default() {
        if let FirewallEntry::Builtin {
            name,
            base_url_vars,
            ..
        } = firewall
            && builtin_targets.contains(name.as_str())
        {
            let resolved = base_url_vars
                .as_ref()
                .map(|base_url_vars| {
                    base_url_vars
                        .keys()
                        .map(|key| {
                            registration
                                .vars
                                .and_then(|vars| vars.get(key))
                                .map(|value| (key.clone(), value.clone()))
                                .ok_or_else(|| {
                                    ProviderError::Internal(format!(
                                        "builtin connector {name} is missing routing variable {key}"
                                    ))
                                })
                        })
                        .collect::<ProviderResult<HashMap<_, _>>>()
                })
                .transpose()?
                .unwrap_or_default();
            values.insert(builtin_connector_routing_key(name), resolved);
        }
    }
    for target in targets {
        if let ConnectorRuntimeTargetRegistration::Custom {
            custom_connector_id,
            base_url_vars,
            ..
        } = target
            && active_custom.contains(custom_connector_id.as_str())
        {
            values.insert(
                custom_connector_routing_key(custom_connector_id),
                base_url_vars.clone(),
            );
        }
    }
    Ok(values)
}

fn apply_connector_runtime_update(
    sandbox: &mut TestSandboxEntry,
    update: &ConnectorRuntimeRegistryUpdate,
) -> ProviderResult<bool> {
    let registered =
        sandbox
            .connector_runtime_targets
            .iter()
            .any(|target| match (target, update) {
                (
                    ConnectorRuntimeTarget::Builtin { connector_slug },
                    ConnectorRuntimeRegistryUpdate::BuiltinAvailable {
                        connector_slug: update_slug,
                        ..
                    }
                    | ConnectorRuntimeRegistryUpdate::BuiltinAbsent {
                        connector_slug: update_slug,
                    },
                ) => connector_slug == update_slug,
                (
                    ConnectorRuntimeTarget::Custom {
                        custom_connector_id,
                    },
                    ConnectorRuntimeRegistryUpdate::Custom {
                        custom_connector_id: update_id,
                        ..
                    },
                ) => custom_connector_id == update_id,
                _ => false,
            });
    if !registered {
        return Ok(false);
    }

    match update {
        ConnectorRuntimeRegistryUpdate::BuiltinAvailable {
            connector_slug,
            network_policy,
        } => {
            let present = sandbox
                .firewalls
                .as_deref()
                .unwrap_or_default()
                .iter()
                .any(|firewall| firewall_name(firewall) == connector_slug);
            if !present {
                return Ok(false);
            }
            sandbox.omitted_builtin_firewalls.remove(connector_slug);
            sandbox
                .network_policies
                .get_or_insert_with(HashMap::new)
                .insert(connector_slug.clone(), network_policy.clone());
        }
        ConnectorRuntimeRegistryUpdate::BuiltinAbsent { connector_slug } => {
            sandbox
                .omitted_builtin_firewalls
                .insert(connector_slug.clone());
            if let Some(policies) = sandbox.network_policies.as_mut() {
                policies.remove(connector_slug);
            }
        }
        ConnectorRuntimeRegistryUpdate::Custom {
            custom_connector_id,
            state,
        } => apply_custom_state(sandbox, custom_connector_id, state)?,
    }
    Ok(true)
}

fn apply_custom_state(
    sandbox: &mut TestSandboxEntry,
    custom_connector_id: &str,
    state: &CustomConnectorRuntimeRegistryState,
) -> ProviderResult<()> {
    match state {
        CustomConnectorRuntimeRegistryState::Available {
            firewall,
            network_policy,
            routing_variables,
        } => {
            let FirewallEntry::Inline {
                firewall: inline,
                custom_connector_id: Some(owner),
                ..
            } = firewall
            else {
                return Err(ProviderError::Internal(
                    "custom connector runtime result has no connector id".into(),
                ));
            };
            if owner != custom_connector_id {
                return Err(ProviderError::Internal(
                    "custom connector runtime result has mismatched connector id".into(),
                ));
            }
            let firewalls = sandbox.firewalls.get_or_insert_with(Vec::new);
            if firewalls.iter().any(|entry| {
                firewall_name(entry) == inline.name
                    && custom_connector_owner(entry) != Some(custom_connector_id)
            }) {
                return Err(ProviderError::Internal(format!(
                    "custom connector {custom_connector_id} cannot claim firewall {}",
                    inline.name
                )));
            }
            let removed_names = firewalls
                .iter()
                .filter(|entry| custom_connector_owner(entry) == Some(custom_connector_id))
                .map(firewall_name)
                .map(str::to_string)
                .collect::<Vec<_>>();
            let mut replacement = Some(firewall.clone());
            firewalls.retain_mut(|entry| {
                if custom_connector_owner(entry) != Some(custom_connector_id) {
                    return true;
                }
                let Some(next) = replacement.take() else {
                    return false;
                };
                *entry = next;
                true
            });
            if let Some(replacement) = replacement {
                firewalls.push(replacement);
            }
            let retained = firewalls.iter().map(firewall_name).collect::<HashSet<_>>();
            let policies = sandbox.network_policies.get_or_insert_with(HashMap::new);
            for removed in removed_names {
                if !retained.contains(removed.as_str()) {
                    policies.remove(&removed);
                }
            }
            policies.insert(inline.name.clone(), (**network_policy).clone());
            sandbox.connector_routing_variables.insert(
                custom_connector_routing_key(custom_connector_id),
                routing_variables.clone(),
            );
            sandbox
                .omitted_custom_connector_ids
                .remove(custom_connector_id);
        }
        CustomConnectorRuntimeRegistryState::Absent => {
            let mut removed = Vec::new();
            if let Some(firewalls) = sandbox.firewalls.as_mut() {
                firewalls.retain(|entry| {
                    if custom_connector_owner(entry) == Some(custom_connector_id) {
                        removed.push(firewall_name(entry).to_string());
                        false
                    } else {
                        true
                    }
                });
            }
            let retained = sandbox
                .firewalls
                .as_deref()
                .unwrap_or_default()
                .iter()
                .map(firewall_name)
                .collect::<HashSet<_>>();
            if let Some(policies) = sandbox.network_policies.as_mut() {
                for removed in removed {
                    if !retained.contains(removed.as_str()) {
                        policies.remove(&removed);
                    }
                }
            }
            sandbox
                .omitted_custom_connector_ids
                .insert(custom_connector_id.to_string());
        }
    }
    Ok(())
}

fn fail_closed_policy(policy: &NetworkPolicy) -> NetworkPolicy {
    let mut denied = policy.allow.clone();
    denied.extend(policy.deny.iter().cloned());
    denied.extend(policy.ask.iter().cloned());
    denied.sort();
    denied.dedup();
    NetworkPolicy {
        allow: Vec::new(),
        deny: denied,
        ask: Vec::new(),
        unknown_policy: "deny".into(),
    }
}

fn fail_closed_builtin(sandbox: &mut TestSandboxEntry, connector_slug: &str) -> bool {
    let present = sandbox
        .firewalls
        .as_deref()
        .unwrap_or_default()
        .iter()
        .any(|entry| firewall_name(entry) == connector_slug);
    if !present {
        return false;
    }
    let Some(policy) = sandbox
        .network_policies
        .as_mut()
        .and_then(|policies| policies.get_mut(connector_slug))
    else {
        return false;
    };
    *policy = fail_closed_policy(policy);
    true
}

fn fail_closed_custom(
    sandbox: &mut TestSandboxEntry,
    custom_connector_id: &str,
) -> ProviderResult<bool> {
    let owned_names = sandbox
        .firewalls
        .as_deref()
        .unwrap_or_default()
        .iter()
        .filter(|entry| custom_connector_owner(entry) == Some(custom_connector_id))
        .map(firewall_name)
        .map(str::to_string)
        .collect::<HashSet<_>>();
    if owned_names.is_empty() {
        return Ok(false);
    }
    let Some(policies) = sandbox.network_policies.as_mut() else {
        return Ok(false);
    };
    let mut changed = false;
    for name in owned_names {
        if let Some(policy) = policies.get_mut(&name) {
            *policy = fail_closed_policy(policy);
            changed = true;
        }
    }
    Ok(changed)
}
