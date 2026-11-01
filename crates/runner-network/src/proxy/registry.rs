//! Proxy registry schema and file persistence.
//!
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::path::{Path, PathBuf};

use nix::fcntl::Flock;
use serde::{Deserialize, Serialize};
use tracing::info;

use super::control::ControlHandle;
use super::registry_application::{RegistryDigest, RegistryPublication};

use crate::error::{RunnerError, RunnerResult};
use runner_host::lock;
use runner_host::state_file::PROXY_REGISTRY_MAX_BYTES;
pub use runner_types::connector_registry::{
    ConnectorRuntimeRegistryUpdate, CustomConnectorRuntimeRegistryState,
};
use runner_types::types::{
    ConnectorRuntimeTarget, ConnectorRuntimeTargetRegistration, FirewallEntry, NetworkPolicy,
    SecretConnectorMetadata,
};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProxyRegistry {
    sandboxes: HashMap<String, SandboxEntry>,
    updated_at: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SandboxEntry {
    run_id: String,
    cli_agent_type: String,
    sandbox_token: String,
    registered_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    usage_generation: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model_usage_long_context_min_total_input_tokens: Option<u64>,
    /// API-captured, non-secret model intent for host-side request validation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pi_model_config: Option<serde_json::Value>,
}

/// Parameters for registering a sandbox in the proxy registry.
#[derive(Debug)]
pub struct SandboxRegistration<'a> {
    pub run_id: &'a str,
    pub cli_agent_type: &'a str,
    pub sandbox_token: &'a str,
    pub network_log_path: &'a std::path::Path,
    pub proxy_log_path: &'a std::path::Path,
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
    pub model_usage_long_context_min_total_input_tokens: Option<u64>,
    pub pi_model_config: Option<&'a serde_json::Value>,
}

async fn read_registry(path: &std::path::Path) -> RunnerResult<ProxyRegistry> {
    let content = runner_host::state_file::read_to_string(
        path,
        PROXY_REGISTRY_MAX_BYTES,
        runner_host::state_file::OwnerCheck::CurrentEuid,
    )
    .await?
    .ok_or_else(|| RunnerError::Internal(format!("read registry {}: not found", path.display())))?;
    serde_json::from_str(&content)
        .map_err(|e| RunnerError::Internal(format!("parse registry: {e}")))
}

/// Write the proxy registry while preserving capacity for every stored policy
/// to transition to fail-closed.
///
/// On supported Unix runner hosts, this ensures the Python mitm-addon never
/// reads a partially-written file.
async fn write_registry(
    path: &std::path::Path,
    value: &ProxyRegistry,
) -> RunnerResult<RegistryDigest> {
    let fail_closed_reserve = fail_closed_capacity_bytes(value)?;
    let content = serialize_registry(path, value, fail_closed_reserve)?;
    let digest = RegistryDigest::of(&content);
    runner_host::state_file::write_private_atomic(path, &content).await?;
    Ok(digest)
}

async fn write_locked_registry(
    path: &Path,
    value: &ProxyRegistry,
    guard: Flock<File>,
) -> RunnerResult<RegistryDigest> {
    let fail_closed_reserve = fail_closed_capacity_bytes(value)?;
    write_registry_with_reserve(path, value, fail_closed_reserve, guard).await
}

async fn write_registry_with_reserve(
    path: &Path,
    value: &ProxyRegistry,
    fail_closed_reserve: u64,
    guard: Flock<File>,
) -> RunnerResult<RegistryDigest> {
    let content = serialize_registry(path, value, fail_closed_reserve)?;
    let digest = RegistryDigest::of(&content);
    let path = path.to_path_buf();
    runner_host::state_file::spawn_locked_private_atomic_write(path, content, guard)
        .await
        .map_err(|error| {
            RunnerError::Internal(format!("proxy registry publication task failed: {error}"))
        })??;
    Ok(digest)
}

