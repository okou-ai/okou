use guest_contracts::storage_files::{self, StorageFile};
use serde_json::json;
use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};
use std::path::Path;

fn files() -> Vec<StorageFile> {
    vec![
        StorageFile {
            path: "nested/tool".into(),
            mode: 0o751,
            mtime: 1234567890,
            content: b"final-content".to_vec(),
        },
        StorageFile {
            path: "empty".into(),
            mode: 0o640,
            mtime: 0,
            content: vec![],
        },
    ]
}

fn input(target: &Path, cleanup: bool, files: &[StorageFile]) -> std::io::Result<Vec<u8>> {
    let manifest = json!({"storageMounts": [{"mountPath":target,"archiveUrl":"file:///not-staged.tar.gz","name":"test","versionId":"v1"}],
        "cleanupPaths": if cleanup { vec![target] } else { vec![] }});
    storage_files::encode_input(
        &serde_json::to_vec(&manifest)?,
        &[(
            target
                .to_str()
                .ok_or_else(|| std::io::Error::other("non-UTF-8 target"))?,
            files,
        )],
    )
}

#[test]
fn writes_final_files_after_cleanup_with_archive_metadata() {
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("mount");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("stale"), b"obsolete").unwrap();
    assert!(guest_storage_apply::run_storage_files_bytes(
        &input(&target, true, &files()).unwrap()
    ));
    assert!(!target.join("stale").exists());
    let metadata = fs::metadata(target.join("nested/tool")).unwrap();
    assert_eq!(metadata.permissions().mode() & 0o7777, 0o751);
    assert_eq!(metadata.mtime(), 1234567890);
    assert_eq!(metadata.uid(), fs::metadata(root.path()).unwrap().uid());
    assert_eq!(
        fs::read(target.join("nested/tool")).unwrap(),
        b"final-content"
    );
    assert_eq!(fs::metadata(target.join("empty")).unwrap().mtime(), 1);
    assert_eq!(fs::read_dir(&target).unwrap().count(), 2);
}

#[test]
fn malformed_bulk_or_invalid_binding_does_not_run_cleanup() {
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("mount");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("stale"), b"keep").unwrap();
    let valid = input(&target, true, &files()).unwrap();
    for end in [0, 7, 8, 16, valid.len() - 1] {
        assert!(!guest_storage_apply::run_storage_files_bytes(&valid[..end]));
        assert_eq!(fs::read(target.join("stale")).unwrap(), b"keep");
    }
    for extra in [
        json!({"cached":true}),
        json!({"instructionsTargetFilename":"AGENTS.md"}),
        json!({"writeback":true}),
    ] {
        let mut mount = json!({"mountPath":target,"archiveUrl":"file:///unused.tar.gz"});
        mount
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let manifest =
            serde_json::to_vec(&json!({"storageMounts":[mount],"cleanupPaths":[target]})).unwrap();
        let data = storage_files::encode_input(&manifest, &[(target.to_str().unwrap(), &files())])
            .unwrap();
        assert!(!guest_storage_apply::run_storage_files_bytes(&data));
        assert_eq!(fs::read(target.join("stale")).unwrap(), b"keep");
    }
}

#[test]
fn existing_hardlink_is_replaced_without_modifying_its_other_name() {
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("mount");
    fs::create_dir_all(target.join("nested")).unwrap();
    fs::write(root.path().join("outside"), b"keep").unwrap();
    fs::hard_link(root.path().join("outside"), target.join("nested/tool")).unwrap();
    assert!(guest_storage_apply::run_storage_files_bytes(
        &input(&target, false, &files()).unwrap()
    ));
    assert_eq!(fs::read(root.path().join("outside")).unwrap(), b"keep");
    assert_ne!(
        fs::metadata(root.path().join("outside")).unwrap().ino(),
        fs::metadata(target.join("nested/tool")).unwrap().ino()
    );
}

