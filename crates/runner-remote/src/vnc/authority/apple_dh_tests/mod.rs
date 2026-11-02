use super::*;
use serde_json::{Value, json};

fn parse(value: Value, supports_ssh: bool) -> Result<Credential, Failure> {
    let response: ResolveResponse = serde_json::from_value(value).unwrap();
    let ResolveResponse::ResolvedAppleDh {
        host,
        port,
        generation,
        transport,
        authentication,
        security,
    } = response
    else {
        panic!("expected Apple DH outcome");
    };
    apple_dh_credential(
        chrono::Utc::now(),
        host,
        port,
        generation,
        transport,
        authentication,
        security,
        supports_ssh,
    )
}

fn response() -> Value {
    json!({
        "outcome": "resolved_apple_dh",
        "host": "127.0.0.1",
        "port": 5900,
        "generation": 3,
        "transport": {
            "type": "ssh",
            "connectionId": "00000000-0000-4000-8000-000000000001",
            "generation": 4
        },
        "authentication": {
            "method": "apple_dh_username_password",
            "username": "operator",
            "password": "secret"
        },
        "security": { "type": "apple_dh" }
    })
}

#[test]
fn accepts_only_exact_ssh_loopback_apple_tuple() {
    let valid = parse(response(), true).unwrap();
    assert!(matches!(
        valid.transport,
        Transport::Ssh { generation: 4, .. }
    ));
    assert!(matches!(valid.authentication, Authentication::AppleDh(_)));
    assert_eq!(valid.host, "127.0.0.1");
    let mut ipv6 = response();
    ipv6["host"] = json!("::1");
    assert!(parse(ipv6, true).is_ok());
    assert!(matches!(parse(response(), false), Err(Failure::Authority)));

    for (pointer, value) in [
        ("/host", json!("localhost")),
        ("/host", json!("mac.example.com")),
        ("/port", json!(0)),
        ("/generation", json!(0)),
        ("/transport", json!({ "type": "direct" })),
        ("/transport/generation", json!(0)),
        (
            "/authentication",
            json!({ "method": "username_password", "username": "operator", "password": "secret" }),
        ),
        (
            "/security",
            json!({ "type": "x509_plain", "trust": { "mode": "system" } }),
        ),
    ] {
        let mut invalid = response();
        *invalid.pointer_mut(pointer).unwrap() = value;
        assert!(parse(invalid, true).is_err(), "accepted {pointer}");
    }
    for (field, value) in [("username", "x".repeat(64)), ("password", "x".repeat(64))] {
        let mut invalid = response();
        invalid["authentication"][field] = json!(value);
        assert!(matches!(
            parse(invalid, true),
            Err(Failure::InvalidCredential)
        ));
    }
}