fn serialize_registry(
    path: &Path,
    value: &ProxyRegistry,
    fail_closed_reserve: u64,
) -> RunnerResult<Vec<u8>> {
    let content = serde_json::to_vec(value)
        .map_err(|e| RunnerError::Internal(format!("serialize registry: {e}")))?;
    let content_bytes = content.len() as u64;
    let required_bytes = content_bytes
        .checked_add(fail_closed_reserve)
        .ok_or_else(|| RunnerError::Internal("proxy registry size overflow".to_string()))?;
    if required_bytes > PROXY_REGISTRY_MAX_BYTES {
        return Err(RunnerError::Internal(format!(
            "proxy registry {} requires {required_bytes} bytes ({content_bytes} serialized plus \
             {fail_closed_reserve} reserved for fail-closed policy updates), exceeds \
             {PROXY_REGISTRY_MAX_BYTES} bytes",
            path.display()
        )));
    }
    Ok(content)
}

fn fail_closed_capacity_bytes(value: &ProxyRegistry) -> RunnerResult<u64> {
    // Replacing a policy changes only that independent JSON object value. The
    // sum of positive per-policy deltas is therefore the maximum growth across
    // any subset of sequential fail-closed transitions.
    value
        .sandboxes
        .values()
        .filter_map(|sandbox| sandbox.network_policies.as_ref())
        .flat_map(|policies| policies.values())
        .try_fold(0_u64, |reserve, policy| {
            let current_bytes = serde_json::to_vec(policy)
                .map_err(|e| RunnerError::Internal(format!("serialize network policy: {e}")))?
                .len() as u64;
            let fail_closed_bytes = serde_json::to_vec(&fail_closed_policy(policy))
                .map_err(|e| {
                    RunnerError::Internal(format!("serialize fail-closed network policy: {e}"))
                })?
                .len() as u64;
            reserve
                .checked_add(fail_closed_bytes.saturating_sub(current_bytes))
                .ok_or_else(|| {
                    RunnerError::Internal("proxy registry fail-closed reserve overflow".to_string())
                })
        })
}

/// Lightweight, cloneable handle for proxy registry operations.
///
/// Uses file locking (`flock`) to ensure concurrent register/unregister calls
/// from multiple executor tasks don't corrupt the registry JSON.
#[derive(Clone)]
pub struct ProxyRegistryHandle {
    pub(super) registry_path: PathBuf,
    pub(super) lock_path: PathBuf,
    pub(super) control: ControlHandle,
}

pub struct ConnectorRuntimeRegistryTransaction {
    registry_path: PathBuf,
    control: ControlHandle,
    _guard: Flock<File>,
}

pub struct ConnectorRuntimePublication<T> {
    pub outcomes: Vec<T>,
    pub publication: Option<RegistryPublication>,
}

