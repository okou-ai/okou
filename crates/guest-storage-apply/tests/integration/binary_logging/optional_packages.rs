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
    for target in [&missing, &partial] {
        fs::create_dir_all(target)?;
        fs::write(target.join("SKILL.md"), "stale")?;
    }
    fs::write(&blocked, "mount target is a file")?;
    fs::create_dir_all(&missing_document)?;
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
            {"mountPath": missing_document, "name": "workflow", "optional": true, "cached": true}
        ],
        "cleanupPaths": [missing, partial]
    }))?)?;
    assert!(output.status.success(), "{:?}", output.stderr);
    assert_eq!(
        serde_json::from_slice::<StorageApplyReceipt>(&output.stdout)?.skipped_optional,
        [1, 2, 3, 4]
    );
    unavailable.assert_calls(1);
    for target in [&missing, &partial, &blocked, &missing_document] {
        assert!(!target.exists(), "{}", target.display());
    }
    assert_eq!(fs::read(framework.join("settings.json"))?, b"keep");
    let log = fixture.read_system_log()?;
    for package in [&missing, &partial, &blocked, &missing_document] {
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
    for alias in [false, true] {
        let fixture = BinaryLoggingFixture::new("unsafe-optional-archive")?;
        let optional = fixture.dir.path().join("skills/optional");
        let child = optional.join("required");
        fs::create_dir_all(&child)?;
        fs::write(child.join("keep"), "required")?;
        let required = if alias {
            let alias = fixture.dir.path().join("required-alias");
            symlink(&child, &alias)?;
            alias
        } else {
            child.clone()
        };
        let output = fixture.run_manifest_stdin(&serde_json::to_vec(&json!({
            "storageMounts": [
                {"mountPath": optional, "name": "workflow", "optional": true},
                {"mountPath": required, "cached": true}
            ]
        }))?)?;
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert_eq!(fs::read(child.join("keep"))?, b"required");
    }
    Ok(())
}
