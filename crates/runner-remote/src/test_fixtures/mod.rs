pub(crate) mod execution_context;
pub(crate) mod http;
pub(crate) use raw_http_test_support::raw_http;
pub(crate) mod vnc;

/// Inspect Runner's current text rendering in source-boundary tests only.
/// CLI consumers deliberately do not parse this formatting or evidence schema.
pub(crate) fn diagnostic_report(value: &serde_json::Value) -> serde_json::Value {
    let text = value
        .get("diagnostic_text")
        .or_else(|| value.get("message"))
        .and_then(serde_json::Value::as_str)
        .expect("diagnostic text");
    let Some(start) = text.find('{') else {
        return serde_json::Value::Null;
    };
    serde_json::Deserializer::from_str(&text[start..])
        .into_iter::<serde_json::Value>()
        .next()
        .unwrap()
        .unwrap()
}

pub(crate) fn remote_inventory(hosts: &[(&str, i64)], created_at: &str) -> serde_json::Value {
    serde_json::json!({
        "hosts": hosts.iter().map(|(id, _)| serde_json::json!({"id":id,"host":"inventory-host-canary"})).collect::<Vec<_>>(),
        "diagnostics": {"version":1,"identities":hosts.iter().map(|(id, generation)| serde_json::json!({"id":id,"createdAt":created_at,"generation":generation})).collect::<Vec<_>>()}
    })
}
