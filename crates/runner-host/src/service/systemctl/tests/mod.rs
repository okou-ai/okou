use super::*;
fn systemctl_show_output(status: ExitStatus, stdout: &[u8], stderr: &[u8]) -> Output {
    Output {
        status,
        stdout: stdout.to_vec(),
        stderr: stderr.to_vec(),
    }
}

#[test]
fn journalctl_logs_status_allows_successful_exit() {
    use std::os::unix::process::ExitStatusExt;

    let status = ExitStatus::from_raw(0);

    assert!(journalctl_logs_status("vm0-runner-test.service", status).is_ok());
}

#[test]
fn journalctl_logs_status_rejects_failed_exit() {
    use std::os::unix::process::ExitStatusExt;

    let status = ExitStatus::from_raw(0x100);
    let err = journalctl_logs_status("vm0-runner-test.service", status).unwrap_err();

    assert!(
        matches!(err, HostError::Internal(message) if message.contains("journalctl for vm0-runner-test.service exited with"))
    );
}

#[test]
fn journalctl_logs_status_allows_sigpipe() {
    use std::os::unix::process::ExitStatusExt;

    let status = ExitStatus::from_raw(libc::SIGPIPE);

    assert!(journalctl_logs_status("vm0-runner-test.service", status).is_ok());
}

#[test]
fn systemctl_cat_returns_successful_content() {
    use std::os::unix::process::ExitStatusExt;

    let output = systemctl_show_output(
        ExitStatus::from_raw(0),
        b"[Service]\nExecStart=/usr/bin/runner\n",
        b"",
    );

    assert_eq!(
        unit_content_from_systemctl_cat("vm0-runner-test.service", &output).unwrap(),
        "[Service]\nExecStart=/usr/bin/runner\n"
    );
}

#[test]
fn systemctl_cat_rejects_successful_stderr_with_bounded_diagnostic() {
    use std::os::unix::process::ExitStatusExt;

    let stderr = "reload required ".repeat(20);
    let output = systemctl_show_output(ExitStatus::from_raw(0), b"[Service]\n", stderr.as_bytes());
    let message = unit_content_from_systemctl_cat("vm0-runner-test.service", &output).unwrap_err();
    let message = message.to_string();

    assert!(message.contains("emitted stderr"));
    assert!(message.contains("[truncated]"));
    assert!(message.len() < stderr.len());
}

/// systemd emits this block on stderr while `systemctl cat` still exits 0.
/// Reproduced from the `deploy-runner-start` failure in Turbo run
/// 33409335059, where the runner had already reported ready.
const DAEMON_RELOAD_ADVISORY: &str = concat!(
    "# Warning: vm0-runner-test.service changed on disk, the version systemd has loaded is outdated.\n",
    "# This output shows the current version of the unit's original fragment and drop-in files.\n",
    "# If fragments or drop-ins were added or removed, they are not properly reflected in this output.\n",
    "# Run 'systemctl daemon-reload' to reload units.",
);

#[test]
fn systemctl_cat_accepts_daemon_reload_advisory_stderr() {
    use std::os::unix::process::ExitStatusExt;

    let output = systemctl_show_output(
        ExitStatus::from_raw(0),
        b"[Service]\nExecStart=/usr/bin/runner start --config /data/runner.yaml\n",
        DAEMON_RELOAD_ADVISORY.as_bytes(),
    );

    assert_eq!(
        unit_content_from_systemctl_cat("vm0-runner-test.service", &output).unwrap(),
        "[Service]\nExecStart=/usr/bin/runner start --config /data/runner.yaml\n"
    );
}

#[test]
fn systemctl_cat_accepts_colorized_daemon_reload_advisory_stderr() {
    use std::os::unix::process::ExitStatusExt;

    let colorized = DAEMON_RELOAD_ADVISORY
        .lines()
        .map(|line| format!("\u{1b}[0;1;31m{line}"))
        .collect::<Vec<_>>()
        .join("\n");
    let output = systemctl_show_output(
        ExitStatus::from_raw(0),
        b"[Service]\n",
        format!("{colorized}\u{1b}[0m").as_bytes(),
    );

    assert_eq!(
        unit_content_from_systemctl_cat("vm0-runner-test.service", &output).unwrap(),
        "[Service]\n"
    );
}

