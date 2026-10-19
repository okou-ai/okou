#![cfg(unix)]

use std::io;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};

use runner_host::HostError;
use runner_host::private_fs::read_private_file_to_string_with_max;
use runner_host::state_file::{self, OwnerCheck};

fn write_file(root: &Path, name: &str, content: &[u8], mode: u32) -> io::Result<PathBuf> {
    let path = root.join(name);
    std::fs::write(&path, content)?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode))?;
    Ok(path)
}

fn mode(path: &Path) -> io::Result<u32> {
    Ok(std::fs::metadata(path)?.permissions().mode() & 0o777)
}

fn assert_internal(error: HostError, message: String) {
    assert!(matches!(&error, HostError::Internal(_)), "{error}");
    assert_eq!(error.to_string(), format!("internal error: {message}"));
}

fn assert_config(error: HostError, message: String) {
    assert!(matches!(&error, HostError::Config(_)), "{error}");
    assert_eq!(error.to_string(), format!("config error: {message}"));
}

#[tokio::test]
async fn byte_limits_preserve_complete_contents_and_utf8_boundaries()
-> Result<(), Box<dyn std::error::Error>> {
    let dir = tempfile::tempdir()?;
    for (name, text) in [("empty", ""), ("ascii", "x"), ("utf8", "\0é")] {
        let path = write_file(dir.path(), name, text.as_bytes(), 0o600)?;
        let limit = u64::try_from(text.len())?;
        assert_eq!(
            state_file::read_to_bytes_required(&path, limit, OwnerCheck::None).await?,
            text.as_bytes()
        );
        assert_eq!(
            state_file::read_to_string(&path, limit, OwnerCheck::None).await?,
            Some(text.to_owned())
        );
        assert_eq!(
            read_private_file_to_string_with_max(&path, limit).await?,
            Some(text.to_owned())
        );

        if let Some(limit) = limit.checked_sub(1) {
            assert_internal(
                state_file::read_to_bytes_required(&path, limit, OwnerCheck::None)
                    .await
                    .unwrap_err(),
                format!("state file {} exceeds {limit} bytes", path.display()),
            );
            assert_internal(
                state_file::read_to_string(&path, limit, OwnerCheck::None)
                    .await
                    .unwrap_err(),
                format!("state file {} exceeds {limit} bytes", path.display()),
            );
            assert_config(
                read_private_file_to_string_with_max(&path, limit)
                    .await
                    .unwrap_err(),
                format!("private file {} exceeds {limit} bytes", path.display()),
            );
        }
        assert_eq!(std::fs::read(&path)?, text.as_bytes());
    }
    Ok(())
}

#[tokio::test]
async fn content_errors_keep_category_context_and_precedence()
-> Result<(), Box<dyn std::error::Error>> {
    let dir = tempfile::tempdir()?;
    let bytes = [0xff];
    let path = write_file(dir.path(), "binary", &bytes, 0o600)?;
    assert_eq!(
        state_file::read_to_bytes_required(&path, 1, OwnerCheck::None).await?,
        bytes
    );
    let utf8_error = String::from_utf8(bytes.to_vec()).unwrap_err();
    assert_internal(
        state_file::read_to_string(&path, 1, OwnerCheck::None)
            .await
            .unwrap_err(),
        format!("read state file {} as UTF-8: {utf8_error}", path.display()),
    );
    assert_config(
        read_private_file_to_string_with_max(&path, 1)
            .await
            .unwrap_err(),
        format!(
            "read private file {} as UTF-8: {utf8_error}",
            path.display()
        ),
    );
    for (limit, detail) in [
        (0, "exceeds 0 bytes"),
        (u64::MAX, "read limit is too large"),
    ] {
        assert_internal(
            state_file::read_to_bytes_required(&path, limit, OwnerCheck::None)
                .await
                .unwrap_err(),
            format!("state file {} {detail}", path.display()),
        );
        assert_internal(
            state_file::read_to_string(&path, limit, OwnerCheck::None)
                .await
                .unwrap_err(),
            format!("state file {} {detail}", path.display()),
        );
        assert_config(
            read_private_file_to_string_with_max(&path, limit)
                .await
                .unwrap_err(),
            format!("private file {} {detail}", path.display()),
        );
    }
    assert_eq!(std::fs::read(&path)?, bytes);
    Ok(())
}

#[tokio::test]
async fn missing_validation_and_permission_policies_precede_content_limits()
-> Result<(), Box<dyn std::error::Error>> {
    let dir = tempfile::tempdir()?;
    let missing = dir.path().join("missing");
    for limit in [0, u64::MAX] {
        assert!(
            state_file::read_to_string(&missing, limit, OwnerCheck::None)
                .await?
                .is_none()
        );
        assert!(
            read_private_file_to_string_with_max(&missing, limit)
                .await?
                .is_none()
        );
        let error = state_file::read_to_bytes_required(&missing, limit, OwnerCheck::None)
            .await
            .unwrap_err();
        assert!(matches!(&error, HostError::Io(error) if error.kind() == io::ErrorKind::NotFound));
        assert_eq!(
            error.to_string(),
            format!("io error: state file {} not found", missing.display())
        );
    }

    let safe = write_file(dir.path(), "safe", b"x", 0o644)?;
    assert_internal(
        state_file::read_to_string(&safe, u64::MAX, OwnerCheck::CurrentEuidNoUntrustedWrites)
            .await
            .unwrap_err(),
        format!("state file {} read limit is too large", safe.display()),
    );
    assert_eq!(mode(&safe)?, 0o644);
    assert_config(
        read_private_file_to_string_with_max(&safe, u64::MAX)
            .await
            .unwrap_err(),
        format!("private file {} read limit is too large", safe.display()),
    );
    assert_eq!(mode(&safe)?, 0o600);

    let unsafe_file = write_file(dir.path(), "unsafe", b"x", 0o666)?;
    assert_internal(
        state_file::read_to_string(
            &unsafe_file,
            u64::MAX,
            OwnerCheck::CurrentEuidNoUntrustedWrites,
        )
        .await
        .unwrap_err(),
        format!(
            "{} is writable by group or other users",
            unsafe_file.display()
        ),
    );
    assert_config(
        read_private_file_to_string_with_max(&unsafe_file, u64::MAX)
            .await
            .unwrap_err(),
        format!("{} is group/other writable", unsafe_file.display()),
    );
    assert_eq!(mode(&unsafe_file)?, 0o666);

    let target = write_file(dir.path(), "target", b"target", 0o644)?;
    let link = dir.path().join("link");
    symlink(&target, &link)?;
    let state_error = state_file::read_to_string(&link, u64::MAX, OwnerCheck::None)
        .await
        .unwrap_err();
    assert!(matches!(&state_error, HostError::Internal(_)));
    assert!(state_error.to_string().contains("open state file"));
    let private_error = read_private_file_to_string_with_max(&link, u64::MAX)
        .await
        .unwrap_err();
    assert!(matches!(&private_error, HostError::Config(_)));
    assert!(private_error.to_string().contains("open private file"));
    assert_eq!(mode(&target)?, 0o644);
    assert_eq!(std::fs::read(target)?, b"target");
    Ok(())
}
