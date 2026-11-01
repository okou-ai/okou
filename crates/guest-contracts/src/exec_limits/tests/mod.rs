use super::*;

#[test]
fn arg_string_limit_is_inclusive_without_value_leak() {
    let secret = "x".repeat(EXECVE_STRING_MAX_BYTES + 1);
    let exact_limit = secret.strip_suffix('x').unwrap();

    validate_exec_boundary_sizes([ExecBoundaryValue::arg("prompt", exact_limit)]).unwrap();

    let error =
        validate_exec_boundary_sizes([ExecBoundaryValue::arg("prompt", &secret)]).unwrap_err();

    assert_eq!(
        error,
        ExecBoundarySizeError::StringTooLarge {
            kind: ExecBoundaryValueKind::Arg,
            name: "prompt".to_string(),
            bytes: EXECVE_STRING_MAX_BYTES + 1,
            max_bytes: EXECVE_STRING_MAX_BYTES,
        }
    );
    assert!(!error.to_string().contains(&secret));
}

#[test]
fn env_string_limit_is_inclusive_with_key_and_separator() {
    const KEY: &str = "BIG_ENV";
    let exact_value_bytes = EXECVE_STRING_MAX_BYTES - KEY.len() - "=".len();
    let value = "x".repeat(exact_value_bytes + 1);
    let exact_limit = value.strip_suffix('x').unwrap();

    validate_exec_boundary_sizes([ExecBoundaryValue::env(KEY, exact_limit)]).unwrap();

    let error = validate_exec_boundary_sizes([ExecBoundaryValue::env(KEY, &value)]).unwrap_err();

    assert_eq!(
        error,
        ExecBoundarySizeError::StringTooLarge {
            kind: ExecBoundaryValueKind::Env,
            name: KEY.to_string(),
            bytes: EXECVE_STRING_MAX_BYTES + 1,
            max_bytes: EXECVE_STRING_MAX_BYTES,
        }
    );
}

#[test]
fn rejects_aggregate_overflow() {
    let first = "x".repeat(EXECVE_STRING_MAX_BYTES);
    let second = "y".repeat(EXECVE_STRING_MAX_BYTES);
    let values = (0..20).map(|index| {
        if index % 2 == 0 {
            ExecBoundaryValue::arg("chunk", &first)
        } else {
            ExecBoundaryValue::arg("chunk", &second)
        }
    });

    let error = validate_exec_boundary_sizes(values).unwrap_err();

    assert!(matches!(
        error,
        ExecBoundarySizeError::AggregateTooLarge { .. }
    ));
}

#[test]
fn aggregate_limit_is_inclusive_and_counts_all_overhead() {
    let value_count = 2usize;
    let string_only_bytes = "/bin/bash".len() + 1 + "A=".len() + 1;
    let value_pointer_bytes = value_count * EXECVE_POINTER_OVERHEAD_BYTES;
    let pointer_table_terminator_bytes = 2 * EXECVE_POINTER_OVERHEAD_BYTES;
    let expected_bytes = string_only_bytes + value_pointer_bytes + pointer_table_terminator_bytes;
    let values = [
        ExecBoundaryValue::arg("argv[0]", "/bin/bash"),
        ExecBoundaryValue::env("A", ""),
    ];

    validate_exec_boundary_sizes_with_budget(values.clone(), expected_bytes).unwrap();

    let error = validate_exec_boundary_sizes_with_budget(values, expected_bytes - 1).unwrap_err();

    assert_eq!(
        error,
        ExecBoundarySizeError::AggregateTooLarge {
            bytes: expected_bytes,
            max_bytes: expected_bytes - 1,
        }
    );
}