#[test]
fn systemctl_cat_rejects_failed_exit_with_advisory_only_stderr() {
    use std::os::unix::process::ExitStatusExt;

    let output = systemctl_show_output(
        ExitStatus::from_raw(0x100),
        b"",
        DAEMON_RELOAD_ADVISORY.as_bytes(),
    );

    assert!(unit_content_from_systemctl_cat("vm0-runner-test.service", &output).is_err());
}

#[test]
fn systemctl_cat_rejects_real_diagnostic_alongside_advisory_stderr() {
    use std::os::unix::process::ExitStatusExt;

    let stderr = format!("{DAEMON_RELOAD_ADVISORY}\nFailed to get unit file path: No such file");
    let output = systemctl_show_output(ExitStatus::from_raw(0), b"[Service]\n", stderr.as_bytes());
    let message = unit_content_from_systemctl_cat("vm0-runner-test.service", &output)
        .unwrap_err()
        .to_string();

    assert!(message.contains("emitted stderr"));
    assert!(message.contains("Failed to get unit file path"));
    assert!(!message.contains("# Warning:"));
}

#[test]
fn systemctl_cat_failure_does_not_expose_stdout() {
    use std::os::unix::process::ExitStatusExt;

    let output = systemctl_show_output(
        ExitStatus::from_raw(0x100),
        b"ExecStart=/usr/bin/runner --token should-not-appear",
        b"failed to read selected unit",
    );
    let message = unit_content_from_systemctl_cat("vm0-runner-test.service", &output).unwrap_err();
    let message = message.to_string();

    assert!(message.contains("failed to read selected unit"));
    assert!(!message.contains("should-not-appear"));
}

#[test]
fn systemctl_cat_rejects_non_utf8_stdout_without_exposing_content() {
    use std::os::unix::process::ExitStatusExt;

    let output = systemctl_show_output(ExitStatus::from_raw(0), b"secret\xffcontent", b"");
    let message = unit_content_from_systemctl_cat("vm0-runner-test.service", &output).unwrap_err();
    let message = message.to_string();

    assert!(message.contains("non-UTF-8 output"));
    assert!(!message.contains("secret"));
}

#[test]
fn parse_systemctl_show_properties_extracts_values() {
    let values =
        parse_systemctl_show_properties("vm0-runner-test.service", &["MainPID"], b"MainPID=123\n")
            .unwrap();

    assert_eq!(
        required_systemctl_property("vm0-runner-test.service", &values, "MainPID").unwrap(),
        "123"
    );
}

#[test]
fn parse_systemctl_show_properties_rejects_missing_property() {
    let err =
        parse_systemctl_show_properties("vm0-runner-test.service", &["MainPID"], b"").unwrap_err();
    let message = err.to_string();

    assert!(message.contains("missing systemctl show property"));
}

#[test]
fn parse_systemctl_show_properties_rejects_unexpected_property() {
    let err = parse_systemctl_show_properties(
        "vm0-runner-test.service",
        &["MainPID"],
        b"ActiveState=active\n",
    )
    .unwrap_err();
    let message = err.to_string();

    assert!(message.contains("unexpected systemctl show property"));
}

#[test]
fn parse_systemctl_show_properties_rejects_duplicate_property() {
    let err = parse_systemctl_show_properties(
        "vm0-runner-test.service",
        &["MainPID"],
        b"MainPID=123\nMainPID=456\n",
    )
    .unwrap_err();
    let message = err.to_string();

    assert!(message.contains("duplicate systemctl show property"));
}

#[test]
fn parse_systemctl_show_properties_rejects_malformed_line() {
    let err =
        parse_systemctl_show_properties("vm0-runner-test.service", &["MainPID"], b"MainPID 123\n")
            .unwrap_err();
    let message = err.to_string();

    assert!(message.contains("malformed systemctl show output"));
}

#[test]
fn parse_systemctl_show_output_preserves_parse_error_on_success_status() {
    use std::os::unix::process::ExitStatusExt;

    let output = systemctl_show_output(ExitStatus::from_raw(0), b"MainPID 123\n", b"");
    let err =
        parse_systemctl_show_output("vm0-runner-test.service", &["MainPID"], &output).unwrap_err();
    let message = err.to_string();

    assert!(message.contains("malformed systemctl show output"));
}

