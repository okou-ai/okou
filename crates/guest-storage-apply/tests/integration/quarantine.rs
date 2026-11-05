#![cfg(target_os = "linux")]

use crate::binary_logging::BinaryLoggingFixture;
use crate::process::CommandExecution;
use crate::support::create_tar_gz;
use guest_contracts::{runtime_paths, storage_files};
use serde_json::{Value, json};
use std::fs;
use std::io;
use std::os::unix::fs::{MetadataExt, symlink};
use std::path::PathBuf;

fn fixture() -> io::Result<BinaryLoggingFixture> {
    let mut fixture = BinaryLoggingFixture::new("memory-isolation")?;
    let runtime =
        runtime_paths::run_dir_for_home(fixture.dir.path(), "current").map_err(io::Error::other)?;
    fixture.logs.system_log = runtime_paths::system_log_file(&runtime);
    fixture.logs.ops_log = runtime_paths::sandbox_ops_log_file(&runtime);
    fixture.logs.runtime_dir = runtime;
    Ok(fixture)
}

fn target(fixture: &BinaryLoggingFixture) -> PathBuf {
    fixture.dir.path().join(".codex/memories")
}

fn manifest(fixture: &BinaryLoggingFixture) -> io::Result<Value> {
    let archive = fixture.dir.path().join("new.tar.gz");
    fs::write(&archive, create_tar_gz(&[("new.md", b"new memory")])?)?;
    Ok(json!({
        "storageMounts": [{
            "name": "memory", "storageId": "memory-id", "versionId": "new-version",
            "mountPath": target(fixture), "archiveUrl": format!("file://{}", archive.display()),
            "writeback": true
        }],
        "cleanupPaths": [target(fixture)]
    }))
}

fn discarded(fixture: &BinaryLoggingFixture) -> io::Result<Vec<PathBuf>> {
    let parent = fixture
        .logs
        .runtime_dir
        .parent()
        .ok_or_else(|| io::Error::other("missing runtime parent"))?;
    let mut roots = Vec::new();
    for entry in fs::read_dir(parent)? {
        let path = entry?.path();
        if path != fixture.logs.runtime_dir {
            roots.push(path);
        }
    }
    Ok(roots)
}

#[test]
fn replacement_isolates_the_exact_old_tree_for_later_owned_cleanup() {
    for decoded in [false, true] {
        let fixture = fixture().unwrap();
        let memory = target(&fixture);
        fs::create_dir_all(memory.join("nested/deeper")).unwrap();
        fs::write(memory.join("nested/deeper/old.md"), b"old memory").unwrap();
        let outside = fixture.dir.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("keep"), b"outside content").unwrap();
        symlink(&outside, memory.join("outside-link")).unwrap();
        let original = fs::metadata(&memory).unwrap().ino();
        let manifest = serde_json::to_vec(&manifest(&fixture).unwrap()).unwrap();
        let output = if decoded {
            let files = vec![storage_files::StorageFile {
                path: "new.md".into(),
                mode: 0o640,
                mtime: 1234,
                content: b"new memory".to_vec(),
            }];
            let input = storage_files::encode_input(
                &manifest,
                &[(memory.to_str().unwrap(), files.as_slice())],
            )
            .unwrap();
            CommandExecution::spawn(fixture.command().arg("--storage-files-stdin"), Some(&input))
                .unwrap()
                .wait()
                .unwrap()
        } else {
            fixture.run_manifest_stdin(&manifest).unwrap()
        };
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(fs::read(memory.join("new.md")).unwrap(), b"new memory");
        assert_eq!(fs::read_dir(&memory).unwrap().count(), 1);
        assert_ne!(fs::metadata(&memory).unwrap().ino(), original);
        let discarded = discarded(&fixture).unwrap();
        assert_eq!(discarded.len(), 1);
        let old = discarded.first().unwrap();
        assert_eq!(fs::metadata(old).unwrap().ino(), original);
        assert_eq!(
            fs::read(old.join("nested/deeper/old.md")).unwrap(),
            b"old memory"
        );
        assert!(
            fs::symlink_metadata(old.join("outside-link"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(fs::read(outside.join("keep")).unwrap(), b"outside content");
        if decoded {
            assert_eq!(
                fs::metadata(memory.join("new.md")).unwrap().mode() & 0o777,
                0o640
            );
            assert_eq!(fs::metadata(memory.join("new.md")).unwrap().mtime(), 1234);
        }
    }
}

#[test]
fn cached_descendant_keeps_its_root_identity_and_local_content() {
    let fixture = fixture().unwrap();
    let memory = target(&fixture);
    let keep = memory.join("keep");
    fs::create_dir_all(&keep).unwrap();
    fs::write(keep.join("local.md"), b"local edit").unwrap();
    fs::write(memory.join("stale"), b"stale").unwrap();
    let original = fs::metadata(&memory).unwrap().ino();
    let mut manifest = manifest(&fixture).unwrap();
    manifest["storageMounts"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "mountPath": keep, "cached": true, "writeback": false
        }));
    let output = fixture
        .run_manifest_stdin(&serde_json::to_vec(&manifest).unwrap())
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(fs::metadata(&memory).unwrap().ino(), original);
    assert_eq!(fs::read(keep.join("local.md")).unwrap(), b"local edit");
    assert_eq!(fs::read(memory.join("new.md")).unwrap(), b"new memory");
    assert_eq!(fs::read_dir(&memory).unwrap().count(), 2);
    assert!(discarded(&fixture).unwrap().is_empty());
}

