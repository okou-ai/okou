//! The private authority HTTP boundary admits every existing native RFB family.
//! Algorithm interoperability remains in the independent rfb-client peer suites.

use super::{CONNECTION, Harness};
use base64::Engine;
use serde_json::{Value, json};

#[tokio::test]
async fn both_native_carriers_admit_all_eighteen_current_authentication_profiles() {
    let key = rcgen::KeyPair::generate().unwrap();
    let certificate = rcgen::CertificateParams::new(vec!["owner.example.test".into()])
        .unwrap()
        .self_signed(&key)
        .unwrap();
    let encoded = base64::engine::general_purpose::STANDARD;
    let identity = json!({"certificateChainDer":[encoded.encode(certificate.der())],"privateKeyPkcs8Der":encoded.encode(key.serialize_der())});
    for carrier in ["cloudflare_access", "tailscale"] {
        for (outcome, authentication, security) in profiles(&identity) {
            let mut h = Harness::new().await;
            let transport = if carrier == "cloudflare_access" {
                super::route(Some(
                    json!({"serverName":"mac.example.test","trust":{"mode":"custom_ca","caBundle":h.peer.ca}}),
                ))
            } else {
                json!({"type":"tailscale","configId":CONNECTION,"generation":7,"tags":["tag:okou"],
                    "credentials":{"clientId":"private-client","clientSecret":"private-secret"}})
            };
            let mut response = json!({"outcome":outcome,"host":"desktop.example.test","port":if carrier == "tailscale" {5900} else {443},
                "generation":7,"transport":transport,"authentication":authentication,"security":security});
            if outcome == "resolved_transport" {
                response["serverName"] = json!("vnc.example.test");
            }
            let resolve = h.resolve_response(response).await;
            let credential = h
                .runtime
                .authority
                .resolve(
                    h.run.id,
                    CONNECTION.parse().unwrap(),
                    false,
                    None,
                    &mut crate::diagnostics::Identity::default(),
                )
                .await;
            assert!(credential.is_ok(), "{carrier} {outcome}");
            assert!(credential.unwrap().native.is_some());
            assert!(h.network.attempts.lock().unwrap().is_empty());
            resolve.assert_calls_async(1).await;
            h.run.shutdown().await;
        }
    }
}

fn profiles(identity: &Value) -> Vec<(&'static str, Value, Value)> {
    let trust = json!({"mode":"system"});
    let mut profiles = vec![
        (
            "resolved_transport",
            json!({"method":"none"}),
            json!({"type":"x509_none","trust":trust}),
        ),
        (
            "resolved_transport",
            json!({"method":"vnc_password","password":" secret "}),
            json!({"type":"x509_vnc","trust":trust}),
        ),
        (
            "resolved_transport",
            json!({"method":"username_password","username":"user","password":"secret"}),
            json!({"type":"x509_plain","trust":trust}),
        ),
        (
            "resolved_transport",
            json!({"method":"qemu_scram_sha256","username":"user","password":"secret"}),
            json!({"type":"qemu_x509_sasl","trust":trust}),
        ),
        (
            "resolved_apple_vnc_password",
            json!({"method":"vnc_password","password":" secret "}),
            json!({"type":"apple_vnc_password"}),
        ),
        (
            "resolved_apple_dh",
            json!({"method":"apple_dh_username_password","username":"user","password":"secret"}),
            json!({"type":"apple_dh"}),
        ),
        (
            "resolved_apple_srp",
            json!({"method":"apple_srp_username_password","username":"user","password":"secret"}),
            json!({"type":"apple_srp"}),
        ),
        (
            "resolved_apple_rsa_srp",
            json!({"method":"apple_rsa_srp_username_password","username":"user","password":"secret"}),
            json!({"type":"apple_rsa_srp"}),
        ),
    ];
    for (method, security) in [
        ("client_certificate", "x509_none"),
        ("client_certificate_vnc_password", "x509_vnc"),
    ] {
        let mut auth = identity.clone();
        auth["method"] = json!(method);
        if method.ends_with("vnc_password") {
            auth["password"] = json!(" secret ");
        }
        profiles.push((
            "resolved_transport",
            auth,
            json!({"type":security,"trust":trust}),
        ));
    }
    for security in [
        "rsa_aes_ra2",
        "rsa_aes_ra2_256",
        "rsa_aes_ra2ne",
        "rsa_aes_ra2ne_256",
    ] {
        for method in ["rsa_aes_password", "rsa_aes_username_password"] {
            let mut auth = json!({"method":method,"password":"secret"});
            if method == "rsa_aes_username_password" {
                auth["username"] = json!("user");
            }
            profiles.push((
                "resolved_rsa_aes",
                auth,
                json!({"type":security,"serverKeySha256":"ab".repeat(32)}),
            ));
        }
    }
    assert_eq!(profiles.len(), 18);
    profiles
}