#[test]
fn parse_systemctl_show_output_prefers_status_error_on_failed_status() {
    use std::os::unix::process::ExitStatusExt;

    let output = systemctl_show_output(
        ExitStatus::from_raw(0x100),
        b"MainPID 123\n",
        b"Failed to connect to bus\n",
    );
    let err =
        parse_systemctl_show_output("vm0-runner-test.service", &["MainPID"], &output).unwrap_err();
    let message = err.to_string();

    assert!(message.contains("systemctl show vm0-runner-test.service --property=MainPID"));
    assert!(message.contains("Failed to connect to bus"));
    assert!(!message.contains("malformed systemctl show output"));
}

#[test]
fn required_systemctl_property_rejects_empty_value() {
    let values =
        parse_systemctl_show_properties("vm0-runner-test.service", &["MainPID"], b"MainPID=\n")
            .unwrap();
    let err =
        required_systemctl_property("vm0-runner-test.service", &values, "MainPID").unwrap_err();
    let message = err.to_string();

    assert!(message.contains("empty systemctl show property"));
}

#[test]
fn systemd_reload_state_parses_loaded_dirty_unit() {
    use std::os::unix::process::ExitStatusExt;

    let properties = ["LoadState", "NeedDaemonReload", "DropInPaths"];
    let output = systemctl_show_output(
        ExitStatus::from_raw(0),
        b"LoadState=loaded\nNeedDaemonReload=yes\nDropInPaths=/run/systemd/system/vm0-runner-test.service.d/50-vm0-drain.conf\n",
        b"",
    );

    let state =
        systemd_reload_state_from_output("vm0-runner-test.service", &properties, &output).unwrap();

    assert!(!state.is_not_found());
    assert!(state.need_daemon_reload());
    assert!(state.has_drop_in_path(std::path::Path::new(
        "/run/systemd/system/vm0-runner-test.service.d/50-vm0-drain.conf"
    )));
}

#[test]
fn systemd_reload_state_accepts_not_found_with_failed_status() {
    use std::os::unix::process::ExitStatusExt;

    let properties = ["LoadState", "NeedDaemonReload", "DropInPaths"];
    let output = systemctl_show_output(
        ExitStatus::from_raw(0x100),
        b"LoadState=not-found\nNeedDaemonReload=no\nDropInPaths=\n",
        b"Unit not found\n",
    );

    let state =
        systemd_reload_state_from_output("vm0-runner-test.service", &properties, &output).unwrap();

    assert!(state.is_not_found());
    assert!(!state.need_daemon_reload());
}

#[test]
fn systemd_reload_state_rejects_unknown_boolean() {
    use std::os::unix::process::ExitStatusExt;

    let properties = ["LoadState", "NeedDaemonReload", "DropInPaths"];
    let output = systemctl_show_output(
        ExitStatus::from_raw(0),
        b"LoadState=loaded\nNeedDaemonReload=maybe\nDropInPaths=\n",
        b"",
    );

    let error = systemd_reload_state_from_output("vm0-runner-test.service", &properties, &output)
        .unwrap_err();

    assert!(error.to_string().contains("unknown NeedDaemonReload"));
}

#[test]
fn systemd_reload_state_rejects_unknown_load_state() {
    use std::os::unix::process::ExitStatusExt;

    let properties = ["LoadState", "NeedDaemonReload", "DropInPaths"];
    let output = systemctl_show_output(
        ExitStatus::from_raw(0),
        b"LoadState=half-loaded\nNeedDaemonReload=yes\nDropInPaths=\n",
        b"",
    );

    let error = systemd_reload_state_from_output("vm0-runner-test.service", &properties, &output)
        .unwrap_err();

    assert!(error.to_string().contains("unknown LoadState"));
}

#[test]
fn systemctl_show_status_error_includes_stderr() {
    use std::os::unix::process::ExitStatusExt;

    let status = ExitStatus::from_raw(0x100);
    let err = systemctl_show_status_error(
        "vm0-runner-test.service",
        &["MainPID"],
        &status,
        b"Failed to connect to bus: Host is down\n",
    );
    let message = err.to_string();

    assert!(message.contains("systemctl show vm0-runner-test.service --property=MainPID"));
    assert!(message.contains("Failed to connect to bus"));
}

