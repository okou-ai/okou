use super::*;

#[test]
fn context_uses_versioned_camel_case_wire_shape() {
    let context = RunConnectorAccountContext {
        schema_version: SCHEMA_VERSION,
        targets: vec![
            RunConnectorAccountTarget::Builtin {
                connector_slug: "github".to_string(),
                connection_id: Some("550e8400-e29b-41d4-a716-446655440000".to_string()),
            },
            RunConnectorAccountTarget::Custom {
                custom_connector_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                connection_id: None,
            },
        ],
    };

    assert_eq!(
        serde_json::to_value(context).unwrap(),
        serde_json::json!({
            "schemaVersion": 1,
            "targets": [
                {
                    "kind": "builtin",
                    "connectorSlug": "github",
                    "connectionId": "550e8400-e29b-41d4-a716-446655440000"
                },
                {
                    "kind": "custom",
                    "customConnectorId": "550e8400-e29b-41d4-a716-446655440001",
                    "connectionId": null
                }
            ]
        })
    );
}
