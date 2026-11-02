use super::*;

#[test]
fn parse_config_plain_path() {
    let line = r#""/usr/bin/runner" start --config /data/runner.yaml"#;
    assert_eq!(
        parse_exec_start_config(line),
        Some(PathBuf::from("/data/runner.yaml"))
    );
}

#[test]
fn parse_config_quoted_path_with_spaces() {
    let line = r#""/opt/my runner/vm0-runner" start --config "/opt/my config/runner.yaml""#;
    assert_eq!(
        parse_exec_start_config(line),
        Some(PathBuf::from("/opt/my config/runner.yaml"))
    );
}

#[test]
fn parse_config_single_quoted_path_with_spaces() {
    let line = r#""/usr/bin/runner" start --config '/opt/my config/runner.yaml'"#;
    assert_eq!(
        parse_exec_start_config(line),
        Some(PathBuf::from("/opt/my config/runner.yaml"))
    );
}

#[test]
fn parse_config_quoted_path_with_escaped_characters() {
    let line = r#""/usr/bin/runner" start --config "/tmp/a\"b\\c%%d.yaml""#;
    assert_eq!(
        parse_exec_start_config(line),
        Some(PathBuf::from(r#"/tmp/a"b\c%d.yaml"#))
    );
}

#[test]
fn parse_config_quoted_path_without_spaces() {
    let line = r#""/usr/bin/runner" start --config "/etc/runner.yaml" --local"#;
    assert_eq!(
        parse_exec_start_config(line),
        Some(PathBuf::from("/etc/runner.yaml"))
    );
}

#[test]
fn parse_config_short_flag() {
    let line = r#""/usr/bin/runner" start -c "/data/runner.yaml""#;
    assert_eq!(
        parse_exec_start_config(line),
        Some(PathBuf::from("/data/runner.yaml"))
    );
}

#[test]
fn parse_config_missing_flag() {
    let line = r#""/usr/bin/runner" start --local"#;
    assert_eq!(parse_exec_start_config(line), None);
}

#[test]
fn parse_config_flag_at_end_without_value() {
    let line = r#""/usr/bin/runner" start --config"#;
    assert_eq!(parse_exec_start_config(line), None);
}

#[test]
fn parse_config_skips_flag_value_before_valid_config() {
    let line = r#""/usr/bin/runner" start --config --local --config "/data/runner.yaml""#;
    assert_eq!(
        parse_exec_start_config(line),
        Some(PathBuf::from("/data/runner.yaml"))
    );
}

#[test]
fn parse_config_equals_form() {
    let line = r#""/usr/bin/runner" start --config=/data/runner.yaml"#;
    assert_eq!(
        parse_exec_start_config(line),
        Some(PathBuf::from("/data/runner.yaml"))
    );
}

#[test]
fn parse_config_equals_form_quoted() {
    let line = r#""/usr/bin/runner" start --config="/data/my config/runner.yaml""#;
    assert_eq!(
        parse_exec_start_config(line),
        Some(PathBuf::from("/data/my config/runner.yaml"))
    );
}

#[test]
fn parse_config_equals_form_unescapes_percent() {
    let line = r#""/usr/bin/runner" start --config=/data/runner%%config.yaml"#;
    assert_eq!(
        parse_exec_start_config(line),
        Some(PathBuf::from("/data/runner%config.yaml"))
    );
}

#[test]
fn parse_config_ignores_flag_substring_in_exe_path() {
    let line = r#""/opt/nice-cli/runner" start -c "/data/runner.yaml""#;
    assert_eq!(
        parse_exec_start_config(line),
        Some(PathBuf::from("/data/runner.yaml"))
    );
}

#[test]
fn parse_config_ignores_flag_token_inside_quoted_exe_path() {
    let line = r#""/opt/my --config fake/runner" start --config "/data/runner.yaml""#;
    assert_eq!(
        parse_exec_start_config(line),
        Some(PathBuf::from("/data/runner.yaml"))
    );
}

#[test]
fn parse_config_unclosed_quote_returns_none() {
    let line = r#""/usr/bin/runner" start --config "/data/no-close"#;
    assert_eq!(parse_exec_start_config(line), None);
}

#[test]
fn parse_config_tab_separated() {
    let line = "\"/usr/bin/runner\" start --config\t/data/runner.yaml";
    assert_eq!(
        parse_exec_start_config(line),
        Some(PathBuf::from("/data/runner.yaml"))
    );
}

#[test]
fn parse_config_short_flag_equals_form() {
    let line = r#""/usr/bin/runner" start -c=/data/runner.yaml"#;
    assert_eq!(
        parse_exec_start_config(line),
        Some(PathBuf::from("/data/runner.yaml"))
    );
}

#[test]
fn parse_unit_config_path_reads_first_exec_start() {
    let content = r#"
[Unit]
Description=runner

[Service]
ExecStart="/usr/bin/runner" start --config "/etc/runner.yaml"
"#;

    assert_eq!(
        parse_unit_config_path(content),
        Some(PathBuf::from("/etc/runner.yaml"))
    );
}

#[test]
fn parse_unit_config_path_allows_space_before_equals() {
    let content = r#"
[Service]
ExecStart = "/usr/bin/runner" start --config "/etc/runner.yaml"
"#;

    assert_eq!(
        parse_unit_config_path(content),
        Some(PathBuf::from("/etc/runner.yaml"))
    );
}

#[test]
fn parse_unit_config_path_ignores_standalone_comments_ending_in_backslash() {
    for marker in ['#', ';'] {
        for indent in ["", " \t"] {
            let content = format!(
                r#"[Service]
{indent}{marker} runner config example \
ExecStart=/usr/bin/runner start --config /etc/runner.yaml
"#
            );

            assert_eq!(
                parse_unit_config_path(&content),
                Some(PathBuf::from("/etc/runner.yaml")),
                "comment marker {marker:?} with indent {indent:?}"
            );
        }
    }
}

#[test]
fn parse_unit_config_path_comment_does_not_hide_service_section() {
    for marker in ['#', ';'] {
        let content = format!(
            r#"[Unit]
Description=runner
  {marker} service settings \
[Service]
ExecStart=/usr/bin/runner start --config /etc/runner.yaml
"#
        );

        assert_eq!(
            parse_unit_config_path(&content),
            Some(PathBuf::from("/etc/runner.yaml")),
            "comment marker {marker:?}"
        );
    }
}

#[test]
fn parse_unit_config_path_comment_does_not_hide_leaving_service_section() {
    for marker in ['#', ';'] {
        let content = format!(
            r#"[Service]
ExecStart=/usr/bin/runner start --config /etc/runner.yaml
  {marker} install settings \
[Install]
ExecStart=/usr/bin/runner start --config /etc/wrong-runner.yaml
"#
        );

        assert_eq!(
            parse_unit_config_path(&content),
            Some(PathBuf::from("/etc/runner.yaml")),
            "comment marker {marker:?}"
        );
    }
}

#[test]
fn parse_unit_config_path_preserves_comment_markers_inside_arguments() {
    let content = r#"[Service]
ExecStart=/usr/bin/runner start --config "/etc/#runner;config.yaml"
"#;

    assert_eq!(
        parse_unit_config_path(content),
        Some(PathBuf::from("/etc/#runner;config.yaml"))
    );
}

#[test]
fn parse_unit_config_path_ignores_exec_start_outside_service_section() {
    let content = r#"
[Service]
ExecStart="/usr/bin/runner" start --config "/etc/runner.yaml"

[Unit]
ExecStart="/usr/bin/runner" start --config "/etc/wrong-runner.yaml"
"#;

    assert_eq!(
        parse_unit_config_path(content),
        Some(PathBuf::from("/etc/runner.yaml"))
    );
}

#[test]
fn parse_unit_config_path_handles_continued_exec_start() {
    let content = r#"
[Service]
ExecStart="/usr/bin/runner" start \
  --config "/etc/runner.yaml" \
  --local
"#;

    assert_eq!(
        parse_unit_config_path(content),
        Some(PathBuf::from("/etc/runner.yaml"))
    );
}

#[test]
fn parse_unit_config_path_continues_past_comment_lines() {
    let content = r#"
[Service]
ExecStart="/usr/bin/runner" start \
  # comment between continued lines \

  ; another comment \
  --config "/etc/runner.yaml"
"#;

    assert_eq!(
        parse_unit_config_path(content),
        Some(PathBuf::from("/etc/runner.yaml"))
    );
}

#[test]
fn parse_unit_config_path_honors_exec_start_reset() {
    let content = r#"
[Service]
ExecStart="/usr/bin/runner" start --config "/etc/old-runner.yaml"
ExecStart=
ExecStart="/usr/bin/runner" start --config "/etc/new-runner.yaml"
"#;

    assert_eq!(
        parse_unit_config_path(content),
        Some(PathBuf::from("/etc/new-runner.yaml"))
    );
}

#[test]
fn parse_unit_config_path_reset_without_replacement_returns_none() {
    let content = r#"
[Service]
ExecStart="/usr/bin/runner" start --config "/etc/old-runner.yaml"
ExecStart=
"#;

    assert_eq!(parse_unit_config_path(content), None);
}

#[test]
fn parse_unit_config_path_comments_preserve_drop_in_reset_and_replacement() {
    for marker in ['#', ';'] {
        for (replacement, expected) in [
            (
                "/usr/bin/runner start --config /etc/new-runner.yaml",
                Some("/etc/new-runner.yaml"),
            ),
            ("/usr/bin/true", None),
        ] {
            let content = format!(
                r#"# /etc/systemd/system/vm0-runner-test.service
[Service]
ExecStart=/usr/bin/runner start --config /etc/old-runner.yaml

# /run/systemd/system/vm0-runner-test.service.d/override.conf
[Service]
  {marker} reset original command \
ExecStart=
  {marker} replacement command \
ExecStart={replacement}
"#
            );

            assert_eq!(
                parse_unit_config_path(&content),
                expected.map(PathBuf::from),
                "comment marker {marker:?}, replacement {replacement:?}"
            );
        }
    }
}

#[test]
fn parse_unit_config_path_skips_unparseable_exec_start() {
    let content = r#"
[Service]
ExecStart=
ExecStart="/usr/bin/runner" start --config "/etc/runner.yaml"
"#;

    assert_eq!(
        parse_unit_config_path(content),
        Some(PathBuf::from("/etc/runner.yaml"))
    );
}

#[test]
fn parse_unit_config_path_applies_systemd_selected_content_in_order() {
    let content = r#"
# /etc/systemd/system/vm0-runner-v1.0.0.service
[Service]
ExecStart="/usr/bin/runner" start --config "/etc/base-runner.yaml"

# /usr/lib/systemd/system/vm0-runner-.service.d/10-vendor.conf
[Service]
ExecStart=
ExecStart="/usr/bin/runner" start --config "/etc/vendor-runner.yaml"

# /run/systemd/system/vm0-runner-v1.0.0.service.d/20-runtime.conf
[Service]
ExecStart=
ExecStart="/usr/bin/runner" start --config "/etc/runtime-runner.yaml"
"#;

    assert_eq!(
        parse_unit_config_path(content),
        Some(PathBuf::from("/etc/runtime-runner.yaml"))
    );
}
