use super::*;

#[test]
fn build_ws_url_basic() {
    let url = build_ws_url("realtime.ably.io", "my-token", None, None);
    let url = url.unwrap();
    let parsed = url::Url::parse(&url).unwrap();
    assert!(url.starts_with("wss://realtime.ably.io/"));
    assert_query_values(&parsed, "access_token", &["my-token"]);
    assert_query_values(&parsed, "format", &["msgpack"]);
    assert_query_values(&parsed, "v", &[PROTOCOL_VERSION]);
    assert_query_values(
        &parsed,
        "agent",
        &[&format!("ably-subscriber-rs/{}", env!("CARGO_PKG_VERSION"))],
    );
    assert_query_values(&parsed, "heartbeats", &["false"]);
    assert_query_values(&parsed, "echo", &["false"]);
    assert_query_values(&parsed, "heartbeatInterval", &[]);
    assert_query_values(&parsed, "resume", &[]);
}

#[test]
fn build_ws_url_with_resume() {
    let url = build_ws_url("realtime.ably.io", "my-token", Some("conn-key!abc"), None);
    let url = url.unwrap();
    let parsed = url::Url::parse(&url).unwrap();
    assert_query_values(&parsed, "resume", &["conn-key!abc"]);
    assert_query_values(&parsed, "connection_serial", &[]);
}

#[test]
fn build_ws_url_custom_host() {
    let url = build_ws_url("sandbox-realtime.ably.io", "tok", None, None);
    let url = url.unwrap();
    assert!(url.starts_with("wss://sandbox-realtime.ably.io/"));
}

#[test]
fn build_ws_url_preserves_explicit_remote_port() {
    let url = build_ws_url("sandbox-realtime.ably.io:80", "tok", None, None).unwrap();

    assert_websocket_endpoint(
        &url,
        "wss",
        url::Host::Domain("sandbox-realtime.ably.io"),
        Some(80),
    );
}

#[test]
fn rest_host_default() {
    assert_eq!(rest_host("realtime.ably.io"), "rest.ably.io");
}

#[test]
fn rest_host_custom() {
    assert_eq!(rest_host("custom.example.com"), "custom.example.com");
}

#[test]
fn build_token_request_url_basic() {
    let url = build_token_request_url("rest.ably.io", "testKey.testId").unwrap();

    assert_eq!(
        url.as_str(),
        "https://rest.ably.io/keys/testKey.testId/requestToken"
    );
}

#[test]
fn build_token_request_url_localhost_uses_http() {
    let url = build_token_request_url("127.0.0.1:9000", "testKey.testId").unwrap();

    assert_eq!(
        url.as_str(),
        "http://127.0.0.1:9000/keys/testKey.testId/requestToken"
    );

    let url = build_token_request_url("localhost:9000", "testKey.testId").unwrap();
    assert_eq!(
        url.as_str(),
        "http://localhost:9000/keys/testKey.testId/requestToken"
    );

    let url = build_token_request_url("[::1]:9000", "testKey.testId").unwrap();
    assert_eq!(
        url.as_str(),
        "http://[::1]:9000/keys/testKey.testId/requestToken"
    );
}

#[test]
fn build_token_request_url_preserves_explicit_remote_port() {
    let url = build_token_request_url("rest.ably.io:80", "testKey.testId").unwrap();

    assert_eq!(
        url.as_str(),
        "https://rest.ably.io:80/keys/testKey.testId/requestToken"
    );
}

#[test]
fn build_token_request_url_encodes_key_name_as_single_segment() {
    let url = build_token_request_url("rest.ably.io", "a/b?c#d% e").unwrap();

    assert_eq!(
        url.as_str(),
        "https://rest.ably.io/keys/a%2Fb%3Fc%23d%25%20e/requestToken"
    );
}

#[test]
fn build_token_request_url_preserves_preencoded_key_name_as_raw_text() {
    let url = build_token_request_url("rest.ably.io", "%2F").unwrap();

    assert_eq!(url.as_str(), "https://rest.ably.io/keys/%252F/requestToken");
}

#[test]
fn build_token_request_url_encodes_backslash_as_key_name_text() {
    let url = build_token_request_url("rest.ably.io", r"a\b").unwrap();

    assert_eq!(url.as_str(), "https://rest.ably.io/keys/a%5Cb/requestToken");
}

