use super::*;
use std::os::unix::ffi::OsStringExt;

mod oom_priority;
mod placement;

#[test]
fn recognizes_only_canonical_runtime_leaf() {
    let task = "/vm0-exec/exec-12-34/workload/tools/task-00000000-0000-0000-0000-000000000001";
    assert!(is_canonical_runtime_path(Path::new(&format!(
        "{task}/runtime"
    ))));
    assert!(is_canonical_runtime_path(Path::new(&format!(
        "{task}/tools/task-00000000-0000-0000-0000-000000000002/runtime"
    ))));
    for suffix in [
        "/tools",
        "/tools/tool-1",
        "/runtime/nested",
        "/tools/tool-1/../runtime",
    ] {
        assert!(!is_canonical_runtime_path(Path::new(&format!(
            "{task}{suffix}"
        ))));
    }
    assert!(is_canonical_runtime_path(Path::new(
        "/vm0-exec/exec-12-34/workload/runtime"
    )));
    assert!(!is_canonical_runtime_path(Path::new(
        "/vm0-exec/exec-12-34/workload/tools/tool-1"
    )));
    assert!(!is_canonical_runtime_path(Path::new(
        "/vm0-exec/not-an-operation/workload/runtime"
    )));
    assert!(!is_canonical_runtime_path(Path::new("/workload/runtime")));
}

#[test]
fn self_placement_writes_kernel_self_selector() {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = tempfile::tempfile().unwrap();
    let placement: OwnedFd = file.try_clone().unwrap().into();
    write_self_to_cgroup(&placement).unwrap();
    file.seek(SeekFrom::Start(0)).unwrap();
    let mut contents = String::new();
    file.read_to_string(&mut contents).unwrap();
    assert_eq!(contents, "0");
}

#[test]
fn resolves_canonical_tool_placement_endpoint() {
    let endpoint =
        resolve_tool_placement_endpoint(Some(OsString::from("canonical-endpoint"))).unwrap();

    assert_eq!(endpoint, "canonical-endpoint");
}

#[test]
fn rejects_missing_empty_and_non_unicode_canonical_endpoint_without_values() {
    let missing = resolve_tool_placement_endpoint(None).unwrap_err();
    assert_eq!(missing.kind(), io::ErrorKind::PermissionDenied);
    assert_eq!(
        missing.to_string(),
        "managed runtime is missing the tool placement endpoint"
    );

    let empty = resolve_tool_placement_endpoint(Some(OsString::new())).unwrap_err();
    assert_eq!(empty.kind(), io::ErrorKind::InvalidInput);
    assert_eq!(empty.to_string(), "tool placement endpoint is empty");

    let non_unicode = resolve_tool_placement_endpoint(Some(OsString::from_vec(
        b"canonical-must-not-leak\xff".to_vec(),
    )))
    .unwrap_err();
    assert_eq!(non_unicode.kind(), io::ErrorKind::InvalidInput);
    assert_eq!(
        non_unicode.to_string(),
        "tool placement endpoint is not valid UTF-8"
    );
    assert!(!non_unicode.to_string().contains("must-not-leak"));
}

#[test]
fn hook_wraps_commands_losslessly_and_preserves_other_bash_fields() {
    let commands = [
        "printf '%s\\n' \"$HOME\"",
        "printf '$LITERAL' `date`; echo one | sed 's/one/two/'",
        "  leading and trailing  ",
        "printf first\nprintf second",
        "printf '你好，世界 🌍'",
        &"x".repeat(1024 * 1024),
    ];
    for command in commands {
        let payload = json!({
            "hook_event_name": "PreToolUse",
            "tool_name": "Bash",
            "tool_input": {
                "command": command,
                "description": "run command",
                "timeout": 120000,
                "run_in_background": false
            }
        });
        let mut output = Vec::new();
        rewrite_pre_tool_use_hook(
            &mut serde_json::to_vec(&payload).unwrap().as_slice(),
            &mut output,
        )
        .unwrap();

        let output: Value = serde_json::from_slice(&output).unwrap();
        let updated = &output["hookSpecificOutput"]["updatedInput"];
        let wrapped = updated["command"].as_str().unwrap();
        assert_eq!(
            guest_contracts::managed_command::decode_managed_shell_command(wrapped).unwrap(),
            Some(command.to_string())
        );
        assert_eq!(updated["description"], "run command");
        assert_eq!(updated["timeout"], 120000);
        assert_eq!(updated["run_in_background"], false);
        assert_eq!(output["hookSpecificOutput"]["permissionDecision"], "allow");
    }
}

