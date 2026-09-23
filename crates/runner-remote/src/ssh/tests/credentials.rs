use base64::Engine;
use russh::keys::{Algorithm, EcdsaCurve, ssh_key};
use serde_json::json;

use super::{
    harness::{Harness, Reply, key, params},
    terminal,
};

fn pem(label: &str, bytes: &[u8]) -> String {
    format!(
        "-----BEGIN {label}-----\n{}\n-----END {label}-----\n",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

#[tokio::test]
async fn supported_key_algorithms_and_containers_authenticate_with_real_signatures() {
    for algorithm in [
        Algorithm::Ed25519,
        Algorithm::Ecdsa {
            curve: EcdsaCurve::NistP256,
        },
        Algorithm::Ecdsa {
            curve: EcdsaCurve::NistP384,
        },
        Algorithm::Ecdsa {
            curve: EcdsaCurve::NistP521,
        },
        Algorithm::Rsa { hash: None },
    ] {
        let key = key(algorithm.clone());
        let h = Harness::with_keys(Reply::default(), key.clone(), key.clone()).await;
        let mut encodings = vec![
            (
                key.to_openssh(ssh_key::LineEnding::LF).unwrap().to_string(),
                None,
            ),
            (
                pem(
                    "PRIVATE KEY",
                    &russh::keys::pkcs8::encode_pkcs8(&key).unwrap(),
                ),
                None,
            ),
            (
                pem(
                    "ENCRYPTED PRIVATE KEY",
                    &russh::keys::pkcs8::encode_pkcs8_encrypted(b" test passphrase ", 1000, &key)
                        .unwrap(),
                ),
                Some(" test passphrase "),
            ),
            (
                key.encrypt(&mut russh::keys::key::safe_rng(), " test passphrase ")
                    .unwrap()
                    .to_openssh(ssh_key::LineEnding::LF)
                    .unwrap()
                    .to_string(),
                Some(" test passphrase "),
            ),
        ];
        if let ssh_key::private::KeypairData::Rsa(pair) = key.key_data() {
            use rsa::pkcs1::EncodeRsaPrivateKey;
            let rsa = rsa::RsaPrivateKey::try_from(pair).unwrap();
            encodings.push((
                pem("RSA PRIVATE KEY", rsa.to_pkcs1_der().unwrap().as_bytes()),
                None,
            ));
        }
        for (text, passphrase) in encodings {
            let mut credential = h.credential(true);
            credential["privateKey"] = json!(text);
            credential["passphrase"] = json!(passphrase);
            let resolve = h.resolve(credential).await;
            let frames = h.request(params()).await;
            assert_eq!(
                terminal(&frames)["type"],
                "finished",
                "{algorithm}: {frames:?}"
            );
            resolve.delete_async().await;
        }
    }
}

#[tokio::test]
async fn unsupported_formats_bad_passwords_and_bounded_kdf_fail_before_dns() {
    let h = Harness::new(Reply::default()).await;
    let encrypted = h
        .key
        .encrypt(&mut russh::keys::key::safe_rng(), "correct")
        .unwrap();
    let mut oversized_bcrypt = encrypted.to_bytes().unwrap().to_vec();
    // openssh-key-v1 magic, cipher string, KDF name, then KDF options
    // (salt string + rounds). Modify only the advertised cost, without doing it.
    let mut offset = b"openssh-key-v1\0".len();
    for _ in 0..2 {
        let length =
            u32::from_be_bytes(oversized_bcrypt[offset..offset + 4].try_into().unwrap()) as usize;
        offset += 4 + length;
    }
    offset += 4;
    let salt_length =
        u32::from_be_bytes(oversized_bcrypt[offset..offset + 4].try_into().unwrap()) as usize;
    offset += 4 + salt_length;
    oversized_bcrypt[offset..offset + 4].copy_from_slice(&65_u32.to_be_bytes());
    for (text, passphrase, expected) in [
        (pem("EC PRIVATE KEY", &[1,2]), None, "unsupported_credential"),
        (pem("DSA PRIVATE KEY", &[1,2]), None, "unsupported_credential"),
        ("PuTTY-User-Key-File-3: ssh-ed25519\n".into(), None, "unsupported_credential"),
        (pem("RSA PRIVATE KEY", b"bad DER"), None, "invalid_credential"),
        ("-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\n-----END RSA PRIVATE KEY-----".into(), Some("correct"), "invalid_credential"),
        (encrypted.to_openssh(ssh_key::LineEnding::LF).unwrap().to_string(), Some("wrong"), "invalid_credential"),
        (encrypted.to_openssh(ssh_key::LineEnding::LF).unwrap().to_string(), None, "invalid_credential"),
        (pem("OPENSSH PRIVATE KEY", &oversized_bcrypt), Some("correct"), "credential_resource_limit"),
    ] {
        let mut credential = h.credential(true);
        credential["privateKey"] = json!(text);
        credential["passphrase"] = json!(passphrase);
        let resolve = h.resolve(credential).await;
        let frames = h.request(params()).await;
        assert_eq!(terminal(&frames)["failure_reason"], expected);
        assert!(h.observed.queries.lock().unwrap().is_empty());
        assert!(h.observed.attempts.lock().unwrap().is_empty());
        resolve.delete_async().await;
    }
}

#[tokio::test]
async fn encrypted_pkcs8_preflights_memory_work_and_prf_before_derivation() {
    use pkcs5::pbes2::{EncryptionScheme, Kdf, Parameters, Pbkdf2Params, Pbkdf2Prf, ScryptParams};
    use pkcs8::der::{Encode, asn1::OctetStringRef};

    let mut h = Harness::new(Reply::default()).await;
    let salt = [7_u8; 16].as_slice().try_into().unwrap();
    let scrypt = ScryptParams {
        salt,
        cost_parameter: 16,
        block_size: 1,
        parallelization: 1,
        key_length: None,
    };
    let mut parameters = Parameters {
        kdf: Kdf::Scrypt(scrypt),
        encryption: EncryptionScheme::Aes256Cbc { iv: [3; 16] },
    };
    let plaintext = russh::keys::pkcs8::encode_pkcs8(&h.key).unwrap();
    let ciphertext = parameters.encrypt(b"correct", &plaintext).unwrap();
    let pbkdf2 = Pbkdf2Params {
        salt,
        iteration_count: 1000,
        key_length: None,
        prf: Pbkdf2Prf::HmacWithSha256,
    };
    for (kdf, expected) in [
        (Kdf::Scrypt(scrypt), "finished"),
        (
            Kdf::Scrypt(ScryptParams {
                cost_parameter: 65_536,
                block_size: 8,
                ..scrypt
            }),
            "credential_resource_limit",
        ),
        (
            Kdf::Scrypt(ScryptParams {
                parallelization: 2,
                ..scrypt
            }),
            "credential_resource_limit",
        ),
        (
            Kdf::Scrypt(ScryptParams {
                cost_parameter: 3,
                ..scrypt
            }),
            "credential_resource_limit",
        ),
        (
            Kdf::Pbkdf2(Pbkdf2Params {
                iteration_count: 600_001,
                ..pbkdf2
            }),
            "credential_resource_limit",
        ),
        (
            Kdf::Pbkdf2(Pbkdf2Params {
                key_length: Some(1),
                ..pbkdf2
            }),
            "credential_resource_limit",
        ),
        (
            Kdf::Pbkdf2(Pbkdf2Params {
                prf: Pbkdf2Prf::HmacWithSha1,
                ..pbkdf2
            }),
            "credential_resource_limit",
        ),
    ] {
        parameters.kdf = kdf;
        // Change advertised parameters only. Invalid costs must be rejected
        // before attempting to decrypt this valid low-cost scrypt ciphertext.
        let info = pkcs8::EncryptedPrivateKeyInfoRef {
            encryption_algorithm: pkcs5::EncryptionScheme::Pbes2(parameters.clone()),
            encrypted_data: OctetStringRef::new(&ciphertext).unwrap(),
        };
        let mut credential = h.credential(true);
        credential["privateKey"] = json!(pem("ENCRYPTED PRIVATE KEY", &info.to_der().unwrap()));
        credential["passphrase"] = json!("correct");
        let resolve = h.resolve(credential).await;
        let frames = h.request(params()).await;
        if expected == "finished" {
            assert_eq!(terminal(&frames)["type"], "finished");
        } else {
            assert_eq!(terminal(&frames)["failure_reason"], expected);
            assert_eq!(terminal(&frames)["effects"], "not_started");
        }
        assert_eq!(h.observed.attempts.lock().unwrap().len(), 1);
        resolve.delete_async().await;
        // The next credential must be decoded rather than reusing the successful fill.
        h.restart(h.run).await;
    }
}

#[tokio::test]
async fn malformed_sensitive_handoffs_never_reach_credentials_or_network() {
    let h = Harness::new(Reply::default()).await;
    let original = h.credential(true);
    let mut bodies = Vec::new();
    for (field, value) in [
        ("privateKey", json!("")),
        ("privateKey", json!("x".repeat(65537))),
        ("passphrase", json!("x".repeat(4097))),
        ("generation", json!(0)),
        ("generation", json!(2147483648_i64)),
        ("port", json!(65536)),
        ("username", json!("")),
        ("extra", json!("secret-extra-canary")),
    ] {
        let mut body = original.clone();
        body[field] = value;
        bodies.push(body.to_string());
    }
    for field in ["privateKey", "passphrase", "learnedHostKey", "outcome"] {
        let mut body = original.clone();
        body.as_object_mut().unwrap().remove(field);
        bodies.push(body.to_string());
    }
    bodies.push(format!(
        "{{\"privateKey\":\"duplicate-secret-canary\",{}",
        &original.to_string()[1..]
    ));
    bodies.push(
        json!({"outcome":"unavailable","privateKey":"unavailable-secret-canary"}).to_string(),
    );
    bodies.push(format!("{}{}", original, " ".repeat(512 * 1024)));
    for body in bodies {
        let resolve = h
            .api
            .mock_async(|when, then| {
                when.method("POST")
                    .path(format!("/api/runners/runs/{}/ssh/resolve", h.run));
                then.status(200).body(body);
            })
            .await;
        let frames = h.request(params()).await;
        assert_eq!(terminal(&frames)["failure_reason"], "authority_failure");
        assert!(
            !serde_json::to_string(&frames)
                .unwrap()
                .contains("secret-canary")
        );
        assert!(h.observed.queries.lock().unwrap().is_empty());
        resolve.delete_async().await;
    }
}

#[tokio::test]
async fn wrong_user_key_fails_authentication_without_exec() {
    let h = Harness::new(Reply::default()).await;
    let mut credential = h.credential(true);
    credential["privateKey"] = json!(
        key(Algorithm::Ed25519)
            .to_openssh(ssh_key::LineEnding::LF)
            .unwrap()
            .as_str()
    );
    let _resolve = h.resolve(credential).await;
    let frames = h.request(params()).await;
    assert_eq!(terminal(&frames)["failure_reason"], "authentication_failed");
    assert_eq!(terminal(&frames)["effects"], "not_started");
    assert!(h.observed.commands.lock().unwrap().is_empty());
}
