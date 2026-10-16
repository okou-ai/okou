pub(crate) mod execution_context;
pub(crate) mod http;
pub(crate) use raw_http_test_support::raw_http;
pub(crate) mod vnc;

pub(crate) fn remote_inventory(hosts: &[(&str, i64)], created_at: &str) -> serde_json::Value {
    serde_json::json!({
        "hosts": hosts.iter().map(|(id, _)| serde_json::json!({"id":id,"host":"inventory-host-canary"})).collect::<Vec<_>>(),
        "diagnostics": {"version":1,"identities":hosts.iter().map(|(id, generation)| serde_json::json!({"id":id,"createdAt":created_at,"generation":generation})).collect::<Vec<_>>()}
    })
}