pub enum ConnectorRuntimeFailCloseOutcome {
    Applied,
    Unchanged,
    Failed(RunnerError),
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

fn validate_custom_connector_resource_ownership(firewalls: &[FirewallEntry]) -> RunnerResult<()> {
    let mut firewall_name_counts = HashMap::new();
    for firewall in firewalls {
        *firewall_name_counts
            .entry(firewall_name(firewall))
            .or_insert(0) += 1;
    }

    let mut custom_connector_ids = HashSet::new();
    for firewall in firewalls {
        let Some(custom_connector_id) = custom_connector_owner(firewall) else {
            continue;
        };
        if !custom_connector_ids.insert(custom_connector_id) {
            return Err(RunnerError::Internal(format!(
                "custom connector {custom_connector_id} owns multiple firewall entries"
            )));
        }
        let name = firewall_name(firewall);
        if firewall_name_counts.get(name) != Some(&1) {
            return Err(RunnerError::Internal(format!(
                "custom connector {custom_connector_id} does not exclusively own firewall {name}"
            )));
        }
    }
    Ok(())
}

fn replace_first_matching_firewall(
    firewalls: &mut Vec<FirewallEntry>,
    replacement: FirewallEntry,
    mut matches: impl FnMut(&FirewallEntry) -> bool,
) {
    let mut replacement = Some(replacement);
    firewalls.retain_mut(|entry| {
        if !matches(entry) {
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
}

fn apply_custom_connector_runtime_state(
    sandbox: &mut SandboxEntry,
    custom_connector_id: &str,
    state: &CustomConnectorRuntimeRegistryState,
) -> RunnerResult<()> {
    match state {
        CustomConnectorRuntimeRegistryState::Available {
            firewall,
            network_policy,
            routing_variables,
        } => {
            let FirewallEntry::Inline {
                firewall: inline_firewall,
                custom_connector_id: Some(entry_connector_id),
                ..
            } = firewall
            else {
                return Err(RunnerError::Internal(format!(
                    "custom connector runtime result {custom_connector_id} has no connector id"
                )));
            };
            if entry_connector_id != custom_connector_id {
                return Err(RunnerError::Internal(format!(
                    "custom connector runtime result {custom_connector_id} has mismatched connector id"
                )));
            }
            let inline_firewall_name = inline_firewall.name.clone();

            let firewalls = sandbox.firewalls.get_or_insert_with(Vec::new);
            if firewalls.iter().any(|entry| {
                firewall_name(entry) == inline_firewall_name
                    && custom_connector_owner(entry) != Some(custom_connector_id)
            }) {
                return Err(RunnerError::Internal(format!(
                    "custom connector {custom_connector_id} cannot claim firewall {inline_firewall_name} owned by another connector"
                )));
            }
            let removed_firewall_names = firewalls
                .iter()
                .filter_map(|entry| {
                    if let FirewallEntry::Inline {
                        firewall,
                        custom_connector_id: Some(existing_connector_id),
                        ..
                    } = entry
                        && existing_connector_id == custom_connector_id
                    {
                        Some(firewall.name.clone())
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>();
            replace_first_matching_firewall(firewalls, firewall.clone(), |entry| {
                if let FirewallEntry::Inline {
                    custom_connector_id: Some(existing_connector_id),
                    ..
                } = entry
                    && existing_connector_id == custom_connector_id
                {
                    true
                } else {
                    false
                }
            });
            let retained_firewall_names = firewalls
                .iter()
                .map(firewall_name)
                .map(ToOwned::to_owned)
                .collect::<HashSet<_>>();
            let network_policies = sandbox.network_policies.get_or_insert_with(HashMap::new);
            for firewall_name in removed_firewall_names {
                if !retained_firewall_names.contains(&firewall_name) {
                    network_policies.remove(&firewall_name);
                }
            }
            network_policies.insert(inline_firewall_name, (**network_policy).clone());
            sandbox.connector_routing_variables.insert(
                custom_connector_routing_key(custom_connector_id),
                routing_variables.clone(),
            );
            sandbox
                .omitted_custom_connector_ids
                .remove(custom_connector_id);
        }
        CustomConnectorRuntimeRegistryState::Absent => {
            let mut removed_firewall_names = Vec::new();
            if let Some(firewalls) = sandbox.firewalls.as_mut() {
                firewalls.retain(|entry| {
                    if let FirewallEntry::Inline {
                        firewall,
                        custom_connector_id: Some(existing_connector_id),
                        ..
                    } = entry
                        && existing_connector_id == custom_connector_id
                    {
                        removed_firewall_names.push(firewall.name.clone());
                        false
                    } else {
                        true
                    }
                });
            }
            let retained_firewall_names = sandbox
                .firewalls
                .as_deref()
                .unwrap_or_default()
                .iter()
                .map(firewall_name)
                .map(ToOwned::to_owned)
                .collect::<HashSet<_>>();
            if let Some(network_policies) = sandbox.network_policies.as_mut() {
                for firewall_name in removed_firewall_names {
                    if !retained_firewall_names.contains(&firewall_name) {
                        network_policies.remove(&firewall_name);
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

fn apply_connector_runtime_update(
    sandbox: &mut SandboxEntry,
    update: &ConnectorRuntimeRegistryUpdate,
) -> RunnerResult<bool> {
    let target_is_registered =
        sandbox
            .connector_runtime_targets
            .iter()
            .any(|target| match (target, update) {
                (
                    ConnectorRuntimeTarget::Builtin { connector_slug },
                    ConnectorRuntimeRegistryUpdate::BuiltinAvailable {
                        connector_slug: update_slug,
                        ..
                    },
                ) => connector_slug == update_slug,
                (
                    ConnectorRuntimeTarget::Builtin { connector_slug },
                    ConnectorRuntimeRegistryUpdate::BuiltinAbsent {
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
    if !target_is_registered {
        return Ok(false);
    }

    match update {
        ConnectorRuntimeRegistryUpdate::BuiltinAvailable {
            connector_slug,
            network_policy,
        } => {
            if !sandbox_has_connector_firewall(sandbox, connector_slug) {
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
            if let Some(network_policies) = sandbox.network_policies.as_mut() {
                network_policies.remove(connector_slug);
            }
        }
        ConnectorRuntimeRegistryUpdate::Custom {
            custom_connector_id,
            state,
        } => apply_custom_connector_runtime_state(sandbox, custom_connector_id, state)?,
    }
    Ok(true)
}

fn initial_omitted_connector_runtime_targets(
    registration: &SandboxRegistration<'_>,
) -> (HashSet<String>, HashSet<String>) {
    let mut active_builtin_firewalls = HashSet::new();
    let mut active_custom_connector_ids = HashSet::new();
    for firewall in registration.firewalls.unwrap_or_default() {
        match firewall {
            FirewallEntry::Builtin { name, .. } => {
                active_builtin_firewalls.insert(name.as_str());
            }
            FirewallEntry::Inline {
                custom_connector_id: Some(custom_connector_id),
                ..
            } => {
                active_custom_connector_ids.insert(custom_connector_id.as_str());
            }
            FirewallEntry::Inline { .. } => {}
        }
    }

    let mut omitted_builtin_firewalls = HashSet::new();
    let mut omitted_custom_connector_ids = HashSet::new();
    for target in registration.connector_runtime_targets.unwrap_or_default() {
        match target {
            ConnectorRuntimeTargetRegistration::Builtin { connector_slug, .. }
                if !active_builtin_firewalls.contains(connector_slug.as_str()) =>
            {
                omitted_builtin_firewalls.insert(connector_slug.clone());
            }
            ConnectorRuntimeTargetRegistration::Custom {
                custom_connector_id,
                ..
            } if !active_custom_connector_ids.contains(custom_connector_id.as_str()) => {
                omitted_custom_connector_ids.insert(custom_connector_id.clone());
            }
            ConnectorRuntimeTargetRegistration::Builtin { .. }
            | ConnectorRuntimeTargetRegistration::Custom { .. } => {}
        }
    }
    (omitted_builtin_firewalls, omitted_custom_connector_ids)
}

fn initial_connector_routing_variables(
    registration: &SandboxRegistration<'_>,
) -> RunnerResult<HashMap<String, HashMap<String, String>>> {
    let mut routing_variables = HashMap::new();
    let run_vars = registration.vars;
    let firewalls = registration.firewalls.unwrap_or_default();
    let builtin_connector_slugs = registration
        .connector_runtime_targets
        .unwrap_or_default()
        .iter()
        .filter_map(|target| match target {
            ConnectorRuntimeTargetRegistration::Builtin { connector_slug, .. } => {
                Some(connector_slug.as_str())
            }
            ConnectorRuntimeTargetRegistration::Custom { .. } => None,
        })
        .collect::<HashSet<_>>();
    let active_custom_connector_ids = firewalls
        .iter()
        .filter_map(|firewall| match firewall {
            FirewallEntry::Inline {
                custom_connector_id: Some(custom_connector_id),
                ..
            } => Some(custom_connector_id.as_str()),
            FirewallEntry::Builtin { .. } | FirewallEntry::Inline { .. } => None,
        })
        .collect::<HashSet<_>>();
    for firewall in firewalls {
        if let FirewallEntry::Builtin {
            name,
            base_url_vars,
            ..
        } = firewall
        {
            if !builtin_connector_slugs.contains(name.as_str()) {
                continue;
            }
            let raw_values = base_url_vars.as_ref().map_or_else(
                || Ok(HashMap::new()),
                |resolved_values| {
                    resolved_values
                        .keys()
                        .map(|key| {
                            run_vars
                                .and_then(|values| values.get(key))
                                .map(|value| (key.clone(), value.clone()))
                                .ok_or_else(|| {
                                    RunnerError::Internal(format!(
                                        "builtin connector {name} is missing routing variable {key}"
                                    ))
                                })
                        })
                        .collect::<RunnerResult<HashMap<_, _>>>()
                },
            )?;
            routing_variables.insert(builtin_connector_routing_key(name), raw_values);
        }
    }
    for target in registration.connector_runtime_targets.unwrap_or_default() {
        if let ConnectorRuntimeTargetRegistration::Custom {
            custom_connector_id,
            base_url_vars,
            ..
        } = target
            && active_custom_connector_ids.contains(custom_connector_id.as_str())
        {
            routing_variables.insert(
                custom_connector_routing_key(custom_connector_id),
                base_url_vars.clone(),
            );
        }
    }
    Ok(routing_variables)
}

impl ProxyRegistryHandle {
    /// Observe a published registration without delaying sandbox preparation.
    pub fn observe_registration(&self, publication: RegistryPublication) {
        self.control.observe_registry(publication);
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn set_control_target_for_test(&self, directory: PathBuf, generation: String) {
        self.control.set_target(Some(super::control::ControlTarget {
            directory,
            generation,
        }));
    }

    /// Create a handle from explicit paths (for testing).
    #[cfg(any(test, feature = "test-support"))]
    pub fn new(registry_path: PathBuf, lock_path: PathBuf) -> Self {
        Self {
            registry_path,
            lock_path,
            control: ControlHandle::default(),
        }
    }

    /// Register a sandbox in the proxy registry.
    pub async fn register_sandbox(
        &self,
        source_ip: &str,
        registration: &SandboxRegistration<'_>,
    ) -> RunnerResult<RegistryPublication> {
        validate_custom_connector_resource_ownership(registration.firewalls.unwrap_or_default())?;
        let connector_routing_variables = initial_connector_routing_variables(registration)?;
        let guard = lock::acquire(self.lock_path.clone()).await?;

        let mut registry = read_registry(&self.registry_path).await?;
        let now = chrono::Utc::now().timestamp_millis();
        // Preserve original observation provenance for a same-run refresh and
        // across addon restarts. A new process cannot claim the old history.
        let usage_generation = registry
            .sandboxes
            .values()
            .find(|entry| entry.run_id == registration.run_id)
            .map(|entry| entry.usage_generation.clone())
            .unwrap_or_else(|| self.control.target().map(|target| target.generation));
        let firewalls = registration.firewalls.map(|s| s.to_vec());
        let (omitted_builtin_firewalls, omitted_custom_connector_ids) =
            initial_omitted_connector_runtime_targets(registration);
        registry.sandboxes.insert(
            source_ip.to_string(),
            SandboxEntry {
                run_id: registration.run_id.to_string(),
                cli_agent_type: registration.cli_agent_type.to_string(),
                sandbox_token: registration.sandbox_token.to_string(),
                registered_at: now,
                usage_generation,
                network_log_path: registration.network_log_path.to_string_lossy().into_owned(),
                proxy_log_path: registration.proxy_log_path.to_string_lossy().into_owned(),
                firewalls,
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
                encrypted_secrets: registration.encrypted_secrets.map(String::from),
                secret_connector_map: registration.secret_connector_map.cloned(),
                secret_connector_metadata_map: registration.secret_connector_metadata_map.cloned(),
                vars: registration.vars.cloned(),
                capture_network_bodies: registration.capture_network_bodies,
                billable_firewalls: registration.billable_firewalls.to_vec(),
                model_usage_provider: registration.model_usage_provider.map(String::from),
                model_usage_long_context_min_total_input_tokens: registration
                    .model_usage_long_context_min_total_input_tokens,
                pi_model_config: registration.pi_model_config.cloned(),
            },
        );
        registry.updated_at = now;
        let digest = write_locked_registry(&self.registry_path, &registry, guard).await?;
        info!(
            source_ip,
            run_id = registration.run_id,
            "registered sandbox in proxy registry"
        );
        Ok(RegistryPublication {
            digest,
            target: self.control.target(),
        })
    }

    /// Unregister a sandbox from the proxy registry.
    pub async fn unregister_sandbox(&self, source_ip: &str) -> RunnerResult<RegistryPublication> {
        let guard = lock::acquire(self.lock_path.clone()).await?;

        let mut registry = read_registry(&self.registry_path).await?;
        registry.sandboxes.remove(source_ip);
        registry.updated_at = chrono::Utc::now().timestamp_millis();
        let digest = write_locked_registry(&self.registry_path, &registry, guard).await?;
        info!(source_ip, "unregistered sandbox from proxy registry");
        Ok(RegistryPublication {
            digest,
            target: self.control.target(),
        })
    }

    /// Publish validated Builtin and Custom candidate updates in one registry
    /// transaction. `None` means the sandbox disappeared or now belongs to another
    /// run; otherwise each boolean reports whether the same-index update was
    /// accepted. Accepted batches persist only when the resulting sandbox state
    /// changes.
    #[cfg(test)]
    pub(crate) async fn apply_connector_runtime_updates_if_run_matches(
        &self,
        source_ip: &str,
        run_id: &str,
        updates: &[ConnectorRuntimeRegistryUpdate],
    ) -> RunnerResult<Option<Vec<bool>>> {
        self.connector_runtime_registry_transaction()
            .await?
            .apply_updates_if_run_matches(source_ip, run_id, updates)
            .await
            .map(|result| result.map(|result| result.outcomes))
    }

    pub async fn connector_runtime_registry_transaction(
        &self,
    ) -> RunnerResult<ConnectorRuntimeRegistryTransaction> {
        let guard = lock::acquire(self.lock_path.clone()).await?;
        Ok(ConnectorRuntimeRegistryTransaction {
            registry_path: self.registry_path.clone(),
            control: self.control.clone(),
            _guard: guard,
        })
    }

    #[cfg(test)]
    pub(crate) async fn replace_custom_connector_runtime_target_if_run_matches(
        &self,
        source_ip: &str,
        run_id: &str,
        custom_connector_id: &str,
        state: CustomConnectorRuntimeRegistryState,
    ) -> RunnerResult<bool> {
        let outcomes = self
            .apply_connector_runtime_updates_if_run_matches(
                source_ip,
                run_id,
                &[ConnectorRuntimeRegistryUpdate::Custom {
                    custom_connector_id: custom_connector_id.to_string(),
                    state,
                }],
            )
            .await?;
        Ok(outcomes.is_some_and(|outcomes| outcomes == [true]))
    }

    #[cfg(test)]
    pub async fn patch_network_policy_if_run_matches(
        &self,
        source_ip: &str,
        run_id: &str,
        connector_slug: &str,
        policy: NetworkPolicy,
    ) -> RunnerResult<bool> {
        let outcomes = self
            .apply_connector_runtime_updates_if_run_matches(
                source_ip,
                run_id,
                &[ConnectorRuntimeRegistryUpdate::BuiltinAvailable {
                    connector_slug: connector_slug.to_string(),
                    network_policy: policy,
                }],
            )
            .await?;
        Ok(outcomes.is_some_and(|outcomes| outcomes == [true]))
    }

    /// Fail-close all matching connector runtime targets in one registry
    /// transaction. `None` means the sandbox disappeared or now belongs to another
    /// run; otherwise each outcome corresponds to the same-index target.
    #[cfg(test)]
    pub(crate) async fn fail_closed_connector_runtime_targets_if_run_matches(
        &self,
        source_ip: &str,
        run_id: &str,
        targets: &[ConnectorRuntimeTarget],
    ) -> RunnerResult<Option<Vec<ConnectorRuntimeFailCloseOutcome>>> {
        self.connector_runtime_registry_transaction()
            .await?
            .fail_closed_targets_if_run_matches(source_ip, run_id, targets)
            .await
            .map(|result| result.map(|result| result.outcomes))
    }
}

impl ConnectorRuntimeRegistryTransaction {
    pub async fn fail_closed_targets_if_run_matches(
        self,
        source_ip: &str,
        run_id: &str,
        targets: &[ConnectorRuntimeTarget],
    ) -> RunnerResult<Option<ConnectorRuntimePublication<ConnectorRuntimeFailCloseOutcome>>> {
        let mut registry = read_registry(&self.registry_path).await?;
        let Some(sandbox) = registry.sandboxes.get_mut(source_ip) else {
            return Ok(None);
        };
        if sandbox.run_id != run_id {
            return Ok(None);
        }

        let outcomes = targets
            .iter()
            .map(|target| {
                let result = match target {
                    ConnectorRuntimeTarget::Builtin { connector_slug } => Ok(
                        fail_closed_builtin_connector_runtime_target(sandbox, connector_slug),
                    ),
                    ConnectorRuntimeTarget::Custom {
                        custom_connector_id,
                    } => fail_closed_custom_connector_runtime_target(sandbox, custom_connector_id),
                };
                match result {
                    Ok(true) => ConnectorRuntimeFailCloseOutcome::Applied,
                    Ok(false) => ConnectorRuntimeFailCloseOutcome::Unchanged,
                    Err(error) => ConnectorRuntimeFailCloseOutcome::Failed(error),
                }
            })
            .collect::<Vec<_>>();
        let applied_count = outcomes
            .iter()
            .filter(|outcome| matches!(outcome, ConnectorRuntimeFailCloseOutcome::Applied))
            .count();
        if applied_count == 0 {
            return Ok(Some(ConnectorRuntimePublication {
                outcomes,
                publication: None,
            }));
        }

        registry.updated_at = chrono::Utc::now().timestamp_millis();
        let digest =
            write_registry_with_reserve(&self.registry_path, &registry, 0, self._guard).await?;
        info!(
            source_ip,
            run_id,
            target_count = targets.len(),
            applied_count,
            failed_count = outcomes
                .iter()
                .filter(|outcome| matches!(outcome, ConnectorRuntimeFailCloseOutcome::Failed(_)))
                .count(),
            "failed closed connector runtime targets in proxy registry"
        );
        Ok(Some(ConnectorRuntimePublication {
            outcomes,
            publication: Some(RegistryPublication {
                digest,
                target: self.control.target(),
            }),
        }))
    }

    pub async fn apply_updates_if_run_matches(
        self,
        source_ip: &str,
        run_id: &str,
        updates: &[ConnectorRuntimeRegistryUpdate],
    ) -> RunnerResult<Option<ConnectorRuntimePublication<bool>>> {
        let mut registry = read_registry(&self.registry_path).await?;
        let Some(sandbox) = registry.sandboxes.get_mut(source_ip) else {
            return Ok(None);
        };
        if sandbox.run_id != run_id {
            return Ok(None);
        }

        // Keep this snapshot aligned with every sandbox field mutated by
        // `apply_connector_runtime_update`.
        let previous_firewalls = sandbox.firewalls.clone();
        let previous_network_policies = sandbox.network_policies.clone();
        let previous_omitted_builtin_firewalls = sandbox.omitted_builtin_firewalls.clone();
        let previous_omitted_custom_connector_ids = sandbox.omitted_custom_connector_ids.clone();
        let previous_connector_routing_variables = sandbox.connector_routing_variables.clone();
        let accepted = updates
            .iter()
            .map(|update| apply_connector_runtime_update(sandbox, update))
            .collect::<RunnerResult<Vec<_>>>()?;
        if !accepted.iter().any(|accepted| *accepted) {
            return Ok(Some(ConnectorRuntimePublication {
                outcomes: accepted,
                publication: None,
            }));
        }

        validate_custom_connector_resource_ownership(
            sandbox.firewalls.as_deref().unwrap_or_default(),
        )?;
        if previous_firewalls == sandbox.firewalls
            && previous_network_policies == sandbox.network_policies
            && previous_omitted_builtin_firewalls == sandbox.omitted_builtin_firewalls
            && previous_omitted_custom_connector_ids == sandbox.omitted_custom_connector_ids
            && previous_connector_routing_variables == sandbox.connector_routing_variables
        {
            return Ok(Some(ConnectorRuntimePublication {
                outcomes: accepted,
                publication: None,
            }));
        }
        registry.updated_at = chrono::Utc::now().timestamp_millis();
        let digest = write_locked_registry(&self.registry_path, &registry, self._guard).await?;
        info!(
            source_ip,
            run_id,
            update_count = updates.len(),
            "applied connector runtime updates to proxy registry"
        );
        Ok(Some(ConnectorRuntimePublication {
            outcomes: accepted,
            publication: Some(RegistryPublication {
                digest,
                target: self.control.target(),
            }),
        }))
    }
}

fn fail_closed_builtin_connector_runtime_target(
    sandbox: &mut SandboxEntry,
    connector_slug: &str,
) -> bool {
    if !sandbox_has_connector_firewall(sandbox, connector_slug) {
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

fn fail_closed_custom_connector_runtime_target(
    sandbox: &mut SandboxEntry,
    custom_connector_id: &str,
) -> RunnerResult<bool> {
    let Some(firewalls) = sandbox.firewalls.as_deref() else {
        return Ok(false);
    };
    let owned_firewall_names = firewalls
        .iter()
        .filter(|entry| custom_connector_owner(entry) == Some(custom_connector_id))
        .map(firewall_name)
        .map(ToOwned::to_owned)
        .collect::<HashSet<_>>();
    if owned_firewall_names.is_empty() {
        return Ok(false);
    }
    if firewalls.iter().any(|entry| {
        owned_firewall_names.contains(firewall_name(entry))
            && custom_connector_owner(entry) != Some(custom_connector_id)
    }) {
        return Err(RunnerError::Internal(format!(
            "custom connector {custom_connector_id} does not exclusively own its firewall"
        )));
    }
    let Some(network_policies) = sandbox.network_policies.as_mut() else {
        return Ok(false);
    };
    let mut changed = false;
    for firewall_name in owned_firewall_names {
        if let Some(policy) = network_policies.get_mut(&firewall_name) {
            *policy = fail_closed_policy(policy);
            changed = true;
        }
    }
    Ok(changed)
}

fn fail_closed_policy(policy: &NetworkPolicy) -> NetworkPolicy {
    let mut permission_names = policy.allow.clone();
    permission_names.extend(policy.deny.iter().cloned());
    permission_names.extend(policy.ask.iter().cloned());
    permission_names.sort();
    permission_names.dedup();
    NetworkPolicy {
        allow: Vec::new(),
        deny: permission_names,
        ask: Vec::new(),
        unknown_policy: "deny".to_string(),
    }
}

fn sandbox_has_connector_firewall(sandbox: &SandboxEntry, connector_slug: &str) -> bool {
    sandbox.firewalls.as_deref().is_some_and(|firewalls| {
        firewalls
            .iter()
            .any(|entry| firewall_entry_matches(entry, connector_slug))
    })
}

fn firewall_entry_matches(entry: &FirewallEntry, connector_slug: &str) -> bool {
    match entry {
        FirewallEntry::Builtin { name, .. } => name == connector_slug,
        FirewallEntry::Inline { firewall, .. } => firewall.name == connector_slug,
    }
}

pub(super) async fn write_empty_registry(path: &Path) -> RunnerResult<()> {
    let empty_registry = ProxyRegistry {
        sandboxes: HashMap::new(),
        updated_at: 0,
    };
    write_registry(path, &empty_registry).await.map(|_| ())
}

#[cfg(test)]
mod tests;
