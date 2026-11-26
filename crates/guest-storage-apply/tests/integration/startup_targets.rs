use guest_storage_apply::run_manifest_bytes;
use serde_json::json;
use std::{fs, os::unix::fs::symlink};

#[test]
fn future_batch_alias_prevents_current_cleanup_and_memory_preparation() {
    let home = tempfile::tempdir().unwrap();
    let replaced = home.path().join("replaced");
    let unchanged = home.path().join("unchanged");
    let alias = home.path().join("alias");
    let memory = home.path().join("memory");
    fs::create_dir(&replaced).unwrap();
    fs::create_dir(&unchanged).unwrap();
    fs::write(replaced.join("old"), b"old content").unwrap();
    symlink(&unchanged, &alias).unwrap();

    let input = json!({
        "storageMounts": [
            {"mountPath": unchanged, "cached": true},
            {"mountPath": memory, "writeback": true, "empty": true},
        ],
        "cleanupPaths": [replaced],
        "startupTargets": {
            "phase": "check",
            "additionalMounts": [alias.join("not-created-yet")],
        }
    });

    assert!(!run_manifest_bytes(&serde_json::to_vec(&input).unwrap()));
    assert_eq!(fs::read(replaced.join("old")).unwrap(), b"old content");
    assert!(!memory.exists());
}

#[test]
fn instruction_file_below_an_archive_root_prevents_writes() {
    let home = tempfile::tempdir().unwrap();
    let managed = home.path().join("owned");
    let instruction = managed.join("AGENTS.md");
    fs::create_dir(&managed).unwrap();
    fs::write(&instruction, b"retained instructions").unwrap();

    let input = json!({
        "storageMounts": [{"mountPath": managed, "writeback": true, "empty": true}],
        "cleanupPaths": [managed],
        "startupTargets": {"phase": "check", "instructionFile": instruction},
    });
    assert!(!run_manifest_bytes(&serde_json::to_vec(&input).unwrap()));
    assert_eq!(fs::read(&instruction).unwrap(), b"retained instructions");
}

#[test]
fn independent_missing_and_retained_targets_allow_memory_preparation() {
    let home = tempfile::tempdir().unwrap();
    let memory = home.path().join("memory");
    let skills = home.path().join("skills");
    let kept = skills.join("existing");
    let instruction = home.path().join("AGENTS.md");
    fs::create_dir_all(&kept).unwrap();
    fs::write(kept.join("SKILL.md"), b"existing package").unwrap();
    fs::write(&instruction, b"existing instructions").unwrap();

    let input = json!({
        "storageMounts": [
            {"mountPath": kept, "cached": true},
            {"mountPath": memory, "writeback": true, "empty": true},
        ],
        "startupTargets": {
            "phase": "check",
            "additionalMounts": [skills.join("later/descendant")],
            "instructionFile": instruction,
        },
    });

    assert!(run_manifest_bytes(&serde_json::to_vec(&input).unwrap()));
    assert!(memory.is_dir());
    assert_eq!(
        fs::read(kept.join("SKILL.md")).unwrap(),
        b"existing package"
    );
    assert_eq!(fs::read(instruction).unwrap(), b"existing instructions");
}
