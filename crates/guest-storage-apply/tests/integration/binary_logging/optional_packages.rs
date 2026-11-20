use super::BinaryLoggingFixture;
use guest_contracts::storage_manifest::StorageApplyReceipt;
use httpmock::prelude::*;
use serde_json::json;
use std::{fs, io, os::unix::fs::symlink};

#[test]
fn optional_archive_failures_clean_their_mounts_and_keep_the_framework_root() -> io::Result<()> {
    let fixture = BinaryLoggingFixture::new("optional-archives")?;
    let framework = fixture.dir.path().join("framework");
    let missing = framework.join("skills/missing");
    let partial = framework.join("skills/partial");
    let blocked = framework.join("skills/blocked");
    let missing_document = framework.join("skills/missing-document");
    let blocked_parent = framework.join("blocked-skills");
    let blocked_child = blocked_parent.join("optional");
    for target in [&missing, &partial] {
        fs::create_dir_all(target)?;
        fs::write(target.join("SKILL.md"), "stale")?;
    }
    fs::write(&blocked, "mount target is a file")?;
    fs::create_dir_all(&missing_document)?;
    fs::write(&blocked_parent, "parent is a file")?;
    fs::write(framework.join("settings.json"), "keep")?;

    let server = MockServer::start();
    let unavailable = server.mock(|when, then| {
        when.method(GET).path("/missing.tar.gz");
        then.status(404);
    });
    let mut bytes = crate::gzip_integrity::create_stored_archive()?;
    let crc = bytes.len() - 8;
    bytes[crc] ^= 1;
    let archive = fixture.dir.path().join("bad.tar.gz");
    fs::write(&archive, bytes)?;
    let local = format!("file://{}", archive.display());
    let output = fixture.run_manifest_stdin(&serde_json::to_vec(&json!({
        "storageMounts": [
            {"mountPath": framework, "cached": true},
            {"mountPath": missing, "name": "workflow", "optional": true,
             "archiveUrl": server.url("/missing.tar.gz")},
            {"mountPath": partial, "name": "workflow", "optional": true, "archiveUrl": local},
            {"mountPath": blocked, "name": "workflow", "optional": true, "archiveUrl": local},
            {"mountPath": missing_document, "name": "workflow", "optional": true, "cached": true},
            {"mountPath": blocked_child, "name": "workflow", "optional": true, "archiveUrl": local}
        ],
        "cleanupPaths": [missing, partial, blocked_child]
    }))?)?;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<StorageApplyReceipt>(&output.stdout)?.skipped_optional,
        [1, 2, 3, 4, 5]
    );
    unavailable.assert_calls(1);
    for target in [&missing, &partial, &blocked, &missing_document] {
        assert!(!target.exists(), "{}", target.display());
    }
    assert_eq!(fs::read(framework.join("settings.json"))?, b"keep");
    assert_eq!(fs::read(&blocked_parent)?, b"parent is a file");
    let log = fixture.read_system_log()?;
    for package in [
        &missing,
        &partial,
        &blocked,
        &missing_document,
        &blocked_child,
    ] {
        assert!(
            log.lines().any(|line| {
                line.contains("[ERROR]") && line.contains(package.to_str().unwrap())
            }),
            "{log}"
        );
    }

    // The same archive writes a real file before its late CRC failure.
    let required = fixture.run_manifest_stdin(&serde_json::to_vec(&json!({
        "storageMounts": [{"mountPath": partial, "name": "workflow", "archiveUrl": local}]
    }))?)?;
    assert!(!required.status.success());
    assert_eq!(fs::read(partial.join("file.txt"))?, b"ORIGINAL_PAYLOAD");
    assert!(required.stdout.is_empty());
    Ok(())
}