#[test]
fn classify_unit_active_accepts_active_states() {
    for active_state in ["active", "activating", "reloading", "refreshing"] {
        assert!(classify_unit_active("vm0-runner-test.service", "loaded", active_state).unwrap());
    }
}

#[test]
fn classify_unit_active_accepts_inactive_states() {
    for active_state in ["inactive", "failed", "deactivating", "maintenance"] {
        assert!(!classify_unit_active("vm0-runner-test.service", "loaded", active_state).unwrap());
    }
}

#[test]
fn classify_unit_active_treats_not_found_inactive_as_inactive() {
    assert!(!classify_unit_active("vm0-runner-test.service", "not-found", "inactive").unwrap());
}

#[test]
fn classify_unit_active_rejects_unknown_active_state() {
    let err = classify_unit_active("vm0-runner-test.service", "loaded", "half-active").unwrap_err();
    let message = err.to_string();

    assert!(message.contains("unknown ActiveState"));
}

#[test]
fn normalize_unit_state_keeps_lifecycle_active_like_states() {
    for active_state in [
        "active",
        "activating",
        "reloading",
        "refreshing",
        "deactivating",
    ] {
        assert_eq!(
            normalize_unit_state("vm0-runner-test.service", "loaded", active_state).unwrap(),
            NormalizedUnitState::ActiveLike,
            "{active_state} should normalize to active-like"
        );
    }
}

#[test]
fn normalize_unit_state_preserves_loaded_inactive_states() {
    for (active_state, normalized_state) in [
        ("inactive", NormalizedUnitState::Inactive),
        ("failed", NormalizedUnitState::Failed),
        ("maintenance", NormalizedUnitState::Maintenance),
    ] {
        assert_eq!(
            normalize_unit_state("vm0-runner-test.service", "loaded", active_state).unwrap(),
            normalized_state,
            "{active_state} should preserve its loaded normalized state"
        );
    }
}

#[test]
fn cleanup_unit_active_state_allows_not_found_inactive_on_failed_status() {
    use std::os::unix::process::ExitStatusExt;

    let properties = ["LoadState", "ActiveState"];
    let values = parse_systemctl_show_properties(
        "vm0-runner-test.service",
        &properties,
        b"LoadState=not-found\nActiveState=inactive\n",
    )
    .unwrap();
    let status = ExitStatus::from_raw(0x100);
    let state = cleanup_unit_active_state_from_systemctl_show(
        "vm0-runner-test.service",
        &properties,
        &status,
        &values,
        b"Unit not found\n",
    )
    .unwrap();

    assert_eq!(state.active_state(), "inactive");
    assert!(!state.is_active_like());
}

#[test]
fn service_unit_state_keeps_deactivating_active_like_for_reporting() {
    use std::os::unix::process::ExitStatusExt;

    let properties = ["LoadState", "ActiveState", "SubState", "Result"];
    let values = parse_systemctl_show_properties(
        "vm0-runner-test.service",
        &properties,
        b"LoadState=loaded\nActiveState=deactivating\nSubState=stop-sigterm\nResult=success\n",
    )
    .unwrap();
    let status = ExitStatus::from_raw(0);
    let state = service_unit_state_from_systemctl_show(
        "vm0-runner-test.service",
        &properties,
        &status,
        &values,
        b"",
    )
    .unwrap();

    assert_eq!(state.active_state(), "deactivating");
    assert!(state.is_active_like());
    assert_eq!(state.normalized_state, NormalizedUnitState::ActiveLike);
}

#[test]
fn service_unit_state_accepts_all_active_like_states_for_reporting() {
    use std::os::unix::process::ExitStatusExt;

    let properties = ["LoadState", "ActiveState", "SubState", "Result"];
    let status = ExitStatus::from_raw(0);
    for active_state in [
        "active",
        "activating",
        "reloading",
        "refreshing",
        "deactivating",
    ] {
        let stdout = format!(
            "LoadState=loaded\nActiveState={active_state}\nSubState=running\nResult=success\n"
        );
        let values = parse_systemctl_show_properties(
            "vm0-runner-test.service",
            &properties,
            stdout.as_bytes(),
        )
        .unwrap();
        let state = service_unit_state_from_systemctl_show(
            "vm0-runner-test.service",
            &properties,
            &status,
            &values,
            b"",
        )
        .unwrap();

        assert_eq!(state.normalized_state, NormalizedUnitState::ActiveLike);
        assert!(
            state.is_active_like(),
            "{active_state} should be active-like"
        );
    }
}

