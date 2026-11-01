use super::*;

#[test]
fn bounds_scram_credentials_without_classic_vnc_truncation() {
    let valid =
        QemuScramCredentials::new("owner@example.test".into(), "more-than-eight".into()).unwrap();
    assert_eq!(format!("{valid:?}"), "QemuScramCredentials([REDACTED])");
    assert!(matches!(
        QemuScramCredentials::new("a,b".into(), "password".into()),
        Err(Error::InvalidScramUsername)
    ));
    assert!(matches!(
        QemuScramCredentials::new("user".into(), "\0password".into()),
        Err(Error::InvalidScramPassword)
    ));
    assert!(matches!(
        QemuScramCredentials::new("user".into(), "x".repeat(1024)),
        Err(Error::InvalidScramPassword)
    ));
}
