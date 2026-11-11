use std::error::Error;
use std::fs;
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Command, Output};

use sandbox_firecracker::PREWARM_SCRIPT;

const CLAUDE_COMMAND: &str = r#"#!/bin/sh
printf '%s\n' CLAUDE >> "$PREWARM_TRACE"
exit "$CLAUDE_EXIT"
"#;

const CODEX_COMMAND: &str = r#"#!/bin/sh
printf '%s\n' CODEX >> "$PREWARM_TRACE"
exit "$CODEX_EXIT"
"#;

const OKOU_COMMAND: &str = r#"#!/bin/sh
printf 'OKOU:%s\n' "$*" >> "$PREWARM_TRACE"
exit "$OKOU_EXIT"
"#;

const SU_COMMAND: &str = r#"#!/bin/sh
printf '%s\n' su >> "$PREWARM_TRACE"
exit 97
"#;

type TestResult<T> = Result<T, Box<dyn Error>>;

fn write_executable(path: &Path, contents: &str) -> io::Result<()> {
    fs::write(path, contents)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

fn run_prewarm(claude_exit: u8, codex_exit: u8, okou_exit: u8) -> TestResult<(Output, String)> {
    let temp = tempfile::tempdir()?;
    let trace = temp.path().join("trace");
    write_executable(&temp.path().join("claude"), CLAUDE_COMMAND)?;
    write_executable(&temp.path().join("codex"), CODEX_COMMAND)?;
    write_executable(&temp.path().join("okou"), OKOU_COMMAND)?;
    write_executable(&temp.path().join("su"), SU_COMMAND)?;

    let output = Command::new("/bin/sh")
        .arg("-c")
        .arg(PREWARM_SCRIPT)
        .env_clear()
        .env("PATH", temp.path())
        .env("PREWARM_TRACE", &trace)
        .env("CLAUDE_EXIT", claude_exit.to_string())
        .env("CODEX_EXIT", codex_exit.to_string())
        .env("OKOU_EXIT", okou_exit.to_string())
        .output()?;
    let trace = fs::read_to_string(trace)?;

    Ok((output, trace))
}

#[test]
fn prewarm_script_preserves_process_group_and_failure_isolation() -> TestResult<()> {
    assert!(
        !PREWARM_SCRIPT.contains("su "),
        "PREWARM_SCRIPT must not switch users; the guest exec layer owns the user-shell wrapper"
    );

    for (claude_exit, codex_exit, okou_exit) in
        [(0, 0, 0), (7, 0, 0), (0, 9, 0), (0, 0, 11), (7, 9, 11)]
    {
        let (output, trace) = run_prewarm(claude_exit, codex_exit, okou_exit)?;

        assert!(
            output.status.success(),
            "prewarm failed for claude={claude_exit}, codex={codex_exit}, okou={okou_exit}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            trace, "CLAUDE\nCODEX\nOKOU:__agent-loop --help\n",
            "all warmups must run without starting an Agent session or nesting a user-shell wrapper"
        );
    }

    Ok(())
}
