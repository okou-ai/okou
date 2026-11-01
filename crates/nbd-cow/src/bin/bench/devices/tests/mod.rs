use std::os::unix::fs::PermissionsExt;

use super::*;

#[test]
fn tool_exists_in_finds_only_executable_files() {
    let temp_dir = tempfile::tempdir().unwrap();
    let executable = temp_dir.path().join("available-tool");
    std::fs::write(&executable, "#!/bin/sh\n").unwrap();
    let mut permissions = std::fs::metadata(&executable).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&executable, permissions).unwrap();

    let non_executable = temp_dir.path().join("non-executable-tool");
    std::fs::write(&non_executable, "not executable\n").unwrap();
    let mut permissions = std::fs::metadata(&non_executable).unwrap().permissions();
    permissions.set_mode(0o644);
    std::fs::set_permissions(&non_executable, permissions).unwrap();

    let paths = std::env::join_paths([temp_dir.path()]).unwrap();
    assert!(tool_exists_in("available-tool", &paths, temp_dir.path()));
    assert!(!tool_exists_in("missing-tool", &paths, temp_dir.path()));
    assert!(!tool_exists_in(
        "non-executable-tool",
        &paths,
        temp_dir.path()
    ));
}
