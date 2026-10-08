use std::collections::HashMap;

use guest_contracts::env::sanitize_env_key_for_diagnostic;

use super::super::env::is_runner_owned_env_key;
use super::super::{AGENT_ENV_KEY_DIAGNOSTIC_LIMIT, BOOTSTRAP_SENSITIVE_ENV_KEYS};

const AGENT_ENV_VALUE_SIZE_DIAGNOSTIC_LIMIT: usize = 5;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(in crate::executor) struct AgentEnvDiagnostics {
    pub(in crate::executor) env_count: usize,
    pub(in crate::executor) env_bytes: usize,
    pub(in crate::executor) runner_owned_count: usize,
    pub(in crate::executor) external_count: usize,
    pub(in crate::executor) suspicious_keys: Vec<String>,
    pub(in crate::executor) largest_entries: Vec<AgentEnvValueSizeDiagnostics>,
}

impl AgentEnvDiagnostics {
    pub(in crate::executor) fn suspicious_keys_csv(&self) -> String {
        self.suspicious_keys.join(",")
    }

    pub(in crate::executor) fn largest_entries_csv(&self) -> String {
        self.largest_entries
            .iter()
            .map(|entry| format!("{}:{}", entry.key, entry.value_len))
            .collect::<Vec<_>>()
            .join(",")
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(in crate::executor) struct AgentEnvValueSizeDiagnostics {
    pub(in crate::executor) key: String,
    pub(in crate::executor) value_len: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(in crate::executor) struct AgentEnvKeyDiagnostics {
    pub(in crate::executor) logged_keys: Vec<String>,
    pub(in crate::executor) omitted_key_count: usize,
}

impl AgentEnvKeyDiagnostics {
    pub(in crate::executor) fn logged_keys_csv(&self) -> String {
        self.logged_keys.join(",")
    }
}

pub(in crate::executor) fn build_agent_env_diagnostics(
    env: &HashMap<String, String>,
    user_env: &HashMap<String, String>,
) -> AgentEnvDiagnostics {
    let mut suspicious_keys: Vec<String> = BOOTSTRAP_SENSITIVE_ENV_KEYS
        .iter()
        .copied()
        .filter(|key| user_env.contains_key(*key))
        .map(sanitize_env_key_for_diagnostic)
        .collect();
    suspicious_keys.sort();

    let runner_owned_count = env
        .keys()
        .filter(|key| is_runner_owned_env_key(key))
        .count();
    let env_bytes = env.iter().map(|(key, value)| key.len() + value.len()).sum();
    let mut largest_entries: Vec<AgentEnvValueSizeDiagnostics> = env
        .iter()
        .map(|(key, value)| AgentEnvValueSizeDiagnostics {
            key: sanitize_env_key_for_diagnostic(key),
            value_len: value.len(),
        })
        .collect();
    largest_entries.sort_by(|left, right| {
        right
            .value_len
            .cmp(&left.value_len)
            .then_with(|| left.key.cmp(&right.key))
    });
    largest_entries.truncate(AGENT_ENV_VALUE_SIZE_DIAGNOSTIC_LIMIT);

    AgentEnvDiagnostics {
        env_count: env.len(),
        env_bytes,
        runner_owned_count,
        external_count: env.len().saturating_sub(runner_owned_count),
        suspicious_keys,
        largest_entries,
    }
}

pub(in crate::executor) fn build_agent_env_key_diagnostics(
    env: &[(String, String)],
) -> AgentEnvKeyDiagnostics {
    let mut keys: Vec<String> = env
        .iter()
        .map(|(key, _)| sanitize_env_key_for_diagnostic(key))
        .collect();
    keys.sort();

    let logged_keys: Vec<String> = keys
        .iter()
        .take(AGENT_ENV_KEY_DIAGNOSTIC_LIMIT)
        .cloned()
        .collect();
    let omitted_key_count = keys.len().saturating_sub(logged_keys.len());

    AgentEnvKeyDiagnostics {
        logged_keys,
        omitted_key_count,
    }
}
