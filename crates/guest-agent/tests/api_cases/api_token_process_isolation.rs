//! The untrusted CLI child must not inspect guest-agent's API credential.

#![cfg(target_os = "linux")]

use crate::common;

use shell_quote::quote_shell_arg;
use std::os::unix::fs::{PermissionsExt, chown};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::time::Duration;
use tokio::process::Command;

const API_TOKEN: &str = "guest-agent-parent-token-proof";
const RUN_ID: &str = "api-token-process-isolation";
const UNPRIVILEGED_ID: u32 = 65_534;
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

#[tokio::test]
async fn guest_agent_hides_canonical_api_token_from_its_cli_child() -> TestResult {
    assert!(
        Path::new("/proc/self/environ").is_file(),
        "the process-isolation test requires procfs"
    );
    common::ensure_canonical_workspace_for_test()?;

    assert_api_token_process_isolation().await
}

async fn assert_api_token_process_isolation() -> TestResult {
    let tmp = tempfile::tempdir()?;
    let home = tmp.path().join("home");
    let runtime_dir = tmp.path().join("runtime");
    let marker_path = tmp.path().join("probe-result");
    let probe_path = tmp.path().join("process-inspection-probe");
    std::fs::create_dir_all(&home)?;
    let run_payload_path = common::write_run_payload_file_for_test(
        &runtime_dir,
        &guest_contracts::env::RunPayload {
            prompt: "inspect the trusted parent process".to_string(),
            ..guest_contracts::env::RunPayload::default()
        },
    )?;
    write_process_inspection_probe(&probe_path, &marker_path)?;

    let launch_unprivileged = is_root();
    if launch_unprivileged {
        chown_fixture_for_unprivileged_launch(tmp.path(), &home, &runtime_dir, &run_payload_path)?;
    }

    let mut command = Command::new(env!("CARGO_BIN_EXE_guest-agent"));
    command
        .env_clear()
        .env(
            "PATH",
            std::env::var("PATH").unwrap_or_else(|_| "/usr/local/bin:/usr/bin:/bin".to_string()),
        )
        .env("SHELL", "/bin/sh")
        .env("HOME", &home)
        .env(
            guest_contracts::env::CANONICAL_API_URL_ENV,
            "http://127.0.0.1:1",
        )
        .env(guest_contracts::env::CANONICAL_API_TOKEN_ENV, API_TOKEN)
        .env(guest_contracts::env::RUN_ID_ENV, RUN_ID)
        .env(
            guest_contracts::env::CANONICAL_SANDBOX_ID_ENV,
            "00000000-0000-4000-8000-000000000abc",
        )
        .env(guest_contracts::env::CLI_AGENT_TYPE_ENV, "claude-code")
        .env(guest_contracts::env::USE_MOCK_CLAUDE_ENV, "true")
        .env(
            guest_contracts::env::CANONICAL_MOCK_CLAUDE_PATH_ENV,
            &probe_path,
        )
        .env(
            guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
            &run_payload_path,
        )
        .env(
            guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
            &runtime_dir,
        );
    if launch_unprivileged {
        command
            .as_std_mut()
            .gid(UNPRIVILEGED_ID)
            .uid(UNPRIVILEGED_ID);
    }

    let output = common::command_output_with_timeout(
        &mut command,
        PROBE_TIMEOUT,
        "guest-agent did not finish after the process-inspection probe",
    )
    .await?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        !stderr.contains(API_TOKEN),
        "guest-agent stderr exposed API token material"
    );
    assert!(
        !stdout.contains(API_TOKEN),
        "guest-agent stdout exposed API token material"
    );
    let system_log_path = guest_contracts::runtime_paths::system_log_file(&runtime_dir);
    if let Ok(system_log) = std::fs::read_to_string(system_log_path) {
        assert!(
            !system_log.contains(API_TOKEN),
            "guest-agent system log exposed API token material"
        );
    }
    let observed = std::fs::read_to_string(&marker_path).map_err(|error| {
        std::io::Error::new(
            error.kind(),
            format!(
                "read process-inspection marker after guest-agent exited with {}: {error}",
                output.status
            ),
        )
    })?;

    assert_eq!(
        observed, "parent-access-denied",
        "CLI process inspection result was {observed}"
    );
    Ok(())
}

fn write_process_inspection_probe(path: &Path, marker_path: &Path) -> TestResult {
    let expected_canonical = format!(
        "{}={API_TOKEN}",
        guest_contracts::env::CANONICAL_API_TOKEN_ENV
    );
    let script = format!(
        "#!/bin/sh\n\
         set -eu\n\
         marker={}\n\
         expected_canonical={}\n\
         if env | grep -Fqx -- \"$expected_canonical\"; then\n\
           result=child-env-visible\n\
         elif grep -aFq -- \"$expected_canonical\" \"/proc/$PPID/environ\" 2>/dev/null; then\n\
           result=parent-token-visible\n\
         elif cat \"/proc/$PPID/environ\" >/dev/null 2>&1; then\n\
           result=parent-readable-token-absent\n\
         else\n\
           result=parent-access-denied\n\
         fi\n\
         printf '%s' \"$result\" > \"$marker\"\n\
         exit 1\n",
        quote_shell_arg(&marker_path.to_string_lossy()),
        quote_shell_arg(&expected_canonical),
    );
    std::fs::write(path, script)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))?;
    Ok(())
}

fn chown_fixture_for_unprivileged_launch(
    root: &Path,
    home: &Path,
    runtime_dir: &Path,
    run_payload_path: &Path,
) -> Result<(), std::io::Error> {
    let run_payload_dir = run_payload_path
        .parent()
        .ok_or_else(|| std::io::Error::other("run payload must have a private parent directory"))?;
    for path in [root, home, runtime_dir, run_payload_dir, run_payload_path] {
        chown(path, Some(UNPRIVILEGED_ID), Some(UNPRIVILEGED_ID))?;
    }
    Ok(())
}

fn is_root() -> bool {
    // SAFETY: `geteuid` only reads the current process credential.
    unsafe { libc::geteuid() == 0 }
}
