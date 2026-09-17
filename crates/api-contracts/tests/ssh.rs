use api_contracts::generated::types::runners::ssh::ResolveResponse;
use serde_json::json;

#[test]
fn access_handoff_separates_and_bounds_both_credentials() {
    use api_contracts::generated::types::runners::ssh::ResolveResponseResolvedAccessAuthentication;
    let body = json!({
        "outcome": "resolved_access", "host": "ssh.example.com", "port": 443,
        "username": "deploy", "generation": 5, "learnedHostKey": null,
        "authentication": { "method": "password", "password": " ssh-password\n" },
        "access": { "configId": "00000000-0000-4000-8000-000000000001", "generation": 2,
            "clientId": "client-id-canary", "clientSecret": "client-secret-canary" }
    });
    let response: ResolveResponse = serde_json::from_str(&body.to_string()).unwrap();
    let ResolveResponse::ResolvedAccess {
        authentication,
        access,
        ..
    } = response
    else {
        panic!("expected protected SSH");
    };
    let ResolveResponseResolvedAccessAuthentication::Password { password } = authentication else {
        panic!("expected SSH password");
    };
    assert_eq!(password.expose(), " ssh-password\n");
    assert_eq!(access.client_id.expose(), "client-id-canary");
    assert_eq!(access.client_secret.expose(), "client-secret-canary");
    for field in ["clientId", "clientSecret"] {
        for invalid in [String::new(), "x".repeat(4097)] {
            let mut invalid_body = body.clone();
            invalid_body["access"][field] = json!(invalid);
            assert!(serde_json::from_str::<ResolveResponse>(&invalid_body.to_string()).is_err());
        }
        let mut missing = body.clone();
        missing["access"].as_object_mut().unwrap().remove(field);
        assert!(serde_json::from_str::<ResolveResponse>(&missing.to_string()).is_err());
    }
    let mut mixed = body.clone();
    mixed["authentication"]["privateKey"] = json!("secret-canary");
    let error = serde_json::from_str::<ResolveResponse>(&mixed.to_string())
        .err()
        .unwrap();
    assert!(!error.to_string().contains("secret-canary"));
    for field in ["outcome", "access", "authentication"] {
        let duplicate = format!("{{\"{field}\":{},{}", body[field], &body.to_string()[1..]);
        assert!(serde_json::from_str::<ResolveResponse>(&duplicate).is_err());
    }
}

#[test]
fn password_handoff_requires_exact_variant_fields_and_bounded_secrets() {
    let password = format!(" {}  \n", "😀".repeat(2046));
    assert_eq!(password.encode_utf16().count(), 4096);
    let body = json!({"outcome":"resolved_password","host":"example.com","port":22,"username":"user","generation":1,"learnedHostKey":null,"password":password});
    let decoded: ResolveResponse = serde_json::from_str(&body.to_string()).unwrap();
    let ResolveResponse::ResolvedPassword {
        password: decoded, ..
    } = decoded
    else {
        panic!("expected password");
    };
    assert_eq!(decoded.expose(), password);
    for password in ["".to_owned(), "😀".repeat(2049)] {
        let mut invalid = body.clone();
        invalid["password"] = json!(password);
        assert!(serde_json::from_str::<ResolveResponse>(&invalid.to_string()).is_err());
    }
    for field in [
        "host",
        "port",
        "username",
        "generation",
        "learnedHostKey",
        "password",
    ] {
        let mut invalid = body.clone();
        invalid.as_object_mut().unwrap().remove(field);
        assert!(
            serde_json::from_str::<ResolveResponse>(&invalid.to_string()).is_err(),
            "missing {field}"
        );
    }
    for field in ["privateKey", "passphrase", "unknown"] {
        let mut invalid = body.clone();
        invalid[field] = json!("secret-canary");
        let error = serde_json::from_str::<ResolveResponse>(&invalid.to_string())
            .err()
            .unwrap();
        assert!(!error.to_string().contains("secret-canary"));
    }
    for field in ["outcome", "host", "password", "learnedHostKey"] {
        let duplicate = format!("{{\"{field}\":{},{}", body[field], &body.to_string()[1..]);
        assert!(
            serde_json::from_str::<ResolveResponse>(&duplicate).is_err(),
            "duplicate {field}"
        );
    }
    let mut mixed = body;
    mixed["outcome"] = json!("resolved");
    mixed["privateKey"] = json!("secret-key");
    mixed["passphrase"] = serde_json::Value::Null;
    assert!(serde_json::from_str::<ResolveResponse>(&mixed.to_string()).is_err());
}

#[test]
fn credential_handoff_obeys_utf16_bounds_and_preserves_secret_whitespace() {
    let body = json!({"outcome":"resolved","host":"example.com","port":22,"username":"user","generation":1,"learnedHostKey":null,"privateKey":"😀".repeat(32768),"passphrase":" passphrase\n"});
    let decoded: ResolveResponse = serde_json::from_value(body.clone()).unwrap();
    let ResolveResponse::Resolved {
        private_key,
        passphrase,
        ..
    } = decoded
    else {
        panic!("expected resolved");
    };
    assert_eq!(private_key.expose().encode_utf16().count(), 65536);
    assert_eq!(passphrase.unwrap().expose(), " passphrase\n");
    let mut oversized = body;
    oversized["privateKey"] = json!("😀".repeat(32769));
    assert!(serde_json::from_value::<ResolveResponse>(oversized).is_err());
    for response in [
        r#"{"outcome":"unavailable","outcome":"unavailable"}"#,
        r#"{"outcome":"unavailable","unknown":"canary"}"#,
        r#"{"outcome":"unavailable","passphrase":null}"#,
    ] {
        assert!(serde_json::from_str::<ResolveResponse>(response).is_err());
    }
}
