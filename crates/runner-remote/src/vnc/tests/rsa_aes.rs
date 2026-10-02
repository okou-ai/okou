use super::harness::Harness;
use serde_json::json;

#[tokio::test]
async fn malformed_rsa_pin_credentials_or_ne_route_never_opens_a_socket() {
    let pin = "ab".repeat(32);
    for (security, authentication, transport, host, reason) in [
        (
            json!({"type":"rsa_aes_ra2","serverKeySha256":"ab".repeat(20)}),
            json!({"method":"rsa_aes_password","password":"secret"}),
            json!({"type":"direct"}),
            "rsa.example.test",
            "authority_failure",
        ),
        (
            json!({"type":"rsa_aes_ra2","serverKeySha256":pin.to_uppercase()}),
            json!({"method":"rsa_aes_password","password":"secret"}),
            json!({"type":"direct"}),
            "rsa.example.test",
            "authority_failure",
        ),
        (
            json!({"type":"rsa_aes_ra2","serverKeySha256":pin}),
            json!({"method":"rsa_aes_password","password":"é".repeat(128)}),
            json!({"type":"direct"}),
            "rsa.example.test",
            "invalid_credential",
        ),
        (
            json!({"type":"rsa_aes_ra2_256","serverKeySha256":pin}),
            json!({"method":"rsa_aes_username_password","username":"x\u{0}y","password":"secret"}),
            json!({"type":"direct"}),
            "rsa.example.test",
            "invalid_credential",
        ),
        (
            json!({"type":"rsa_aes_ra2ne","serverKeySha256":pin}),
            json!({"method":"rsa_aes_password","password":"secret"}),
            json!({"type":"direct"}),
            "127.0.0.1",
            "authority_failure",
        ),
        (
            json!({"type":"rsa_aes_ra2ne_256","serverKeySha256":pin}),
            json!({"method":"rsa_aes_password","password":"secret"}),
            json!({"type":"ssh","connectionId":"10000000-0000-4000-8000-000000000001","generation":1}),
            "other.example.test",
            "authority_failure",
        ),
        (
            json!({"type":"rsa_aes_ra2","serverKeySha256":pin}),
            json!({"method":"vnc_password","password":"secret"}),
            json!({"type":"direct"}),
            "rsa.example.test",
            "authority_failure",
        ),
        (
            json!({"type":"x509_vnc","trust":{"mode":"system"}}),
            json!({"method":"rsa_aes_password","password":"secret"}),
            json!({"type":"direct"}),
            "rsa.example.test",
            "authority_failure",
        ),
    ] {
        let mut h = Harness::new().await;
        let resolved = h.resolve_response(json!({"outcome":"resolved_rsa_aes","host":host,"port":5900,"generation":7,"transport":transport,"authentication":authentication,"security":security})).await;
        let started = h.start("shared").await;
        assert_eq!(
            started.result(),
            &json!({"outcome":"failed","reason":reason})
        );
        assert!(h.network.attempts.lock().unwrap().is_empty());
        resolved.assert_calls_async(1).await;
        h.run.shutdown().await;
    }
}

#[test]
fn rsa_key_mismatch_is_redacted_authentication_failure() {
    assert_eq!(
        super::super::Failure::from(rfb_client::Error::RsaServerKeyMismatch),
        super::super::Failure::AuthenticationFailed
    );
}