#[test]
fn service_unit_state_accepts_inactive_like_states_for_reporting() {
    use std::os::unix::process::ExitStatusExt;

    let properties = ["LoadState", "ActiveState", "SubState", "Result"];
    let status = ExitStatus::from_raw(0);
    for (active_state, normalized_state) in [
        ("inactive", NormalizedUnitState::Inactive),
        ("failed", NormalizedUnitState::Failed),
        ("maintenance", NormalizedUnitState::Maintenance),
    ] {
        let stdout = format!(
            "LoadState=loaded\nActiveState={active_state}\nSubState=dead\nResult=success\n"
        );
        let values = parse_systemctl_show_properties(
            "vm0-runner-test.service",
            &properties,
            stdout.as_bytes(),
        )
        .unwrap();
        let state = service_unit_state_from_systemctl_show(
            "vm0-runner-test.service",
            &properties,
            &status,
            &values,
            b"",
        )
        .unwrap();

        assert_eq!(state.normalized_state, normalized_state);
        assert!(
            !state.is_active_like(),
            "{active_state} should not be active-like"
        );
    }
}

#[test]
fn service_unit_state_preserves_empty_optional_fields() {
    use std::os::unix::process::ExitStatusExt;

    let properties = ["LoadState", "ActiveState", "SubState", "Result"];
    let values = parse_systemctl_show_properties(
        "vm0-runner-test.service",
        &properties,
        b"LoadState=loaded\nActiveState=inactive\nSubState=\nResult=\n",
    )
    .unwrap();
    let status = ExitStatus::from_raw(0);
    let state = service_unit_state_from_systemctl_show(
        "vm0-runner-test.service",
        &properties,
        &status,
        &values,
        b"",
    )
    .unwrap();

    assert_eq!(state.sub_state, "");
    assert_eq!(state.result, "");
    assert!(!state.is_active_like());
    assert_eq!(state.normalized_state, NormalizedUnitState::Inactive);
}

#[test]
fn service_unit_state_allows_not_found_on_failed_status() {
    use std::os::unix::process::ExitStatusExt;

    let properties = ["LoadState", "ActiveState", "SubState", "Result"];
    let values = parse_systemctl_show_properties(
        "vm0-runner-test.service",
        &properties,
        b"LoadState=not-found\nActiveState=inactive\nSubState=dead\nResult=success\n",
    )
    .unwrap();
    let status = ExitStatus::from_raw(0x100);
    let state = service_unit_state_from_systemctl_show(
        "vm0-runner-test.service",
        &properties,
        &status,
        &values,
        b"Unit not found\n",
    )
    .unwrap();

    assert_eq!(state.normalized_state, NormalizedUnitState::NotFound);
    assert!(!state.is_active_like());
}

#[test]
fn service_unit_state_accepts_not_found_inactive_like_states() {
    use std::os::unix::process::ExitStatusExt;

    let properties = ["LoadState", "ActiveState", "SubState", "Result"];
    let status = ExitStatus::from_raw(0x100);
    for active_state in ["inactive", "failed", "maintenance"] {
        let stdout = format!(
            "LoadState=not-found\nActiveState={active_state}\nSubState=dead\nResult=success\n"
        );
        let values = parse_systemctl_show_properties(
            "vm0-runner-test.service",
            &properties,
            stdout.as_bytes(),
        )
        .unwrap();
        let state = service_unit_state_from_systemctl_show(
            "vm0-runner-test.service",
            &properties,
            &status,
            &values,
            b"Unit not found\n",
        )
        .unwrap();

        assert_eq!(state.normalized_state, NormalizedUnitState::NotFound);
        assert!(
            !state.is_active_like(),
            "{active_state} should not be active-like"
        );
    }
}

