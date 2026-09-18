//! Curated environment for CLI children.

use std::collections::{BTreeMap, HashMap};

use super::CliRuntimeConfig;

const DEFAULT_PATH: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const DEFAULT_SHELL: &str = "/bin/bash";
const NPM_CACHE_ENV_KEY: &str = "npm_config_cache";
const WORKSPACE_NPM_CACHE_RELATIVE_PATH: &str = ".vm0/cache/npm";
// The sandbox CLI needs the same API origin as the guest-agent in local
// development. The managed-CLI reader floor is complete, so expose only the
// canonical spelling. Tokens and all other bootstrap controls must stay private
// to the guest-agent.
const RUNNER_VISIBLE_API_URL_ENV_KEY: &str = guest_contracts::env::CANONICAL_API_URL_ENV;
const OPTIONAL_BASE_ENV_KEYS: &[&str] = &[
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    // Rootfs-wide runtime settings from /etc/environment. Keep these out of
    // guest-agent bootstrap control while preserving access to preinstalled
    // toolchains and the injected proxy CA by default.
    "RUSTUP_HOME",
    "NPM_CONFIG_UPDATE_NOTIFIER",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "REQUESTS_CA_BUNDLE",
    "CARGO_HTTP_CAINFO",
];

pub(super) fn values_for_runtime(runtime: &CliRuntimeConfig<'_>) -> Vec<(String, String)> {
    let user_env = runtime.child_user_env();
    values_with_inputs(
        runtime.home_dir.as_ref(),
        user_env.as_ref(),
        runtime.api_url.as_ref(),
    )
}

pub(super) fn values_with_inputs(
    home_dir: &str,
    user_env: &HashMap<String, String>,
    api_url: &str,
) -> Vec<(String, String)> {
    let mut values = Vec::new();
    for (key, value) in base_child_env(home_dir) {
        values.push((key.to_string(), value));
    }
    for (key, value) in user_env {
        if key == guest_contracts::env::CANONICAL_API_URL_ENV
            || key.eq_ignore_ascii_case(NPM_CACHE_ENV_KEY)
        {
            continue;
        }
        values.push((key.clone(), value.clone()));
    }
    apply_runner_visible_env(api_url, |key, value| {
        values.push((key.to_string(), value));
    });
    values.push((
        NPM_CACHE_ENV_KEY.to_string(),
        format!(
            "{}/{}",
            crate::paths::CANONICAL_WORKING_DIR,
            WORKSPACE_NPM_CACHE_RELATIVE_PATH
        ),
    ));
    normalize_values(values)
}

pub(super) fn normalize_values(values: Vec<(String, String)>) -> Vec<(String, String)> {
    let mut final_values = BTreeMap::new();
    for (key, value) in values {
        final_values.insert(key, value);
    }
    final_values.into_iter().collect()
}

pub(super) fn apply_values_to_tokio_command(
    cmd: &mut tokio::process::Command,
    values: &[(String, String)],
) {
    cmd.env_clear();
    for (key, value) in values {
        cmd.env(key, value);
    }
}

fn base_child_env(home_dir: &str) -> Vec<(&'static str, String)> {
    let mut base = Vec::with_capacity(OPTIONAL_BASE_ENV_KEYS.len() + 3);
    base.push(("HOME", home_dir.to_string()));
    base.push((
        "PATH",
        std::env::var("PATH")
            .ok()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| DEFAULT_PATH.to_string()),
    ));
    base.push((
        "SHELL",
        std::env::var("SHELL")
            .ok()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| DEFAULT_SHELL.to_string()),
    ));

    for key in OPTIONAL_BASE_ENV_KEYS {
        if let Ok(value) = std::env::var(key)
            && !value.is_empty()
        {
            base.push((*key, value));
        }
    }

    base
}

fn apply_runner_visible_env(api_url: &str, mut apply: impl FnMut(&'static str, String)) {
    if !api_url.is_empty() {
        apply(RUNNER_VISIBLE_API_URL_ENV_KEY, api_url.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_child_env_includes_stable_minimum() {
        let keys: Vec<&str> = base_child_env("/tmp/home")
            .into_iter()
            .map(|(key, _)| key)
            .collect();

        assert!(keys.contains(&"HOME"));
        assert!(keys.contains(&"PATH"));
        assert!(keys.contains(&"SHELL"));
    }

    #[test]
    fn normalize_values_keeps_last_value_for_duplicate_keys() {
        let values = normalize_values(vec![
            (
                guest_contracts::env::CANONICAL_API_URL_ENV.to_string(),
                "user-value".to_string(),
            ),
            (
                guest_contracts::env::CANONICAL_API_URL_ENV.to_string(),
                "runner-value".to_string(),
            ),
        ]);

        assert_eq!(
            values
                .iter()
                .find(|(key, _)| key == guest_contracts::env::CANONICAL_API_URL_ENV)
                .map(|(_, value)| value.as_str()),
            Some("runner-value")
        );
        assert_eq!(
            values
                .iter()
                .filter(|(key, _)| key == guest_contracts::env::CANONICAL_API_URL_ENV)
                .count(),
            1
        );
    }

    #[test]
    fn values_with_inputs_uses_captured_canonical_api_url() {
        let mut user_env = HashMap::new();
        let oversized_user_api_url =
            "x".repeat(guest_contracts::exec_limits::EXECVE_STRING_MAX_BYTES + 1);
        user_env.insert(
            guest_contracts::env::CANONICAL_API_URL_ENV.to_string(),
            oversized_user_api_url,
        );
        let captured_api_url = "https://runner.example/%2F?raw=%20#fragment/";

        let values = values_with_inputs("/tmp/home", &user_env, captured_api_url);

        assert_eq!(
            values
                .iter()
                .find(|(key, _)| key == guest_contracts::env::CANONICAL_API_URL_ENV)
                .map(|(_, value)| value.as_str()),
            Some(captured_api_url)
        );
        assert_eq!(
            values
                .iter()
                .filter(|(key, _)| key == guest_contracts::env::CANONICAL_API_URL_ENV)
                .count(),
            1
        );
    }

    #[test]
    fn apply_values_clears_resume_session_bootstrap_key() {
        let mut command = tokio::process::Command::new("unused");
        command.env(
            guest_contracts::env::CANONICAL_RESUME_SESSION_ID_ENV,
            "canonical-session-id",
        );

        let values = values_with_inputs("/tmp/home", &HashMap::new(), "");
        apply_values_to_tokio_command(&mut command, &values);

        let explicit_keys = command
            .as_std()
            .get_envs()
            .map(|(key, _)| key)
            .collect::<Vec<_>>();
        let key = guest_contracts::env::CANONICAL_RESUME_SESSION_ID_ENV;
        assert!(
            !explicit_keys.contains(&std::ffi::OsStr::new(key)),
            "CLI child environment retained bootstrap key {key}"
        );
    }
}
