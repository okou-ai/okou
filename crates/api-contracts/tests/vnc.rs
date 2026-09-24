use api_contracts::generated::types::runners::vnc::{
    CheckRequest, CheckRequestExpectedTransport, CheckRequestRunnerIdentity, CheckResponse,
    ResolveRequest, ResolveRequestRunnerIdentity, ResolveRequestSupportedProfile,
    ResolveRequestSupportedProfileAuthMethod, ResolveRequestSupportedProfileSecurityType,
    ResolveRequestSupportedProfileTransportType, ResolveResponse,
    ResolveResponseResolvedAuthentication, ResolveResponseResolvedSecurity,
    ResolveResponseResolvedSecurityX509VncTrust, ResolveResponseResolvedTransportTransport,
};
use serde_json::{Value, json};

fn resolved() -> Value {
    json!({
        "outcome": "resolved", "host": "vnc.example.com", "port": 5900,
        "generation": 5,
        "authentication": {"method": "vnc_password", "password": " pass  "},
        "security": {"type": "x509_vnc", "trust": {"mode": "system"}}
    })
}

#[test]
fn credential_handoff_preserves_explicit_authentication_and_trust() {
    let response: ResolveResponse = serde_json::from_str(&resolved().to_string()).unwrap();
    let ResolveResponse::Resolved {
        authentication,
        security,
        generation,
        ..
    } = response
    else {
        panic!("expected current authority");
    };
    let ResolveResponseResolvedAuthentication::VncPassword { password } = authentication else {
        panic!("expected classic VNC password");
    };
    assert_eq!(password.expose(), " pass  ");
    assert_eq!(generation, 5);
    let ResolveResponseResolvedSecurity::X509Vnc { trust } = security else {
        panic!("expected X509Vnc security");
    };
    assert!(matches!(
        trust,
        ResolveResponseResolvedSecurityX509VncTrust::System
    ));

    let mut custom = resolved();
    custom["security"]["trust"] = json!({"mode": "custom_ca", "caBundle": "owner-ca-bundle"});
    let response: ResolveResponse = serde_json::from_str(&custom.to_string()).unwrap();
    let ResolveResponse::Resolved { security, .. } = response else {
        panic!("expected custom trust");
    };
    let ResolveResponseResolvedSecurity::X509Vnc { trust } = security else {
        panic!("expected X509Vnc security");
    };
    let ResolveResponseResolvedSecurityX509VncTrust::CustomCa { ca_bundle } = trust else {
        panic!("expected custom CA");
    };
    assert_eq!(ca_bundle, "owner-ca-bundle");

    let plain: ResolveResponse = serde_json::from_value(json!({
        "outcome": "resolved", "host": "plain.example.com", "port": 5900,
        "generation": 6,
        "authentication": {
            "method": "username_password",
            "username": " operator界 ",
            "password": " päss 界 "
        },
        "security": {"type": "x509_plain", "trust": {"mode": "system"}}
    }))
    .unwrap();
    let ResolveResponse::Resolved {
        authentication,
        security,
        ..
    } = plain
    else {
        panic!("expected current Plain authority");
    };
    let ResolveResponseResolvedAuthentication::UsernamePassword { username, password } =
        authentication
    else {
        panic!("expected Plain credentials");
    };
    assert_eq!(username, " operator界 ");
    assert_eq!(password.expose(), " päss 界 ");
    assert!(matches!(
        security,
        ResolveResponseResolvedSecurity::X509Plain {
            trust: ResolveResponseResolvedSecurityX509VncTrust::System
        }
    ));
}

#[test]
fn private_handoff_rejects_unknown_tags_and_mixed_variant_fields() {
    for (pointer, value) in [
        ("/outcome", "future_outcome"),
        ("/authentication/method", "password"),
        ("/security/type", "none"),
        ("/security/trust/mode", "insecure"),
    ] {
        let mut invalid = resolved();
        *invalid.pointer_mut(pointer).unwrap() = json!(value);
        assert!(serde_json::from_str::<ResolveResponse>(&invalid.to_string()).is_err());
    }
    for pointer in ["", "/authentication", "/security", "/security/trust"] {
        let mut invalid = resolved();
        invalid.pointer_mut(pointer).unwrap()["unknown"] = json!("secret-canary");
        let error = serde_json::from_str::<ResolveResponse>(&invalid.to_string())
            .err()
            .unwrap();
        assert!(!error.to_string().contains("secret-canary"));
    }
    for outcome in ["unavailable", "unsupported_profile"] {
        let mut invalid = resolved();
        invalid["outcome"] = json!(outcome);
        assert!(serde_json::from_str::<ResolveResponse>(&invalid.to_string()).is_err());
        assert!(
            serde_json::from_str::<ResolveResponse>(&json!({"outcome":outcome}).to_string())
                .is_ok()
        );
    }
    for authentication in [
        json!({"method":"vnc_password","username":"operator","password":"secret"}),
        json!({"method":"username_password","password":"secret"}),
    ] {
        let mut invalid = resolved();
        invalid["authentication"] = authentication;
        assert!(serde_json::from_value::<ResolveResponse>(invalid).is_err());
    }
}

