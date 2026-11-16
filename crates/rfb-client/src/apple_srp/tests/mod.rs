use super::{derive_password, expected_proof, parse_challenge, valid_final_token};
use crate::{AuthenticationStage, Error};
use tokio::time::{Duration, Instant};

#[allow(
    clippy::expect_used,
    clippy::indexing_slicing,
    reason = "fixed public protocol fixture"
)]
fn challenge() -> Vec<u8> {
    let hex_group: String = include_str!("../../../tests/data/rfc5054_4096.hex")
        .chars()
        .filter(|c| !c.is_ascii_whitespace())
        .collect();
    let group = hex::decode(hex_group).expect("RFC 5054 test group");
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&(1155u32).to_be_bytes());
    bytes.push(0);
    bytes.extend_from_slice(&(512u16).to_be_bytes());
    bytes.extend_from_slice(&group);
    bytes.extend_from_slice(&(1u16).to_be_bytes());
    bytes.push(5);
    bytes.push(32);
    bytes.extend_from_slice(&[0x13; 32]);
    bytes.extend_from_slice(&(512u16).to_be_bytes());
    let mut public = [0u8; 512];
    public[511] = 5;
    bytes.extend_from_slice(&public);
    bytes.extend_from_slice(&(131_578u64).to_be_bytes());
    bytes.extend_from_slice(&(80u16).to_be_bytes());
    bytes.extend_from_slice(&[0x31; 80]);
    assert_eq!(bytes.len(), 1159);
    bytes
}

#[test]
#[allow(
    clippy::indexing_slicing,
    reason = "fixed public protocol fixture offsets"
)]
fn challenge_rejects_modified_group_lengths_and_work_factor() {
    let valid = challenge();
    assert!(parse_challenge(&valid).is_ok());
    let mut changed = valid.clone();
    changed[7] ^= 1;
    assert!(matches!(
        parse_challenge(&changed),
        Err(Error::InvalidAppleSrpParameters)
    ));
    let mut changed = valid.clone();
    changed[521] = 2;
    assert!(matches!(
        parse_challenge(&changed),
        Err(Error::InvalidAppleSrpParameters)
    ));
    let mut changed = valid.clone();
    changed[1069..1077].copy_from_slice(&(u64::MAX).to_be_bytes());
    assert!(matches!(
        parse_challenge(&changed),
        Err(Error::InvalidAppleSrpParameters)
    ));
    let mut changed = valid.clone();
    changed[1069..1077].copy_from_slice(&(9_999u64).to_be_bytes());
    assert!(matches!(
        parse_challenge(&changed),
        Err(Error::InvalidAppleSrpParameters)
    ));
    let mut changed = valid.clone();
    changed[1077..1079].copy_from_slice(&(81u16).to_be_bytes());
    assert!(matches!(
        parse_challenge(&changed),
        Err(Error::InvalidAppleSrpParameters)
    ));
    assert!(matches!(
        parse_challenge(&valid[..valid.len() - 1]),
        Err(Error::InvalidAppleSrpParameters)
    ));
}

#[tokio::test]
#[allow(clippy::expect_used, reason = "fixed public protocol fixture")]
async fn invalid_server_public_values_are_rejected_before_password_derivation() {
    let mut bytes = challenge();
    bytes.get_mut(557..1069).expect("B fixture").fill(0);
    let parsed = parse_challenge(&bytes).expect("valid lengths");
    assert!(matches!(
        expected_proof(&parsed, b"password", Instant::now()).await,
        Err(Error::InvalidAppleSrpParameters)
    ));

    let mut bytes = challenge();
    let modulus = bytes.get(7..519).expect("N fixture").to_vec();
    bytes
        .get_mut(557..1069)
        .expect("B fixture")
        .copy_from_slice(&modulus);
    let parsed = parse_challenge(&bytes).expect("valid lengths");
    assert!(matches!(
        expected_proof(&parsed, b"password", Instant::now()).await,
        Err(Error::InvalidAppleSrpParameters)
    ));
}

#[tokio::test]
async fn password_kdf_checks_deadline_during_work() {
    assert!(matches!(
        derive_password(b"password", &[0; 32], 10_000, Instant::now()).await,
        Err(Error::AuthenticationDeadlineExceeded {
            stage: AuthenticationStage::AppleSrpAuthentication
        })
    ));
}