#[test]
fn escaping_parent_is_skipped_like_archive_extraction() {
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("mount");
    let outside = root.path().join("outside");
    fs::create_dir(&target).unwrap();
    fs::create_dir(&outside).unwrap();
    symlink(&outside, target.join("nested")).unwrap();
    assert!(guest_storage_apply::run_storage_files_bytes(
        &input(&target, false, &files()).unwrap()
    ));
    assert!(!outside.join("tool").exists());
    assert!(target.join("empty").is_file());
}

#[test]
fn batch_rejects_traversal_duplicate_and_parent_child_file_paths() {
    for path in [
        "../escape",
        "/absolute",
        "nested/../escape",
        "nested/tool",
        "nested",
    ] {
        let mut entries = files();
        entries[1].path = path.into();
        assert!(
            storage_files::encode(&[("/mount", &entries)]).is_err(),
            "{path}"
        );
    }
}

#[test]
fn direct_and_http_mounts_coexist() {
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("direct");
    let remote = root.path().join("remote");
    let server = httpmock::MockServer::start();
    let archive = super::support::create_tar_gz(&[("other", b"http-content")]).unwrap();
    let response = server.mock(|when, then| {
        when.path("/archive");
        then.status(200).body(&archive);
    });
    let manifest = serde_json::to_vec(&json!({"storageMounts":[
        {"mountPath":target,"archiveUrl":"file:///not-staged"},
        {"mountPath":remote,"archiveUrl":server.url("/archive")}
    ]}))
    .unwrap();
    let data =
        storage_files::encode_input(&manifest, &[(target.to_str().unwrap(), &files())]).unwrap();
    assert!(guest_storage_apply::run_storage_files_bytes(&data));
    assert_eq!(fs::read(remote.join("other")).unwrap(), b"http-content");
    response.assert_calls(1);
}

#[test]
fn overlapping_mount_is_rejected_before_stale_cleanup() {
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("mount");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("stale"), b"keep").unwrap();
    for other in [
        target.clone(),
        target.join("nested"),
        target.join("child/../nested"),
    ] {
        let manifest = serde_json::to_vec(&json!({"storageMounts":[
            {"mountPath":target,"archiveUrl":"file:///not-staged"},
            {"mountPath":other,"archiveUrl":"file:///other"}
        ], "cleanupPaths":[target]}))
        .unwrap();
        let data = storage_files::encode_input(&manifest, &[(target.to_str().unwrap(), &files())])
            .unwrap();
        assert!(!guest_storage_apply::run_storage_files_bytes(&data));
        assert_eq!(fs::read(target.join("stale")).unwrap(), b"keep");
    }
}

#[test]
fn decoded_skills_reject_actual_instruction_writes_before_cleanup() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join(".claude");
    let skill = home.join("skills/workflow");
    let stage = root.path().join("runtime/storage-instructions/0");
    for (target, mount, staging, filename) in [
        (skill.clone(), home.clone(), None, "CLAUDE.md"),
        (skill.clone(), home.clone(), Some(home.clone()), "CLAUDE.md"),
        (
            skill.clone(),
            home.clone(),
            Some(skill.clone()),
            "CLAUDE.md",
        ),
        (
            skill.clone(),
            home.clone(),
            Some(skill.join("nested")),
            "CLAUDE.md",
        ),
        (
            skill.clone(),
            home.clone(),
            Some(home.join("other/../skills")),
            "CLAUDE.md",
        ),
        (
            skill.clone(),
            root.path().join("unrelated"),
            Some(skill.clone()),
            "CLAUDE.md",
        ),
        (
            home.join("CLAUDE.md"),
            home.clone(),
            Some(stage.clone()),
            "CLAUDE.md",
        ),
        (
            home.join("AGENTS.md/nested"),
            home.clone(),
            Some(stage.clone()),
            "CLAUDE.md",
        ),
        (
            home.join(".AGENTS.md.vm0-copy-1-0.tmp"),
            home.clone(),
            Some(stage.clone()),
            "AGENTS.md",
        ),
        (home.clone(), home.clone(), Some(stage.clone()), "CLAUDE.md"),
        (
            skill.clone(),
            home.clone(),
            Some(stage.clone()),
            "../invalid",
        ),
    ] {
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("stale"), b"keep").unwrap();
        let manifest = serde_json::to_vec(&json!({"storageMounts":[
            {"mountPath": target, "archiveUrl": "file:///not-staged"},
            {"mountPath": mount, "extractPath": staging,
             "instructionsTargetFilename": filename, "archiveUrl": "file:///instructions"}
        ], "cleanupPaths": [target]}))
        .unwrap();
        let data = storage_files::encode_input(&manifest, &[(target.to_str().unwrap(), &files())])
            .unwrap();
        assert!(
            !guest_storage_apply::run_storage_files_bytes(&data),
            "{target:?} {staging:?}"
        );
        assert_eq!(fs::read(target.join("stale")).unwrap(), b"keep");
    }
}

