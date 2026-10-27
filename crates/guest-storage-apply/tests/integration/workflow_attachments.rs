use crate::support::{create_tar_gz, run_guest_storage_apply_manifest_json};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::fs;

#[test]
fn workflow_archives_verify_bytes_before_materializing_and_reconcile_all_framework_roots() {
    for root in [".claude", ".codex", ".pi/agent"] {
        let home = tempfile::tempdir().unwrap();
        let mount = home.path().join(root).join("skills/custom-workflow");
        let neighbor = home.path().join(root).join("skills/unmanaged/keep.md");
        fs::create_dir_all(neighbor.parent().unwrap()).unwrap();
        fs::write(&neighbor, "unrelated contents").unwrap();
        let name = "workflow:7feae200-7a26-46f5-9dcb-12eaa0804414";
        for (index, filename) in ["old.md", "nested/new.md"].iter().enumerate() {
            let archive = create_tar_gz(&[(filename, "附件".as_bytes())]).unwrap();
            let digest = hex::encode(Sha256::digest(&archive));
            let source = home.path().join(format!("archive-{index}.tar.gz"));
            fs::write(&source, &archive).unwrap();
            let manifest = json!({
                "storageMounts": [{"name": name, "versionId": digest, "mountPath": mount, "archiveUrl": format!("file://{}", source.display())}],
                "cleanupPaths": [mount],
            });
            assert!(run_guest_storage_apply_manifest_json(
                &serde_json::to_vec(&manifest).unwrap()
            ));
            assert_eq!(fs::read_to_string(mount.join(filename)).unwrap(), "附件");
            if index == 1 {
                assert!(!mount.join("old.md").exists());
            }
        }
        let document = home.path().join("private-document");
        let large_document = format!(
            "---\nname: custom-workflow\n---\n\n{}\n",
            "文".repeat(5 * 1024 * 1024)
        );
        fs::write(&document, &large_document).unwrap();
        assert!(guest_storage_apply::apply_workflow_skill(
            home.path(),
            &mount,
            &document
        ));
        assert_eq!(
            fs::read(mount.join("SKILL.md")).unwrap(),
            large_document.as_bytes()
        );
        let empty =
            serde_json::to_vec(&json!({"storageMounts": [], "cleanupPaths": [mount]})).unwrap();
        assert!(run_guest_storage_apply_manifest_json(&empty));
        fs::write(&document, "").unwrap();
        assert!(guest_storage_apply::apply_workflow_skill(
            home.path(),
            &mount,
            &document
        ));
        assert!(!mount.join("nested/new.md").exists());
        assert!(fs::read(mount.join("SKILL.md")).unwrap().is_empty());
        assert!(run_guest_storage_apply_manifest_json(&empty));
        assert!(!mount.exists());
        assert_eq!(fs::read_to_string(&neighbor).unwrap(), "unrelated contents");
    }
}

#[test]
fn wrong_workflow_archive_digest_cannot_write_attachment_contents() {
    let directory = tempfile::tempdir().unwrap();
    let archive = create_tar_gz(&[("unexpected.md", b"wrong bytes")]).unwrap();
    let source = directory.path().join("archive.tar.gz");
    fs::write(&source, archive).unwrap();
    let mount = directory.path().join("mount");
    let manifest = serde_json::to_vec(&json!({"storageMounts": [{
        "name": "workflow:7feae200-7a26-46f5-9dcb-12eaa0804414", "versionId": "0".repeat(64),
        "mountPath": mount, "archiveUrl": format!("file://{}", source.display()),
    }]}))
    .unwrap();
    assert!(!run_guest_storage_apply_manifest_json(&manifest));
    assert!(!mount.join("unexpected.md").exists());
}
