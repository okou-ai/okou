use api_contracts::generated::types::runners::vnc::{
    AcquireResponse, CheckResponse, ReleaseResponse, RenewResponse, ResolveResponse,
    ResolveResponseResolvedAuthentication, ResolveResponseResolvedSecurity,
    ResolveResponseResolvedSecurityX509VncTrust,
};
use serde_json::{Value, json};

fn resolved() -> Value {
    json!({
        "outcome": "resolved", "host": "vnc.example.com", "port": 5900,
        "authority": {
            "instanceId": "00000000-0000-4000-8000-000000000001",
            "generation": 5,
            "grantId": "00000000-0000-4000-8000-000000000002"
        },
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
        authority,
        ..
    } = response
    else {
        panic!("expected current authority");
    };
    let ResolveResponseResolvedAuthentication::VncPassword { password } = authentication;
    assert_eq!(password.expose(), " pass  ");
    assert_eq!(authority.generation, 5);
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
    for pointer in [
        "",
        "/authority",
        "/authentication",
        "/security",
        "/security/trust",
    ] {
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
    for field in ["authority", "authentication", "security", "host", "port"] {
        let mut invalid = resolved();
        invalid.as_object_mut().unwrap().remove(field);
        assert!(serde_json::from_str::<ResolveResponse>(&invalid.to_string()).is_err());
    }
    let body = resolved().to_string();
    for field in ["outcome", "authentication", "security", "authority"] {
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
fn lease_responses_preserve_fencing_and_route_specific_outcomes() {
    let body = json!({
        "outcome": "acquired", "leaseToken": "00000000-0000-4000-8000-000000000003",
        "serverTime": "2026-09-18T00:00:00.000Z", "expiresAt": "2026-09-18T00:00:30.000Z",
        "validForMs": 30000, "renewAfterMs": 10000
    });
    let response: AcquireResponse = serde_json::from_value(body.clone()).unwrap();
    let AcquireResponse::Acquired {
        lease_token,
        valid_for_ms,
        renew_after_ms,
        ..
    } = response
    else {
        panic!("expected lease");
    };
    assert_eq!(lease_token, "00000000-0000-4000-8000-000000000003");
    assert_eq!(valid_for_ms, 30000);
    assert_eq!(renew_after_ms, 10000);
    assert!(serde_json::from_value::<CheckResponse>(body.clone()).is_err());
    assert!(serde_json::from_value::<RenewResponse>(body.clone()).is_err());
    assert!(serde_json::from_value::<ReleaseResponse>(body.clone()).is_err());
    let mut valid = body;
    valid["outcome"] = json!("valid");
    assert!(serde_json::from_value::<CheckResponse>(valid.clone()).is_ok());
    assert!(serde_json::from_value::<RenewResponse>(valid.clone()).is_ok());
    assert!(serde_json::from_value::<AcquireResponse>(valid).is_err());
}