#[test]
fn decoded_skills_coexist_with_staged_and_cached_framework_instructions() {
    for (home_name, filename, alternate) in [
        (".claude", "CLAUDE.md", "AGENTS.md"),
        (".codex", "AGENTS.md", "CLAUDE.md"),
        (".pi/agent", "AGENTS.md", "CLAUDE.md"),
    ] {
        for cached in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let home = root.path().join(home_name);
            let skill = home.join("skills/workflow");
            let sibling = home.join("skills/retained/SKILL.md");
            let staging = root.path().join("runtime/storage-instructions/0");
            fs::create_dir_all(&skill).unwrap();
            fs::create_dir_all(sibling.parent().unwrap()).unwrap();
            fs::write(&sibling, b"retained skill").unwrap();
            if !cached {
                fs::write(skill.join("stale"), b"obsolete").unwrap();
            }
            fs::write(home.join(alternate), b"runtime instructions").unwrap();
            let archive = root.path().join("instructions.tar.gz");
            fs::write(
                &archive,
                super::support::create_tar_gz(&[
                    (filename, b"runtime instructions"),
                    ("skills/unwanted/SKILL.md", b"not promoted"),
                ])
                .unwrap(),
            )
            .unwrap();
            let manifest = serde_json::to_vec(&json!({
                "storageMounts": [
                    {"mountPath": home, "extractPath": staging, "cached": cached,
                     "archiveUrl": (!cached).then(|| format!("file://{}", archive.display())),
                     "instructionsTargetFilename": filename},
                    {"mountPath": skill, "archiveUrl": "file:///not-staged-skill.tar.gz"}
                ],
                "cleanupPaths": if cached { vec![] } else { vec![&skill] },
                "instructionCleanups": if cached { vec![] } else {
                    vec![json!({"mountPath": home, "targetFilename": filename})]
                }
            }))
            .unwrap();
            let data =
                storage_files::encode_input(&manifest, &[(skill.to_str().unwrap(), &files())])
                    .unwrap();
            assert!(
                guest_storage_apply::run_storage_files_bytes(&data),
                "{home_name} cached={cached}"
            );
            assert_eq!(
                fs::read(home.join(filename)).unwrap(),
                b"runtime instructions"
            );
            assert!(!home.join(alternate).exists());
            assert!(!staging.exists());
            assert!(!home.join("skills/unwanted").exists());
            assert!(!skill.join("stale").exists());
            assert_eq!(fs::read(&sibling).unwrap(), b"retained skill");
            assert_eq!(
                fs::read(skill.join("nested/tool")).unwrap(),
                b"final-content"
            );
            let metadata = fs::metadata(skill.join("nested/tool")).unwrap();
            assert_eq!(metadata.mode() & 0o7777, 0o751);
            assert_eq!(metadata.mtime(), 1234567890);
        }
    }
}

#[test]
fn failed_final_write_is_failure_without_rollback_or_archive_retry() {
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("mount");
    fs::create_dir_all(target.join("empty/child")).unwrap();
    assert!(!guest_storage_apply::run_storage_files_bytes(
        &input(&target, false, &files()).unwrap()
    ));
    assert_eq!(
        fs::read(target.join("nested/tool")).unwrap(),
        b"final-content"
    );
    assert!(target.join("empty/child").is_dir());
}
