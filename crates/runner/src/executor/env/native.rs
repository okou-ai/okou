use api_contracts::generated::constants::runners::PI_NATIVE_CREDENTIAL_PLACEHOLDER;
use api_contracts::generated::types::runners::runs::PiModelConfigV4;
use serde_json::Value;

use super::{has_exact_object_fields, is_valid_pi_credential_header};
use crate::types::ExecutionContext;

fn field<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Pi native {key} is invalid"))
}

fn valid_text(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.encode_utf16().count() <= max
        && !value.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// Validate the native wire refinements not represented by Serde DTOs.
pub(super) fn validate(value: &Value) -> Result<(), String> {
    let _: PiModelConfigV4 = serde_json::from_value(value.clone())
        .map_err(|_| "Pi native model config is invalid".to_string())?;
    let object = value
        .as_object()
        .ok_or("Pi native config must be an object")?;
    let mut required = vec![
        "schemaVersion",
        "dialect",
        "transport",
        "provider",
        "route",
        "baseUrl",
        "model",
        "catalogModel",
        "credentialOwner",
        "billingOwner",
        "requestPolicy",
        "credentialBindings",
    ];
    if value["dialect"] == "bedrock-converse-stream" {
        required.extend(["region", "authMode"]);
    }
    let mut allowed = required.clone();
    allowed.push("thinkingLevel");
    if !has_exact_object_fields(object, &required, &allowed)
        || !value["requestPolicy"].as_object().is_some_and(|policy| {
            has_exact_object_fields(
                policy,
                &["maxAttempts", "cacheRetention"],
                &["maxAttempts", "cacheRetention"],
            )
        })
    {
        return Err("Pi native config fields are invalid".into());
    }
    let base = field(value, "baseUrl")?;
    let model = field(value, "model")?;
    let url = url::Url::parse(base).map_err(|_| "Pi native URL is invalid")?;
    let host = url.host_str().ok_or("Pi native URL host is missing")?;
    let raw_authority = crate::firewall_hostname_policy::raw_url_authority(base)
        .ok_or("Pi native URL authority is missing")?;
    crate::firewall_hostname_policy::validate_raw_url_host(
        crate::firewall_hostname_policy::raw_host_from_authority(raw_authority),
        "Pi native",
    )?;
    if !valid_text(base, 2048)
        || !valid_text(model, 512)
        || url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || base.ends_with('/')
        || url.as_str().trim_end_matches('/') != base
        || base.contains(['{', '}', '\\'])
        || host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || (!host.contains('.') && !host.starts_with('['))
    {
        return Err("Pi native inference URL or model is invalid".into());
    }
    // Native cloud targets are provider-owned domains. Custom IP literals must
    // also pass the shared public destination policy enforced by Runner egress.
    if let Some(ip) = url.host().and_then(|h| match h {
        url::Host::Ipv4(ip) => Some(std::net::IpAddr::V4(ip)),
        url::Host::Ipv6(ip) => Some(std::net::IpAddr::V6(ip)),
        url::Host::Domain(_) => None,
    }) && !crate::firewall_hostname_policy::is_public_ip_address(ip)
    {
        return Err("Pi native inference requires a public destination".into());
    }
    let policy = value
        .get("requestPolicy")
        .ok_or("Pi native request policy is missing")?;
    if value.get("thinkingLevel").is_some_and(Value::is_null)
        || policy.get("maxAttempts").and_then(Value::as_u64) != Some(1)
        || policy.get("cacheRetention").and_then(Value::as_str) != Some("short")
        || (value["credentialOwner"] == "builtin") != (value["billingOwner"] == "builtin")
    {
        return Err("Pi native request or ownership policy is invalid".into());
    }
    let bindings = value["credentialBindings"]
        .as_array()
        .ok_or("Pi native bindings are invalid")?;
    if value["dialect"] == "bedrock-converse-stream" {
        let region = field(value, "region")?;
        let parts: Vec<&str> = region.split('-').collect();
        let (number, prefix) = parts
            .split_last()
            .ok_or("Pi native Bedrock region is missing")?;
        if parts.len() < 3
            || !parts.first().is_some_and(|part| part.len() == 2)
            || !prefix
                .iter()
                .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_lowercase()))
            || number.is_empty()
            || !number.bytes().all(|b| b.is_ascii_digit())
            || base != format!("https://bedrock-runtime.{region}.amazonaws.com")
            || (model.starts_with("arn:")
                && (!model.starts_with(&format!("arn:aws:bedrock:{region}:"))))
            || value["billingOwner"] == "builtin"
        {
            return Err("Pi native Bedrock region or owner is invalid".into());
        }
        let mut kinds = std::collections::HashSet::new();
        for binding in bindings {
            if !binding.as_object().is_some_and(|object| {
                has_exact_object_fields(
                    object,
                    &["kind", "environment", "secretName"],
                    &["kind", "environment", "secretName"],
                )
            }) {
                return Err("Pi native Bedrock binding fields are invalid".into());
            }
            let kind = field(binding, "kind")?;
            let (environment, secret) = match kind {
                "aws-bearer-token" => ("OKOU_PI_BEDROCK_BEARER_TOKEN", "AWS_BEARER_TOKEN_BEDROCK"),
                "aws-access-key-id" => ("OKOU_PI_AWS_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"),
                "aws-secret-access-key" => {
                    ("OKOU_PI_AWS_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY")
                }
                "aws-session-token" => ("OKOU_PI_AWS_SESSION_TOKEN", "AWS_SESSION_TOKEN"),
                _ => return Err("Pi native Bedrock binding is invalid".into()),
            };
            if !kinds.insert(kind)
                || field(binding, "environment")? != environment
                || field(binding, "secretName")? != secret
            {
                return Err("Pi native Bedrock binding is invalid".into());
            }
        }
        let valid = if value["authMode"] == "bearer" {
            kinds.len() == 1 && kinds.contains("aws-bearer-token")
        } else {
            (2..=3).contains(&kinds.len())
                && kinds.contains("aws-access-key-id")
                && kinds.contains("aws-secret-access-key")
                && !kinds.contains("aws-bearer-token")
        };
        if !valid {
            return Err("Pi native Bedrock credential bundle is invalid".into());
        }
        return Ok(());
    }
    if bindings.len() != 1 {
        return Err("Pi native Messages requires one credential".into());
    }
    let binding = bindings
        .first()
        .ok_or("Pi native Messages binding is missing")?;
    if !binding.as_object().is_some_and(|object| {
        has_exact_object_fields(
            object,
            &["kind", "environment", "secretName", "credentialHeader"],
            &["kind", "environment", "secretName", "credentialHeader"],
        )
    }) {
        return Err("Pi native Messages binding fields are invalid".into());
    }
    if field(binding, "kind")? != "api-key"
        || field(binding, "environment")? != "OKOU_PI_NATIVE_API_KEY"
        || !is_valid_pi_credential_header(&binding["credentialHeader"])
    {
        return Err("Pi native Messages binding is invalid".into());
    }
    let name = field(&binding["credentialHeader"], "name")?.to_ascii_lowercase();
    let template = field(&binding["credentialHeader"], "valueTemplate")?;
    if matches!(
        name.as_str(),
        "host"
            | "content-length"
            | "connection"
            | "transfer-encoding"
            | "proxy-authorization"
            | "user-agent"
    ) || template.to_ascii_lowercase().contains("sk-ant-oat")
        || template.to_ascii_lowercase().contains("sk-ant-ort")
    {
        return Err("Pi native credential header is unsafe".into());
    }
    let route = field(value, "route")?;
    let (expected_base, secret, header, expected_template) = match route {
        "anthropic-api-key" => (
            "https://api.anthropic.com",
            "ANTHROPIC_API_KEY",
            "x-api-key",
            "{{secret}}",
        ),
        "openrouter-api-key" => (
            // Mirrors openrouter-routing.ts; shared native fixtures verify
            // the owned Messages allowlist at both protocol boundaries.
            if base == "https://us.openrouter.ai/api"
                && value["credentialOwner"] == "builtin"
                && matches!(
                    field(value, "model")?,
                    "anthropic/claude-opus-5"
                        | "anthropic/claude-opus-4.8"
                        | "anthropic/claude-sonnet-5"
                        | "anthropic/claude-sonnet-4.6"
                )
            {
                "https://us.openrouter.ai/api"
            } else {
                "https://openrouter.ai/api"
            },
            "OPENROUTER_API_KEY",
            "authorization",
            "Bearer {{secret}}",
        ),
        "vercel-ai-gateway" => (
            "https://ai-gateway.vercel.sh",
            "VERCEL_AI_GATEWAY_API_KEY",
            "authorization",
            "Bearer {{secret}}",
        ),
        "azure-foundry" => {
            let resource = host
                .strip_suffix(".services.ai.azure.com")
                .ok_or("Pi native Foundry resource is invalid")?;
            if resource.is_empty()
                || resource.len() > 63
                || !resource
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                || resource.starts_with('-')
                || resource.ends_with('-')
                || url.path() != "/anthropic"
                || url.port().is_some()
            {
                return Err("Pi native Foundry resource is invalid".into());
            }
            (base, "ANTHROPIC_FOUNDRY_API_KEY", "x-api-key", "{{secret}}")
        }
        "custom-anthropic-messages" => {
            (base, "OKOU_MODEL_PROVIDER_API_KEY", name.as_str(), template)
        }
        _ => return Err("Pi native Messages route is invalid".into()),
    };
    if base != expected_base
        || field(binding, "secretName")? != secret
        || name != header
        || template != expected_template
        || (value["billingOwner"] == "builtin"
            && !matches!(route, "anthropic-api-key" | "openrouter-api-key"))
    {
        return Err("Pi native Messages endpoint or credential policy is invalid".into());
    }
    Ok(())
}

