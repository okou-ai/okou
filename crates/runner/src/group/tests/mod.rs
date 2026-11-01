use super::*;

#[test]
fn validate_or_err_passes_for_valid_name() {
    assert!(validate_or_err("vm0/prod").is_ok());
}

#[test]
fn validate_or_err_carries_offending_name_in_message() {
    let err = validate_or_err("/etc").unwrap_err();
    assert_eq!(
        err.to_string(),
        "config error: invalid group name: /etc (must be org/name format, lowercase alphanumeric + hyphens)"
    );
}