#[test]
fn managed_invocation_restores_shell_argv_without_changing_legacy_execution() {
    let command = "  printf '%s\\n' \"$HOME\"; echo `date` | cat\n你好  ";
    let envelope = guest_contracts::managed_command::encode_command_envelope(command).unwrap();
    let (shell, arguments) = shell_invocation(vec![
        OsString::from(format!("{COMMAND_ENVELOPE_ARGUMENT_PREFIX}{envelope}")),
        OsString::from(SHELL_OPTION),
        OsString::from("/bin/custom-bash"),
    ])
    .unwrap();
    assert_eq!(shell, "/bin/custom-bash");
    assert_eq!(arguments, [OsString::from("-c"), OsString::from(command)]);

    let legacy_arguments = vec![
        OsString::from(SHELL_OPTION),
        OsString::from("/bin/custom-bash"),
        OsString::from("-c"),
        OsString::from("printf legacy"),
    ];
    let (shell, arguments) = shell_invocation(legacy_arguments.clone()).unwrap();
    assert_eq!(shell, "/bin/custom-bash");
    assert_eq!(arguments, legacy_arguments[2..]);
}

#[test]
fn malformed_managed_invocations_fail_before_shell_execution() {
    for arguments in [
        vec![OsString::from(format!(
            "{COMMAND_ENVELOPE_ARGUMENT_PREFIX}vm0.command.v2.4.c2FmZQ"
        ))],
        vec![
            OsString::from(format!(
                "{COMMAND_ENVELOPE_ARGUMENT_PREFIX}vm0.command.v1.4.c2Fm"
            )),
            OsString::from(SHELL_OPTION),
            OsString::from(BASH_PATH),
        ],
        vec![
            OsString::from(format!(
                "{COMMAND_ENVELOPE_ARGUMENT_PREFIX}vm0.command.v1.4.c2FmZQ"
            )),
            OsString::from(SHELL_OPTION),
            OsString::from(BASH_PATH),
            OsString::from("unexpected"),
        ],
    ] {
        assert_eq!(
            shell_invocation(arguments).unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
    }
}

#[test]
fn hook_rejects_nul_with_existing_denial_behavior() {
    let payload = br#"{
            "hook_event_name":"PreToolUse",
            "tool_name":"Bash",
            "tool_input":{"command":"before\u0000after"}
        }"#;
    let error = rewrite_pre_tool_use_hook(&mut payload.as_slice(), &mut Vec::new()).unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    assert_eq!(error.to_string(), "Bash command contains a null byte");
}

#[test]
fn malformed_hook_payload_fails_closed() {
    let error = rewrite_pre_tool_use_hook(
        &mut br#"{"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{}}"#.as_slice(),
        &mut Vec::new(),
    )
    .unwrap_err();
    let mut output = Vec::new();
    write_hook_denial(&mut output, &error.to_string()).unwrap();
    let output: Value = serde_json::from_slice(&output).unwrap();

    assert_eq!(output["hookSpecificOutput"]["permissionDecision"], "deny");
    assert!(
        output["hookSpecificOutput"]["permissionDecisionReason"]
            .as_str()
            .unwrap()
            .contains("expected a PreToolUse Bash hook payload")
    );
}
