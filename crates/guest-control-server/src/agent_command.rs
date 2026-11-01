//! Fixed Guest Agent process construction.
//!
//! Controlled Agent launch never accepts a caller-selected executable,
//! arguments, sudo choice, or shell program. Structured bootstrap values are
//! installed directly in the child environment and remain absent from argv
//! and diagnostics.

use std::fs;
use std::io;
use std::os::fd::OwnedFd;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{ChildStderr, ChildStdout};

use crate::contained_command::{CommandStdio, ContainedCommand as Command, ContainedCommandExt};

use guest_contracts::session_history_identity::SessionHistoryIdentityVerifyRequest;

use crate::process_containment::ExecProcessContainment;
use crate::shell_command::SpawnedCommand;

#[derive(Clone)]
pub(crate) enum GuestAgentProgram {
    Production,
    Test(PathBuf),
}

impl GuestAgentProgram {
    pub(crate) fn production() -> Self {
        Self::Production
    }

    pub(crate) fn for_test(path: PathBuf) -> Self {
        Self::Test(path)
    }

    fn executable(&self) -> &Path {
        match self {
            Self::Production => Path::new(guest_contracts::guest_binary::AGENT_PATH),
            Self::Test(path) => path,
        }
    }
}

pub(crate) fn spawn_agent_command_with_pipes(
    env: &[(&str, &str)],
    process_containment: ExecProcessContainment,
    program: &GuestAgentProgram,
) -> io::Result<SpawnedCommand> {
    spawn_agent_executable_with_pipes(program.executable(), env, process_containment)
}

pub(crate) fn spawn_session_history_identity_verifier_with_pipes(
    request: &SessionHistoryIdentityVerifyRequest,
    process_containment: ExecProcessContainment,
    program: &GuestAgentProgram,
) -> io::Result<SpawnedCommand> {
    request
        .validate()
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error.to_string()))?;
    let history_size_bytes = request.expectation.history_size_bytes.to_string();
    let spawn_result = (|| {
        validate_agent_executable(program.executable())?;
        let mut command = Command::new(program.executable());
        command
            .arg("verify-session-history-identity")
            .arg(&request.metadata_path)
            .arg(request.expectation.framework.as_str())
            .arg(&request.expectation.session_id_hash)
            .arg(request.expectation.history_ref_kind.as_str())
            .arg(&request.expectation.history_hash)
            .arg(&history_size_bytes)
            .env_clear()
            .env(
                guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
                &request.runtime_dir,
            )
            .stdout(CommandStdio::Piped)
            .stderr(CommandStdio::Piped);
        crate::user::configure_guest_agent_command_environment(&mut command)?;
        command.spawn(false, &process_containment)
    })();

    SpawnedCommand::from_spawn_result(spawn_result.map(|child| (child, None)), process_containment)
}

fn spawn_agent_executable_with_pipes(
    executable: &Path,
    env: &[(&str, &str)],
    process_containment: ExecProcessContainment,
) -> io::Result<SpawnedCommand> {
    let spawn_result = (|| {
        crate::shell_command::validate_exec_environment(env)?;
        validate_agent_executable(executable)?;
        let (output_reader, output_writer) = cloexec_pipe()?;
        let output_stderr = output_writer.try_clone()?;
        let (diagnostic_reader, diagnostic_writer) = cloexec_pipe()?;
        drop(diagnostic_writer);

        let mut command = Command::new(executable);
        command
            .env_clear()
            .envs(env.iter().copied())
            .stdout(CommandStdio::Owned(output_writer))
            .stderr(CommandStdio::Owned(output_stderr));
        crate::user::configure_guest_agent_command_environment(&mut command)?;
        let mut child = command.spawn(false, &process_containment)?;
        child.stdout = Some(ChildStdout::from(output_reader));
        child.stderr = Some(ChildStderr::from(diagnostic_reader));
        Ok(child)
    })();

    SpawnedCommand::from_spawn_result(spawn_result.map(|child| (child, None)), process_containment)
}

fn validate_agent_executable(executable: &Path) -> io::Result<()> {
    let metadata = match fs::metadata(executable) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "agent bootstrap failed: guest-agent is missing",
            ));
        }
        Err(error) => return Err(error),
    };
    if !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "agent bootstrap failed: guest-agent is not a regular file",
        ));
    }
    if metadata.permissions().mode() & 0o111 == 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "agent bootstrap failed: guest-agent is not executable",
        ));
    }
    Ok(())
}

fn cloexec_pipe() -> io::Result<(OwnedFd, OwnedFd)> {
    let (reader, writer) = io::pipe()?;
    Ok((reader.into(), writer.into()))
}

#[cfg(test)]
mod tests;
