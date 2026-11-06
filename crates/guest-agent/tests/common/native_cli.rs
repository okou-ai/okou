//! Native Claude/Codex argument recording for explicit-config scenarios.

use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

pub fn write_user_env_file(
    runtime_dir: &Path,
    user_env: &HashMap<&str, &str>,
) -> Result<PathBuf, String> {
    let dir = runtime_dir.join(guest_contracts::env::USER_ENV_PRIVATE_DIR_NAME);
    std::fs::create_dir_all(&dir).map_err(|error| format!("create user env dir: {error}"))?;
    let path = dir.join(guest_contracts::env::USER_ENV_FILENAME);
    let bytes =
        serde_json::to_vec(user_env).map_err(|error| format!("serialize user env: {error}"))?;
    std::fs::write(&path, bytes).map_err(|error| format!("write user env: {error}"))?;
    Ok(path)
}

pub fn write_recording_wrapper(root: &Path) -> Result<PathBuf, String> {
    let path = root.join("record-args");
    std::fs::write(
        &path,
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$TEST_ARGS_PATH\"\nexec \"$TEST_REAL_MOCK\" \"$@\"\n",
    )
    .map_err(|error| format!("write recording wrapper: {error}"))?;
    let mut permissions = std::fs::metadata(&path)
        .map_err(|error| format!("read recording wrapper permissions: {error}"))?
        .permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(&path, permissions)
        .map_err(|error| format!("set recording wrapper permissions: {error}"))?;
    Ok(path)
}

pub fn read_args(path: &Path) -> Result<Vec<String>, String> {
    let contents =
        std::fs::read_to_string(path).map_err(|error| format!("read recorded args: {error}"))?;
    Ok(contents.lines().map(str::to_string).collect())
}
