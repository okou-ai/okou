use std::path::{Path, PathBuf};

use sandbox::{SandboxControlError, SandboxId};

use crate::paths::{RuntimePaths, SockPaths};

/// Find the control socket for a given sandbox ID (full UUID or prefix).
///
/// Full UUIDs resolve through the exact socket path. Prefixes scan the runtime
/// socket directory for matching directories that contain a `control.sock` file.
pub(super) fn resolve_control_socket(input: &str) -> Result<PathBuf, SandboxControlError> {
    let runtime = RuntimePaths::new();
    let sock_parent = runtime.sock_base();
    resolve_control_socket_in(&sock_parent, input)
}

fn resolve_control_socket_in(
    sock_parent: &Path,
    input: &str,
) -> Result<PathBuf, SandboxControlError> {
    if let Ok(sandbox_id) = input.parse::<SandboxId>() {
        let control_sock = SockPaths::new(sock_parent.join(sandbox_id.to_string())).control_sock();
        return match control_sock.try_exists() {
            Ok(true) => Ok(control_sock),
            Ok(false) => {
                let _entries = read_control_socket_parent(sock_parent)?;
                Err(control_socket_not_found(input))
            }
            Err(e) => Err(SandboxControlError::Connection(format!(
                "cannot check {}: {e}",
                control_sock.display()
            ))),
        };
    }

    let entries = read_control_socket_parent(sock_parent)?;

    let mut matches: Vec<(String, PathBuf)> = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| {
            SandboxControlError::Connection(format!(
                "cannot read entry in {}: {e}",
                sock_parent.display()
            ))
        })?;
        let name = entry.file_name();
        let Some(name_str) = name.to_str() else {
            continue;
        };
        if !name_str.starts_with(input) {
            continue;
        }
        let file_type = entry.file_type().map_err(|e| {
            SandboxControlError::Connection(format!(
                "cannot inspect {}: {e}",
                entry.path().display()
            ))
        })?;
        if !file_type.is_dir() {
            continue;
        }
        let control_sock = SockPaths::new(entry.path()).control_sock();
        match control_sock.try_exists() {
            Ok(true) => matches.push((name_str.to_owned(), control_sock)),
            Ok(false) => {}
            Err(e) => {
                return Err(SandboxControlError::Connection(format!(
                    "cannot check {}: {e}",
                    control_sock.display()
                )));
            }
        }
    }

    match matches.as_slice() {
        [] => Err(control_socket_not_found(input)),
        [single] => Ok(single.1.clone()),
        _ => {
            let ids: Vec<&str> = matches.iter().map(|(id, _)| id.as_str()).collect();
            Err(SandboxControlError::Ambiguous(format!(
                "prefix '{input}' matches: {}",
                ids.join(", ")
            )))
        }
    }
}

fn read_control_socket_parent(sock_parent: &Path) -> Result<std::fs::ReadDir, SandboxControlError> {
    std::fs::read_dir(sock_parent).map_err(|e| {
        SandboxControlError::Connection(format!(
            "cannot read {}: {e} (is a sandbox running?)",
            sock_parent.display()
        ))
    })
}

fn control_socket_not_found(input: &str) -> SandboxControlError {
    SandboxControlError::NotFound(format!(
        "no running sandbox matches '{input}' (no control.sock found)"
    ))
}

#[cfg(test)]
mod tests;