pub(super) fn validate_environment(context: &ExecutionContext) -> Result<(), String> {
    let Some(config) = &context.pi_model_config else {
        return Ok(());
    };
    if config["schemaVersion"] != 4 {
        return Ok(());
    }
    let bindings = config["credentialBindings"]
        .as_array()
        .ok_or("Pi native bindings are invalid")?;
    for binding in bindings {
        let environment = field(binding, "environment")?;
        if context
            .environment
            .as_ref()
            .and_then(|env| env.get(environment))
            .map(String::as_str)
            != Some(PI_NATIVE_CREDENTIAL_PLACEHOLDER)
        {
            return Err("Pi native environment must contain opaque firewall markers".into());
        }
    }
    // Prevent raw cloud credentials carried over from the old harness from
    // reaching a native sandbox, even when an unrelated env exemption exists.
    for key in [
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AWS_BEARER_TOKEN_BEDROCK",
        "ANTHROPIC_FOUNDRY_API_KEY",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "OPENROUTER_API_KEY",
        "VERCEL_AI_GATEWAY_API_KEY",
        "OKOU_MODEL_PROVIDER_API_KEY",
    ] {
        if context
            .environment
            .as_ref()
            .and_then(|env| env.get(key))
            .is_some_and(|value| !value.is_empty())
        {
            return Err("Pi native environment contains an unselected provider credential".into());
        }
    }
    Ok(())
}
