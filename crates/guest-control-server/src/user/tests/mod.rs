use super::*;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::Path;

fn write_executable(path: &Path, output: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, format!("#!/bin/sh\nprintf '%s' '{output}'\n")).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[test]
fn sandbox_user_path_finds_tools_installed_after_launch() {
    for relative_dir in [".local/bin", "bin"] {
        let home = tempfile::tempdir().unwrap();
        let path = sandbox_user_path(home.path());
        write_executable(
            &home.path().join(relative_dir).join("okou-user-path-test"),
            "user tool found",
        );

        let output = Command::new("okou-user-path-test")
            .env_clear()
            .env("PATH", path)
            .output()
            .unwrap_or_else(|error| panic!("tool in {relative_dir} was not found: {error}"));
        assert!(output.status.success());
        assert_eq!(output.stdout, b"user tool found");
    }
}

#[test]
fn sandbox_user_path_preserves_command_precedence() {
    let home = tempfile::tempdir().unwrap();
    let path = sandbox_user_path(home.path());
    let user_commands: [(&str, &str, bool, &[u8]); 4] = [
        ("go/bin", "/bin/true", true, b""),
        (".cargo/bin", "/bin/false", false, b""),
        (".local/bin", "/bin/echo", true, b"marker\n"),
        ("bin", "/usr/bin/printf", true, b"marker"),
    ];
    for &(relative_dir, command_target, _, _) in &user_commands {
        let dir = home.path().join(relative_dir);
        std::fs::create_dir_all(&dir).unwrap();
        symlink(command_target, dir.join("okou-user-path-test")).unwrap();
        symlink("/bin/false", dir.join("cat")).unwrap();
    }

    let input = home.path().join("input");
    std::fs::write(&input, "system command found").unwrap();
    let output = Command::new("cat")
        .arg(&input)
        .env_clear()
        .env("PATH", &path)
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(output.stdout, b"system command found");

    for (relative_dir, _, expected_success, expected_stdout) in user_commands {
        let output = Command::new("okou-user-path-test")
            .arg("marker")
            .env_clear()
            .env("PATH", &path)
            .output()
            .unwrap();
        assert_eq!(output.status.success(), expected_success);
        assert_eq!(output.stdout, expected_stdout);
        std::fs::remove_file(home.path().join(relative_dir).join("okou-user-path-test")).unwrap();
    }
}

#[test]
fn guest_agent_environment_preserves_trusted_defaults() {
    let mut command = crate::contained_command::ContainedCommand::new("true");
    configure_guest_agent_command_environment(&mut command).unwrap();

    for (key, expected) in TRUSTED_ROOTFS_ENVIRONMENT {
        let actual = command.environment.get(std::ffi::OsStr::new(key));
        assert_eq!(
            actual.map(|value| value.as_os_str()),
            Some(std::ffi::OsStr::new(expected))
        );
    }
    let shell = command.environment.get(std::ffi::OsStr::new("SHELL"));
    assert_eq!(
        shell.map(|value| value.as_os_str()),
        Some(std::ffi::OsStr::new(AGENT_SHELL))
    );
}

#[test]
fn parse_user_credentials_includes_primary_and_supplementary_groups() {
    let passwd = "root:x:0:0:root:/root:/bin/bash\nuser:x:1000:1000::/home/user:/bin/bash\n";
    let group = "user:x:1000:\nsudo:x:27:user\npostgres:x:113:user,other\n";

    let credentials = parse_user_credentials(passwd, group, "user").unwrap();

    assert_eq!(credentials.uid, 1000);
    assert_eq!(credentials.gid, 1000);
    assert_eq!(credentials.home, PathBuf::from("/home/user"));
    assert_eq!(credentials.groups, vec![27, 113, 1000]);
}

#[test]
fn parse_user_credentials_uses_passwd_primary_gid_without_group_entry() {
    let passwd = "user:x:1000:2000::/home/user:/bin/bash\n";

    let credentials = parse_user_credentials(passwd, "", "user").unwrap();

    assert_eq!(credentials.gid, 2000);
    assert_eq!(credentials.groups, vec![2000]);
}

#[cfg(any(debug_assertions, feature = "test-support"))]
#[test]
fn sandbox_user_gid_is_unavailable_in_local_builds() {
    let err = sandbox_user_gid().unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::Other);
    assert!(err.to_string().contains("sandbox user gid is unavailable"));
}

#[test]
fn parse_user_credentials_fails_when_user_missing() {
    let err = parse_user_credentials("root:x:0:0:root:/root:/bin/bash\n", "", "user").unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::NotFound);
}

#[test]
fn parse_user_credentials_fails_on_invalid_uid() {
    let err = parse_user_credentials("user:x:not-a-uid:1000::/home/user:/bin/bash\n", "", "user")
        .unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
}

#[test]
fn parse_user_credentials_fails_on_invalid_gid() {
    let err = parse_user_credentials("user:x:1000:not-a-gid::/home/user:/bin/bash\n", "", "user")
        .unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
}
