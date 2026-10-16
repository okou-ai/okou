pub(crate) mod execution_context;
pub(crate) mod http;
pub(crate) use raw_http_test_support::raw_http;
pub(crate) mod vnc;

pub(crate) fn diagnostic_text(value: &serde_json::Value) -> &str {
    value
        .get("diagnostic_text")
        .or_else(|| value.get("message"))
        .and_then(serde_json::Value::as_str)
        .expect("diagnostic text")
}

/// Select a real returned incident through the public diagnose RPC in tests.
pub(crate) fn diagnostic_attempt(value: &serde_json::Value) -> uuid::Uuid {
    diagnostic_text(value)
        .lines()
        .find_map(|line| line.strip_prefix("Attempt: "))
        .expect("returned attempt ID")
        .parse()
        .expect("attempt UUID")
}

pub(crate) fn remote_inventory(hosts: &[(&str, i64)], created_at: &str) -> serde_json::Value {
    serde_json::json!({
        "hosts": hosts.iter().map(|(id, _)| serde_json::json!({"id":id,"host":"inventory-host-canary"})).collect::<Vec<_>>(),
        "identities":hosts.iter().map(|(id, generation)| serde_json::json!({"id":id,"createdAt":created_at,"generation":generation})).collect::<Vec<_>>()
    })
}
