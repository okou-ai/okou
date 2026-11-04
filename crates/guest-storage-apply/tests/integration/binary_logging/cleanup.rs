use super::{BinaryLoggingFixture, assert_cleanup_phase};
use crate::support::{assert_does_not_contain_any, create_tar_gz};
use serde_json::json;
use std::fs;

#[test]
fn binary_attributes_cleanup_without_changing_preservation_and_restoration() {
    let fixture = BinaryLoggingFixture::new("cleanup-attribution").unwrap();
    let root = fixture.dir.path().join("private-workspace-name");
    let cached = root.join("private-cached-child");
    let restored = root.join("private-restored-child");
    let instructions = fixture.dir.path().join("private-instruction-home");
    let archive = fixture.dir.path().join("private-archive.tar.gz");
    fs::create_dir_all(&cached).unwrap();
    fs::create_dir_all(&instructions).unwrap();
    fs::write(cached.join("keep.txt"), b"cached content").unwrap();
    fs::write(root.join("private-stale-file"), b"private stale bytes").unwrap();
    fs::write(instructions.join("CLAUDE.md"), b"private old instructions").unwrap();
    fs::write(instructions.join("history.jsonl"), b"preserved history").unwrap();
    fs::write(
        &archive,
        create_tar_gz(&[("fresh.txt", b"restored content")]).unwrap(),
    )
    .unwrap();
    let manifest = serde_json::to_vec(&json!({
        "storageMounts": [
            {"mountPath": cached, "cached": true},
            {"mountPath": restored, "writeback": true,
             "archiveUrl": format!("file://{}", archive.display())}
        ],
        "cleanupPaths": [root],
        "instructionCleanups": [{"mountPath": instructions, "targetFilename": "CLAUDE.md"}]
    }))
    .unwrap();

    let output = fixture.run_manifest_stdin(&manifest).unwrap();

    assert!(output.status.success());
    assert_eq!(
        fs::read(cached.join("keep.txt")).unwrap(),
        b"cached content"
    );
    assert!(!root.join("private-stale-file").exists());
    assert_eq!(
        fs::read(restored.join("fresh.txt")).unwrap(),
        b"restored content"
    );
    assert!(!instructions.join("CLAUDE.md").exists());
    assert_eq!(
        fs::read(instructions.join("history.jsonl")).unwrap(),
        b"preserved history"
    );

    let ops = fixture.ops_entries().unwrap();
    assert_cleanup_phase(
        &ops,
        "guest_storage_apply_stale_cleanup",
        true,
        "requested_1",
    );
    assert_cleanup_phase(
        &ops,
        "guest_storage_apply_instruction_cleanup",
        true,
        "requested_1",
    );
    let actions = fixture.action_types().unwrap();
    let position = |name| actions.iter().position(|action| action == name).unwrap();
    assert!(
        position("guest_storage_apply_cleanup") < position("guest_storage_apply_stale_cleanup")
    );
    assert!(
        position("guest_storage_apply_stale_cleanup_cpu")
            < position("guest_storage_apply_instruction_cleanup")
    );
    assert!(
        position("guest_storage_apply_instruction_cleanup_cpu")
            < position("guest_storage_apply_target_prepare")
    );

    for row in ops.iter().filter(|op| {
        op["action_type"].as_str().is_some_and(|action| {
            action.starts_with("guest_storage_apply_stale_cleanup")
                || action.starts_with("guest_storage_apply_instruction_cleanup")
        })
    }) {
        assert_does_not_contain_any(
            "cleanup attribution row",
            &row.to_string(),
            &[
                fixture.dir.path().to_str().unwrap(),
                "private-",
                "cached content",
                "private stale bytes",
                "private old instructions",
                "keep.txt",
                "fresh.txt",
                "CLAUDE.md",
                "history.jsonl",
            ],
        );
    }
}