#[test]
fn capable_handoff_requires_an_explicit_transport_and_server_identity() {
    let direct: ResolveResponse = serde_json::from_value(json!({
        "outcome": "resolved_transport", "host": "vnc.example.com", "port": 5900,
        "generation": 5, "serverName": "desktop.internal",
        "transport": {"type": "direct"},
        "authentication": {"method": "vnc_password", "password": "secret"},
        "security": {"type": "x509_vnc", "trust": {"mode": "system"}}
    }))
    .unwrap();
    let ResolveResponse::ResolvedTransport {
        server_name,
        transport,
        ..
    } = direct
    else {
        panic!("expected capable direct authority");
    };
    assert_eq!(server_name, "desktop.internal");
    assert!(matches!(
        transport,
        ResolveResponseResolvedTransportTransport::Direct
    ));

    let ssh: ResolveResponse = serde_json::from_value(json!({
        "outcome": "resolved_transport", "host": "private.internal", "port": 5900,
        "generation": 6, "serverName": "certificate.internal",
        "transport": {
            "type": "ssh",
            "connectionId": "00000000-0000-4000-8000-000000000003",
            "generation": 9
        },
        "authentication": {
            "method": "username_password", "username": "operator", "password": "secret"
        },
        "security": {"type": "x509_plain", "trust": {"mode": "system"}}
    }))
    .unwrap();
    let ResolveResponse::ResolvedTransport { transport, .. } = ssh else {
        panic!("expected SSH authority");
    };
    assert!(matches!(
        transport,
        ResolveResponseResolvedTransportTransport::Ssh {
            connection_id,
            generation: 9
        } if connection_id == "00000000-0000-4000-8000-000000000003"
    ));

    for missing in ["serverName", "transport"] {
        let mut invalid = json!({
            "outcome": "resolved_transport", "host": "vnc.example.com", "port": 5900,
            "generation": 5, "serverName": "desktop.internal",
            "transport": {"type": "direct"},
            "authentication": {"method": "vnc_password", "password": "secret"},
            "security": {"type": "x509_vnc", "trust": {"mode": "system"}}
        });
        invalid.as_object_mut().unwrap().remove(missing);
        assert!(serde_json::from_value::<ResolveResponse>(invalid).is_err());
    }
}

#[test]
fn apple_dh_handoff_keeps_secret_private_and_omits_x509_identity() {
    let response: ResolveResponse = serde_json::from_value(json!({
        "outcome": "resolved_apple_dh", "host": "127.0.0.1", "port": 5900,
        "generation": 5,
        "transport": {
            "type": "ssh", "connectionId": "00000000-0000-4000-8000-000000000003",
            "generation": 9
        },
        "authentication": {
            "method": "apple_dh_username_password", "username": "operator", "password": "secret"
        },
        "security": { "type": "apple_dh" }
    }))
    .unwrap();
    let ResolveResponse::ResolvedAppleDh {
        authentication,
        security,
        transport,
        ..
    } = response
    else {
        panic!("expected Apple DH authority");
    };
    let ResolveResponseResolvedAuthentication::AppleDhUsernamePassword { username, password } =
        authentication
    else {
        panic!("expected Apple DH credentials");
    };
    assert_eq!(username, "operator");
    assert_eq!(password.expose(), "secret");
    assert!(matches!(security, ResolveResponseResolvedSecurity::AppleDh));
    assert!(matches!(
        transport,
        ResolveResponseResolvedTransportTransport::Ssh { generation: 9, .. }
    ));
}

#[test]
fn malformed_credentials_and_duplicate_fields_do_not_expose_passwords() {
    for password in ["".to_owned(), format!("secret-canary{}", "界".repeat(342))] {
        let mut invalid = resolved();
        invalid["authentication"]["password"] = json!(password);
        let error = serde_json::from_str::<ResolveResponse>(&invalid.to_string())
            .err()
            .unwrap();
        assert!(!error.to_string().contains("secret-canary"));
    }
    for field in ["generation", "authentication", "security", "host", "port"] {
        let mut invalid = resolved();
        invalid.as_object_mut().unwrap().remove(field);
        assert!(serde_json::from_str::<ResolveResponse>(&invalid.to_string()).is_err());
    }
    let body = resolved().to_string();
    for field in ["outcome", "authentication", "security", "generation"] {
        let duplicate = format!("{{\"{field}\":{},{}", resolved()[field], &body[1..]);
        assert!(serde_json::from_str::<ResolveResponse>(&duplicate).is_err());
    }
    let duplicate_password = body.replace(
        "\"password\":\" pass  \"",
        "\"password\":\"first\",\"password\":\"second\"",
    );
    assert!(serde_json::from_str::<ResolveResponse>(&duplicate_password).is_err());
}