#[test]
fn service_unit_state_reports_not_found_active_like_state() {
    use std::os::unix::process::ExitStatusExt;

    let properties = ["LoadState", "ActiveState", "SubState", "Result"];
    let values = parse_systemctl_show_properties(
        "vm0-runner-test.service",
        &properties,
        b"LoadState=not-found\nActiveState=deactivating\nSubState=stop-sigterm\nResult=success\n",
    )
    .unwrap();
    let status = ExitStatus::from_raw(0x100);
    let state = service_unit_state_from_systemctl_show(
        "vm0-runner-test.service",
        &properties,
        &status,
        &values,
        b"Unit not found\n",
    )
    .unwrap();

    assert_eq!(state.load_state, "not-found");
    assert_eq!(state.normalized_state, NormalizedUnitState::ActiveLike);
    assert!(state.is_active_like());
}

#[test]
fn service_unit_state_rejects_unknown_active_state() {
    use std::os::unix::process::ExitStatusExt;

    let properties = ["LoadState", "ActiveState", "SubState", "Result"];
    let values = parse_systemctl_show_properties(
        "vm0-runner-test.service",
        &properties,
        b"LoadState=loaded\nActiveState=half-active\nSubState=unknown\nResult=success\n",
    )
    .unwrap();
    let status = ExitStatus::from_raw(0);
    let err = service_unit_state_from_systemctl_show(
        "vm0-runner-test.service",
        &properties,
        &status,
        &values,
        b"",
    )
    .unwrap_err();

    assert!(err.to_string().contains("unknown ActiveState"));
}

#[test]
fn service_unit_state_rejects_not_found_unknown_active_state() {
    use std::os::unix::process::ExitStatusExt;

    let properties = ["LoadState", "ActiveState", "SubState", "Result"];
    let values = parse_systemctl_show_properties(
        "vm0-runner-test.service",
        &properties,
        b"LoadState=not-found\nActiveState=half-active\nSubState=unknown\nResult=success\n",
    )
    .unwrap();
    let status = ExitStatus::from_raw(0x100);
    let err = service_unit_state_from_systemctl_show(
        "vm0-runner-test.service",
        &properties,
        &status,
        &values,
        b"Unit not found\n",
    )
    .unwrap_err();

    assert!(err.to_string().contains("unknown ActiveState"));
}

#[test]
fn unit_enabled_from_systemctl_is_enabled_accepts_enabled_states() {
    use std::os::unix::process::ExitStatusExt;

    let status = ExitStatus::from_raw(0);
    for state in ["enabled", "enabled-runtime"] {
        assert!(
            unit_enabled_from_systemctl_is_enabled(
                "vm0-runner-test.service",
                &status,
                format!("{state}\n").as_bytes(),
                b"",
            )
            .unwrap()
        );
    }
}

#[test]
fn unit_enablement_preserves_runtime_only_state() {
    use std::os::unix::process::ExitStatusExt;

    let status = ExitStatus::from_raw(0);
    let enablement = unit_enablement_from_systemctl_is_enabled(
        "vm0-runner-test.service",
        &status,
        b"enabled-runtime\n",
        b"",
    )
    .unwrap();

    assert_eq!(enablement, SystemdUnitEnablement::EnabledRuntime);
    assert_eq!(
        enablement.restore_actions(),
        [
            SystemdEnablementRestoreAction::Disable,
            SystemdEnablementRestoreAction::EnableRuntime,
        ]
    );
}

#[test]
fn unit_enabled_from_systemctl_is_enabled_rejects_disabled_states() {
    use std::os::unix::process::ExitStatusExt;

    let status = ExitStatus::from_raw(0x100);
    for state in [
        "alias",
        "disabled",
        "generated",
        "indirect",
        "linked",
        "linked-runtime",
        "masked",
        "masked-runtime",
        "not-found",
        "static",
        "transient",
    ] {
        assert!(
            !unit_enabled_from_systemctl_is_enabled(
                "vm0-runner-test.service",
                &status,
                format!("{state}\n").as_bytes(),
                b"",
            )
            .unwrap(),
            "{state} should not be treated as enabled"
        );
    }
}