#[tokio::test(start_paused = true)]
async fn password_kdf_matches_independent_two_block_vectors()
-> Result<(), Box<dyn std::error::Error>> {
    // Python: hashlib.pbkdf2_hmac("sha512", b"p" * length,
    //                             bytes([0x13]) * 32, iterations, 128).hex()
    // Cover both output blocks, SHA-512's 128-byte HMAC key boundary and the
    // accepted maximum password length/work factor. Paused time keeps this
    // byte-contract test independent of machine speed in debug/coverage builds.
    let cases = [
        (
            13,
            10_000,
            concat!(
                "f4b739881cb653dbcf77e2ac5787179fed7abeb9ff7d7f98c3f05893fa85c7b6",
                "abddb3c6e2d21153d3b457fbe2aecdb1c145a36f4dadddae05f0b34dc8196a84",
                "0192e8231507f3cf72cacbcc2242b0a6fcbf937aba43de4dd755646d0ecea348",
                "e98c746c4ed157f154a4ab70cfcb690fef5eaf1084255b1284581bb953a93ffd",
            ),
        ),
        (
            127,
            10_000,
            concat!(
                "a32c93aecd73b10f788c9e1ac8eb185b7d82786316be0852157e19cb1e0c8284",
                "8323b97db69a4b981498a14093380b189d444f35eba545dd57438937c929fb81",
                "057c06aa2d7b0a72d8888dae146551d783b8069e83f8172ca7583f59a385a7c6",
                "40f784f419201d767829096f955bb8ce478f215f2f3db69848f2402c2e47373e",
            ),
        ),
        (
            128,
            10_000,
            concat!(
                "bbb7e380011b3e82f21ac5e52b25a6f1482765073933e7851b4cd0a84e4765fc",
                "4c0af851cb32d4bcd04a1c552bf80c677e079e0c93eff5e6234d3c6f2453c746",
                "f57ecb25190ea311dd34cd40bd5858a24c59d924400621accfab4ac8f646ebce",
                "f87a1f41f36c8beb2d4d3a5e02e3d7578bb241276bcb89ab3416b0d4e43f7d87",
            ),
        ),
        (
            129,
            10_000,
            concat!(
                "e7fd70ef5ff168b475b88b87102729572086393a2cc069e7953805c188bf2fe1",
                "b2ab93cc5fb74419b7db3ca804d0aa71c4d26b32720a062ae41fdf917a111276",
                "f119eb31d311f625054763549df5bee2579c693b1f789d42f8b8e3b5f7b76a2c",
                "5b81006a06717a753ce4959c7f4241656a6127b095b916741076eb3e1fd792d9",
            ),
        ),
        (
            1023,
            10_000,
            concat!(
                "4af45b9190b1b52b31c61800082ecf16a0444ccbf77a0439ce448aec88584442",
                "39fd868c8b666b90e50a7a1fc5c32a882cc04b831964af8d587f281acb1f47be",
                "1d514806624c0f72a059612c3606105e5ca27c27c54ed46cd8e219a14b2808be",
                "aee56c5a57e53b0a58d416dea229e850207c00e3d2eaa176fc911f5e84ec9b85",
            ),
        ),
        (
            1023,
            250_000,
            concat!(
                "82ce1f63e04827bfbbbbdb2116768af91466886814d24624ec245b7f273f86d9",
                "4a5ef8a6151565a1d0560f0411f86d59a85601d67099aa0fbf81b1ed59bf3a11",
                "f8fccefe31c01bec6c20f339399adb29aab33fcf3c49c16ce2d881afc4f955bc",
                "cae7bca4133550c8424f18b407b54ab40e5d640f8caf53ecb17a619d38c7cd24",
            ),
        ),
    ];
    for (length, iterations, expected) in cases {
        let derived = derive_password(
            &vec![b'p'; length],
            &[0x13; 32],
            iterations,
            Instant::now() + Duration::from_secs(30),
        )
        .await?;
        assert_eq!(
            derived.as_slice(),
            hex::decode(expected).map_err(|error| format!("invalid PBKDF2 vector: {error}"))?,
            "password bytes: {length}, iterations: {iterations}"
        );
    }
    Ok(())
}

#[test]
fn final_token_requires_exact_shape_and_server_proof() {
    let proof = [0x5a; 64];
    let mut token = [0u8; 92];
    token[..4].copy_from_slice(&(88u32).to_be_bytes());
    token[4] = 64;
    token[5..69].copy_from_slice(&proof);
    token[69] = 16;
    assert!(valid_final_token(&token, &proof));
    token[5] ^= 1;
    assert!(!valid_final_token(&token, &proof));
    token[5] ^= 1;
    token[88] = 1;
    assert!(!valid_final_token(&token, &proof));
    assert!(!valid_final_token(&token[..91], &proof));
}
