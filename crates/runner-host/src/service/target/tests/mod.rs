use super::*;

fn unit_name(suffix: &str) -> HostResult<String> {
    RunnerServiceUnit::from_suffix(suffix).map(|unit| unit.unit_name().to_string())
}

#[test]
fn test_unit_name() {
    assert_eq!(unit_name("v0.2.0").unwrap(), "vm0-runner-v0.2.0");
    assert_eq!(unit_name("staging").unwrap(), "vm0-runner-staging");
    assert_eq!(
        unit_name("pr-1234-test").unwrap(),
        "vm0-runner-pr-1234-test"
    );
}

#[test]
fn test_unit_name_accepts_max_length_suffix() {
    let suffix = "a".repeat(crate::runner_dirname::MAX_NAME_BYTES);
    assert_eq!(unit_name(&suffix).unwrap(), format!("vm0-runner-{suffix}"));
}

#[test]
fn test_unit_name_rejects_invalid() {
    assert!(unit_name("").is_err());
    assert!(unit_name("../evil").is_err());
    assert!(unit_name("has space").is_err());
    assert!(unit_name("semi;colon").is_err());
    // Now aligned with runner_dirname: reject uppercase, underscore, leading dot/hyphen
    assert!(unit_name("V0.2.0").is_err());
    assert!(unit_name("my_name-1.0").is_err());
    assert!(unit_name(".hidden").is_err());
    assert!(unit_name("-flag").is_err());
}

#[test]
fn test_unit_name_rejects_over_max_length_suffix() {
    let suffix = "a".repeat(crate::runner_dirname::MAX_NAME_BYTES + 1);
    let msg = unit_name(&suffix).unwrap_err().to_string();
    assert!(msg.contains("service name suffix"), "got: {msg}");
    assert!(
        msg.contains(&format!(
            "at most {} bytes",
            crate::runner_dirname::MAX_NAME_BYTES
        )),
        "got: {msg}"
    );
    assert!(
        msg.contains(&format!(
            "{} bytes",
            crate::runner_dirname::MAX_NAME_BYTES + 1
        )),
        "got: {msg}"
    );
    assert!(
        !msg.contains(&suffix),
        "overlong suffix should be previewed, not echoed in full: {msg}"
    );
}

/// Guard against someone replacing the call with `validate_or_err`
/// which would surface a "runner-dirname" message in a service context.
#[test]
fn test_unit_name_error_mentions_service() {
    let msg = unit_name("UPPER").unwrap_err().to_string();
    assert!(msg.contains("service name suffix"), "got: {msg}");
}

#[test]
fn from_file_name_accepts_only_valid_runner_services() {
    assert_eq!(
        RunnerServiceUnit::from_file_name("vm0-runner-v1.0.0.service")
            .unwrap()
            .service_name(),
        "vm0-runner-v1.0.0.service"
    );
    assert!(RunnerServiceUnit::from_file_name("other-v1.0.0.service").is_none());
    assert!(RunnerServiceUnit::from_file_name("vm0-runner-v1.0.0.timer").is_none());
    assert!(RunnerServiceUnit::from_file_name("vm0-runner-.service").is_none());
    assert!(RunnerServiceUnit::from_file_name("vm0-runner-UPPER.service").is_none());
}

#[test]
fn lock_file_name_round_trips_current_runner_service() {
    let unit = RunnerServiceUnit::from_suffix("v1.0.0").unwrap();
    let home = HomePaths::with_root(PathBuf::from("/test"));

    assert_eq!(unit.lock_file_name(), "service-vm0-runner-v1.0.0.lock");
    assert_eq!(
        unit.lock_path(&home),
        PathBuf::from("/test/locks/service-vm0-runner-v1.0.0.lock")
    );
    assert_eq!(
        RunnerServiceUnit::from_lock_file_name(unit.lock_file_name()),
        Some(unit)
    );
    assert!(RunnerServiceUnit::from_lock_file_name("service-vm0-runner-staging").is_none());
    assert!(RunnerServiceUnit::from_lock_file_name("home-image-cache-v1.0.0.lock").is_none());
    assert!(RunnerServiceUnit::from_lock_file_name("service-vm0-runner-UPPER.lock").is_none());
}