#[test]
fn build_token_request_url_preserves_preencoded_dot_segments_as_raw_text() {
    let url = build_token_request_url("rest.ably.io", "%2E%2E").unwrap();

    assert_eq!(
        url.as_str(),
        "https://rest.ably.io/keys/%252E%252E/requestToken"
    );
}

#[test]
fn build_token_request_url_rejects_dot_segments() {
    for key_name in [".", ".."] {
        assert!(matches!(
            build_token_request_url("rest.ably.io", key_name),
            Err(Error::Url(url::ParseError::InvalidDomainCharacter))
        ));
    }
}

#[test]
fn build_token_request_url_rejects_key_names_with_url_ignored_whitespace() {
    for key_name in ["a\tb", "a\nb", "a\rb", ".\n", "..\r"] {
        assert!(matches!(
            build_token_request_url("rest.ably.io", key_name),
            Err(Error::Url(url::ParseError::InvalidDomainCharacter))
        ));
    }
}

fn assert_websocket_endpoint(
    url: &str,
    scheme: &str,
    expected_host: url::Host<&str>,
    expected_port: Option<u16>,
) {
    let parsed = url::Url::parse(url).unwrap();
    assert_eq!(parsed.scheme(), scheme);
    assert_eq!(parsed.host(), Some(expected_host));
    assert_eq!(parsed.port(), expected_port);
}

fn assert_query_values(url: &url::Url, key: &str, expected: &[&str]) {
    let values = url
        .query_pairs()
        .filter_map(|(query_key, value)| (query_key == key).then(|| value.into_owned()))
        .collect::<Vec<_>>();
    assert_eq!(values, expected);
}

#[test]
fn build_ws_url_localhost_uses_ws() {
    let url = build_ws_url("127.0.0.1:9000", "tok", None, None).unwrap();
    assert_websocket_endpoint(
        &url,
        "ws",
        url::Host::Ipv4(std::net::Ipv4Addr::LOCALHOST),
        Some(9000),
    );

    let url = build_ws_url("localhost:9000", "tok", None, None).unwrap();
    assert_websocket_endpoint(&url, "ws", url::Host::Domain("localhost"), Some(9000));

    let url = build_ws_url("LOCALHOST:9000", "tok", None, None).unwrap();
    assert_websocket_endpoint(&url, "ws", url::Host::Domain("localhost"), Some(9000));

    let url = build_ws_url("[::1]:9000", "tok", None, None).unwrap();
    assert_websocket_endpoint(
        &url,
        "ws",
        url::Host::Ipv6(std::net::Ipv6Addr::LOCALHOST),
        Some(9000),
    );
}

#[test]
fn build_ws_url_localhost_prefixes_use_wss() {
    let cases = [
        (
            "localhost.evil.com",
            url::Host::Domain("localhost.evil.com"),
        ),
        (
            "127.0.0.1.attacker.com",
            url::Host::Domain("127.0.0.1.attacker.com"),
        ),
        (
            "127.0.0.10",
            url::Host::Ipv4(std::net::Ipv4Addr::new(127, 0, 0, 10)),
        ),
    ];

    for (host, expected_host) in cases {
        let url = build_ws_url(host, "tok", None, None).unwrap();
        assert_websocket_endpoint(&url, "wss", expected_host, None);
    }
}

#[test]
fn endpoint_builders_reject_base_url_inputs() {
    let cases = [
        "",
        "https://example.com",
        "example.com/path",
        "example.com/",
        "example.com/.",
        "example.com/..",
        "example.com/%2e%2e",
        r"example.com\path",
        r"example.com\..",
        "example.com?x=1",
        "example.com#frag",
        "rest\t.ably.io",
        "rest.\nably.io",
        "rest.ably.io\r",
        "user@example.com",
        "user:pass@example.com",
    ];

    for host in cases {
        assert!(matches!(
            build_ws_url(host, "tok", None, None),
            Err(Error::Url(_))
        ));
        assert!(matches!(
            build_token_request_url(host, "testKey.testId"),
            Err(Error::Url(_))
        ));
    }
}

#[test]
fn invalid_endpoint_host_url_error_does_not_include_raw_host() {
    let err = build_ws_url("user:secret@example.com", "tok", None, None).unwrap_err();
    let message = err.to_string();

    assert_eq!(message, "URL parse error: invalid domain character");
    assert!(!message.contains("user"));
    assert!(!message.contains("secret"));
    assert!(!message.contains("example.com"));
}
