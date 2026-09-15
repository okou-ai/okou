//! Explicit shell-tool launcher and runtime hook adapter for Okou guests.

use std::env;
use std::ffi::{OsStr, OsString};
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::path::{Component, Path};
use std::process::{Command, ExitCode};
use std::time::Duration;

use guest_contracts::managed_command::{
    COMMAND_ENVELOPE_ARGUMENT_PREFIX, decode_command_envelope, render_managed_shell_command,
};
use guest_contracts::process_containment::{
    CANONICAL_TOOL_CGROUP_PROCS_ENV, EXEC_CGROUP_NAME_PREFIX, RUNTIME_CGROUP_NAME,
    WORKLOAD_CGROUP_NAME,
};
use serde::Deserialize;
use serde_json::{Map, Value, json};

const BASH_PATH: &str = "/bin/bash";
const HOOK_MODE: &str = "hook";
const SHELL_OPTION: &str = "--shell";
const PROC_SELF_CGROUP: &str = "/proc/self/cgroup";
const PLACEMENT_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Deserialize)]
struct PreToolUseInput {
    hook_event_name: String,
    tool_name: String,
    tool_input: Map<String, Value>,
}

/// Rewrite managed runtime shell tools or execute one in its assigned cgroup.
pub fn run() -> ExitCode {
    if env::args_os().nth(1).as_deref() == Some(OsStr::new(HOOK_MODE)) {
        return run_pre_tool_use_hook();
    }

    if let Err(error) = place_managed_tool() {
        eprintln!("guest tool exec: placement failed: {error}");
        return ExitCode::from(125);
    }

    if let Err(error) = set_tool_oom_priority() {
        eprintln!("guest tool exec: OOM priority setup failed: {error}");
        return ExitCode::from(125);
    }

    let error = exec_shell();
    eprintln!("guest tool exec: failed to exec shell: {error}");
    ExitCode::from(126)
}

fn set_tool_oom_priority() -> io::Result<()> {
    // Change only the placed launcher, before exec or user-created descendants.
    // Ordinary children inherit this preference; the runtime and hook do not.
    // This prioritizes eligible tools, without making the runtime OOM-immune.
    std::fs::write("/proc/self/oom_score_adj", "1000")
}

fn run_pre_tool_use_hook() -> ExitCode {
    match rewrite_pre_tool_use_hook(&mut io::stdin().lock(), &mut io::stdout().lock()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("guest tool exec: hook rewrite failed: {error}");
            if write_hook_denial(&mut io::stdout().lock(), &error.to_string()).is_ok() {
                ExitCode::SUCCESS
            } else {
                ExitCode::from(125)
            }
        }
    }
}

fn rewrite_pre_tool_use_hook(input: &mut impl Read, output: &mut impl Write) -> io::Result<()> {
    let mut payload = String::new();
    input.read_to_string(&mut payload)?;
    let mut input: PreToolUseInput = serde_json::from_str(&payload).map_err(io::Error::other)?;
    if input.hook_event_name != "PreToolUse" || input.tool_name != "Bash" {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected a PreToolUse Bash hook payload",
        ));
    }
    let command = input
        .tool_input
        .get("command")
        .and_then(Value::as_str)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Bash command is missing"))?;
    if command.contains('\0') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Bash command contains a null byte",
        ));
    }
    let wrapped = render_managed_shell_command(command)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
    input
        .tool_input
        .insert("command".to_string(), Value::String(wrapped));
    write_hook_output(output, Value::Object(input.tool_input))
}

fn write_hook_output(output: &mut impl Write, updated_input: Value) -> io::Result<()> {
    serde_json::to_writer(
        &mut *output,
        &json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
                "updatedInput": updated_input,
            }
        }),
    )?;
    output.write_all(b"\n")
}

fn write_hook_denial(output: &mut impl Write, reason: &str) -> io::Result<()> {
    serde_json::to_writer(
        &mut *output,
        &json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": format!("Okou could not isolate this shell tool: {reason}"),
            }
        }),
    )?;
    output.write_all(b"\n")
}

fn place_managed_tool() -> io::Result<()> {
    if !current_process_is_runtime()? {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "tool executor was not launched from the managed runtime cgroup",
        ));
    }
    let endpoint = tool_placement_endpoint_from_process_env()?;
    place_current_process(&endpoint)
}

/// Resolve the canonical endpoint written to managed CLI children by Guest
/// Agent. The endpoint value stays out of diagnostics on every invalid path.
fn tool_placement_endpoint_from_process_env() -> io::Result<String> {
    resolve_tool_placement_endpoint(env::var_os(CANONICAL_TOOL_CGROUP_PROCS_ENV))
}