#[test]
fn unit_enabled_from_systemctl_is_enabled_rejects_unknown_success_state() {
    use std::os::unix::process::ExitStatusExt;

    let status = ExitStatus::from_raw(0);
    let err = unit_enabled_from_systemctl_is_enabled(
        "vm0-runner-test.service",
        &status,
        b"half-enabled\n",
        b"",
    )
    .unwrap_err();
    let message = err.to_string();

    assert!(message.contains("unknown UnitFileState"));
}

#[test]
fn unit_enabled_from_systemctl_is_enabled_rejects_unknown_failed_state() {
    use std::os::unix::process::ExitStatusExt;

    let status = ExitStatus::from_raw(0x100);
    let err = unit_enabled_from_systemctl_is_enabled(
        "vm0-runner-test.service",
        &status,
        b"bad\n",
        b"unit file is invalid\n",
    )
    .unwrap_err();
    let message = err.to_string();

    assert!(message.contains("unknown UnitFileState"));
    assert!(message.contains("bad"));
    assert!(message.contains("unit file is invalid"));
}

#[test]
fn unit_active_from_systemctl_show_allows_not_found_inactive_on_failed_status() {
    use std::os::unix::process::ExitStatusExt;

    let properties = ["LoadState", "ActiveState"];
    let values = parse_systemctl_show_properties(
        "vm0-runner-test.service",
        &properties,
        b"LoadState=not-found\nActiveState=inactive\n",
    )
    .unwrap();
    let status = ExitStatus::from_raw(0x100);

    assert!(
        !unit_active_from_systemctl_show(
            "vm0-runner-test.service",
            &properties,
            &status,
            &values,
            b"Unit not found\n",
        )
        .unwrap()
    );
}

#[test]
fn unit_active_from_systemctl_show_rejects_nonzero_loaded_inactive() {
    use std::os::unix::process::ExitStatusExt;

    let properties = ["LoadState", "ActiveState"];
    let values = parse_systemctl_show_properties(
        "vm0-runner-test.service",
        &properties,
        b"LoadState=loaded\nActiveState=inactive\n",
    )
    .unwrap();
    let status = ExitStatus::from_raw(0x100);
    let err = unit_active_from_systemctl_show(
        "vm0-runner-test.service",
        &properties,
        &status,
        &values,
        b"Failed to connect to bus\n",
    )
    .unwrap_err();
    let message = err.to_string();

    assert!(message.contains("Failed to connect to bus"));
}

#[test]
fn ensure_systemctl_show_status_requires_explicit_failed_status_allowance() {
    use std::os::unix::process::ExitStatusExt;

    let status = ExitStatus::from_raw(0x100);

    assert!(
        ensure_systemctl_show_status(
            "vm0-runner-test.service",
            &["MainPID"],
            &status,
            b"Unit not found\n",
            true,
        )
        .is_ok()
    );

    let err = ensure_systemctl_show_status(
        "vm0-runner-test.service",
        &["MainPID"],
        &status,
        b"Failed to connect to bus\n",
        false,
    )
    .unwrap_err();
    let message = err.to_string();

    assert!(message.contains("systemctl show vm0-runner-test.service --property=MainPID"));
    assert!(message.contains("Failed to connect to bus"));
}

#[test]
fn service_main_process_present_from_systemctl_show_returns_true_on_success() {
    use std::os::unix::process::ExitStatusExt;

    let properties = ["LoadState", "MainPID"];
    let values = parse_systemctl_show_properties(
        "vm0-runner-test.service",
        &properties,
        b"LoadState=loaded\nMainPID=123\n",
    )
    .unwrap();
    let status = ExitStatus::from_raw(0);

    assert!(
        service_main_process_present_from_systemctl_show(
            "vm0-runner-test.service",
            &properties,
            &status,
            &values,
            b"",
        )
        .unwrap()
    );
}

#[test]
fn service_main_process_present_from_systemctl_show_allows_not_found_zero_on_failed_status() {
    use std::os::unix::process::ExitStatusExt;

    let properties = ["LoadState", "MainPID"];
    let values = parse_systemctl_show_properties(
        "vm0-runner-test.service",
        &properties,
        b"LoadState=not-found\nMainPID=0\n",
    )
    .unwrap();
    let status = ExitStatus::from_raw(0x100);

    assert!(
        !service_main_process_present_from_systemctl_show(
            "vm0-runner-test.service",
            &properties,
            &status,
            &values,
            b"Unit not found\n",
        )
        .unwrap()
    );
}

