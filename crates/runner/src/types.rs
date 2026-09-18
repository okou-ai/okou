use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::sync::Arc;

use api_contracts::generated::types::runners::runs::CodexRuntimeConfig;
use api_contracts::generated::types::webhooks::agent::complete::RequestFailureReason;
use sandbox::SandboxId;
use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;

use crate::firewall_hostname_policy::{raw_host_from_authority, raw_url_authority};
use crate::ids::RunId;
use crate::storage_manifest::StorageManifest;

pub(crate) const MAX_HELD_SANDBOX_STATES: usize = 1024;
pub(crate) const MAX_HELD_WORKSPACE_STATES: usize = 1024;
pub(crate) const MAX_WORKSPACE_CACHES_PER_REUSE_KEY: usize = 8;
pub(crate) const MAX_WORKSPACE_CACHES_PER_HEARTBEAT: usize = 1024;
pub(crate) const WORKSPACE_AFFINITY_VERSION: u8 = 1;

fn is_false(value: &bool) -> bool {
    !*value
}

// ---------------------------------------------------------------------------
// Poll
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PollResponse {
    pub job: Option<Job>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub run_id: RunId,
    pub experimental_profile: String,
    #[serde(default)]
    pub reuse_key: Option<String>,
    #[serde(default)]
    pub history_generation_run_id: Option<RunId>,
    #[serde(default)]
    pub runner_preference: Option<serde_json::Value>,
}

pub(crate) fn reuse_key_kind(reuse_key: &str) -> &'static str {
    if reuse_key.starts_with("thread:") {
        "thread"
    } else {
        "other"
    }
}

impl Job {
    pub(crate) fn reuse_key(&self) -> Option<&str> {
        self.reuse_key.as_deref()
    }
}

// ---------------------------------------------------------------------------
// Claim (execution context)
// ---------------------------------------------------------------------------

/// Normalized inputs consumed by API-claimed and locally submitted jobs.
///
/// API claim responses deserialize directly into this type. It intentionally models only the
/// runner-owned subset of the response, and unknown top-level fields are ignored for forward
/// compatibility. The canonical producer schema is
/// `runnersJobClaimContract.claim.responses[200]` in
/// `turbo/packages/api-contracts/src/contracts/runners.ts`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionContext {
    pub run_id: RunId,
    #[serde(default)]
    pub reuse_key: Option<String>,
    pub prompt: String,
    #[serde(default)]
    pub append_system_prompt: Option<String>,
    // Vars are passed to the proxy registry for auth header template resolution.
    #[serde(default)]
    pub vars: Option<HashMap<String, String>>,
    pub sandbox_token: String,
    #[serde(default)]
    pub(crate) storage_manifest: Option<StorageManifest>,
    #[serde(default)]
    pub environment: Option<HashMap<String, String>>,
    /// Trusted API-authored agent environment.
    pub platform_environment: HashMap<String, String>,
    #[serde(default)]
    pub resume_session: Option<ResumeSession>,
    // Plain secret values used only for redaction. These are values, not names.
    #[serde(default)]
    pub secret_values: Option<Vec<String>>,
    // Local submit may explicitly allow raw provider secrets for local-only
    // runner testing. This marker is internal and must not be claimable via API JSON.
    #[serde(default, skip)]
    pub local_secret_env_keys: Option<HashSet<String>>,
    // Encrypted runtime secret namespace forwarded to mitm-addon for auth
    // resolution. Decrypted keys match `${{ secrets.NAME }}` names; connector
    // and model-provider keys are env aliases, not storage secret names.
    #[serde(default)]
    pub encrypted_secrets: Option<String>,
    // Maps firewall auth secret env aliases (the `NAME` in `${{ secrets.NAME }}`)
    // to their connector or provider owner. Keys are env aliases, not storage secret names.
    #[serde(default)]
    pub secret_connector_map: Option<HashMap<String, String>>,
    // Same keys as secret_connector_map; adds source details when the owner
    // alone is not enough to locate access storage.
    #[serde(default)]
    pub secret_connector_metadata_map: Option<HashMap<String, SecretConnectorMetadata>>,
    pub cli_agent_type: String,
    #[serde(default)]
    pub real_agent_in_preview: Option<bool>,
    #[serde(default)]
    pub api_start_time: Option<u64>,
    #[serde(default)]
    pub user_timezone: Option<String>,
    #[serde(default)]
    pub capture_network_bodies: Option<bool>,
    #[serde(default)]
    pub firewalls: Option<Vec<FirewallEntry>>,
    #[serde(default)]
    pub network_policies: Option<std::collections::HashMap<String, NetworkPolicy>>,
    #[serde(default)]
    pub network_policy_refreshes: Option<std::collections::HashMap<String, NetworkPolicyRefresh>>,
    pub connector_runtime_targets: Vec<ConnectorRuntimeTargetRegistration>,
    #[serde(default)]
    pub disallowed_tools: Option<Vec<String>>,
    #[serde(default)]
    pub tools: Option<Vec<String>>,
    #[serde(default)]
    pub settings: Option<String>,
    // Feature flags evaluated at job creation time (all switch states for user/org)
    #[serde(default)]
    pub feature_flags: Option<HashMap<String, bool>>,
    #[serde(default)]
    pub billable_firewalls: Vec<String>,
    #[serde(default)]
    pub model_usage_provider: Option<String>,
    #[serde(default)]
    pub codex_runtime_config: Option<CodexRuntimeConfig>,
    /// Raw Pi launch config retained so additive API fields survive forwarding
    /// through a draining older runner.
    #[serde(default)]
    pub pi_launch_config: Option<serde_json::Value>,
    /// Raw non-secret Pi model config retained for the same rollout boundary.
    #[serde(default)]
    pub pi_model_config: Option<serde_json::Value>,
    /// Chat Thread id used as Pi's official JSONL session id.
    #[serde(default)]
    pub pi_session_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretConnectorMetadata {
    pub source_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_user_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata_key: Option<String>,
}

/// Execution firewall entry supplied by the API.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind")]
pub enum FirewallEntry {
    /// Built-in firewall resolved by the Python addon from the runner-written catalog cache.
    #[serde(rename = "builtin", rename_all = "camelCase")]
    Builtin {
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        base_url_vars: Option<HashMap<String, String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source_id: Option<String>,
    },
    /// Inline firewall body for org custom connectors.
    #[serde(rename = "inline", rename_all = "camelCase")]
    Inline {
        firewall: Firewall,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        custom_connector_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source_id: Option<String>,
    },
}

/// A firewall definition shared by inline execution entries and builtin catalogs.
///
/// `name` is the canonical identifier and is also used as the `networkPolicies`
/// map key. For builtin catalogs, changes to base URL, auth, `hostPolicy`,
/// permission, or serialized-shape semantics must remain compatible with the
/// TypeScript catalog producer and projection and the Python cache and runtime
/// validators. Detailed validity rules belong in executable validators and
/// shared behavioral contracts.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Firewall {
    pub name: String,
    pub apis: Vec<FirewallApi>,
}

impl Firewall {
    /// Validates an unresolved builtin firewall before cache publication.
    ///
    /// This gate checks the structural and syntax invariants available before
    /// per-sandbox resolution. Catalog API IDs must be empty because the Python
    /// registry resolver assigns run-scoped IDs after resolving the entries.
    ///
    /// The Python consumer still independently validates the cache file,
    /// schema, and payload, then owns base-variable resolution, final
    /// credentialed-destination and host-policy checks, matcher compilation,
    /// and request-time enforcement.
    pub(crate) fn validate_for_cache(&self) -> Result<(), String> {
        self.validate_shape()?;
        for (index, api) in self.apis.iter().enumerate() {
            api.validate_for_cache()
                .map_err(|e| format!("firewall {} apis[{index}]: {e}", self.name))?;
        }
        Ok(())
    }

    pub(crate) fn validate_for_connector_runtime(&self) -> Result<(), String> {
        self.validate_shape()?;
        let mut api_ids = HashSet::new();
        for (index, api) in self.apis.iter().enumerate() {
            api.validate_for_connector_runtime()
                .map_err(|e| format!("firewall {} apis[{index}]: {e}", self.name))?;
            if !api_ids.insert(api.id.as_str()) {
                return Err(format!(
                    "firewall {} api id {:?} must be unique",
                    self.name, api.id
                ));
            }
        }
        Ok(())
    }

    fn validate_shape(&self) -> Result<(), String> {
        if self.name.is_empty() {
            return Err("firewall name must be non-empty".to_string());
        }
        if self.apis.is_empty() {
            return Err(format!("firewall {} must have at least one api", self.name));
        }
        Ok(())
    }
}

/// A single firewall API entry with base URL and auth headers for proxy-side matching.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct FirewallApi {
    /// Stable API identifier used as one component of mitm-addon auth cache keys.
    /// Builtin catalogs leave this empty for the Python registry loader to
    /// assign. Synced custom connector firewalls provide a stable ID.
    #[serde(default)]
    pub id: String,
    pub base: String,
    pub auth: FirewallAuth,
    #[serde(
        default,
        rename = "hostPolicy",
        skip_serializing_if = "Option::is_none"
    )]
    pub host_policy: Option<FirewallBaseHostPolicy>,
    #[serde(default)]
    pub permissions: Option<Vec<FirewallPermission>>,
}

impl FirewallApi {
    fn validate_for_cache(&self) -> Result<(), String> {
        if !self.id.is_empty() {
            return Err("id must be empty because the runner assigns api ids".to_string());
        }
        self.validate_shape()
    }

    fn validate_for_connector_runtime(&self) -> Result<(), String> {
        if self.id.is_empty() {
            return Err("id must be non-empty".to_string());
        }
        self.validate_shape()
    }

    fn validate_shape(&self) -> Result<(), String> {
        if self.base.is_empty() {
            return Err("base must be non-empty".to_string());
        }
        validate_firewall_base_for_cache(&self.base)?;
        self.auth.validate_for_cache()?;
        if let Some(host_policy) = &self.host_policy {
            host_policy.validate_for_cache()?;
        }
        if let Some(permissions) = &self.permissions {
            let mut seen_names = HashSet::new();
            for permission in permissions {
                permission.validate_for_cache()?;
                if !seen_names.insert(permission.name.as_str()) {
                    return Err(format!(
                        "permission name {:?} must be unique per api",
                        permission.name
                    ));
                }
            }
        }
        Ok(())
    }
}

/// A named permission group with matching rules for request authorization.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct FirewallPermission {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub rules: Vec<String>,
}

impl FirewallPermission {
    fn validate_for_cache(&self) -> Result<(), String> {
        if self.name.is_empty() {
            return Err("permission name must be non-empty".to_string());
        }
        if self.name == "all" || self.name == "__unknown__" {
            return Err(format!("permission name {:?} is reserved", self.name));
        }
        if self.rules.is_empty() {
            return Err(format!(
                "permission {:?} must have at least one rule",
                self.name
            ));
        }
        if self.rules.iter().any(|rule| rule.is_empty()) {
            return Err(format!(
                "permission {:?} rules must be non-empty",
                self.name
            ));
        }
        for rule in &self.rules {
            validate_firewall_permission_rule(rule)
                .map_err(|e| format!("permission {:?} rule {:?}: {e}", self.name, rule))?;
        }
        Ok(())
    }
}

