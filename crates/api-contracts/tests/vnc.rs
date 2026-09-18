use api_contracts::generated::types::runners::vnc::{
    CheckRequest, CheckRequestRunnerIdentity, CheckResponse, ResolveResponse,
    ResolveResponseResolvedAuthentication, ResolveResponseResolvedSecurity,
    ResolveResponseResolvedSecurityX509VncTrust,
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
    let ResolveResponseResolvedAuthentication::VncPassword { password } = authentication;
    assert_eq!(password.expose(), " pass  ");
    assert_eq!(generation, 5);
    let ResolveResponseResolvedSecurity::X509Vnc { trust } = security;
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
    let ResolveResponseResolvedSecurity::X509Vnc { trust } = security;
    let ResolveResponseResolvedSecurityX509VncTrust::CustomCa { ca_bundle } = trust else {
        panic!("expected custom CA");
    };
    assert_eq!(ca_bundle, "owner-ca-bundle");
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
}

#[test]
fn malformed_credentials_and_duplicate_fields_do_not_expose_passwords() {
    for password in ["", "secret-canary-over-eight-bytes"] {
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
fn authorization_check_preserves_expected_generation_and_closed_outcomes() {
    let request = CheckRequest {
        connection_id: "00000000-0000-4000-8000-000000000001".to_owned(),
        runner_identity: CheckRequestRunnerIdentity {
            runner_id: "00000000-0000-4000-8000-000000000002".to_owned(),
            heartbeat_generation: 5_000_000_000,
        },
        expected_generation: 5,
    };
    assert_eq!(
        serde_json::to_value(request).unwrap(),
        json!({
            "connectionId": "00000000-0000-4000-8000-000000000001",
            "runnerIdentity": {
                "runnerId": "00000000-0000-4000-8000-000000000002",
                "heartbeatGeneration": 5_000_000_000_i64
            },
            "expectedGeneration": 5
        })
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