#[test]
fn service_restart_policy_from_systemctl_show_returns_restart_value() {
    use std::os::unix::process::ExitStatusExt;

    let properties = ["Restart"];
    let values =
        parse_systemctl_show_properties("vm0-runner-test.service", &properties, b"Restart=no\n")
            .unwrap();
    let status = ExitStatus::from_raw(0);

    assert_eq!(
        service_restart_policy_from_systemctl_show(
            "vm0-runner-test.service",
            &properties,
            &status,
            &values,
            b"",
        )
        .unwrap(),
        "no"
    );
}

#[test]
fn service_restart_policy_from_systemctl_show_exposes_non_no_policy() {
    use std::os::unix::process::ExitStatusExt;

    let properties = ["Restart"];
    let values = parse_systemctl_show_properties(
        "vm0-runner-test.service",
        &properties,
        b"Restart=on-failure\n",
    )
    .unwrap();
    let status = ExitStatus::from_raw(0);

    assert_eq!(
        service_restart_policy_from_systemctl_show(
            "vm0-runner-test.service",
            &properties,
            &status,
            &values,
            b"",
        )
        .unwrap(),
        "on-failure"
    );
}

#[test]
fn service_restart_policy_from_systemctl_show_rejects_failed_status() {
    use std::os::unix::process::ExitStatusExt;

    let properties = ["Restart"];
    let values =
        parse_systemctl_show_properties("vm0-runner-test.service", &properties, b"Restart=no\n")
            .unwrap();
    let status = ExitStatus::from_raw(0x100);
    let err = service_restart_policy_from_systemctl_show(
        "vm0-runner-test.service",
        &properties,
        &status,
        &values,
        b"Failed to connect to bus\n",
    )
    .unwrap_err();
    let message = err.to_string();

    assert!(message.contains("systemctl show vm0-runner-test.service --property=Restart"));
    assert!(message.contains("Failed to connect to bus"));
}

#[test]
fn service_main_process_present_from_systemctl_show_rejects_nonzero_loaded_zero() {
    use std::os::unix::process::ExitStatusExt;

    let properties = ["LoadState", "MainPID"];
    let values = parse_systemctl_show_properties(
        "vm0-runner-test.service",
        &properties,
        b"LoadState=loaded\nMainPID=0\n",
    )
    .unwrap();
    let status = ExitStatus::from_raw(0x100);
    let err = service_main_process_present_from_systemctl_show(
        "vm0-runner-test.service",
        &properties,
        &status,
        &values,
        b"Failed to connect to bus\n",
    )
    .unwrap_err();
    let message = err.to_string();

    assert!(message.contains("Failed to connect to bus"));
}

#[test]
fn service_main_process_present_from_systemctl_show_rejects_malformed_pid_on_failed_status() {
    use std::os::unix::process::ExitStatusExt;

    let properties = ["LoadState", "MainPID"];
    let values = parse_systemctl_show_properties(
        "vm0-runner-test.service",
        &properties,
        b"LoadState=not-found\nMainPID=abc\n",
    )
    .unwrap();
    let status = ExitStatus::from_raw(0x100);
    let err = service_main_process_present_from_systemctl_show(
        "vm0-runner-test.service",
        &properties,
        &status,
        &values,
        b"Unit not found\n",
    )
    .unwrap_err();
    let message = err.to_string();

    assert!(message.contains("Unit not found"));
}

#[test]
fn parse_main_pid_zero_returns_none() {
    assert_eq!(
        parse_main_pid("vm0-runner-test.service", "0").unwrap(),
        None
    );
}

#[test]
fn parse_main_pid_positive_returns_pid() {
    assert_eq!(
        parse_main_pid("vm0-runner-test.service", "123").unwrap(),
        Some(123)
    );
}

#[test]
fn parse_main_pid_rejects_malformed_values() {
    for value in ["abc", "", "-1", "4294967296"] {
        assert!(
            parse_main_pid("vm0-runner-test.service", value).is_err(),
            "value should fail: {value}"
        );
    }
}