#[test]
fn final_memory_symlink_is_replaced_without_touching_its_referent() {
    let fixture = fixture().unwrap();
    let memory = target(&fixture);
    fs::create_dir_all(memory.parent().unwrap()).unwrap();
    let outside = fixture.dir.path().join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("keep"), b"keep").unwrap();
    symlink(&outside, &memory).unwrap();
    let output = fixture
        .run_manifest_stdin(&serde_json::to_vec(&manifest(&fixture).unwrap()).unwrap())
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(fs::symlink_metadata(&memory).unwrap().is_dir());
    assert_eq!(fs::read(memory.join("new.md")).unwrap(), b"new memory");
    assert_eq!(fs::read(outside.join("keep")).unwrap(), b"keep");
    assert!(discarded(&fixture).unwrap().is_empty());
}

#[test]
fn unsafe_runtime_alias_does_not_grant_isolation_authority() {
    let fixture = fixture().unwrap();
    let memory = target(&fixture);
    fs::create_dir_all(&memory).unwrap();
    fs::write(memory.join("old.md"), b"old memory").unwrap();
    let parent = fixture.logs.runtime_dir.parent().unwrap();
    fs::create_dir_all(parent.parent().unwrap()).unwrap();
    let outside = fixture.dir.path().join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("keep"), b"outside").unwrap();
    symlink(&outside, parent).unwrap();
    let output = fixture
        .run_manifest_stdin(&serde_json::to_vec(&manifest(&fixture).unwrap()).unwrap())
        .unwrap();
    assert!(!output.status.success());
    assert_eq!(fs::read(memory.join("old.md")).unwrap(), b"old memory");
    assert_eq!(fs::read(outside.join("keep")).unwrap(), b"outside");
    assert_eq!(fs::read_dir(&outside).unwrap().count(), 1);
}

#[test]
fn an_unrelated_input_error_does_not_trigger_physical_memory_reclamation() {
    let fixture = fixture().unwrap();
    let memory = target(&fixture);
    fs::create_dir_all(memory.join("nested")).unwrap();
    fs::write(memory.join("nested/old.md"), b"old memory").unwrap();
    let mut manifest = manifest(&fixture).unwrap();
    manifest["storageMounts"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "mountPath": fixture.dir.path().join("other"),
            "archiveUrl": "file:///missing-other-input.tar.gz"
        }));
    let output = fixture
        .run_manifest_stdin(&serde_json::to_vec(&manifest).unwrap())
        .unwrap();
    assert!(!output.status.success());
    assert_eq!(fs::read(memory.join("new.md")).unwrap(), b"new memory");
    let discarded = discarded(&fixture).unwrap();
    assert_eq!(discarded.len(), 1);
    assert_eq!(
        fs::read(discarded.first().unwrap().join("nested/old.md")).unwrap(),
        b"old memory"
    );
}