const VALID_FIREWALL_RULE_METHODS: &[&str] = &[
    "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "ANY",
];

struct FirewallRuleSegmentParam<'a> {
    name: &'a str,
    greedy: bool,
    prefix: &'a str,
    suffix: &'a str,
}

const DNS_LABEL_MAX_LENGTH: usize = 63;

fn validate_firewall_permission_rule(rule: &str) -> Result<(), String> {
    let Some((method, path)) = rule.split_once(' ') else {
        return Err("must be \"METHOD /path\"".to_string());
    };
    if method.is_empty() || path.is_empty() {
        return Err("must be \"METHOD /path\"".to_string());
    }
    if !VALID_FIREWALL_RULE_METHODS.contains(&method) {
        return Err(format!("unknown method {method:?}"));
    }
    if !path.starts_with('/') {
        return Err("path must start with \"/\"".to_string());
    }
    if path.chars().any(is_raw_whitespace) {
        return Err("path must not contain whitespace".to_string());
    }
    if path.chars().any(is_unsafe_url_codepoint) {
        return Err("path must not contain control characters".to_string());
    }
    if path.contains('\\') {
        return Err("path must not contain backslash".to_string());
    }
    if path.contains('?') || path.contains('#') {
        return Err("path must not contain query string or fragment".to_string());
    }

    let segments: Vec<&str> = split_firewall_rule_path_segments(path).collect();
    let last_index = segments.len().saturating_sub(1);
    let mut param_names = HashSet::new();
    for (index, segment) in segments.iter().enumerate() {
        let Some(param) = parse_firewall_rule_segment(segment)? else {
            continue;
        };
        if !param_names.insert(param.name) {
            return Err(format!("duplicate parameter name {:?}", param.name));
        }
        if param.greedy && index != last_index {
            return Err(format!(
                "greedy parameter {:?} must be the last segment",
                param.name
            ));
        }
        if param.greedy && (!param.prefix.is_empty() || !param.suffix.is_empty()) {
            return Err(format!(
                "greedy parameter {:?} cannot be combined with a literal prefix or suffix",
                param.name
            ));
        }
    }
    Ok(())
}

fn split_firewall_rule_path_segments(path: &str) -> impl Iterator<Item = &str> {
    let path_without_leading_slash = path.strip_prefix('/').unwrap_or(path);
    path_without_leading_slash
        .split('/')
        .filter(|segment| !path_without_leading_slash.is_empty() || !segment.is_empty())
}

fn parse_firewall_rule_segment(
    segment: &str,
) -> Result<Option<FirewallRuleSegmentParam<'_>>, String> {
    let open_count = segment.matches('{').count();
    let close_count = segment.matches('}').count();

    if open_count == 0 && close_count == 0 {
        return Ok(None);
    }
    if open_count != close_count {
        return Err(format!("unbalanced brace in segment {segment:?}"));
    }

    let Some(open_index) = segment.find('{') else {
        return Err(format!("unbalanced brace in segment {segment:?}"));
    };
    let Some(close_index) = segment.find('}') else {
        return Err(format!("unbalanced brace in segment {segment:?}"));
    };
    if close_index < open_index {
        return Err(format!("unbalanced brace in segment {segment:?}"));
    }

    if open_count >= 2 {
        let open_after_close = segment[close_index + 1..]
            .find('{')
            .map(|index| close_index + 1 + index);
        if open_after_close == Some(close_index + 1) {
            return Err(format!("adjacent parameters in segment {segment:?}"));
        }
        return Err(format!(
            "literal-separated parameters in segment {segment:?}"
        ));
    }

    let prefix = &segment[..open_index];
    let content = &segment[open_index + 1..close_index];
    let suffix = &segment[close_index + 1..];
    if prefix.contains('{') || prefix.contains('}') || suffix.contains('{') || suffix.contains('}')
    {
        return Err(format!("unbalanced brace in segment {segment:?}"));
    }

    let (name, greedy) = content
        .strip_suffix('+')
        .map(|name| (name, true))
        .or_else(|| content.strip_suffix('*').map(|name| (name, true)))
        .unwrap_or((content, false));
    if name.is_empty() {
        return Err(format!("empty parameter name in segment {segment:?}"));
    }

    Ok(Some(FirewallRuleSegmentParam {
        name,
        greedy,
        prefix,
        suffix,
    }))
}

fn is_raw_whitespace(ch: char) -> bool {
    matches!(ch, ' ' | '\t' | '\n' | '\r' | '\u{000c}' | '\u{000b}')
}

fn is_unsafe_url_codepoint(ch: char) -> bool {
    ch < '\u{0020}' || ch == '\u{007f}'
}

// Keep component witnesses small; hostname fragments also preserve adjacent
// literal label boundaries when materialized below.
const BASE_URL_TEMPLATE_WHOLE_BASE_PLACEHOLDER: &str = "https://x.y";
const BASE_URL_TEMPLATE_HOST_PLACEHOLDER: &str = "x.y";
const BASE_URL_TEMPLATE_PORT_PLACEHOLDER: &str = "1";
const BASE_URL_TEMPLATE_PATH_PLACEHOLDER: &str = "x";
const BASE_URL_TEMPLATE_HOST_LABEL_DELIMITERS: &[char] = &[
    '.', ':', '/', '?', '#', '@', '[', ']', '\u{3002}', '\u{ff0e}', '\u{ff61}',
];

// Precompute fixed URL delimiters once; a catalog base can contain many templates.
struct BaseUrlTemplateComponentBoundaries {
    authority_start: Option<usize>,
    path_start: Option<usize>,
    query_or_fragment_start: Option<usize>,
}

impl BaseUrlTemplateComponentBoundaries {
    fn new(base: &str) -> Self {
        let authority_start = base.find("://").map(|index| index + "://".len());
        let path_start = authority_start.and_then(|start| {
            base[start..]
                .find('/')
                .map(|relative_index| start + relative_index)
        });
        let query_or_fragment_start = authority_start.and_then(|start| {
            base[start..]
                .find(['?', '#'])
                .map(|relative_index| start + relative_index)
        });
        Self {
            authority_start,
            path_start,
            query_or_fragment_start,
        }
    }

    fn prefix_is_inside_authority(&self, template_start: usize) -> bool {
        self.authority_start
            .is_some_and(|start| start <= template_start)
            && self
                .path_start
                .into_iter()
                .chain(self.query_or_fragment_start)
                .all(|boundary| template_start <= boundary)
    }

    fn prefix_is_inside_path(&self, template_start: usize) -> bool {
        self.path_start
            .is_some_and(|path_start| path_start < template_start)
            && self
                .query_or_fragment_start
                .is_none_or(|boundary| template_start <= boundary)
    }
}

fn validate_firewall_base_for_cache(base: &str) -> Result<(), String> {
    let template_syntax_target = base_url_template_syntax_target_for_cache(base)?;
    let raw_syntax_target = template_syntax_target.as_deref().unwrap_or(base);
    if raw_syntax_target.contains('\\') {
        return Err("base URL must not contain backslash".to_string());
    }
    if raw_syntax_target.chars().any(is_raw_whitespace) {
        return Err("base URL must not contain whitespace".to_string());
    }
    if raw_syntax_target.chars().any(is_unsafe_url_codepoint) {
        return Err("base URL must not contain control characters".to_string());
    }
    if raw_syntax_target.contains('?') {
        return Err("base URL must not contain query string".to_string());
    }
    if raw_syntax_target.contains('#') {
        return Err("base URL must not contain fragment".to_string());
    }
    let raw_path = raw_url_path(raw_syntax_target);
    if path_has_unsafe_segments_for_cache(raw_path) {
        return Err("base URL must not contain unsafe path".to_string());
    }
    if raw_syntax_target.contains('{') || raw_syntax_target.contains('}') {
        return validate_parameterized_firewall_base_for_cache(raw_syntax_target);
    }
    let parsed =
        url::Url::parse(raw_syntax_target).map_err(|_| "base URL is invalid".to_string())?;
    let authority = raw_url_authority(raw_syntax_target)
        .ok_or_else(|| "base URL must include :// after the scheme".to_string())?;
    if authority.is_empty() {
        return Err("base URL must include a host".to_string());
    }
    if raw_authority_has_empty_port(raw_syntax_target) {
        return Err("base URL authority must not include an empty port".to_string());
    }
    crate::firewall_hostname_policy::validate_raw_url_host(
        raw_host_from_authority(authority),
        "base URL",
    )?;

    let scheme = parsed.scheme();
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return Err("base URL scheme must be http or https".to_string());
    }
    if parsed.host_str().is_none() {
        return Err("base URL must include a host".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("base URL must not contain userinfo".to_string());
    }
    if parsed.query().is_some() {
        return Err("base URL must not contain query string".to_string());
    }
    if parsed.fragment().is_some() {
        return Err("base URL must not contain fragment".to_string());
    }
    Ok(())
}

fn base_url_template_syntax_target_for_cache(base: &str) -> Result<Option<String>, String> {
    let mut search_start = 0;
    let mut result = String::new();
    let mut found = false;
    let boundaries = BaseUrlTemplateComponentBoundaries::new(base);
    while let Some(relative_start) = base[search_start..].find("${{") {
        found = true;
        let start = search_start + relative_start;
        let content_start = start + "${{".len();
        let Some(relative_end) = base[content_start..].find("}}") else {
            return Err("base URL template reference is unterminated".to_string());
        };
        let end = content_start + relative_end;
        validate_base_url_var_reference(&base[content_start..end])?;
        result.push_str(&base[search_start..start]);
        let template_end = end + "}}".len();
        result.push_str(base_url_template_syntax_placeholder_for_cache(
            base,
            search_start,
            start,
            template_end,
            &boundaries,
        )?);
        search_start = template_end;
    }
    if !found {
        return Ok(None);
    }
    result.push_str(&base[search_start..]);
    Ok(Some(result))
}

fn validate_base_url_var_reference(content: &str) -> Result<(), String> {
    let trimmed = content.trim_matches(is_ecmascript_whitespace);
    let Some(name) = trimmed.strip_prefix("vars.") else {
        return Err("base URL template reference must use vars".to_string());
    };
    validate_template_identifier(name, "base URL template variable")
}