fn resolve_tool_placement_endpoint(canonical: Option<OsString>) -> io::Result<String> {
    let endpoint = canonical
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::PermissionDenied,
                "managed runtime is missing the tool placement endpoint",
            )
        })?
        .into_string()
        .map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "tool placement endpoint is not valid UTF-8",
            )
        })?;
    if endpoint.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "tool placement endpoint is empty",
        ));
    }
    Ok(endpoint)
}

fn current_process_is_runtime() -> io::Result<bool> {
    let contents = std::fs::read_to_string(PROC_SELF_CGROUP)?;
    let Some(path) = contents.lines().find_map(|line| line.strip_prefix("0::")) else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "current unified cgroup path is missing",
        ));
    };
    Ok(is_canonical_runtime_path(Path::new(path)))
}

fn is_canonical_runtime_path(path: &Path) -> bool {
    let components = path.components().collect::<Vec<_>>();
    let [
        Component::RootDir,
        Component::Normal(base),
        Component::Normal(operation),
        Component::Normal(workload),
        Component::Normal(runtime),
    ] = components.as_slice()
    else {
        return false;
    };
    *base == "vm0-exec"
        && operation
            .as_encoded_bytes()
            .starts_with(EXEC_CGROUP_NAME_PREFIX.as_bytes())
        && *workload == WORKLOAD_CGROUP_NAME
        && *runtime == RUNTIME_CGROUP_NAME
}

fn place_current_process(endpoint: &str) -> io::Result<()> {
    let stream = process_control_ipc::connect_abstract_with_timeout(endpoint, PLACEMENT_TIMEOUT)?;
    stream.set_read_timeout(Some(PLACEMENT_TIMEOUT))?;
    stream.set_write_timeout(Some(PLACEMENT_TIMEOUT))?;
    let placement = process_control_ipc::receive_tool_placement(&stream)?;
    write_self_to_cgroup(&placement)?;
    drop(placement);
    process_control_ipc::write_tool_placement_confirmation(&stream)?;
    process_control_ipc::read_tool_placement_ack(&stream)
}

fn write_self_to_cgroup(placement: &OwnedFd) -> io::Result<()> {
    loop {
        // SAFETY: `placement` is open for writing and the one-byte buffer is
        // valid for the duration of the call.
        let written = unsafe { libc::write(placement.as_raw_fd(), b"0".as_ptr().cast(), 1) };
        if written == 1 {
            return Ok(());
        }
        if written < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        return Err(io::Error::from_raw_os_error(libc::EIO));
    }
}

fn exec_shell() -> io::Error {
    let arguments = env::args_os().skip(1).collect::<Vec<_>>();
    let (shell, arguments) = match shell_invocation(arguments) {
        Ok(invocation) => invocation,
        Err(error) => return error,
    };
    let mut command = Command::new(shell);
    command.args(arguments);
    command.exec()
}

fn shell_invocation(mut arguments: Vec<OsString>) -> io::Result<(OsString, Vec<OsString>)> {
    let envelope = arguments
        .first()
        .and_then(|argument| argument.to_str())
        .and_then(|argument| argument.strip_prefix(COMMAND_ENVELOPE_ARGUMENT_PREFIX))
        .map(str::to_string);
    if envelope.is_some() {
        let _ = arguments.remove(0);
    }

    let explicit_shell = arguments
        .first()
        .is_some_and(|argument| argument == OsStr::new(SHELL_OPTION));
    let shell = if explicit_shell {
        let _ = arguments.remove(0);
        if arguments.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{SHELL_OPTION} requires a shell executable"),
            ));
        }
        arguments.remove(0)
    } else {
        OsString::from(BASH_PATH)
    };
    if shell.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "shell executable is empty",
        ));
    }

    if let Some(envelope) = envelope {
        if !explicit_shell || !arguments.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "managed command invocation is invalid",
            ));
        }
        let command = decode_command_envelope(&envelope)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
        arguments = vec![OsString::from("-c"), OsString::from(command)];
    }

    Ok((shell, arguments))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::ffi::OsStringExt;

    mod oom_priority;
    mod placement;

    #[test]
    fn recognizes_only_canonical_runtime_leaf() {
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
        let error =
            rewrite_pre_tool_use_hook(&mut payload.as_slice(), &mut Vec::new()).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(error.to_string(), "Bash command contains a null byte");
    }

    #[test]
    fn malformed_hook_payload_fails_closed() {
        let error = rewrite_pre_tool_use_hook(
            &mut br#"{"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{}}"#
                .as_slice(),
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
}
