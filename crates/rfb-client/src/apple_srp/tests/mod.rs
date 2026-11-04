use super::{derive_password, expected_proof, parse_challenge, valid_final_token};
use crate::{AuthenticationStage, Error};
use tokio::time::Instant;

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