fn is_ecmascript_whitespace(ch: char) -> bool {
    matches!(
        ch,
        '\u{0009}'..='\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

fn base_url_template_syntax_placeholder_for_cache(
    base: &str,
    literal_start: usize,
    start: usize,
    template_end: usize,
    boundaries: &BaseUrlTemplateComponentBoundaries,
) -> Result<&'static str, String> {
    let ends_base_or_starts_path =
        template_end == base.len() || base[template_end..].starts_with('/');

    if start == 0 && ends_base_or_starts_path {
        return Ok(BASE_URL_TEMPLATE_WHOLE_BASE_PLACEHOLDER);
    }
    if base[..start].ends_with("://") && ends_base_or_starts_path {
        return Ok(BASE_URL_TEMPLATE_HOST_PLACEHOLDER);
    }
    if boundaries.prefix_is_inside_authority(start) {
        if base[..start].ends_with(':') && ends_base_or_starts_path {
            return Ok(BASE_URL_TEMPLATE_PORT_PLACEHOLDER);
        }
        let prefix = &base[literal_start..start];
        let remaining = &base[template_end..];
        let suffix = remaining
            .split_once("${{")
            .map_or(remaining, |(literal, _)| literal);
        return Ok(base_url_template_hostname_placeholder(prefix, suffix));
    }
    if boundaries.prefix_is_inside_path(start) {
        return Ok(BASE_URL_TEMPLATE_PATH_PLACEHOLDER);
    }
    Err("base URL template variable is used in an unsupported position".to_string())
}

fn base_url_template_hostname_placeholder(prefix: &str, suffix: &str) -> &'static str {
    let prefix_label = prefix
        .rsplit_once(BASE_URL_TEMPLATE_HOST_LABEL_DELIMITERS)
        .map_or(prefix, |(_, label)| label);
    let suffix_label = suffix
        .split_once(BASE_URL_TEMPLATE_HOST_LABEL_DELIMITERS)
        .map_or(suffix, |(label, _)| label);
    // A variable may supply a dot, so a complete literal label need not grow.
    // Incomplete labels still join the witness; final URL validation checks both.
    match (
        base_url_template_literal_label_is_valid(prefix_label),
        base_url_template_literal_label_is_valid(suffix_label),
    ) {
        (true, true) => ".x.y.",
        (true, false) => ".x.y",
        (false, true) => "x.y.",
        (false, false) => BASE_URL_TEMPLATE_HOST_PLACEHOLDER,
    }
}

fn base_url_template_literal_label_is_valid(label: &str) -> bool {
    !label.is_empty()
        && validate_parameterized_firewall_base_authority("https", &format!("x.{label}.y"), "")
            .is_ok()
}

fn validate_template_identifier(name: &str, label: &str) -> Result<(), String> {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return Err(format!("{label} name must be non-empty"));
    };
    if !(first == '_' || first.is_ascii_alphabetic()) {
        return Err(format!(
            "{label} name must start with a letter or underscore"
        ));
    }
    if !chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric()) {
        return Err(format!("{label} name must be alphanumeric"));
    }
    Ok(())
}

fn validate_parameterized_firewall_base_for_cache(base: &str) -> Result<(), String> {
    let Some((scheme, rest)) = base.split_once("://") else {
        return Err("base URL missing scheme".to_string());
    };
    if scheme.contains('{') || scheme.contains('}') {
        return Err("base URL scheme must not contain parameters".to_string());
    }
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return Err("base URL scheme must be http or https".to_string());
    }

    let (authority, path) = rest
        .split_once('/')
        .map_or((rest, ""), |(authority, path)| (authority, path));
    if authority.is_empty() {
        return Err("base URL must include a host".to_string());
    }
    if authority.contains('@') {
        return Err("base URL must not contain userinfo".to_string());
    }

    let (host, port_suffix) = parameterized_base_authority(authority)?;
    let mut param_names = HashSet::new();
    let materialized_host = validate_parameterized_firewall_base_host(host, &mut param_names)?;
    validate_parameterized_firewall_base_authority(scheme, &materialized_host, port_suffix)?;
    validate_parameterized_firewall_base_path(path, &mut param_names)?;
    Ok(())
}

fn parameterized_base_authority(authority: &str) -> Result<(&str, &str), String> {
    if authority.ends_with(':') {
        return Err("base URL authority must not include an empty port".to_string());
    }
    if authority.contains('[') || authority.contains(']') {
        return Err("parameterized base URL authority must not be bracketed".to_string());
    }
    if authority.contains('%') {
        return Err(
            "parameterized base URL authority must not contain percent encoding".to_string(),
        );
    }
    let Some((host, port)) = authority.rsplit_once(':') else {
        return Ok((authority, ""));
    };
    if !port.chars().all(|ch| ch.is_ascii_digit()) {
        return Err("base URL authority has invalid port".to_string());
    }
    if host.is_empty() {
        return Err("base URL must include a host".to_string());
    }
    Ok((host, &authority[host.len()..]))
}

fn validate_parameterized_firewall_base_host(
    host: &str,
    param_names: &mut HashSet<String>,
) -> Result<String, String> {
    let has_trailing_dot = host.ends_with('.');
    let host_without_trailing_dot = host.strip_suffix('.').unwrap_or(host);
    let segments: Vec<&str> = host_without_trailing_dot.split('.').collect();
    if segments.len() < 2 {
        return Err("base URL host must have at least two segments".to_string());
    }

    let mut has_static_segment = false;
    let mut materialized_host = String::with_capacity(host.len());
    for (index, segment) in segments.iter().enumerate() {
        if segment.is_empty() {
            return Err("base URL host segments must be non-empty".to_string());
        }
        if index > 0 {
            materialized_host.push('.');
        }
        if let Some(param) = parse_firewall_rule_segment(segment)? {
            if !param_names.insert(param.name.to_string()) {
                return Err(format!(
                    "duplicate parameter name {:?} in base URL host",
                    param.name
                ));
            }
            if param.greedy && index != 0 {
                return Err(format!(
                    "greedy parameter {:?} must be the first host segment",
                    param.name
                ));
            }
            if param.greedy && (!param.prefix.is_empty() || !param.suffix.is_empty()) {
                return Err(format!(
                    "greedy parameter {:?} cannot be combined with a literal prefix or suffix in base URL host",
                    param.name
                ));
            }
            validate_parameterized_firewall_base_host_literal(param.prefix)?;
            validate_parameterized_firewall_base_host_literal(param.suffix)?;
            materialized_host.push_str(param.prefix);
            materialized_host.push('x');
            materialized_host.push_str(param.suffix);
        } else {
            validate_parameterized_firewall_base_host_literal(segment)?;
            has_static_segment = true;
            materialized_host.push_str(segment);
        }
    }
    if !has_static_segment {
        return Err("base URL host must have at least one static segment".to_string());
    }
    if has_trailing_dot {
        materialized_host.push('.');
    }
    Ok(materialized_host)
}

fn validate_parameterized_firewall_base_host_literal(literal: &str) -> Result<(), String> {
    if literal.contains('*') || literal.contains(',') {
        return Err("parameterized base URL host contains invalid literal syntax".to_string());
    }
    Ok(())
}

fn validate_parameterized_firewall_base_authority(
    scheme: &str,
    materialized_host: &str,
    port_suffix: &str,
) -> Result<(), String> {
    crate::firewall_hostname_policy::validate_raw_url_host(materialized_host, "base URL")?;
    let syntax_target = format!("{scheme}://{materialized_host}{port_suffix}");
    let parsed = url::Url::parse(&syntax_target)
        .map_err(|_| "parameterized base URL authority is invalid".to_string())?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "parameterized base URL authority must include a host".to_string())?;
    if host
        .split('.')
        .any(|label| label.len() > DNS_LABEL_MAX_LENGTH)
    {
        return Err("parameterized base URL host label is too long".to_string());
    }
    Ok(())
}

fn validate_parameterized_firewall_base_path(
    path: &str,
    param_names: &mut HashSet<String>,
) -> Result<(), String> {
    for segment in path.split('/') {
        let Some(param) = parse_firewall_rule_segment(segment)? else {
            continue;
        };
        if param.greedy {
            return Err(format!(
                "greedy parameter {:?} is not allowed in base URL path",
                param.name
            ));
        }
        if !param_names.insert(param.name.to_string()) {
            return Err(format!(
                "duplicate parameter name {:?} in base URL path",
                param.name
            ));
        }
    }
    Ok(())
}

/// Base-host ownership policy for credentialed builtin firewall APIs.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum FirewallBaseHostPolicy {
    #[serde(rename = "providerOwned", rename_all = "camelCase")]
    ProviderOwned {
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        exact_hosts: Vec<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        suffixes: Vec<String>,
        #[serde(default, skip_serializing_if = "is_false")]
        allow_non_default_port: bool,
    },
    #[serde(rename = "publicDestination")]
    PublicDestination,
}

impl FirewallBaseHostPolicy {
    fn validate_for_cache(&self) -> Result<(), String> {
        match self {
            Self::ProviderOwned {
                exact_hosts,
                suffixes,
                ..
            } => {
                if exact_hosts.is_empty() && suffixes.is_empty() {
                    return Err(
                        "providerOwned hostPolicy requires exactHosts or suffixes".to_string()
                    );
                }
                for host in exact_hosts {
                    validate_host_policy_hostname(host, false)?;
                }
                for suffix in suffixes {
                    validate_host_policy_hostname(suffix, true)?;
                }
                Ok(())
            }
            Self::PublicDestination => Ok(()),
        }
    }
}

fn validate_host_policy_hostname(value: &str, allow_leading_dot: bool) -> Result<(), String> {
    if value.is_empty() {
        return Err("hostPolicy host must be non-empty".to_string());
    }
    if !allow_leading_dot && value.starts_with('.') {
        return Err("hostPolicy exactHosts must not start with a dot".to_string());
    }
    if !value.is_ascii()
        || value
            .chars()
            .any(|ch| ch.is_whitespace() || ch.is_ascii_control())
    {
        return Err(
            "hostPolicy hosts must be ASCII without whitespace or control characters".to_string(),
        );
    }
    const FORBIDDEN: &[char] = &['%', '*', '[', ']', '/', '?', '#', '@', '\\', ':', '{', '}'];
    if value.chars().any(|ch| FORBIDDEN.contains(&ch)) {
        return Err("hostPolicy hosts contain forbidden syntax characters".to_string());
    }

    let host = if allow_leading_dot && value.starts_with('.') {
        &value[1..]
    } else {
        value
    };
    let host = host.strip_suffix('.').unwrap_or(host);
    if host.is_empty() {
        return Err("hostPolicy host must be non-empty".to_string());
    }
    if host.parse::<IpAddr>().is_ok() {
        return Err("hostPolicy host must not be an IP address".to_string());
    }
    if crate::firewall_hostname_policy::is_ipv4_literal_like(host) {
        return Err("hostPolicy host must not look like an IPv4 address".to_string());
    }
    let labels: Vec<&str> = host.split('.').collect();
    if labels.len() < 2 || labels.iter().any(|label| label.is_empty()) {
        return Err("hostPolicy host must have at least two non-empty labels".to_string());
    }
    Ok(())
}

/// Auth configuration for a firewall API entry.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct FirewallAuth {
    #[serde(default)]
    pub headers: std::collections::HashMap<String, String>,
    /// Optional base URL template for URL rewriting (e.g. webhook-url connectors).
    /// When set, the proxy rewrites the request URL before applying resolved auth.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    /// Optional query parameters with secret/var templates for query-param auth.
    /// When set, the proxy injects resolved query params into the request URL.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<std::collections::HashMap<String, String>>,
    /// Optional AWS SigV4 auth template.
    #[serde(default, rename = "awsSigv4", skip_serializing_if = "Option::is_none")]
    pub aws_sigv4: Option<FirewallAwsSigv4Auth>,
}

impl FirewallAuth {
    fn validate_for_cache(&self) -> Result<(), String> {
        if let Some(base) = &self.base {
            validate_auth_base_for_cache(base)?;
        }
        let Some(aws_sigv4) = &self.aws_sigv4 else {
            return Ok(());
        };
        aws_sigv4.validate_for_cache()?;
        if self.base.is_some() {
            return Err("auth.base cannot be combined with auth.awsSigv4".to_string());
        }
        if !self.headers.is_empty() {
            return Err("auth.headers cannot be combined with auth.awsSigv4".to_string());
        }
        if self.query.as_ref().is_some_and(|query| !query.is_empty()) {
            return Err("auth.query cannot be combined with auth.awsSigv4".to_string());
        }
        Ok(())
    }
}