#[test]
fn unsafe_optional_mount_cleanup_stops_application() -> io::Result<()> {
    for layout in ["nested", "direct alias", "link chain"] {
        let fixture = BinaryLoggingFixture::new("unsafe-optional-archive")?;
        let optional = fixture.dir.path().join("skills/optional");
        let child = optional.join("required");
        if layout == "link chain" {
            fs::create_dir_all(&optional)?;
            let backing = fixture.dir.path().join("required-data");
            fs::create_dir(&backing)?;
            fs::write(backing.join("keep"), "required")?;
            symlink(&backing, &child)?;
        } else {
            fs::create_dir_all(&child)?;
            fs::write(child.join("keep"), "required")?;
        }
        let required = if layout == "nested" {
            child
        } else {
            let alias = fixture.dir.path().join("required-alias");
            symlink(&child, &alias)?;
            alias.join("")
        };
        let output = fixture.run_manifest_stdin(&serde_json::to_vec(&json!({
            "storageMounts": [
                {"mountPath": optional, "name": "workflow", "optional": true},
                {"mountPath": required, "cached": true}
            ]
        }))?)?;
        assert!(!output.status.success(), "{layout}");
        assert!(output.stdout.is_empty());
        assert_eq!(fs::read(required.join("keep"))?, b"required");
    }
    Ok(())
}

#[test]
fn optional_symlink_is_removed_only_if_other_mounts_do_not_use_it() -> io::Result<()> {
    let server = MockServer::start();
    let archive = server.mock(|when, then| {
        when.method(GET).path("/optional.tar.gz");
        then.status(404);
    });
    for shared in [false, true] {
        let fixture = BinaryLoggingFixture::new("optional-symlink")?;
        let backing = fixture.dir.path().join("backing");
        fs::create_dir(&backing)?;
        fs::write(backing.join("keep"), "required")?;
        let optional = fixture.dir.path().join("optional");
        symlink(&backing, &optional)?;
        let cycle = fixture.dir.path().join("cycle");
        symlink(&cycle, &cycle)?;
        let required = if shared {
            let alias = fixture.dir.path().join("required");
            symlink(&optional, &alias)?;
            alias
        } else {
            backing
        };
        let output = fixture.run_manifest_stdin(&serde_json::to_vec(&json!({
            "storageMounts": [
                {"mountPath": required, "cached": true},
                {"mountPath": optional, "name": "workflow", "optional": true,
                 "archiveUrl": server.url("/optional.tar.gz")},
                {"mountPath": cycle, "name": "workflow", "optional": true, "cached": true}
            ]
        }))?)?;
        let stderr = String::from_utf8_lossy(&output.stderr);
        if shared {
            assert!(!output.status.success());
            assert!(output.stdout.is_empty());
            assert!(stderr.contains("overlaps another mount"), "{stderr}");
            assert!(fs::symlink_metadata(&optional)?.is_symlink());
        } else {
            assert!(output.status.success(), "{stderr}");
            assert_eq!(
                serde_json::from_slice::<StorageApplyReceipt>(&output.stdout)?.skipped_optional,
                [1, 2]
            );
            for path in [&optional, &cycle] {
                assert_eq!(
                    fs::symlink_metadata(path).unwrap_err().kind(),
                    io::ErrorKind::NotFound
                );
            }
        }
        assert_eq!(fs::read(required.join("keep"))?, b"required");
    }
    archive.assert_calls(0);
    Ok(())
}

#[test]
fn optional_mount_under_an_aliased_parent_is_unsafe() -> io::Result<()> {
    let fixture = BinaryLoggingFixture::new("optional-parent-alias")?;
    let alias = fixture.dir.path().join("alias");
    let backing = fixture.dir.path().join("backing");
    let package = backing.join("package");
    fs::create_dir_all(&package)?;
    fs::write(package.join("keep"), "unaltered")?;
    symlink(&backing, &alias)?;
    let output = fixture.run_manifest_stdin(&serde_json::to_vec(&json!({
        "storageMounts": [
            {"mountPath": alias.join("package"), "name": "workflow", "optional": true}
        ]
    }))?)?;
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert_eq!(fs::read(package.join("keep"))?, b"unaltered");
    Ok(())
}