#[test]
fn resolve_request_advertises_the_five_exact_supported_tuples() {
    let request = ResolveRequest {
        connection_id: "00000000-0000-4000-8000-000000000001".to_owned(),
        runner_identity: ResolveRequestRunnerIdentity {
            runner_id: "00000000-0000-4000-8000-000000000002".to_owned(),
            heartbeat_generation: 5_000_000_000,
        },
        supported_profiles: vec![
            ResolveRequestSupportedProfile {
                auth_method: ResolveRequestSupportedProfileAuthMethod::VncPassword,
                security_type: ResolveRequestSupportedProfileSecurityType::X509Vnc,
                transport_type: Some(ResolveRequestSupportedProfileTransportType::Direct),
            },
            ResolveRequestSupportedProfile {
                auth_method: ResolveRequestSupportedProfileAuthMethod::VncPassword,
                security_type: ResolveRequestSupportedProfileSecurityType::X509Vnc,
                transport_type: Some(ResolveRequestSupportedProfileTransportType::Ssh),
            },
            ResolveRequestSupportedProfile {
                auth_method: ResolveRequestSupportedProfileAuthMethod::UsernamePassword,
                security_type: ResolveRequestSupportedProfileSecurityType::X509Plain,
                transport_type: Some(ResolveRequestSupportedProfileTransportType::Direct),
            },
            ResolveRequestSupportedProfile {
                auth_method: ResolveRequestSupportedProfileAuthMethod::UsernamePassword,
                security_type: ResolveRequestSupportedProfileSecurityType::X509Plain,
                transport_type: Some(ResolveRequestSupportedProfileTransportType::Ssh),
            },
            ResolveRequestSupportedProfile {
                auth_method: ResolveRequestSupportedProfileAuthMethod::AppleDhUsernamePassword,
                security_type: ResolveRequestSupportedProfileSecurityType::AppleDh,
                transport_type: Some(ResolveRequestSupportedProfileTransportType::Ssh),
            },
        ],
    };
    assert_eq!(
        serde_json::to_value(request).unwrap()["supportedProfiles"],
        json!([
            {"authMethod":"vnc_password","securityType":"x509_vnc","transportType":"direct"},
            {"authMethod":"vnc_password","securityType":"x509_vnc","transportType":"ssh"},
            {"authMethod":"username_password","securityType":"x509_plain","transportType":"direct"},
            {"authMethod":"username_password","securityType":"x509_plain","transportType":"ssh"},
            {"authMethod":"apple_dh_username_password","securityType":"apple_dh","transportType":"ssh"}
        ])
    );
}

#[test]
fn authorization_check_preserves_expected_generation_and_closed_outcomes() {
    let request = CheckRequest {
        connection_id: "00000000-0000-4000-8000-000000000001".to_owned(),
        runner_identity: CheckRequestRunnerIdentity {
            runner_id: "00000000-0000-4000-8000-000000000002".to_owned(),
            heartbeat_generation: 5_000_000_000,
        },
        expected_generation: 5,
        expected_transport: Some(CheckRequestExpectedTransport::Ssh {
            connection_id: "00000000-0000-4000-8000-000000000003".to_owned(),
            generation: 7,
        }),
    };
    assert_eq!(
        serde_json::to_value(request).unwrap(),
        json!({
            "connectionId": "00000000-0000-4000-8000-000000000001",
            "runnerIdentity": {
                "runnerId": "00000000-0000-4000-8000-000000000002",
                "heartbeatGeneration": 5_000_000_000_i64
            },
            "expectedGeneration": 5,
            "expectedTransport": {
                "type": "ssh",
                "connectionId": "00000000-0000-4000-8000-000000000003",
                "generation": 7
            }
        })
    );
    let legacy = CheckRequest {
        connection_id: "00000000-0000-4000-8000-000000000001".to_owned(),
        runner_identity: CheckRequestRunnerIdentity {
            runner_id: "00000000-0000-4000-8000-000000000002".to_owned(),
            heartbeat_generation: 5_000_000_000,
        },
        expected_generation: 5,
        expected_transport: None,
    };
    assert!(
        serde_json::to_value(legacy)
            .unwrap()
            .get("expectedTransport")
            .is_none()
    );
    for (outcome, expected) in [
        ("valid", CheckResponse::Valid),
        ("configuration_changed", CheckResponse::ConfigurationChanged),
        ("unavailable", CheckResponse::Unavailable),
    ] {
        let response: CheckResponse = serde_json::from_value(json!({"outcome": outcome})).unwrap();
        assert_eq!(response, expected);
    }
    assert!(serde_json::from_value::<CheckResponse>(json!({"outcome": "future"})).is_err());
}