struct AuthBaseStaticValidationTarget {
    url: Option<String>,
    dynamic_prefix_suffix: String,
}

fn validate_auth_base_for_cache(auth_base: &str) -> Result<(), String> {
    if auth_base.is_empty() {
        return Err("auth.base must be non-empty when present".to_string());
    }
    if auth_base.contains('\\') {
        return Err("auth.base must not contain backslash".to_string());
    }
    let target = auth_base_static_validation_target_for_cache(auth_base)?;
    validate_dynamic_auth_base_suffix_for_cache(&target.dynamic_prefix_suffix)?;
    let Some(validation_url) = target.url else {
        return Ok(());
    };
    if validation_url.contains("${{") {
        return Err("auth.base contains unsupported template reference".to_string());
    }
    if validation_url.chars().any(is_raw_whitespace) {
        return Err("auth.base must not contain whitespace".to_string());
    }
    if validation_url.chars().any(is_unsafe_url_codepoint) {
        return Err("auth.base must not contain control characters".to_string());
    }
    if !validation_url.contains("://") {
        return Err("auth.base URL must include a scheme".to_string());
    }
    let parsed =
        url::Url::parse(&validation_url).map_err(|_| "auth.base URL is invalid".to_string())?;
    if parsed.scheme() != "https" {
        return Err("auth.base scheme must be https".to_string());
    }
    if parsed.host_str().is_none() {
        return Err("auth.base URL must include a host".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("auth.base must not contain userinfo".to_string());
    }
    if parsed.fragment().is_some() {
        return Err("auth.base must not contain fragment".to_string());
    }
    if raw_authority_has_empty_port(&validation_url) {
        return Err("auth.base URL authority must not include an empty port".to_string());
    }
    if path_has_unsafe_segments_for_cache(raw_url_path(&validation_url)) {
        return Err("auth.base must not contain unsafe path".to_string());
    }
    Ok(())
}

fn auth_base_static_validation_target_for_cache(
    auth_base: &str,
) -> Result<AuthBaseStaticValidationTarget, String> {
    let mut search_start = 0;
    let mut result = String::new();
    let mut first_template_end = None;
    let mut found = false;
    while let Some(relative_start) = auth_base[search_start..].find("${{") {
        found = true;
        let start = search_start + relative_start;
        let content_start = start + "${{".len();
        let Some(relative_end) = auth_base[content_start..].find("}}") else {
            return Err("auth.base template reference is unterminated".to_string());
        };
        let end = content_start + relative_end;
        validate_auth_base_template_reference(&auth_base[content_start..end])?;
        result.push_str(&auth_base[search_start..start]);
        result.push_str("placeholder");
        search_start = end + "}}".len();
        if start == 0 && first_template_end.is_none() {
            first_template_end = Some(result.len());
        }
    }
    if !found {
        return Ok(AuthBaseStaticValidationTarget {
            url: Some(auth_base.to_string()),
            dynamic_prefix_suffix: String::new(),
        });
    }
    result.push_str(&auth_base[search_start..]);
    if let Some(end) = first_template_end {
        return Ok(AuthBaseStaticValidationTarget {
            url: None,
            dynamic_prefix_suffix: result[end..].to_string(),
        });
    }
    Ok(AuthBaseStaticValidationTarget {
        url: Some(result),
        dynamic_prefix_suffix: String::new(),
    })
}

fn validate_auth_base_template_reference(content: &str) -> Result<(), String> {
    let trimmed = content.trim_matches(is_ecmascript_whitespace);
    let name = trimmed
        .strip_prefix("secrets.")
        .or_else(|| trimmed.strip_prefix("vars."))
        .ok_or_else(|| "auth.base template reference must use secrets or vars".to_string())?;
    validate_template_identifier(name, "auth.base template variable")
}

fn validate_dynamic_auth_base_suffix_for_cache(suffix: &str) -> Result<(), String> {
    if suffix.contains("${{") {
        return Err("auth.base contains unsupported template reference".to_string());
    }
    if suffix.chars().any(is_raw_whitespace) {
        return Err("auth.base dynamic URL suffix must not contain whitespace".to_string());
    }
    if suffix.chars().any(is_unsafe_url_codepoint) {
        return Err("auth.base dynamic URL suffix must not contain control characters".to_string());
    }
    if suffix.contains('#') {
        return Err("auth.base must not contain fragment".to_string());
    }
    if !suffix.is_empty() && !suffix.starts_with('/') && !suffix.starts_with('?') {
        return Err("auth.base dynamic URL suffix must start with / or ?".to_string());
    }
    if suffix.starts_with('/') {
        let path = suffix.split_once('?').map_or(suffix, |(path, _)| path);
        if path_has_unsafe_segments_for_cache(path) {
            return Err("auth.base dynamic URL suffix must not contain unsafe path".to_string());
        }
    }
    Ok(())
}

fn path_has_unsafe_segments_for_cache(path: &str) -> bool {
    path.contains('\\') || path.split('/').any(segment_has_unsafe_path_for_cache)
}

fn segment_has_unsafe_path_for_cache(raw_segment: &str) -> bool {
    const MAX_PERCENT_DECODE_PASSES: usize = 5;

    let mut segment = raw_segment.to_string();
    for _ in 0..MAX_PERCENT_DECODE_PASSES {
        if segment_has_unsafe_syntax_for_cache(&segment) {
            return true;
        }
        let Some(decoded) = percent_decode_segment(&segment) else {
            return true;
        };
        if decoded == segment {
            return false;
        }
        segment = decoded;
    }

    if segment_has_unsafe_syntax_for_cache(&segment) {
        return true;
    }
    percent_decode_segment(&segment).is_none_or(|decoded| decoded != segment)
}

fn segment_has_unsafe_syntax_for_cache(segment: &str) -> bool {
    if segment_has_unsafe_syntax_parts_for_cache(segment) {
        return true;
    }

    let normalized: String = segment.nfkc().collect();
    normalized != segment
        && (normalized.contains('%') || segment_has_unsafe_syntax_parts_for_cache(&normalized))
}

fn segment_has_unsafe_syntax_parts_for_cache(segment: &str) -> bool {
    segment.chars().any(is_unsafe_url_codepoint)
        || segment.contains('\\')
        || path_part_is_dot_segment_for_cache(segment)
        || segment.split('/').any(path_part_is_dot_segment_for_cache)
}

fn path_part_is_dot_segment_for_cache(segment: &str) -> bool {
    let path_part = segment.split_once(';').map_or(segment, |(part, _)| part);
    path_part == "." || path_part == ".."
}

fn percent_decode_segment(segment: &str) -> Option<String> {
    let bytes = segment.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while let Some(&byte) = bytes.get(index) {
        if byte != b'%' {
            decoded.push(byte);
            index += 1;
            continue;
        }
        let high = *bytes.get(index + 1)?;
        let low = *bytes.get(index + 2)?;
        decoded.push((hex_value(high)? << 4) | hex_value(low)?);
        index += 3;
    }
    String::from_utf8(decoded).ok()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn raw_authority_has_empty_port(value: &str) -> bool {
    let Some(authority) = raw_url_authority(value) else {
        return false;
    };
    authority.ends_with(':')
}

fn raw_url_path(value: &str) -> &str {
    let Some(rest) = value.split_once("://").map(|(_, rest)| rest) else {
        return "";
    };
    let Some(path_start) = rest.find(['/', '?', '#']) else {
        return "";
    };
    if !rest[path_start..].starts_with('/') {
        return "";
    }
    let path_and_after = &rest[path_start..];
    let path_end = path_and_after
        .find(['?', '#'])
        .unwrap_or(path_and_after.len());
    &path_and_after[..path_end]
}

/// AWS SigV4 auth template for firewall auth injection.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct FirewallAwsSigv4Auth {
    pub access_key_id: String,
    pub secret_access_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_token: Option<String>,
}

impl FirewallAwsSigv4Auth {
    fn validate_for_cache(&self) -> Result<(), String> {
        if self.access_key_id.is_empty() {
            return Err("auth.awsSigv4.accessKeyId must be non-empty".to_string());
        }
        if self.secret_access_key.is_empty() {
            return Err("auth.awsSigv4.secretAccessKey must be non-empty".to_string());
        }
        if self.session_token.as_deref() == Some("") {
            return Err("auth.awsSigv4.sessionToken must be non-empty when present".to_string());
        }
        Ok(())
    }
}

/// Per-firewall grant configuration: which permissions are authorized and
/// what policy applies to unknown endpoints (not matching any rule).
/// Firewall names absent from the map are fully permissive (all granted + allow unknown).
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkPolicy {
    /// Permission names granted by the user.
    pub allow: Vec<String>,
    /// Permission names explicitly denied by the admin.
    pub deny: Vec<String>,
    /// Permission names requiring user approval before use.
    pub ask: Vec<String>,
    /// Policy for requests not matching any known permission rule.
    /// Values: "allow", "deny", "ask"
    pub unknown_policy: String,
}

/// Per-connector runtime network policy refresh boundary supplied by the API.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkPolicyRefresh {
    pub next_refresh_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ConnectorRuntimeTarget {
    #[serde(rename_all = "camelCase")]
    Builtin { connector_slug: String },
    #[serde(rename_all = "camelCase")]
    Custom { custom_connector_id: String },
}

/// Stable connector identity plus run-pinned metadata used at registration and
/// in runtime synchronization requests. Metadata never participates in the
/// derived target identity, result correlation, or realtime notification routing.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ConnectorRuntimeTargetRegistration {
    #[serde(rename_all = "camelCase")]
    Builtin {
        connector_slug: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        base_url_vars: Option<HashMap<String, String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Custom {
        custom_connector_id: String,
        base_url_vars: HashMap<String, String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source_id: Option<String>,
    },
}

impl ConnectorRuntimeTargetRegistration {
    pub(crate) fn target(&self) -> ConnectorRuntimeTarget {
        match self {
            Self::Builtin { connector_slug, .. } => ConnectorRuntimeTarget::Builtin {
                connector_slug: connector_slug.clone(),
            },
            Self::Custom {
                custom_connector_id,
                ..
            } => ConnectorRuntimeTarget::Custom {
                custom_connector_id: custom_connector_id.clone(),
            },
        }
    }

    pub(crate) fn custom_base_url_vars(&self) -> Option<&HashMap<String, String>> {
        match self {
            Self::Custom { base_url_vars, .. } => Some(base_url_vars),
            Self::Builtin { .. } => None,
        }
    }

    pub(crate) fn source_id(&self) -> Option<&str> {
        match self {
            Self::Builtin { source_id, .. } | Self::Custom { source_id, .. } => {
                source_id.as_deref()
            }
        }
    }
}

impl ConnectorRuntimeTarget {
    pub(crate) fn log_identity(&self) -> String {
        match self {
            Self::Builtin { connector_slug } => format!("builtin:{connector_slug}"),
            Self::Custom {
                custom_connector_id,
            } => format!("custom:{custom_connector_id}"),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorRuntimeSyncResult {
    pub target: ConnectorRuntimeTarget,
    pub next_sync_at: Option<String>,
    /// Custom routing inputs echoed by an available synchronization result. The
    /// scheduler accepts them only when they match the run-pinned registration.
    #[serde(default)]
    pub base_url_vars: Option<HashMap<String, String>>,
    #[serde(flatten)]
    pub state: ConnectorRuntimeSyncState,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "state",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum ConnectorRuntimeSyncState {
    Available {
        network_policy: NetworkPolicy,
        #[serde(default)]
        firewall: Option<FirewallEntry>,
    },
    Unresolved {
        reason: ConnectorRuntimeUnresolvedReason,
    },
    Absent {
        reason: ConnectorRuntimeCustomAbsentReason,
    },
}

#[derive(Clone, Debug, Deserialize)]
pub enum ConnectorRuntimeUnresolvedReason {
    #[serde(rename = "connector-unavailable")]
    Connector,
    #[serde(rename = "permission-bundle-unavailable")]
    PermissionBundle,
    #[serde(rename = "runtime-configuration-unavailable")]
    RuntimeConfiguration,
}

#[derive(Clone, Debug, Deserialize)]
pub enum ConnectorRuntimeCustomAbsentReason {
    #[serde(rename = "connector-unavailable")]
    Connector,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorRuntimeSyncBatchResponse {
    pub results: Vec<ConnectorRuntimeSyncResult>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeSession {
    #[serde(rename = "sessionId")]
    pub cli_agent_session_id: String,
    #[serde(flatten)]
    pub history: ResumeSessionHistory,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub enum ResumeSessionHistory {
    Inline {
        #[serde(rename = "sessionHistory")]
        #[serde(deserialize_with = "deserialize_shared_string")]
        session_history: Arc<String>,
    },
    Ref {
        #[serde(rename = "historyRef")]
        history_ref: ResumeSessionHistoryRef,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeSessionHistoryRef {
    pub kind: ResumeSessionHistoryRefKind,
    pub hash: String,
    pub url: String,
    pub encoding: ResumeSessionHistoryEncoding,
    #[serde(rename = "rawSize")]
    pub raw_size: u64,
    #[serde(rename = "encodedSize")]
    pub encoded_size: u64,
    #[serde(rename = "downloadSource", default)]
    pub download_source: Option<ResumeSessionHistoryDownloadSource>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
pub enum ResumeSessionHistoryRefKind {
    #[serde(rename = "blob")]
    Blob,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq)]
pub enum ResumeSessionHistoryEncoding {
    #[serde(rename = "identity")]
    Identity,
    #[serde(rename = "gzip")]
    Gzip,
    #[serde(rename = "zstd")]
    Zstd,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
pub enum ResumeSessionHistoryDownloadSource {
    #[serde(rename = "configured_public_endpoint")]
    ConfiguredPublicEndpoint,
    #[serde(rename = "default_r2_endpoint")]
    DefaultR2Endpoint,
    #[serde(other)]
    Unknown,
}

impl ResumeSession {
    pub fn inline(cli_agent_session_id: String, session_history: String) -> Self {
        Self {
            cli_agent_session_id,
            history: ResumeSessionHistory::Inline {
                session_history: Arc::new(session_history),
            },
        }
    }

    #[cfg(test)]
    pub fn session_history(&self) -> Option<&str> {
        match &self.history {
            ResumeSessionHistory::Inline { session_history } => Some(session_history),
            ResumeSessionHistory::Ref { .. } => None,
        }
    }

    pub fn shared_session_history(&self) -> Option<Arc<String>> {
        match &self.history {
            ResumeSessionHistory::Inline { session_history } => Some(Arc::clone(session_history)),
            ResumeSessionHistory::Ref { .. } => None,
        }
    }

    pub fn history_ref(&self) -> Option<&ResumeSessionHistoryRef> {
        match &self.history {
            ResumeSessionHistory::Inline { .. } => None,
            ResumeSessionHistory::Ref { history_ref } => Some(history_ref),
        }
    }
}

fn deserialize_shared_string<'de, D>(deserializer: D) -> Result<Arc<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    String::deserialize(deserializer).map(Arc::new)
}

impl ExecutionContext {
    pub(crate) fn reuse_key(&self) -> Option<&str> {
        self.reuse_key.as_deref()
    }

    /// Extract the framework-native session id.
    ///
    /// Prefers `pi_session_id`, otherwise returns the resume-session id.
    /// Pi session ids are preassigned, including on first runs without a
    /// `resume_session`, so `Some` does not imply a continued session.
    ///
    /// Returns `None` only when neither source supplies an id. In that case,
    /// the executor reads the CLI-generated session id from the guest filesystem
    /// post-execution (see `read_guest_cli_agent_session_id`).
    pub fn cli_agent_session_id(&self) -> Option<&str> {
        self.pi_session_id.as_deref().or_else(|| {
            self.resume_session
                .as_ref()
                .map(|r| r.cli_agent_session_id.as_str())
        })
    }
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReusableSandboxState {
    pub profile: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub history_generation_run_id: Option<RunId>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum SessionHistorySizeBucket {
    #[serde(rename = "lt_64_kib")]
    LessThan64Kib,
    #[serde(rename = "64_256_kib")]
    From64To256Kib,
    #[serde(rename = "256_kib_1_mib")]
    From256KibTo1Mib,
    #[serde(rename = "1_4_mib")]
    From1To4Mib,
    #[serde(rename = "4_16_mib")]
    From4To16Mib,
    #[serde(rename = "16_64_mib")]
    From16To64Mib,
    #[serde(rename = "64_128_mib")]
    From64To128Mib,
}

impl SessionHistorySizeBucket {
    pub const fn from_size(size: u64) -> Self {
        const SIZE_64_KIB: u64 = 64 * 1024;
        const SIZE_256_KIB: u64 = 256 * 1024;
        const SIZE_1_MIB: u64 = 1024 * 1024;
        const SIZE_4_MIB: u64 = 4 * SIZE_1_MIB;
        const SIZE_16_MIB: u64 = 16 * SIZE_1_MIB;
        const SIZE_64_MIB: u64 = 64 * SIZE_1_MIB;

        if size < SIZE_64_KIB {
            Self::LessThan64Kib
        } else if size < SIZE_256_KIB {
            Self::From64To256Kib
        } else if size < SIZE_1_MIB {
            Self::From256KibTo1Mib
        } else if size < SIZE_4_MIB {
            Self::From1To4Mib
        } else if size < SIZE_16_MIB {
            Self::From4To16Mib
        } else if size < SIZE_64_MIB {
            Self::From16To64Mib
        } else {
            Self::From64To128Mib
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::LessThan64Kib => "lt_64_kib",
            Self::From64To256Kib => "64_256_kib",
            Self::From256KibTo1Mib => "256_kib_1_mib",
            Self::From1To4Mib => "1_4_mib",
            Self::From4To16Mib => "4_16_mib",
            Self::From16To64Mib => "16_64_mib",
            Self::From64To128Mib => "64_128_mib",
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCacheCapability {
    pub profile: String,
    pub workspace_affinity_version: u8,
}

/// Reusable sandbox state keyed by the runner-owned reuse identity.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HeldSandboxState {
    pub reuse_key: String,
    pub last_completed_at: String,
    pub reusable_sandbox: ReusableSandboxState,
}

/// Workspace cache state owned by a runner reuse key rather than a provider
/// session identity.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HeldWorkspaceState {
    pub reuse_key: String,
    pub last_completed_at: String,
    pub workspace_caches: Vec<WorkspaceCacheCapability>,
}

/// Runner state snapshot sent to the server via heartbeat.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatState {
    pub runner_id: String,
    pub group: String,
    pub snapshot_generation: u64,
    pub snapshot_sequence: u64,
    pub total_vcpu: u32,
    pub total_memory_mb: u32,
    pub max_concurrent: usize,
    pub allocated_vcpu: u32,
    pub allocated_memory_mb: u32,
    pub running_count: usize,
    pub admittable_profiles: Vec<String>,
    pub held_sandbox_states: Vec<HeldSandboxState>,
    pub held_workspace_states: Vec<HeldWorkspaceState>,
    pub mode: String,
}

// ---------------------------------------------------------------------------
// Complete
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteRequest {
    pub run_id: RunId,
    pub exit_code: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_reason: Option<RequestFailureReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Sandbox the run executed against. `None` when the run failed before
    /// sandbox allocation; otherwise set on every completion regardless of
    /// reuse status.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandbox_id: Option<SandboxId>,
    /// Outcome of the sandbox-reuse decision made before this run started.
    /// `None` means the run failed before the runner reached that decision, or
    /// that the caller could not determine it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandbox_reuse_result: Option<SandboxReuseResult>,
    /// Final outcome of the workspace-reuse decision. `None` means the run
    /// failed before the runner reached a reliable final decision.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_reuse_result: Option<WorkspaceReuseResult>,
    /// Active-input deliveries observed in the guest receipt journal but not
    /// confirmed through the direct receipt route before process exit.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub active_input_delivery_ids: Vec<String>,
}

/// Outcome of the sandbox-reuse decision made at job dispatch time. `Reused`
/// means the sandbox was unparked from the idle pool; the other variants describe
/// why reuse did not happen. Wire name: `sandboxReuseResult`.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SandboxReuseResult {
    Reused,
    NoReuseKey,
    PoolMiss,
    ProfileMismatch,
    DeviceLimitMismatch,
    UnparkFailed,
}

impl SandboxReuseResult {
    /// Wire-format string, kept lockstep with the `#[serde(rename_all =
    /// "camelCase")]` derive via `as_wire_matches_serde_serialization`.
    pub const fn as_wire(self) -> &'static str {
        match self {
            Self::Reused => "reused",
            Self::NoReuseKey => "noReuseKey",
            Self::PoolMiss => "poolMiss",
            Self::ProfileMismatch => "profileMismatch",
            Self::DeviceLimitMismatch => "deviceLimitMismatch",
            Self::UnparkFailed => "unparkFailed",
        }
    }
}

/// Final outcome of workspace reuse after sandbox preparation has settled.
/// Wire name: `workspaceReuseResult`.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceReuseResult {
    Reused,
    SandboxReused,
    CacheMiss,
    NoReuseKey,
    InvalidWorkingDir,
    LockBusy,
    InvalidMetadata,
    DiskPressure,
    NotConfigured,
    SandboxPrepareFallback,
}

impl WorkspaceReuseResult {
    /// Wire-format string, kept lockstep with the serde derive in tests.
    pub const fn as_wire(self) -> &'static str {
        match self {
            Self::Reused => "reused",
            Self::SandboxReused => "sandboxReused",
            Self::CacheMiss => "cacheMiss",
            Self::NoReuseKey => "noReuseKey",
            Self::InvalidWorkingDir => "invalidWorkingDir",
            Self::LockBusy => "lockBusy",
            Self::InvalidMetadata => "invalidMetadata",
            Self::DiskPressure => "diskPressure",
            Self::NotConfigured => "notConfigured",
            Self::SandboxPrepareFallback => "sandboxPrepareFallback",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn firewall_base_url_validation_matches_shared_contract() {
        let mismatches: Vec<String> =
            crate::test_fixtures::firewall_base_url_contract::firewall_base_url_validation_cases()
                .into_iter()
                .filter_map(|test_case| {
                    let result = validate_firewall_base_for_cache(&test_case.base);
                    (result.is_ok() != test_case.expected_valid).then(|| {
                        format!(
                            "shared case {:?} produced unexpected result for {:?}: {:?}",
                            test_case.name,
                            test_case.base,
                            result.err()
                        )
                    })
                })
                .collect();

        assert!(
            mismatches.is_empty(),
            "firewall base URL contract mismatches:\n{}",
            mismatches.join("\n")
        );
    }

    #[test]
    fn raw_url_path_does_not_treat_query_or_fragment_content_as_path() {
        assert_eq!(raw_url_path("https://api.example.com?next=/../"), "");
        assert_eq!(raw_url_path("https://api.example.com#next=/../"), "");
    }

    #[test]
    fn firewall_auth_base_allows_path_syntax_in_query() {
        validate_auth_base_for_cache("https://api.example.com?next=/../").unwrap();
    }

    #[test]
    fn poll_response_with_job() {
        let json = json!({
            "job": {
                "runId": "550e8400-e29b-41d4-a716-446655440000",
                "experimentalProfile": "browser",
                "cliAgentSessionId": "session-id",
                "runnerPreference": {
                    "kind": "preference",
                    "runnerIdentity": {
                        "runnerId": "b85bb257-21c1-4b8f-8676-a4051f35b7b0",
                        "heartbeatGeneration": 7
                    },
                    "tier": "reusableSandbox",
                    "expiresAt": "2026-08-03T12:00:00.000Z"
                }
            }
        });
        let resp: PollResponse = serde_json::from_value(json).unwrap();
        let job = resp.job.unwrap();
        assert_eq!(
            job.run_id,
            "550e8400-e29b-41d4-a716-446655440000"
                .parse::<RunId>()
                .unwrap()
        );
        assert_eq!(job.experimental_profile, "browser");
        assert!(job.runner_preference.is_some());
        assert!(job.reuse_key().is_none());
    }

    #[test]
    fn poll_response_no_job() {
        let json = json!({ "job": null });
        let resp: PollResponse = serde_json::from_value(json).unwrap();
        assert!(resp.job.is_none());
    }

    #[test]
    fn job_requires_profile() {
        let json = json!({
            "runId": "550e8400-e29b-41d4-a716-446655440000"
        });
        assert!(serde_json::from_value::<Job>(json).is_err());
    }

    #[test]
    fn execution_context_deserializes_pi_sandbox_resources() {
        let json = serde_json::json!({
            "runId": "11111111-1111-4111-8111-111111111111",
            "prompt": "hello",
            "sandboxToken": "tok",
            "cliAgentType": "pi",
            "piSessionId": "22222222-2222-4222-8222-222222222222",
            "piLaunchConfig": {
                "schemaVersion": 2,
                "apiFirstTurn": {
                    "schemaVersion": 1,
                    "resourceSnapshotDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "manifestUrl": "https://storage.example/manifest.json",
                    "sessionUrl": "https://storage.example/session.jsonl",
                    "deadlineAt": 2000000000000_u64,
                    "baseSession": {
                        "sessionId": "22222222-2222-4222-8222-222222222222",
                        "sha256": null
                    },
                    "sandboxEventSequenceStart": 1
                }
            },
            "piModelConfig": {
                "provider": "deepseek",
                "baseUrl": "https://api.deepseek.com/",
                "model": "deepseek-v4-flash",
                "apiKeyEnv": "OPENAI_API_KEY",
                "credentialSecretName": "DEEPSEEK_API_KEY"
            },
            "platformEnvironment": {},
            "connectorRuntimeTargets": []
        });

        let context: ExecutionContext = serde_json::from_value(json).unwrap();

        assert_eq!(
            context.pi_session_id.as_deref(),
            Some("22222222-2222-4222-8222-222222222222")
        );
        assert!(context.resume_session.is_none());
        assert_eq!(
            context.cli_agent_session_id(),
            Some("22222222-2222-4222-8222-222222222222")
        );
        assert_eq!(
            context
                .pi_launch_config
                .as_ref()
                .and_then(|config| config["schemaVersion"].as_u64()),
            Some(2)
        );
        assert_eq!(
            context
                .pi_model_config
                .as_ref()
                .and_then(|config| config["model"].as_str()),
            Some("deepseek-v4-flash")
        );
    }

    #[test]
    fn execution_context_rejects_legacy_expanded_firewall_entry() {
        let json = serde_json::json!({
            "runId": "11111111-1111-4111-8111-111111111111",
            "prompt": "hello",
            "sandboxToken": "tok",
            "cliAgentType": "claude-code",
            "platformEnvironment": {},
            "connectorRuntimeTargets": [],
            "firewalls": [{
                "name": "github",
                "apis": [{
                    "base": "https://api.github.com",
                    "auth": {"headers": {}},
                    "permissions": [{
                        "name": "issues-read",
                        "rules": ["GET /repos/{owner}/{repo}/issues"]
                    }]
                }]
            }]
        });

        let result = serde_json::from_value::<ExecutionContext>(json);
        assert!(result.is_err());
    }

    #[test]
    fn execution_context_rejects_unknown_firewall_kind() {
        let json = serde_json::json!({
            "runId": "11111111-1111-4111-8111-111111111111",
            "prompt": "hello",
            "sandboxToken": "tok",
            "cliAgentType": "claude-code",
            "platformEnvironment": {},
            "connectorRuntimeTargets": [],
            "firewalls": [{
                "kind": "unknown",
                "name": "github",
                "apis": [{
                    "base": "https://api.github.com",
                    "auth": {"headers": {}}
                }]
            }]
        });

        let result = serde_json::from_value::<ExecutionContext>(json);
        assert!(result.is_err());
    }

    #[test]
    fn firewall_round_trip() {
        let fw = Firewall {
            name: "github".into(),
            apis: vec![FirewallApi {
                id: "api-1".into(),
                base: "https://api.github.com".into(),
                auth: FirewallAuth {
                    headers: [("Authorization".into(), "Bearer tok".into())]
                        .into_iter()
                        .collect(),
                    base: None,
                    query: None,
                    aws_sigv4: None,
                },
                host_policy: None,
                permissions: Some(vec![FirewallPermission {
                    name: "metadata:read".into(),
                    description: Some("read repo metadata".into()),
                    rules: vec!["GET /repos/{owner}/{repo}".into()],
                }]),
            }],
        };
        let json = serde_json::to_value(&fw).unwrap();
        assert_eq!(json["name"], "github");
        // round-trip
        let deserialized: Firewall = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized.name, "github");
        assert_eq!(
            deserialized.apis[0].permissions.as_ref().unwrap()[0].name,
            "metadata:read"
        );
    }

    #[test]
    fn firewall_auth_base_omitted_when_none() {
        let auth = FirewallAuth {
            headers: HashMap::new(),
            base: None,
            query: None,
            aws_sigv4: None,
        };
        let json = serde_json::to_value(&auth).unwrap();
        assert!(json.get("base").is_none());
    }

    #[test]
    fn firewall_preserves_host_policy_and_aws_sigv4() {
        let json = serde_json::json!({
            "name": "aws",
            "apis": [{
                "base": "https://s3.amazonaws.com",
                "hostPolicy": {
                    "kind": "providerOwned",
                    "exactHosts": ["s3.amazonaws.com"],
                    "allowNonDefaultPort": false
                },
                "auth": {
                    "awsSigv4": {
                        "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                        "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
                        "sessionToken": "${{ secrets.AWS_SESSION_TOKEN }}"
                    }
                },
                "permissions": [{
                    "name": "read",
                    "rules": ["GET /{bucket}"]
                }]
            }]
        });

        let firewall: Firewall = serde_json::from_value(json).unwrap();
        firewall.validate_for_cache().unwrap();
        let round_trip = serde_json::to_value(&firewall).unwrap();

        assert_eq!(
            round_trip["apis"][0]["hostPolicy"]["exactHosts"][0],
            "s3.amazonaws.com"
        );
        assert_eq!(
            round_trip["apis"][0]["auth"]["awsSigv4"]["accessKeyId"],
            "${{ secrets.AWS_ACCESS_KEY_ID }}"
        );
    }

    #[test]
    fn firewall_validation_rejects_aws_sigv4_with_headers() {
        let firewall: Firewall = serde_json::from_value(serde_json::json!({
            "name": "aws",
            "apis": [{
                "base": "https://s3.amazonaws.com",
                "auth": {
                    "headers": {"Authorization": "Bearer token"},
                    "awsSigv4": {
                        "accessKeyId": "key",
                        "secretAccessKey": "secret"
                    }
                }
            }]
        }))
        .unwrap();

        let error = firewall.validate_for_cache().unwrap_err();

        assert!(
            error.contains("auth.headers cannot be combined with auth.awsSigv4"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn firewall_validation_rejects_empty_provider_owned_host_policy() {
        let firewall: Firewall = serde_json::from_value(serde_json::json!({
            "name": "example",
            "apis": [{
                "base": "https://api.example.com",
                "hostPolicy": {"kind": "providerOwned"},
                "auth": {"headers": {}}
            }]
        }))
        .unwrap();

        let error = firewall.validate_for_cache().unwrap_err();

        assert!(
            error.contains("providerOwned hostPolicy requires exactHosts or suffixes"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn firewall_validation_rejects_empty_apis() {
        let firewall: Firewall = serde_json::from_value(serde_json::json!({
            "name": "empty",
            "apis": []
        }))
        .unwrap();

        let error = firewall.validate_for_cache().unwrap_err();

        assert!(
            error.contains("must have at least one api"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn firewall_deserialization_rejects_unsupported_host_policy_fields() {
        let error = serde_json::from_value::<Firewall>(serde_json::json!({
            "name": "example",
            "apis": [{
                "base": "https://api.example.com",
                "hostPolicy": {
                    "kind": "providerOwned",
                    "exactHosts": ["api.example.com"],
                    "unexpected": true
                },
                "auth": {"headers": {}}
            }]
        }))
        .unwrap_err();

        assert!(
            error.to_string().contains("unknown field"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn firewall_deserialization_rejects_unsupported_aws_sigv4_fields() {
        let error = serde_json::from_value::<Firewall>(serde_json::json!({
            "name": "aws",
            "apis": [{
                "base": "https://s3.amazonaws.com",
                "auth": {
                    "awsSigv4": {
                        "accessKeyId": "key",
                        "secretAccessKey": "secret",
                        "unexpected": true
                    }
                }
            }]
        }))
        .unwrap_err();

        assert!(
            error.to_string().contains("unknown field"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn complete_request_camel_case() {
        let req = CompleteRequest {
            run_id: "550e8400-e29b-41d4-a716-446655440000"
                .parse::<RunId>()
                .unwrap(),
            exit_code: 0,
            failure_reason: None,
            error: None,
            sandbox_id: None,
            sandbox_reuse_result: None,
            workspace_reuse_result: None,
            active_input_delivery_ids: Vec::new(),
        };
        let json = serde_json::to_value(&req).unwrap();
        assert!(json.get("runId").is_some());
        assert!(json.get("exitCode").is_some());
        // optionals omitted when None
        assert!(json.get("error").is_none());
        assert!(json.get("failureReason").is_none());
        assert!(json.get("sandboxId").is_none());
        assert!(json.get("sandboxReuseResult").is_none());
        assert!(json.get("workspaceReuseResult").is_none());
        assert!(json.get("activeInputDeliveryIds").is_none());
    }

    #[test]
    fn complete_request_with_pre_sandbox_error_omits_sandbox_fields() {
        let req = CompleteRequest {
            run_id: "550e8400-e29b-41d4-a716-446655440000"
                .parse::<RunId>()
                .unwrap(),
            exit_code: 1,
            failure_reason: Some(RequestFailureReason::ProviderRateLimited),
            error: Some("timeout".into()),
            sandbox_id: None,
            sandbox_reuse_result: None,
            workspace_reuse_result: None,
            active_input_delivery_ids: Vec::new(),
        };
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["error"], "timeout");
        assert_eq!(json["failureReason"], "provider_rate_limited");
        assert!(json.get("sandboxId").is_none());
        assert!(json.get("sandboxReuseResult").is_none());
        assert!(json.get("workspaceReuseResult").is_none());
    }

    #[test]
    fn complete_request_serializes_input_too_large_failure_reason() {
        let req = CompleteRequest {
            run_id: "550e8400-e29b-41d4-a716-446655440000"
                .parse::<RunId>()
                .unwrap(),
            exit_code: 1,
            failure_reason: Some(RequestFailureReason::InputTooLarge),
            error: Some(
                "execution: Codex input is too large: 101 characters provided, maximum is 100 characters. Reduce the input and try again."
                    .into(),
            ),
            sandbox_id: None,
            sandbox_reuse_result: None,
            workspace_reuse_result: None,
            active_input_delivery_ids: Vec::new(),
        };

        let json = serde_json::to_value(&req).unwrap();

        assert_eq!(json["failureReason"], "input_too_large");
    }

    #[test]
    fn complete_request_with_reuse_fields() {
        let sid: SandboxId = "11111111-2222-3333-4444-555555555555".parse().unwrap();
        let req = CompleteRequest {
            run_id: "550e8400-e29b-41d4-a716-446655440000"
                .parse::<RunId>()
                .unwrap(),
            exit_code: 0,
            failure_reason: None,
            error: None,
            sandbox_id: Some(sid),
            sandbox_reuse_result: Some(SandboxReuseResult::Reused),
            workspace_reuse_result: Some(WorkspaceReuseResult::SandboxReused),
            active_input_delivery_ids: vec!["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee".to_string()],
        };
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["sandboxId"], "11111111-2222-3333-4444-555555555555");
        assert_eq!(json["sandboxReuseResult"], "reused");
        assert_eq!(json["workspaceReuseResult"], "sandboxReused");
        assert_eq!(
            json["activeInputDeliveryIds"],
            serde_json::json!(["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"])
        );
    }

    #[test]
    fn sandbox_reuse_result_serializes_camel_case() {
        assert_eq!(
            serde_json::to_value(SandboxReuseResult::NoReuseKey).unwrap(),
            serde_json::json!("noReuseKey"),
        );
        assert_eq!(
            serde_json::to_value(SandboxReuseResult::PoolMiss).unwrap(),
            serde_json::json!("poolMiss"),
        );
        assert_eq!(
            serde_json::to_value(SandboxReuseResult::ProfileMismatch).unwrap(),
            serde_json::json!("profileMismatch"),
        );
        assert_eq!(
            serde_json::to_value(SandboxReuseResult::DeviceLimitMismatch).unwrap(),
            serde_json::json!("deviceLimitMismatch"),
        );
        assert_eq!(
            serde_json::to_value(SandboxReuseResult::UnparkFailed).unwrap(),
            serde_json::json!("unparkFailed"),
        );
    }

    /// `as_wire` is hand-written; pin it to the serde derive so adding a
    /// variant forces both sides to stay in sync.
    #[test]
    fn as_wire_matches_serde_serialization() {
        for variant in [
            SandboxReuseResult::Reused,
            SandboxReuseResult::NoReuseKey,
            SandboxReuseResult::PoolMiss,
            SandboxReuseResult::ProfileMismatch,
            SandboxReuseResult::DeviceLimitMismatch,
            SandboxReuseResult::UnparkFailed,
        ] {
            assert_eq!(
                serde_json::to_value(variant).unwrap(),
                serde_json::Value::String(variant.as_wire().to_string()),
            );
        }
        for variant in [
            WorkspaceReuseResult::Reused,
            WorkspaceReuseResult::SandboxReused,
            WorkspaceReuseResult::CacheMiss,
            WorkspaceReuseResult::NoReuseKey,
            WorkspaceReuseResult::InvalidWorkingDir,
            WorkspaceReuseResult::LockBusy,
            WorkspaceReuseResult::InvalidMetadata,
            WorkspaceReuseResult::DiskPressure,
            WorkspaceReuseResult::NotConfigured,
            WorkspaceReuseResult::SandboxPrepareFallback,
        ] {
            assert_eq!(
                serde_json::to_value(variant).unwrap(),
                serde_json::Value::String(variant.as_wire().to_string()),
            );
        }
    }

    #[test]
    fn cli_agent_session_id_returns_none_without_supplied_id() {
        let json = json!({
            "runId": "550e8400-e29b-41d4-a716-446655440000",
            "prompt": "hello",
            "sandboxToken": "tok",
            "cliAgentType": "claude_code",
            "billableFirewalls": [],
            "platformEnvironment": {},
            "connectorRuntimeTargets": []
        });
        let ctx: ExecutionContext = serde_json::from_value(json).unwrap();
        assert!(ctx.cli_agent_session_id().is_none());
    }

    #[test]
    fn execution_context_requires_custom_connector_routing_values() {
        let execution_context = |target: serde_json::Value| {
            json!({
                "runId": "550e8400-e29b-41d4-a716-446655440000",
                "prompt": "hello",
                "sandboxToken": "tok",
                "cliAgentType": "claude_code",
                "billableFirewalls": [],
                "platformEnvironment": {},
                "connectorRuntimeTargets": [target]
            })
        };
        let custom_connector_id = "550e8400-e29b-41d4-a716-446655440001";

        assert!(
            serde_json::from_value::<ExecutionContext>(execution_context(json!({
                "kind": "custom",
                "customConnectorId": custom_connector_id
            })))
            .is_err()
        );

        let legacy_context = serde_json::from_value::<ExecutionContext>(execution_context(json!({
            "kind": "custom",
            "customConnectorId": custom_connector_id,
            "baseUrlVars": {}
        })))
        .expect("empty custom connector routing values should be accepted");
        assert_eq!(
            legacy_context
                .connector_runtime_targets
                .first()
                .and_then(ConnectorRuntimeTargetRegistration::source_id),
            None
        );
        let source_id = "550e8400-e29b-41d4-a716-446655440002";
        let context = serde_json::from_value::<ExecutionContext>(execution_context(json!({
            "kind": "custom",
            "customConnectorId": custom_connector_id,
            "baseUrlVars": {},
            "sourceId": source_id
        })))
        .expect("custom connector source identity should be accepted");
        assert_eq!(
            context.connector_runtime_targets,
            vec![ConnectorRuntimeTargetRegistration::Custom {
                custom_connector_id: custom_connector_id.to_string(),
                base_url_vars: HashMap::new(),
                source_id: Some(source_id.to_string()),
            }]
        );
    }

    #[test]
    fn cli_agent_session_id_returns_id_from_resume_session() {
        let json = json!({
            "runId": "550e8400-e29b-41d4-a716-446655440000",
            "prompt": "hello",
            "sandboxToken": "tok",
            "cliAgentType": "claude_code",
            "resumeSession": {
                "sessionId": "sess-abc-123",
                "sessionHistory": "{}"
            },
            "billableFirewalls": [],
            "platformEnvironment": {},
            "connectorRuntimeTargets": []
        });
        let ctx: ExecutionContext = serde_json::from_value(json).unwrap();
        assert_eq!(ctx.cli_agent_session_id(), Some("sess-abc-123"));
        assert_eq!(
            ctx.resume_session.as_ref().unwrap().session_history(),
            Some("{}")
        );
        let session = ctx.resume_session.as_ref().unwrap();
        let first = session.shared_session_history().unwrap();
        let second = session.shared_session_history().unwrap();
        assert!(Arc::ptr_eq(&first, &second));
    }

    #[test]
    fn cli_agent_session_id_returns_id_from_resume_session_history_ref() {
        let json = json!({
            "runId": "550e8400-e29b-41d4-a716-446655440000",
            "prompt": "hello",
            "sandboxToken": "tok",
            "cliAgentType": "claude_code",
            "resumeSession": {
                "sessionId": "sess-ref-123",
                "historyRef": {
                    "kind": "blob",
                    "hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "url": "https://r2.example.com/blobs/a.blob?sig=secret",
                    "encoding": "identity",
                    "rawSize": 42,
                    "encodedSize": 42
                }
            },
            "billableFirewalls": [],
            "platformEnvironment": {},
            "connectorRuntimeTargets": []
        });
        let ctx: ExecutionContext = serde_json::from_value(json).unwrap();
        let session = ctx.resume_session.as_ref().unwrap();
        let history_ref = session.history_ref().unwrap();
        assert_eq!(ctx.cli_agent_session_id(), Some("sess-ref-123"));
        assert!(session.session_history().is_none());
        assert_eq!(history_ref.kind, ResumeSessionHistoryRefKind::Blob);
        assert_eq!(history_ref.encoding, ResumeSessionHistoryEncoding::Identity);
        assert_eq!(history_ref.raw_size, 42);
        assert_eq!(history_ref.encoded_size, 42);
    }

    #[test]
    fn cli_agent_session_id_returns_id_from_gzip_resume_session_history_ref() {
        let json = json!({
            "runId": "550e8400-e29b-41d4-a716-446655440000",
            "prompt": "hello",
            "sandboxToken": "tok",
            "cliAgentType": "claude_code",
            "resumeSession": {
                "sessionId": "sess-ref-123",
                "historyRef": {
                    "kind": "blob",
                    "hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "url": "https://r2.example.com/blobs/a.blob.gz?sig=secret",
                    "encoding": "gzip",
                    "rawSize": 42,
                    "encodedSize": 24,
                    "downloadSource": "configured_public_endpoint"
                }
            },
            "billableFirewalls": [],
            "platformEnvironment": {},
            "connectorRuntimeTargets": []
        });
        let ctx: ExecutionContext = serde_json::from_value(json).unwrap();
        let session = ctx.resume_session.as_ref().unwrap();
        let history_ref = session.history_ref().unwrap();
        assert_eq!(ctx.cli_agent_session_id(), Some("sess-ref-123"));
        assert!(session.session_history().is_none());
        assert_eq!(history_ref.kind, ResumeSessionHistoryRefKind::Blob);
        assert_eq!(history_ref.encoding, ResumeSessionHistoryEncoding::Gzip);
        assert_eq!(history_ref.raw_size, 42);
        assert_eq!(history_ref.encoded_size, 24);
        assert_eq!(
            history_ref.download_source,
            Some(ResumeSessionHistoryDownloadSource::ConfiguredPublicEndpoint)
        );
    }

    #[test]
    fn cli_agent_session_id_tolerates_unknown_resume_session_history_download_source() {
        let json = json!({
            "runId": "550e8400-e29b-41d4-a716-446655440000",
            "prompt": "hello",
            "sandboxToken": "tok",
            "cliAgentType": "claude_code",
            "resumeSession": {
                "sessionId": "sess-ref-123",
                "historyRef": {
                    "kind": "blob",
                    "hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "url": "https://r2.example.com/blobs/a.blob.gz?sig=secret",
                    "encoding": "gzip",
                    "rawSize": 42,
                    "encodedSize": 24,
                    "downloadSource": "future_edge_cache"
                }
            },
            "billableFirewalls": [],
            "platformEnvironment": {},
            "connectorRuntimeTargets": []
        });
        let ctx: ExecutionContext = serde_json::from_value(json).unwrap();
        let session = ctx.resume_session.as_ref().unwrap();
        let history_ref = session.history_ref().unwrap();
        assert_eq!(ctx.cli_agent_session_id(), Some("sess-ref-123"));
        assert_eq!(
            history_ref.download_source,
            Some(ResumeSessionHistoryDownloadSource::Unknown)
        );
    }

    #[test]
    fn cli_agent_session_id_returns_id_from_zstd_resume_session_history_ref() {
        let json = json!({
            "runId": "550e8400-e29b-41d4-a716-446655440000",
            "prompt": "hello",
            "sandboxToken": "tok",
            "cliAgentType": "claude_code",
            "resumeSession": {
                "sessionId": "sess-ref-123",
                "historyRef": {
                    "kind": "blob",
                    "hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "url": "https://r2.example.com/blobs/a.blob.zst?sig=secret",
                    "encoding": "zstd",
                    "rawSize": 42,
                    "encodedSize": 18
                }
            },
            "billableFirewalls": [],
            "platformEnvironment": {},
            "connectorRuntimeTargets": []
        });
        let ctx: ExecutionContext = serde_json::from_value(json).unwrap();
        let session = ctx.resume_session.as_ref().unwrap();
        let history_ref = session.history_ref().unwrap();
        assert_eq!(ctx.cli_agent_session_id(), Some("sess-ref-123"));
        assert!(session.session_history().is_none());
        assert_eq!(history_ref.kind, ResumeSessionHistoryRefKind::Blob);
        assert_eq!(history_ref.encoding, ResumeSessionHistoryEncoding::Zstd);
        assert_eq!(history_ref.raw_size, 42);
        assert_eq!(history_ref.encoded_size, 18);
    }

    fn execution_context_with_storage_manifest(
        storage_manifest: serde_json::Value,
    ) -> serde_json::Value {
        json!({
            "runId": "550e8400-e29b-41d4-a716-446655440000",
            "prompt": "hello",
            "sandboxToken": "tok",
            "storageManifest": storage_manifest,
            "cliAgentType": "claude_code",
            "billableFirewalls": [],
            "platformEnvironment": {},
            "connectorRuntimeTargets": []
        })
    }

    #[test]
    fn execution_context_accepts_canonical_storage_mounts() {
        let json = execution_context_with_storage_manifest(json!({
            "storageMounts": [
                {
                    "name": "instructions",
                    "storageId": "storage-read-only",
                    "versionId": "version-1",
                    "mountPath": "/home/user/.claude",
                    "archiveUrl": "https://example.com/instructions.tar.gz",
                    "instructionsTargetFilename": "CLAUDE.md",
                    "futureMountField": true
                },
                {
                    "name": "memory",
                    "storageId": "storage-writeback",
                    "versionId": "version-2",
                    "mountPath": "/memory",
                    "empty": true,
                    "missingRootPolicy": "preserveParentVersion",
                    "writeback": true
                }
            ],
            "futureManifestField": true
        }));

        let context: ExecutionContext = serde_json::from_value(json).unwrap();
        let manifest = context.storage_manifest.unwrap();

        assert_eq!(manifest.storages.len(), 1);
        assert_eq!(manifest.storages[0].name, "instructions");
        assert_eq!(manifest.storages[0].vas_storage_name, "instructions");
        assert_eq!(manifest.storages[0].vas_version_id, "version-1");
        assert_eq!(manifest.artifacts.len(), 1);
        assert_eq!(manifest.artifacts[0].vas_storage_name, "memory");
        assert_eq!(manifest.artifacts[0].vas_storage_id, "storage-writeback");
        assert_eq!(manifest.artifacts[0].empty, Some(true));
    }

    #[test]
    fn execution_context_rejects_legacy_storage_manifest_representations() {
        for storage_manifest in [
            json!({ "storages": [], "artifacts": [] }),
            json!({ "storages": [] }),
            json!({ "artifacts": [] }),
            json!({}),
        ] {
            let result = serde_json::from_value::<ExecutionContext>(
                execution_context_with_storage_manifest(storage_manifest),
            );
            assert!(result.is_err());
        }
    }

    #[test]
    fn execution_context_rejects_duplicate_storage_mount_paths() {
        let result = serde_json::from_value::<ExecutionContext>(
            execution_context_with_storage_manifest(json!({
                "storageMounts": [
                    {
                        "name": "workspace",
                        "storageId": "storage-read-only",
                        "versionId": "version-1",
                        "mountPath": "/workspace",
                        "archiveUrl": "https://example.com/workspace.tar.gz"
                    },
                    {
                        "name": "artifact",
                        "storageId": "storage-writeback",
                        "versionId": "version-2",
                        "mountPath": "/workspace",
                        "empty": true,
                        "writeback": true
                    }
                ]
            })),
        );

        let error = result.unwrap_err().to_string();
        assert!(error.contains("duplicate mountPath \"/workspace\""));
    }

    #[test]
    fn execution_context_rejects_invalid_canonical_storage_mount_behavior() {
        for mount in [
            json!({
                "name": "read-only",
                "storageId": "storage-1",
                "versionId": "version-1",
                "mountPath": "/read-only"
            }),
            json!({
                "name": "read-only-empty",
                "storageId": "storage-2",
                "versionId": "version-2",
                "mountPath": "/read-only-empty",
                "archiveUrl": "https://example.com/empty.tar.gz",
                "empty": true
            }),
            json!({
                "name": "read-only-missing-root-policy",
                "storageId": "storage-3",
                "versionId": "version-3",
                "mountPath": "/read-only-missing-root-policy",
                "archiveUrl": "https://example.com/read-only.tar.gz",
                "missingRootPolicy": "preserveParentVersion"
            }),
            json!({
                "name": "writeback-instructions",
                "storageId": "storage-4",
                "versionId": "version-4",
                "mountPath": "/writeback-instructions",
                "archiveUrl": "https://example.com/instructions.tar.gz",
                "instructionsTargetFilename": "AGENTS.md",
                "writeback": true
            }),
            json!({
                "name": "writeback-without-archive",
                "storageId": "storage-5",
                "versionId": "version-5",
                "mountPath": "/writeback-without-archive",
                "writeback": true
            }),
        ] {
            let result = serde_json::from_value::<ExecutionContext>(
                execution_context_with_storage_manifest(json!({
                    "storageMounts": [mount]
                })),
            );
            assert!(result.is_err());
        }
    }

    #[test]
    fn heartbeat_state_serializes_camel_case() {
        let state = HeartbeatState {
            runner_id: "550e8400-e29b-41d4-a716-446655440000".into(),
            group: "vm0/production".into(),
            snapshot_generation: 7,
            snapshot_sequence: 42,
            total_vcpu: 16,
            total_memory_mb: 32768,
            max_concurrent: 8,
            allocated_vcpu: 6,
            allocated_memory_mb: 6144,
            running_count: 2,
            admittable_profiles: vec!["vm0/default".into()],
            held_sandbox_states: vec![HeldSandboxState {
                reuse_key: "thread:thread-abc".into(),
                last_completed_at: "2026-05-28T00:00:00.000Z".into(),
                reusable_sandbox: ReusableSandboxState {
                    profile: "vm0/default".into(),
                    history_generation_run_id: Some(
                        "11111111-1111-4111-8111-111111111111".parse().unwrap(),
                    ),
                },
            }],
            held_workspace_states: vec![HeldWorkspaceState {
                reuse_key: "thread:thread-abc".into(),
                last_completed_at: "2026-05-28T00:00:00.000Z".into(),
                workspace_caches: vec![WorkspaceCacheCapability {
                    profile: "vm0/large".into(),
                    workspace_affinity_version: WORKSPACE_AFFINITY_VERSION,
                }],
            }],
            mode: "running".into(),
        };
        let json: serde_json::Value = serde_json::to_value(&state).unwrap();
        assert_eq!(
            json,
            json!({
                "runnerId": "550e8400-e29b-41d4-a716-446655440000",
                "group": "vm0/production",
                "snapshotGeneration": 7,
                "snapshotSequence": 42,
                "totalVcpu": 16,
                "totalMemoryMb": 32768,
                "maxConcurrent": 8,
                "allocatedVcpu": 6,
                "allocatedMemoryMb": 6144,
                "runningCount": 2,
                "admittableProfiles": ["vm0/default"],
                "heldSandboxStates": [{
                    "reuseKey": "thread:thread-abc",
                    "lastCompletedAt": "2026-05-28T00:00:00.000Z",
                    "reusableSandbox": {
                        "profile": "vm0/default",
                        "historyGenerationRunId": "11111111-1111-4111-8111-111111111111"
                    }
                }],
                "heldWorkspaceStates": [{
                    "reuseKey": "thread:thread-abc",
                    "lastCompletedAt": "2026-05-28T00:00:00.000Z",
                    "workspaceCaches": [{
                        "profile": "vm0/large",
                        "workspaceAffinityVersion": 1
                    }]
                }],
                "mode": "running"
            })
        );
    }

    #[test]
    fn held_sandbox_state_serializes_required_sandbox_without_optional_history_generation() {
        let state = HeldSandboxState {
            reuse_key: "thread:thread-current".into(),
            last_completed_at: "2026-05-28T00:00:00.000Z".into(),
            reusable_sandbox: ReusableSandboxState {
                profile: "vm0/default".into(),
                history_generation_run_id: None,
            },
        };
        let serialized = serde_json::to_value(state).unwrap();
        assert_eq!(serialized["reusableSandbox"]["profile"], "vm0/default");
        assert!(
            serialized["reusableSandbox"]
                .get("historyGenerationRunId")
                .is_none()
        );
    }

    #[test]
    fn heartbeat_state_serializes_empty_held_state_arrays() {
        let state = HeartbeatState {
            runner_id: "550e8400-e29b-41d4-a716-446655440000".into(),
            group: "vm0/production".into(),
            snapshot_generation: 7,
            snapshot_sequence: 42,
            total_vcpu: 16,
            total_memory_mb: 32768,
            max_concurrent: 8,
            allocated_vcpu: 0,
            allocated_memory_mb: 0,
            running_count: 0,
            admittable_profiles: vec!["vm0/default".into()],
            held_sandbox_states: Vec::new(),
            held_workspace_states: Vec::new(),
            mode: "running".into(),
        };

        let serialized = serde_json::to_value(state).unwrap();
        assert_eq!(serialized["heldSandboxStates"], json!([]));
        assert_eq!(serialized["heldWorkspaceStates"], json!([]));
    }
}
