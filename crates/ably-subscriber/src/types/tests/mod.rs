use super::*;

#[test]
fn token_request_json_round_trip() {
    let tr = TokenRequest {
        key_name: "xVLyHw.mDYnFA".to_string(),
        timestamp: 1700000000000,
        nonce: "abc123".to_string(),
        mac: "base64mac==".to_string(),
        capability: r#"{"channel":["subscribe"]}"#.to_string(),
        ttl: Some(3600000),
        client_id: None,
    };
    let json = serde_json::to_string(&tr).unwrap();
    assert!(json.contains("keyName"));
    assert!(json.contains("xVLyHw.mDYnFA"));
    assert!(!json.contains("clientId")); // None → skipped

    let parsed: TokenRequest = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.key_name, "xVLyHw.mDYnFA");
    assert_eq!(parsed.ttl, Some(3600000));
}

#[test]
fn token_details_json_deserialization() {
    let json = r#"{
            "token": "xVLyHw.some-token-string",
            "keyName": "xVLyHw.mDYnFA",
            "issued": 1700000000000,
            "expires": 1700003600000,
            "capability": "{\"*\":[\"*\"]}"
        }"#;
    let td: TokenDetails = serde_json::from_str(json).unwrap();
    assert_eq!(td.token, "xVLyHw.some-token-string");
    assert_eq!(td.expires, 1700003600000);
    assert_eq!(td.issued, 1700000000000);
}

#[test]
fn timing_config_close_timeout_is_shorter_than_connect_timeout() {
    let timing = TimingConfig::default();

    assert_eq!(timing.close_timeout, Duration::from_secs(5));
    assert!(
        timing.close_timeout < timing.connect_timeout,
        "best-effort close should not wait as long as connect"
    );
}

#[test]
fn websocket_error_display_redacts_auth_query_params() {
    let err = Error::from(tungstenite::Error::Url(
            tungstenite::error::UrlError::UnableToConnect(
                "wss://realtime.ably.io/?access_token=secret-token&resume=secret-key&format=msgpack \
                 retry_url=wss://realtime.ably.io/?format=msgpack&access_token=second-secret&resume=second-key"
                    .to_string(),
            ),
        ));

    let message = err.to_string();
    assert_eq!(
        message,
        "WebSocket error: URL error: Unable to connect to \
             wss://realtime.ably.io/?access_token=<redacted>&resume=<redacted>&format=msgpack \
             retry_url=wss://realtime.ably.io/?format=msgpack&access_token=<redacted>&resume=<redacted>"
    );
    assert!(!message.contains("secret-token"));
    assert!(!message.contains("secret-key"));
    assert!(!message.contains("second-secret"));
    assert!(!message.contains("second-key"));

    let debug_message = format!("{err:?}");
    assert!(debug_message.contains("access_token=<redacted>"));
    assert!(debug_message.contains("resume=<redacted>"));
    assert!(!debug_message.contains("secret-token"));
    assert!(!debug_message.contains("secret-key"));
    assert!(!debug_message.contains("second-secret"));
    assert!(!debug_message.contains("second-key"));
}

#[test]
fn protocol_error_display_redacts_auth_query_params() {
    let err = Error::Protocol {
            code: 80003,
            message: "failed wss://realtime.ably.io/?access_token=secret-token&resume=secret-key&format=msgpack"
                .to_string(),
        };

    let message = err.to_string();
    assert_eq!(
        message,
        "Ably protocol error: code=80003, failed \
             wss://realtime.ably.io/?access_token=<redacted>&resume=<redacted>&format=msgpack"
    );
    assert!(!message.contains("secret-token"));
    assert!(!message.contains("secret-key"));
}

#[test]
fn token_fetch_error_display_redacts_auth_query_params() {
    let err = Error::TokenFetch(Box::new(std::io::Error::other(
        "failed wss://realtime.ably.io/?access_token=secret-token&resume=secret-key&format=msgpack",
    )));

    let message = err.to_string();
    assert_eq!(
        message,
        "Token fetch failed: failed \
             wss://realtime.ably.io/?access_token=<redacted>&resume=<redacted>&format=msgpack"
    );
    assert!(!message.contains("secret-token"));
    assert!(!message.contains("secret-key"));
}

#[test]
fn auth_query_param_redaction_handles_common_message_delimiters() {
    let message = concat!(
        "url=\"wss://example/?access_token=quoted-token&resume=quoted-key\" ",
        "url='wss://example/?access_token=single-token&resume=single-key' ",
        "url=(wss://example/?access_token=paren-token&resume=paren-key) ",
        "url=[wss://example/?access_token=bracket-token&resume=bracket-key] ",
        "json={\"url\":\"wss://example/?access_token=json-token&resume=json-key\"}",
    );

    let redacted = redact_auth_query_params(message);

    assert_eq!(
        redacted,
        concat!(
            "url=\"wss://example/?access_token=<redacted>&resume=<redacted>\" ",
            "url='wss://example/?access_token=<redacted>&resume=<redacted>' ",
            "url=(wss://example/?access_token=<redacted>&resume=<redacted>) ",
            "url=[wss://example/?access_token=<redacted>&resume=<redacted>] ",
            "json={\"url\":\"wss://example/?access_token=<redacted>&resume=<redacted>\"}",
        )
    );
    for secret in [
        "quoted-token",
        "quoted-key",
        "single-token",
        "single-key",
        "paren-token",
        "paren-key",
        "bracket-token",
        "bracket-key",
        "json-token",
        "json-key",
    ] {
        assert!(!redacted.contains(secret));
    }
}
