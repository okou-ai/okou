use super::*;

fn decoded_output<P: Serialize>(registry: &ProxyRegistry<P>) -> String {
    // Normalize map ordering without changing Serde's numeric representation.
    serde_json::to_value(registry).unwrap().to_string()
}

#[tokio::test]
async fn registration_decoder_preserves_owned_writer_values() {
    let fixture = RegistryHarness::new().await;
    let policies = HashMap::from([(
        "connector".into(),
        NetworkPolicy {
            allow: vec!["plain".into(), "".into(), "雪😀".into()],
            deny: vec!["quoted\"\\\n\0".into(), "plain".into()],
            ask: vec!["plain".into()],
            unknown_policy: "arbitrary\nvalue".into(),
        },
    )]);
    let model: serde_json::Value = serde_json::from_str(
        r#"{"negativeZero":-0.0,"precise":1.2345678901234567,"large":18446744073709551615}"#,
    )
    .unwrap();
    fixture
        .handle
        .register_sandbox(
            "10.200.0.2",
            &SandboxRegistration {
                network_policies: Some(&policies),
                pi_model_config: Some(&model),
                ..base_registration()
            },
        )
        .await
        .unwrap();
    let content = tokio::fs::read_to_string(fixture.registry_path())
        .await
        .unwrap();
    let owned: ProxyRegistry = parse_registry(&content, &mut UnobservedRegistration).unwrap();
    let borrowed: ProxyRegistry<borrowed::NetworkPolicy<'_>> =
        parse_registry(&content, &mut UnobservedRegistration).unwrap();
    assert_eq!(decoded_output(&owned), decoded_output(&borrowed));
    assert_eq!(
        fail_closed_capacity_bytes(&owned).unwrap(),
        fail_closed_capacity_bytes(&borrowed).unwrap()
    );

    // A second registration rewrites the original stored entry through the
    // borrowing decoder. The ordinary owned reader must recover identical data.
    fixture
        .handle
        .register_sandbox("10.200.0.3", &base_registration())
        .await
        .unwrap();
    let stored = read_registry(fixture.registry_path()).await.unwrap();
    let original = &stored.sandboxes["10.200.0.2"];
    assert_eq!(original.network_policies.as_ref(), Some(&policies));
    assert_eq!(original.pi_model_config.as_ref(), Some(&model));
    assert_eq!(
        original.pi_model_config.as_ref().unwrap().to_string(),
        model.to_string()
    );
}

#[tokio::test]
async fn registration_decoder_retains_typed_rejections() {
    let fixture = RegistryHarness::new().await;
    fixture
        .handle
        .register_sandbox("10.200.0.2", &base_registration())
        .await
        .unwrap();
    let mut registry: serde_json::Value = serde_json::from_str(
        &tokio::fs::read_to_string(fixture.registry_path())
            .await
            .unwrap(),
    )
    .unwrap();
    let invalid_policies = [
        r#"null"#,
        r#"[]"#,
        r#"{"allow":[],"deny":[],"ask":[],"unknownPolicy":null}"#,
        r#"{"allow":[1],"deny":[],"ask":[],"unknownPolicy":"deny"}"#,
        r#"{"allow":[],"ask":[],"unknownPolicy":"deny"}"#,
        r#"{"allow":[],"allow":[],"deny":[],"ask":[],"unknownPolicy":"deny"}"#,
        r#"{"allow":["\ud800"],"deny":[],"ask":[],"unknownPolicy":"deny"}"#,
    ];
    for policy in invalid_policies {
        registry["sandboxes"]["10.200.0.2"]["networkPolicies"] =
            serde_json::json!({"connector": "POLICY"});
        let content = registry.to_string().replace("\"POLICY\"", policy);
        let owned = parse_registry::<NetworkPolicy>(&content, &mut UnobservedRegistration);
        let borrowed =
            parse_registry::<borrowed::NetworkPolicy<'_>>(&content, &mut UnobservedRegistration);
        assert!(owned.is_err(), "owned decoder accepted {policy}");
        assert!(borrowed.is_err(), "borrowing decoder accepted {policy}");
        assert_eq!(
            owned.err().unwrap().to_string(),
            borrowed.err().unwrap().to_string()
        );
    }
    registry["sandboxes"]["10.200.0.2"]["networkPolicies"] = serde_json::Value::Null;
    registry["sandboxes"]["10.200.0.2"]["piModelConfig"] = "DEEP".into();
    let content = registry.to_string().replace(
        "\"DEEP\"",
        &format!("{}0{}", "[".repeat(128), "]".repeat(128)),
    );
    assert!(parse_registry::<NetworkPolicy>(&content, &mut UnobservedRegistration).is_err());
    assert!(
        parse_registry::<borrowed::NetworkPolicy<'_>>(&content, &mut UnobservedRegistration)
            .is_err()
    );
}
